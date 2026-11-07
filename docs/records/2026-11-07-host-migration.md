# 2026-11-07 宿主机迁移与验收

[文档导航](../README.md) · [当前部署](../DEPLOYMENT.md) · [运维边界](../RUNBOOK.md)

本记录保存本次实际执行、失败尝试及验证结果。以下时间均为 **Asia/Shanghai（UTC+8）**。源码基线为 `96d347fffa3b3d78388986a56f9ad43b9e2ce87e`。日后操作以当前部署／运维指南为准，不重复执行这里的迁移脚本。

## 目标和最终边界

从源 WSL 安装迁移全部应用与业务数据到 Debian 13 amd64 虚拟机，允许短暂停服。目标通过 `ssh -p 2222 idoly@172.20.32.1` 访问，虚拟机当前地址为 `172.25.66.32`；虚拟机地址并非固定不变的产品契约。

初期按 rootless Podman 分离应用／数据准备，后按用户决定改为 **宿主机直接运行应用**：不交付应用镜像、不注册 service、不配置自动拉起。Podman 仅保留作浏览器测试。

最终目录：

| 内容 | 位置 |
| --- | --- |
| 应用 | `/home/idoly/issue-pilot` |
| 唯一业务数据根 | `/home/idoly/issue-pilot/data` |
| 启停入口 | `/home/idoly/issue-pilot/restart.sh` |
| 本机实现及操作证据 | `/home/idoly/.local/share/issue-pilot-runtime` |
| PID／锁／当前和上次日志 | `/home/idoly/.local/state/issue-pilot-host` |
| Pi 资源与配置 | `/home/idoly/.pi/agent` |
| SSH 文件 | `/home/idoly/.ssh` |

目标不保留 `.issue-pilot` 目录、符号链接或 bind mount。没有更改业务 Schema、工单分支或代码内容。源码部署差异为 state.directory=data、根 data 忽略规则及本机入口脚本；本轮文档另行重整，用户随后授权在目标机提交并推送迁移配置与文档。

## 打包、传输与工具准备

1. 08:45:48 停源实例建立初始快照，08:49:59 完成停写拷贝，08:51:08 源服务恢复健康。初始包只代表这一时刻，不包含之后继续运行的增量。
2. 分别打包源码、state 和 runtime-home，执行 gzip 完整性、tar 内容／元数据及 SHA-256 检查，使用 rsync 传到目标 `/home/idoly/issue-pilot-migration-20261107`。原包没有交付应用镜像。
3. 在源侧隔离恢复演练核对持久状态与 Git，明确该演练不是目标 Debian 的运行验收。目标校验传输后解压，再独立安装平台对应的生产依赖。
4. 数据先解压到 `/home/idoly/data`，之后移入应用目录。曾短暂准备旧路径挂载，最终卸载并移除；它不属于当前启动方案。
5. 准备宿主工具、Pi 配置和 SSH，之后执行最终停写增量同步与路径迁移。

| 工具 | 本次安装结果 |
| --- | --- |
| Node／npm | 26.13.0／11.20.0，`/usr/local/node` |
| Temurin JDK | 8u504-b01，`/usr/local/java` |
| Maven | 3.9.16，`/usr/local/maven` |
| aliyun CLI | 3.5.2，`/usr/local/bin/aliyun` |
| Git | 2.56.0，`/usr/bin/git` |
| 全局 Pi | 1.5.0，prefix `~/.local`，入口 `~/.local/bin/pi` |
| Python venv | 应用 `.venv`，openpyxl 3.1.5、et_xmlfile 2.0.0 |

用户要求的全局安装实际执行为 `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`；应用另行执行 `npm ci --omit=dev --no-audit --no-fund` 并通过项目 Pi／zod 补丁校验，不能混淆两个安装。

系统补齐 bubblewrap、socat、proxychains4、python3-venv、ripgrep、fd-find、curl、rsync。Node／Java／Maven／aliyun 为便携安装，PATH、JAVA_HOME、MAVEN_HOME 配置到 `/etc/profile`；runner 另外显式设置环境。

原 Debian Git 2.47 不支持应用所需 `--relative-paths`。基于已验证 Debian 构建缓存，按 prefix=/usr 制作本地 Debian 包 `1:2.56.0+issuepilot1`，替换旧 Git；exec path 为 `/usr/libexec/git-core`，templates 为 `/usr/share/git-core`，保留 lazygit。最初试装的 `/usr/local/git` 已移除，apt-get check／dpkg --audit 通过。

用户要求的 `.ssh` 五个文件已复制并逐一 SHA 对照，目录 0700、文件 0600，不在记录中保存内容。Pi 配置也完成哈希／权限核对。系统时区改为上海，zh_CN.UTF-8／en_US.UTF-8 生成并在新进程验证；中文 roundtrip 与字符宽度通过。Hyper-V 基本文本控制台仍受客户端字体限制，使用支持中文的 SSH 终端。

## 正式切换与失败处理

| 时间 | 实际行为与结果 |
| --- | --- |
| 10:31:40 | 第一次停源后，SSH ControlMaster 连接断开，切换中止；未执行路径改写，自动恢复源服务并确认 health |
| 10:39:36 | 第二次停源并补齐增量，路径迁移预检把历史 session 头 cwd 当成当前目录，预检拒绝；尚未改写数据，恢复源服务并确认 health |
| 10:51:40 | 第三次停源，确认两服务 PID 为 0、租约释放后最终 rsync；不广泛 --delete，保留目标额外路径 |
| 10:55:04–10:55:08 | 离线路径迁移完成；数据库、文件和 Git 核对通过 |
| 10:58:38 | 目标应用首启 health 通过，源实例继续停止 |
| 11:05 前 | 一次真实 restart 完成，重复 start 不产生第二进程；断开管理 SSH 后独立重连确认仍健康 |
| 11:11:53 | 真实模型、DMS、SLS 代表链路验收记录完成 |
| 11:12:43 | 删除目标原迁移包，保留小型来源／校验记录；磁盘可用约 13.6 GiB |

最终 rsync 保留所有持久内容及非干净工作树；只移除源停写后已不存在的目标 SQLite WAL／SHM，避免把旧 sidecar 混入新主库。初始快照之后源启动产生的正常增量也纳入同步，不能要求最终状态仍等于初始归档的文件集合。

### 历史会话 cwd 的核实

第二次预检拒绝后查阅 [Engine](../../src/agent/engine.ts) 和 SDK 的 SessionManager.open：应用显式传入当前 workDirectory 作为 cwdOverride，历史 JSONL 头的 cwd 不是当前运行目录约束。最终方案保留全部会话字节，不重建历史目录、不替换正文或头部。

### 实际路径改写

| 位置 | 修改范围 |
| --- | --- |
| issue_repositories.local_path | 215 条路径 |
| issue_attachments.object_key | 553 条路径 |
| issue_pilot_sessions.session_file | 481 条路径 |
| issue_pilot_sessions.workspace_path | 481 条路径 |
| .issue-runtime.json | 481 份清单的旧根绝对 link value |
| issue-pilot.config.ts | state.directory 从 .issue-pilot 改为 data |

482 个 JSONL（481 个当前绑定及 1 个历史会话）前后完整 SHA 相同。物理链接及 Git 有效指针原为相对路径，无须改写；不改变 refs、分支、索引或工作文件。历史消息和离线证据中的旧路径按历史保留。

## 验证结果与范围

| 验证层次 | 实际结果 |
| --- | --- |
| 持久数据 | integrity/FK、481 工单的唯一 Workspace、553 原件的 hash／0400、481 当前会话及 75417 条 JSONL 记录、215 登记代码路径通过；未登记工单根为 0 |
| Git | 初始 258 对象库、215 代码路径与归档对照，43 个非干净路径保留；最终同步后在新根核对路径／refs，变化 refs 再做对象连通性检查 |
| 目标隔离行为测试 | native-tools.test.ts、git.test.ts，21 pass、0 fail、0 skip，包含实际本地 SRT |
| 运行依赖 | 生产 npm audit 为 0 漏洞；pip check、临时中文 Excel 读写、Java 编译运行、Pi CLI 检查通过 |
| 真实个人 Git | 使用当前工单 owner 的 DB 私钥和应用 Git 环境，git ls-remote HEAD 成功，无其他身份 fallback |
| HTTP | health、页面、身份、481 工单列表、当前目录、会话分页、源码 repositories／tree、SSE 首帧及附件下载 hash 通过 |
| runner | 实际 stop/start/restart、重复 start、脱离 SSH 后存活与 health 通过 |
| 浏览器容器 | Playwright v1.64.1-noble 拉取成功，临时容器无 data 挂载，Chromium 打开当前应用通过；不是完整交互回归 |

Playwright 镜像 digest 为 `sha256:ee15712262f017b8157421b212b12099146645f44b1bc5c0514cbbe6a229b1d0`，镜像仅用于测试，不是应用镜像。

### 真实模型、DMS 和 SLS

验收从目标 checkout 运行独立操作脚本，以 `PRAGMA query_only=ON` 读取实际 SQLite，复用应用的 owner、凭证选择、模型隔离、service_query schema 和 execute 分发，不发工单消息、不改业务配置或工作文件。

| 链路 | 输入与确认 |
| --- | --- |
| 模型 | 当前 owner 选择的 xhgj／gpt-6.1-sol，短提示要求 ISSUE_PILOT_ACCEPTANCE_OK，收到预期文本和 stop；无工具。共享与个人的 provider／model／Key 相同，未重复发送同一模型请求 |
| DMS | CRM prod 的当前个人凭证，SELECT 1 AS issue_pilot_acceptance，经 alias／schema 解析、发现和 executeScript，确认常量结果 |
| SLS 正式 | CRM prod 当前 owner 凭证，精确配置日志库，最近 60 秒 count(*) 聚合 LIMIT 1，Complete 且返回 1 行聚合 |
| SLS 测试 | CRM test 当前 owner 凭证，同样最近 60 秒聚合，Complete 且返回 1 行聚合 |

未输出连接秘密或业务日志正文。模型请求可能计费，SDK 本次有用量记录，费用是目录估算，不作账单承诺。验收脚本初次在本地准备阶段关联了不存在的 Issue deploymentId 字段，能力尚未发出请求即失败；修正为 serviceId／environmentId 关联后仅重跑失败能力，保留已成功模型结果。此为操作脚本修正，不是生产代码缺陷或厂商失败。

这些是代表目标的真实集成验收，不是全部服务／用户／DMS 数据库／日志库／模型的逐一验证。没有进行业务修改 SQL、日志全文获取、模型工具整轮任务、DBHub 可选驱动或钉钉真实导入。全量 typecheck／npm test／Web build 未在目标执行；目标只装生产依赖并使用匹配源码的既有 Web 构建。

## 访问范围的最终决定

用户随后决定不在目标机处理访问转发；该项不纳入本次迁移交付，不保留为待办。没有修改 Windows 宿主机 portproxy、防火墙或其他网络映射。目标 API 保持监听 3000，目标本机的健康、页面及 API 验收结果不变。

## 清理、证据与恢复边界

真实查询全部通过并再次确认目标健康后，删除精确目录 `/home/idoly/issue-pilot-migration-20261107`（约 10 GiB 的原传输包及其脚本），没有删除 live data。清理后可用空间为 14609457152 字节；仅保留来源 manifest 与 SHA 文件到 delivery-provenance，不构成可恢复归档。

删除了不用的 Podman 应用启动入口，迁移 Containerfile 移到私有操作记录，不纳入当前源码；清理本次源侧 Git 构建容器、三份已确认的构建 stage 镜像及 Git 传输／staging，保留 Debian 安装包和验证证据，不全局 prune。

源机原始数据和原迁移归档保留，两个旧 user services 停止并禁用。目标后续写入不会同步回源，原包也不含最终增量；不能把旧归档、旧 DB 和当前文件混用，不能在两机同时开展业务。

目标小型数据库检查点与元数据撤销材料位于 path-relocation 和 path-relocation-preflight-failed，只保留本次最新与上一份。它们不恢复原件、会话、工作文件或 Git。所有 relocate／unpack 脚本仅是离线迁移证据，不在运行实例重复执行。

原始操作证据根为 `~/.local/share/issue-pilot-runtime`，主要包括 cutover.json、path-relocation/report.json、http-verification.json、browser-container-verification.json、live-acceptance.json、delivery-cleanup.json 及测试／audit 记录。03:05 UTC 的 completion.json 是补充真实查询前的阶段记录，其未验收描述已被后续 live-acceptance.json 更新，不覆盖或伪造历史原始证据。
