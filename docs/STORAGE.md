# 数据存储

[文档导航](README.md) · [架构](ARCHITECTURE.md) · [恢复](RUNBOOK.md)

## 事实与保留单位

| 内容 | 来源与 owner |
| --- | --- |
| 配置、工单关系、参数和绑定 | SQLite，[schema.ts](../src/db/schema.ts) |
| 对话、工具结果、会话分支 | Pi JSONL，Agent 会话 owner |
| 附件原件及事务 | 文件＋DB，[attachment-store.ts](../src/http/attachment-store.ts) |
| 脚本、报告、导出 | 普通文件，[work-files.ts](../src/workspace/work-files.ts) |
| 代码、refs、对象与索引 | 共享／工单 Git owner |

人工评论独立于 Pi 对话，应用不另建 SQL 聊天表。SQLite rollback 不撤销文件或 Git，恢复必须匹配各介质。GET 脱敏不等于存储加密。

## 数据关系

用户有活跃状态、业务角色和独立 isAdmin；个人凭证、共享凭证、全局模型与参数各由所属表维护。应用参数保存显式覆盖与 revision，默认值仍来自代码。

服务关联仓库目录，Deployment 绑定服务／环境、查询目标和基线分支，部署 MCP 有明确归属。每张工单恰有一条 Workspace，当前会话绑定、仓库历史、附件、服务范围、关联、抄送和置顶分别记录。

内部 issueId 为 UUID，业务编号为配置时区的 ISSUE-YYYYMMDD-NNN...；HTTP 工单 id 使用业务编号，目录小写。服务／环境必须匹配有效部署，resolved 与 resolved_at 非空等价，Issue type 由数据库 guard 约束为当前闭集。

字段、索引和触发器以 [schema](../src/db/schema.ts)、[bootstrap](../src/db/bootstrap.ts) 和已发布 [迁移](../drizzle) 为准，不修改历史 SQL／journal。

## 目录与模式

```text
.issue-pilot/
├── issues.db{,-wal,-shm}
├── git/
│   ├── repositories/<url-hash>/
│   └── checkouts/<url-hash>/<commit>/
├── workspaces/<issue-key>/
│   ├── <repository>/
│   ├── .issue-git/<url-hash>/
│   ├── .session-<name>.jsonl
│   ├── .attachment-<id>.<ext>
│   ├── .issue-runtime.json
│   ├── .related-<key>{,.json,.jsonl}
│   └── 普通文件、报告、脚本和缓存
└── control/
```

state 为 0700、DB／JSONL 为 0600、附件为 0400。统一 issueRoot 是 cwd；管理文件可列名但不能普通原始下载。node_modules、venv、Web 构建和恢复点位于模型工作根之外，工单内自己的依赖缓存另行分类。

## 文件写入与发布

### 原始附件

先暂存、计算 size／SHA-256，再协调工单事务和文件公开。物理名含 UUID 并遵守 UTF-8 字节预算，原名保留元数据与标准下载文件名。

附件 owner 要求工单根已存在、为真实目录且解析后的路径与登记路径一致；根自身或祖先的符号链接会被拒绝。创建先由工单 owner 认领空根，编辑上传不能自动重建缺失目录或改写现有目录权限。异常根应保留现场检查，不能靠重新上传修复。回归见[附件编辑](../tests/http/attachment-api.test.ts)。

读取要求直属工单根、regular file、精确 0400、大小和 hash 匹配。下载打开后通过 Linux `/proc/self/fd` 复核实际路径，拒绝检查与打开之间的祖先重定向，再有界完整校验并从同一描述符发送；取消关闭句柄，不重新打开可变路径。Agent 准备校验原件但不声称持续监控外部修改。实现与边界见 [attachment-store.ts](../src/http/attachment-store.ts)、[文件校验回归](../tests/http/attachments.test.ts)。

附件下载取消时不再向断开的连接返回错误；若取消期间关闭句柄失败，路由仍记录脱敏的 `attachment_download_failed`，包含稳定 reason（如 `attachment_read_cleanup_failed`）和 errno，不输出绝对路径或原始错误链。普通取消不记作故障。实现见 [attachment-routes.ts](../src/http/attachment-routes.ts)、[取消与清理回归](../tests/http/attachment-api.test.ts)。

删除先 quarantine，rollback 恢复、commit 后 finalize；收尾失败不掩盖原错误。新原件在关闭旧会话及预约后写入，避免旧沙箱保护列表漏掉它。没有自动可编辑副本，粘贴图片属于消息。

### 普通工作文件

查询导出校验路径／取消，独占临时文件，内容与协议收尾完成后再原子替换；提交前失败保留旧内容，不自动重查。路径级串行和等待取消避免同名导出互相覆盖。

工作文件与 Source 使用固定目录／文件描述符、实际打开路径复核、管理名及 Git 控制路径拒绝，避免父目录变化把写入导向外部。清理只处理本次拥有的临时文件，操作与清理失败聚合。

工作文件目录读取或下载打开失败后若关闭描述符也失败，owner 用 `work_file_read_cleanup_failed` 聚合两项错误，避免关闭错误覆盖读取／路径错误；仅关闭失败则保留该错误。聚合保留诊断，不表示句柄已成功释放或可自动重试。依据：[work-files.ts](../src/workspace/work-files.ts)、[故障注入回归](../tests/workspace/work-files.test.ts)。

源码新建先独占同目录临时文件，写完并关闭后才通过硬链接发布；发布不覆盖竞争创建的目标。写入／关闭／发布前失败不会留下半个目标文件，同名重试仍需检查当前路径。若发布完成后临时链接清理失败，返回 `source_create_cleanup_failed`，完整目标可能已存在，应先重读目标并检查临时证据，不盲目删除或重试。实现与故障回归见 [source-browser.ts](../src/workspace/source-browser.ts)、[source-pagination.test.ts](../tests/workspace/source-pagination.test.ts)。

源码保存比较读取时 SHA-256，冲突返回 source_file_changed。文本、diff、历史与 MCP 读取各有独立预算；超限返回元数据或明确错误，不无界缓冲。预览预算不截断普通下载。

对话只解析当前 workspace、普通相对路径和已授权相关工单；outputs／work／attachments 是真实目录，不剥除为旧别名。历史 issues 绝对路径不自动转换，迁移索引不成为下载兼容层。

## Git 与工作区

共享 bare store 保存基线对象与引用，checkout 是 detached 展开快照。开发工单持有私有 store、分支、新对象、worktree 和索引，只读复用共享对象，不跨工单共享可写硬链接。

| 仓库集合 | local_path | working_branch |
| --- | --- | --- |
| read_only | 全 NULL | 全 NULL |
| development_workspace | 全非空 | 全非空 |
| development_snapshot | 全 NULL | 全非空 |
| invalid | 空集合／混合／其他组合 | 拒绝并检查 |

共享基线按完整 ref 解析，复用检查 HEAD、common dir、tracked／untracked／ignored。开发恢复只使用本地合法分支，不 reset、远端 fallback 或改绑定。config、hooks、alternates、索引与 backpointer 各有安全检查。

释放要求已解决、空闲、布局／分支匹配且干净，含 ignored 内容；只移除登记代码，保留根、文件、会话与持久分支。开发工单根丢失时拒绝释放／重开，不能把共享 ref 当完整历史。发布使用 compare-and-swap，外部 ref 变化拒绝覆盖。

scope 先保存意图，再准备资源，同 URL 分支冲突拒绝。失败记录与已有事实保留供重试，代码释放后运行视图恢复失败由维护在预约内重新检查。

## 容量统计

工单 totalBytes 包含附件、会话、工作文件、缓存和私有 Git；sharedGitBytes 单独统计。它不是全盘容量或同一时刻磁盘快照。

普通并发读取共享在途扫描；完成结果和字节测量缓存一个维护周期，默认 15 分钟，`workspaceMaintenanceIntervalMs=0` 时为 5 秒。`GET /api/workspaces/stats?refresh=true` 绕过旧样本；若已有扫描仍在执行，会排入一次新扫描，而不是返回旧扫描结果。返回的 `sampledAt` 表示该批完成时点，扫描各目录并非原子快照，不宜用高频强制刷新轮询磁盘。

生命周期／策略变更会使相关缓存失效，实际回收重新检查，候选大小不等于释放量。保留期、高水位、目标和周期来自热参数；`workspace.taskConcurrency` 是后台批次并发，不是 Agent 名额。依据：[lifecycle.ts](../src/workspace/lifecycle.ts)、[统计缓存与在途刷新回归](../tests/workspace/lifecycle.test.ts)、[HTTP 统计接口](../tests/http/workspace-statistics.test.ts)。

## 备份与精简边界

- **持久**：DB 文件组、会话、附件、工作文件、私有 Git 是运行事实，不能当缓存删除；完整恢复要求它们彼此匹配。
- **有条件持久**：开发 worktree 的 dirty、untracked、ignored 内容在安全释放前不能删。
- **可再生**：依赖缓存、构建产物与共享快照可经验证排除，但名称不能证明无价值。
- **恢复证据**：未知目录、quarantine、异常临时文件、迁移记录先查 owner，不按垃圾删除。

以上是数据的持久性分类，不代表它们都纳入当前备份。当前安装仅保留数据库检查点，不创建或保留工单文件全量备份；创建时机、验证、有限轮换和恢复限制统一见[运维手册](RUNBOOK.md#当前备份策略)。数据库结构完整不能证明附件、会话、工作文件或 Git 仍在，也不能让这些文件随 DB 回退。

依赖／构建目录与共享 checkout 只有经 owner 检查、确认无独有成果及当前引用后才可精简。不能仅凭 node_modules、target、venv 等名称删除，也不能把共享对象／pin／私有 Git 与展开快照一起删；历史归档的重建条件见[历史完整恢复点的判定](RUNBOOK.md#历史完整恢复点的判定)。
