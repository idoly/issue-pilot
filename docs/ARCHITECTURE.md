# 架构

Issue Pilot 在一个 Node 进程中运行 Fastify、SQLite/Drizzle、Agent 调度和工作区管理。Solid 2 前端通过 HTTP/SSE 访问后端，独立 Monaco 负责文本编辑和差异显示。Pi SDK 持有模型会话、工具管线、Codemode 和 JSONL。

## 事实所有权

| 事实 | 所有者 |
| --- | --- |
| 路径、默认值、预算、保留策略 | [根配置](../issue-pilot.config.ts)、[config.ts](../src/config.ts) |
| 角色、处理方式、业务状态及谓词 | [domain/contracts.ts](../src/domain/contracts.ts) |
| 用户、配置、Issue、Workspace、仓库和会话绑定 | SQLite；当前定义见 [schema.ts](../src/db/schema.ts) |
| 升级历史 | [drizzle](../drizzle) 的 SQL 与 journal，已发布内容不可修改 |
| 对话及分支 | 每工单 Pi JSONL 的 active branch |
| 附件 | 一个持久文件及 DB 中的路径、size、SHA-256 |
| 工作文件与交付成果 | 工单 work 与 outputs，分别由执行流程和 [成果存储](../src/outputs/store.ts) 管理 |
| 开发代码 | bare store 的本地 working branch、活动 worktree 和未提交内容 |
| 正式/测试代码 | 部署分支对应的受管 detached checkout |
| runtime、wrapper、页面状态和统计 | 派生数据，不反向覆盖上述事实 |

## 主要调用路径

```text
Browser -> data/client -> HTTP route -> scope/reservation/transaction -> owner
AgentEngine -> workspace preparation -> Pi session -> native/application tools
Pi JSONL + current events -> SSE snapshot/live -> conversation projection
External AI -> /mcp -> existing HTTP routes -> Issue/Agent owners
```

[api.ts](../src/http/api.ts) 组装数据库、队列、Agent、工作区、路由和关闭流程。路由处理输入、身份、预约和事务协调；Git、文件、协议和命令授权分别由 workspace、attachment/output、capabilities/MCP、tool-runtime owner 承担。

## Issue 与状态

创建请求使用 `workMode` 和 `serviceKey`。处理方式唯一确定环境、Issue type 和代码访问，不额外存储另一份 work mode。创建先独占 claim 空 Issue 目录，再事务写入 Issue、恰好一条 Workspace、关系和附件，成功后入队。

Agent 处理中 Issue 为 `in_progress`，成功后为 `pending`，失败且未解决时回到 `open`。人工可将 pending 标记为 resolved，重开后为 open；`resolved` 与非空 `resolved_at` 等价。Workspace 单独记录准备、运行、失败和释放状态，`runtime_ready` 不能代替物理路径和 Git 状态检查。

范围变更由 [scope-transition.ts](../src/workspace/scope-transition.ts) 生成 plan，结合更新时间与 plan hash 拒绝过期请求。支持正式/测试只读重绑、同服务调查转开发修复、保持 branch mode 的开发跨服务迁移。范围、仓库记录和审计在对应事务中提交；文件与 Git 变更由生命周期 owner 准备、回滚和最终化。

## Git 与代码集合

[Repository rows 分类](../src/workspace/state.ts)决定访问方式：

| 布局 | local_path | working_branch | 行为 |
| --- | --- | --- | --- |
| read_only | 全 NULL | 全 NULL | 正式/测试只读快照 |
| development_workspace | 全非空 | 全非空 | 活动开发 worktree |
| development_snapshot | 全 NULL | 全非空 | 从本地开发分支恢复只读快照 |
| invalid | 空集合、混合或其他布局 | — | 拒绝操作 |

bare store 按 URL hash 共享 objects/refs。开发 worktree 独立保存 staged/untracked；历史 base branch、workspace name 和 working branch 不随当前服务配置重写。普通准备、调查转换和跨服务迁移复用 [project.ts](../src/workspace/project.ts) 的仓库集合保存函数，相同记录不重写时间戳。

`workspace list/describe/include/remove` 管理同环境附加代码。服务范围意图保存在 `issue_service_scopes`，仓库按 URL 去重；同 URL 分支冲突拒绝，移除开发代码要求 clean。开发证据查询另行显式选择 prod/test，不改变代码所属环境。

释放只处理 resolved、空闲、布局正确且 clean 的开发工单。批量移除失败使用原本地 ref/commit 恢复；成功清空 local_path、保留 working branch，再准备只读 runtime。已记录 working branch 的准备与重开只复用本地仓库和分支，不 fetch；缺少本地 ref 时拒绝，不用远程分支或 reset 修复漂移。入口为 [lifecycle.ts](../src/workspace/lifecycle.ts)、[project.ts](../src/workspace/project.ts) 和 [git.ts](../src/workspace/git.ts)。

## 对话、关联和文件

每工单在 `issues/<key>/agent` 保存私有 Pi JSONL，在 `work` 保存跨轮次工作文件。关联目录提供元数据、已持久化对话及可用的开发提交快照，不把另一个工单的未提交工作区当作快照。

附件上传先暂存并计算 hash，持久化后为 `0400` regular file。新增、删除属于 Issue 创建/编辑事务；删除先 quarantine，失败恢复，提交后 finalize。读取检查路径、类型、size/hash。粘贴到 Agent 的图片进入 Pi 消息，不进入附件表。

成果以普通代码生成，再由 [output 工具](../src/agent/output-tool.ts)发布 work 目录中的 regular file。发布使用临时文件和原子替换，取消或失败保留旧交付；工作源文件继续保留。MySQL/DMS 可直接导出完整结果，完成连接收尾后才原子发布；Excel parser 服务于预览，不拥有脚本执行流程。

## Agent 与执行模型

[engine.ts](../src/agent/engine.ts) 拥有每工单排队、活动计数、预约和业务状态；[pi-session.ts](../src/agent/pi-session.ts) 负责 Pi 会话、工具选择、模型运行时和资源生命周期。失败清理位于同一串行任务内，下一项工作等待会话关闭和失败状态回写；排队消息执行时检查捕获的会话是否仍有效，失效后重新打开。

所有工单获得 Pi 原生 `read/bash/edit/write/grep/find/ls`，cwd 为私有 work。模型通过 prompt 中的受管绝对路径访问代码；Bash 保留当前 Git 身份、项目 wrapper PATH 和应用库路径。`service_query` 负责已配置的原生集成，`workspace` 管理代码集合，正式数据处理额外获得 `output`。全局外部 MCP 通过 [Pi 官方扩展适配](../src/mcp/pi-extension.ts)注册独立工具和 resources，由 SDK 管理发现、连接、重连和关闭；数据库与必要的传输、凭证及预算边界由应用持有。

这是单应用容器内的可信代码执行。原生代码拥有应用用户权限，可以绕过业务文件策略，不能据 cwd、Source API 或 QuickJS 宣称工单间 OS 隔离。项目命令 broker 仍维护自己的命令授权边界；HTTP 客户端断开取消对应命令，排队任务在开始执行前再次检查取消。

全局基座持有唯一模型、思考级别、Codemode 模式和 Pi settings。应用显式加载资源目录中的 Skills、Prompts、扩展和附加指令；SDK 负责命令展开、嵌套工具调用、取消及会话格式。模式、配置归属与凭证规则见[配置](CONFIGURATION.md)。

## 事件与前端状态

SSE 顺序为 JSONL 回放、当前未持久增量、`snapshot_ready`、缓冲/实时事件和心跳。订阅后立即登记关闭清理，在首个数据库等待前一起读取持久回放、使用量与当前增量，避免重叠累计。已进入快照的独立 usage 记录按 Pi entry ID 去重。

写入器维护 FIFO：底层 response.write 返回 false 时等待 drain，close/error 共用清理，移除监听并丢弃待发帧。模型响应超时跟随 assistant 生命周期，工具执行期间暂停；其他消息的结束不误清等待计时。

[agent-stream.ts](../src/web/src/app/agent-stream.ts) 管理 EventSource、generation 和重连，[conversation.ts](../src/web/src/app/conversation.ts) 投影会话。[ApplicationResources.tsx](../src/web/src/app/ApplicationResources.tsx) 共享配置与用户，并持有 [基座编辑状态](../src/web/src/app/agent-configuration.ts)，使草稿、保存队列及错误跨页面保留；设置页负责显示和输入。Overview 唯一拥有首页请求和轮询，旧请求通过取消/generation 避免覆盖当前视图。

CodeBrowser 拥有树、搜索、Git 操作和面板布局；Monaco 使用公开 API 处理编辑、定位、撤销和 diff。Source API 对写入目标校验父目录，拒绝越界链接和 Git 控制路径；Git 文件参数按字面路径处理，重命名不覆盖自身或祖先/后代。SourceText/SourceDiff 创建并释放 model/editor，保存保留 SHA-256、草稿、CRLF 和冲突语义，不加载 VS Code 扩展宿主。

## 并发、启动与关闭

锁域保持独立：Agent 活动、Issue-set reservation、API configuration scope、lifecycle、每 Issue inspection，以及按 state root + URL hash 的 repository 操作。

```text
configuration read: scope queue -> SQLite read snapshot
service/Issue scope write: scope queue -> Issue reservation
release/reopen: lifecycle queue -> inspection queue -> Issue reservation
```

等待后的授权在相关协调入口重新检查。处理人、抄送人与附件的工单编辑遵循 scope queue → Issue reservation，避免与用户启停或凭证变更交错。配置快照显式使用 libSQL read transaction，避免普通读取占用写权限；不能用一个全局 mutex 替代所有锁。

启动迁移并验证结构，恢复中断状态，检查 unmanaged state、校验共享 checkout，再准备各 Issue runtime、模型目录和维护任务。恢复 SQL 与 schema 的 timestamp 列统一使用秒，不能写入毫秒值。异常目录、dirty checkout 和分支漂移保留并拒绝相应操作，不猜测修复。关闭 drain 维护与 Agent，随后关闭会话、模型 runtime、broker 和数据库，清理失败聚合报告。发布和恢复按[运维](RUNBOOK.md)执行。
