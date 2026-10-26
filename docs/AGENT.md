# Agent 与能力

[文档导航](README.md) · [系统架构](ARCHITECTURE.md) · [配置与协议](CONFIGURATION.md)

模型选择下一步任务，Pi 管理模型会话和工具管线，应用维护身份、业务范围、持久数据和执行边界。provider／model、thinking 与 Codemode 为全局设置。

## 模型如何使用工具

1. 模型读取任务和工单上下文，选择工具并生成参数。
2. Pi 工具管线与应用 owner 校验后，调用本地或远程能力。
3. 结果进入对话或工作文件，模型继续判断或结束本轮。

| 工具 | 执行路径与范围 |
| --- | --- |
| read／write／edit／bash／grep／find／ls | SDK 原生能力经 SRT 短期执行进程，cwd 为当前工单根目录 |
| `workspace` | owner 维护服务说明、代码 list／include／remove，保持工单代码环境 |
| `service_query` | 配置和权限允许时使用 DMS／SLS 原生只读查询 |
| `mcp__<id>__<tool>` 与 resources | Pi 管理服务部署所属连接，按入口／已包含服务与来源环境筛选 |

提示词不代替执行校验。输入、范围、凭证和路径由 owner 检查，工具存在也不代表模型可以任意操作。入口见 [engine.ts](../src/agent/engine.ts)、[pi-session.ts](../src/agent/pi-session.ts) 和 [prompts.ts](../src/agent/prompts.ts)。

## 原生证据查询

1. 输入经 schema 校验、扩展钩子和 execute 再校验。
2. owner 检查服务、环境、目标与只读规则，注入对应凭证。
3. 协议调用遵守取消、时间和结果预算。
4. 返回完整证据、下载文件或稳定错误。

Pi 的初始校验位于可变参数钩子之前，应用保留 execute 再校验；外部 MCP 发送前按发现的 schema 校验。正式／测试调查选择本环境来源，开发查询显式选 prod／test。连接配置由服务端提供，不由模型传入。

### DMS

DMS 在连接前校验只读 SQL，使用原生 SSE。一次操作预算 120 秒、首次握手 12 秒、最多两次握手；429 按有效 Retry-After 最多等待 5 秒后重试一次握手，401／403 不重试，发送过的 SQL 不自动重放。

工具错误返回稳定 error 与脱敏 diagnostics，阶段包括 connect／discovery／execute／export／close，以及总耗时、阶段耗时、sqlDispatchAttempted 和可用的 retryAfterSeconds。阶段时间可重叠，发送尝试不能证明服务端已执行；错误 JSON 不含 URL、SQL 或认证。取消保留原原因，关闭失败与操作失败分别保留。

完整导出使用普通工作文件，协议收尾成功后才原子替换旧文件。导出失败不重查 SQL，关闭失败保留旧交付。Agent 指引要求 DMS 批次串行且保留间隔：同批主动重查一次仍失败则拆分／暂停；连续两次恢复探测失败或单轮累计五次调用失败时保存断点并停止，成功探测不清零累计失败数。这是模型工作指引，不是服务端限流器。

### SLS 与 MySQL

SLS 调用固定 `aliyun sls GetLogsV2`，0600 临时配置注入选定凭证，禁用 CLI 自动重试并使用 HTTPS；结束或取消时删除配置，不改变宿主默认 profile。只接受 meta.progress=Complete；SQL 分析按 LIMIT／ORDER BY 返回一页，普通查询按 offset 分页。后页失败即整次失败，未知 CLI 错误隐藏，已知 code 转稳定诊断。超时／取消终止进程组并清理凭证，CLI 缺失报 `sls_cli_not_available`。

MySQL 由部署 MCP 与数据库账号提供能力，配置与归属见[MySQL MCP](CONFIGURATION.md#mysql-mcp)。SLS／DMS 查询到的业务 token 与用于连接系统的配置密钥遵循不同展示规则，见[凭证与 owner](CONFIGURATION.md#凭证与-owner)。

## MCP 与 Codemode

入站 `/mcp` 是外部客户端调用应用的接口；服务部署 MCP 是 Agent 的外部能力；DMS 原生连接由适配器管理。钉钉导入连接仅供应用读取单条记录。

Pi 负责外部 MCP 发现、命名、注册、连接复用和关闭。应用维护数据库配置权、传输约束、输入／结果预算及取消。会话过期时报告本次失败，下一次显式调用重新连接，不重放原操作。

| Codemode | 模型工具声明与使用方式 |
| --- | --- |
| off | 直接调用原生、应用和外部 MCP 工具 |
| on | 原生／应用工具与 Codemode 并存，按需 searchTools／describeTool |
| only | SDK 隐藏其他模型工具声明，主要经 Codemode 发现与编排 |

on／only 不预载所有 MCP schema。脚本使用进程级可取消 FIFO，一次执行一个，为 SDK 第二个 Worker 槽位留退出缓冲；默认等待最多 120 秒、队列 32 个，由 `limits.codemode` 管理。等待超时或取消的脚本不执行、不重放；脚本内部独立读取可并行，DMS 仍按批次串行。Codemode 仅编排工具，没有直接文件或网络能力。

## 文件处理与会话

Agent 用普通命令和已安装库处理文件。原始 `.attachment-*` 只读，准备阶段校验但不复制；需要编辑时另存工作文件。Bash PATH 包含应用 `.venv`，直接使用 npm／Maven，Node 可使用已安装包。Python/openpyxl 支持 xlsx 读写及公式保留，不计算公式；xls 不在支持范围内，网页不解析 Excel。

图片读取传递 Pi 自动缩放设置和模型尺寸限制。SDK 图片、长输出及 MCP 二进制资源通过固定版本补丁的保存回调进入工单根目录，补丁见[说明](../patches/README.md)。报告使用工作文件 downloadPath，文件事务见[存储设计](STORAGE.md#文件写入与发布)。

Pi JSONL 保存消息、工具结果与分支，恢复读取 active branch。只读仓库轮次结束后关闭会话，下一轮重新准备快照并恢复对话；开发空闲会话可复用。模型响应超时只累计等待输出的时间，工具执行期间暂停。资源加载和设置覆盖见[Agent 基座与资源](CONFIGURATION.md#agent-基座与资源)。

## 消息接收与中断

消息在等待同工单队列后重新检查会话。文字和图片写入现有 Pi JSONL，绑定保存后才返回 HTTP 202；准备仓库、凭证或 SDK 初始化尚未成功也先保存输入。202 表示已接收，执行队列仍在内存，启动不会自动开始模型工作。

| 持久记录 | 含义与恢复 |
| --- | --- |
| `issue-pilot-user` | 可见用户输入，附交付版本和原服务／环境 ID |
| `issue-pilot-user-delivery: started` | 可能已交付，不保证执行完成；不自动重新注入 |
| `issue-pilot-user-delivery: rejected` | 原范围不再合法，保留原文并拒绝恢复 |
| 无明确排队元信息的消息 | 不推断为待办 |

用户主动重试／继续时，按顺序恢复明确排队且无 started／rejected 的输入，保留图片且不重复追加显示条目。恢复使用当前合法 owner 和模型配置，元信息不保存密钥；未知或损坏记录报错。

未交给 Pi 的流式消息遇会话结束／切换时可转普通回合。已交给 Pi 而旧会话被替换时返回 `409 agent_message_outcome_unknown`，不重放、不写回旧会话，页面保留草稿。应用没有客户端提交幂等 ID、跨进程自动调度或外部副作用恰好一次保证。

写入失败不入队。JSONL 缺失／末尾不完整分别返回 `agent_session_file_missing`／`agent_session_file_incomplete`，保留原文件、绑定和草稿，不截断、改绑或新建替代会话。关闭等待活动、排队工作和预约排空，依次尝试 abort／shutdown／dispose，聚合启动与清理错误。

## 关联工单与信息时效

`.related-<key>` 是源工单真实目录的只读引用，包含代码、附件、工作文件和会话；关联不改变当前 owner 或查询权限。`.related-<key>.json` 及可用的 jsonl 引用在准备时生成，复用开发会话不会自动刷新。源工单变化不触发后台重新分析；使用重要依据时核对文件、对话、代码版本和读取时点。当前没有自动摘要或结论同步。

## 执行边界

模型本地工具和 stdio MCP 使用 SRT，Linux user／PID／mount／network namespace 与 seccomp 共同约束。宿主文件系统只读，当前工单根可持久写入，关联工单只读，数据库与私有配置隐藏。管理文件及 Git 指针额外只读；启动检查跨目录硬链接，写入重新检查路径和管理文件。TMPDIR、Node／Maven 与 Java 缓存落在工单内。

网络经 HTTP 代理，proxychains 为不读代理变量的 TCP 客户端提供同一出口；Unix socket 与嵌套 namespace 默认关闭，宿主控制地址及 API／Web 端口拒绝访问。域名基础列表与数据库追加项见[服务和查询目标](CONFIGURATION.md#服务和查询目标)。危险 loader 环境覆盖拒绝执行；依赖或隔离能力不足时失败。

工单私有 Git store 的索引、工作分支和新对象可写；共享对象、Git config／hooks／alternates 和绑定指针只读。个人 SSH 仅向 native 工具开放当前临时身份目录，私钥 0600，复制 Operator known_hosts 并严格校验；stdio MCP 不获得这份身份。SSH 代理与个人凭据隔离设置组合，保留安全目录及空 credential helper／header。

本地执行与 workspace include／remove 按工单串行，包含等待、取消、退出与准备；SRT 的共享代理生命周期队列不替代业务锁。重复关闭共享清理 Promise，等待临时文件和代理使用权释放，清理失败不覆盖原失败。实例控制 socket 只负责单实例与离线迁移互斥。

Pi SDK、Operator 扩展和应用存储 owner 属于可信代码；工单扩展不加载。远程 MCP 拥有自己的执行权限，本地 SRT 不替其实施数据库只读或业务授权，Source API 与原生查询继续独立检查各自范围。
