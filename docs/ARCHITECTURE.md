# 架构说明

本文定义 Issue Pilot 当前的事实所有权、状态模型、Git/runtime 生命周期、Agent 执行、并发和安全边界。字段和 capability 合同见[配置说明](CONFIGURATION.md)，运行拓扑见[部署说明](DEPLOYMENT.md)，修改方法见[开发指南](DEVELOPMENT.md)，生产操作见[运维手册](RUNBOOK.md)。

## 术语与事实源

| 术语 | 含义 |
| --- | --- |
| Issue | Agent、Pi session、Attachment 和代码上下文的隔离单位 |
| Service | 一组带稳定 ID、alias 和 URL 的 Repository |
| Deployment | Service 在一个 Environment 下的 branch 与 capability 配置，不是发布任务 |
| Global Agent Configuration | 所有 Service/Environment 共享的唯一 Pi provider/model/thinking level |
| Bare store | 按 Repository URL 共享的 Git object/ref store |
| Dev workspace | Active dev Issue 的可写 worktree 集合 |
| Immutable checkout | 按完整 commit 定址、可重建的 detached checkout |
| Runtime | `issues/<key>/runtime` 中的 Repository link 和可选 project wrapper |
| AgentSessionContext | model、capability 名称、标识与代码写权限的最小 session 上下文 |
| Capability | Agent 可调用的 Deployment-scoped 外部只读工具；Playwright 不属于 capability |

| 事实 | 唯一来源 |
| --- | --- |
| User、Issue、Service、Deployment、Repository、Workspace、Attachment、全局模型 | SQLite |
| Path、port、default、retention、runtime、limit | `issue-pilot.config.ts` |
| 业务 enum 和 predicate | `src/domain/contracts.ts` |
| Dev 最终代码 | Bare store 中的本地 working branch ref |
| Prod/test 代码 | 当前 Deployment base branch 的最新 fetched commit |
| Conversation | 每 Issue 的 Pi JSONL active branch |
| Attachment 内容 | Durable file；DB 保存 object key、size、SHA-256 |
| Runtime、wrapper | `src/workspace` 生成器 |
| Capability 配置、input schema、metadata | `src/capabilities/registry.ts` |
| Credential 字段/update 协议 | `src/configuration/contracts.ts` |

Runtime、checkout、页面状态和日志不能反向覆盖 durable 事实。

## 组件边界

```text
Browser
  -> TLS/auth proxy
  -> Application container
       Fastify routes + static Solid Web/Workbench
       SQLite/Drizzle
       AgentEngine -> PiSessionRuntime -> Pi JSONL
       IssueProjectManager -> WorktreeManager -> Git stores
       SourceBrowser -> bounded filesystem/rg/Git operations
       Pi customTools -> protocol clients / ProcessToolRuntime
       ProjectToolBroker -> ProcessToolRuntime
```

| Owner | 责任 |
| --- | --- |
| `src/http` | HTTP parsing、subject、reservation、transaction、SSE、static Web |
| `src/configuration` | Catalog/config projection、credential merge、全局模型 |
| `src/agent` | 每 Issue queue、reservation、state、Pi session、event、prompt |
| `src/pi` | Model runtime 和 Registry-driven custom tool 注册 |
| `src/workspace/project.ts` | Agent/cold-start/reopen 的代码与 runtime preparation |
| `src/workspace/git.ts` | Bare store、fetch、checkout、worktree、batch rollback、Repository lock |
| `src/workspace/state.ts` | Repository 分类、managed path、unmanaged/generated state 检查 |
| `src/workspace/runtime.ts` | Runtime 原子生成 |
| `src/workspace/source-browser.ts` | Source 授权、有界读取和 dev 文件/Git mutation |
| `src/workspace/project-tools.ts` | Unix socket、SQLite 重新授权、Node/Maven action |
| `src/workspace/lifecycle.ts` | 深检、stats、release、reopen、maintenance |
| `src/capabilities/registry.ts` | Save parser、Pi input schema、tool metadata |
| Capability clients | 外部 target、协议、timeout、abort、response、result contract |
| `src/process.ts` | 通用 spawn、abort、timeout、output budget |
| `src/tool-runtime.ts` | `npm`、`mvn`、`aliyun sls` command/environment allowlist |
| `src/serial.ts` | Promise serial primitive；不拥有业务锁域 |

Route 不实现 Git 或外部协议；AgentEngine 不拼 Deployment Repository join；外部 `unknown` 在 HTTP、Registry、TypeBox 或 protocol response 边界解析，内部调用保持 typed。

## 数据模型

当前 SQLite 表：

```text
subjects
environments
services
global_agent_configuration
service_deployments
service_repositories
service_deployment_repositories
issues
issue_cc_recipients
issue_repositories
issue_attachments
issue_comments
issue_pilot_sessions
issue_workspaces
```

核心关系：

- Service/Environment 至多一个 Deployment。
- Deployment 必须覆盖 Service 当前所有 Repository，顺序由 join rows 持久化。
- 每张 Issue 必须引用有效 Service/Environment Deployment，并恰有一条 Workspace row。
- `global_agent_configuration.id` 固定为 `1`。
- `status = resolved` 与 `resolved_at IS NOT NULL` 必须等价。
- Pi conversation 不进入 message table，继续由 JSONL 持有。

## Issue 与 Workspace 状态

### Issue

```text
create -> open -> in_progress -> pending -> resolved
           ^          |            |
           +-- fail --+            +-- retry/metadata round
resolved --reopen--> open
```

- 创建成功后为 `open` 并入队。
- Agent 开始时为 `in_progress`，成功后为 `pending`。
- 未 resolved 的失败轮次回到 `open`。
- 用户只执行 `pending -> resolved` 或 `resolved -> open`。
- Resolved Issue 不能 retry 或接收 Agent message。

### Workspace

| 状态 | 含义 |
| --- | --- |
| `not_created` | 尚未准备代码/session |
| `preparing` | 正在准备 Repository、runtime 或 session |
| `running` | Pi 轮次执行中 |
| `ready` | 当前轮次完成 |
| `stopped` | Dev worktree 已 release，snapshot 可读 |
| `failed` | 准备或执行失败，可按规则 retry |

`runtime_ready` 只记录受管 runtime 已生成，读取 Source 前仍要验证物理目录和 Repository state。

## Repository 三态

`classifyRepositoryState()`按整组 `issue_repositories` 判断：

| 状态 | `local_path` | `working_branch` | 场景 |
| --- | --- | --- | --- |
| `read_only` | 全 NULL | 全 NULL | Prod/test |
| `development_workspace` | 全非 NULL | 全非 NULL | Active dev |
| `development_snapshot` | 全 NULL | 全非 NULL | Released dev |
| `invalid` | 空组、mixed 或其他 | 任意 | Fail closed |

Dev `workspace_name` 是稳定历史。Active 时必须等于 `local_path` basename；release 只清空 `local_path`，不改 working branch 或 workspace name。

## Git 布局

```text
.issue-pilot/git/
  repositories/<url-hash>/
  checkouts/<url-hash>/<40-char-commit>/
.issue-pilot/workspaces/<issue-key>/<workspace-name>/
```

Repository URL 使用 SHA-256 前 20 字符。Bare store 保存 remote tracking refs、本地 Issue branches、objects 和 worktree metadata。Immutable checkout 可跨 Issue 复用，但每次使用前必须验证目录层级、common dir、HEAD 和 clean status；异常返回稳定错误并保留现场。

### Prod/test

每轮重新读取当前 Service/Environment Deployment：

1. 验证每个 Service Repository 恰有一个 base branch。
2. Fetch `origin/<baseBranch>`。
3. 创建或复用 commit checkout。
4. 原子写 `read_only` Repository rows 和 current commit。
5. 生成只读 runtime。
6. 从当前 Deployment capability 和全局模型创建 session。

Prod/test Issue 可在编辑事务中切换到另一 prod/test scope。切换关闭旧内存 session，保留 JSONL、Attachment 和 Comment，清空旧只读 Repository 投影并使 runtime 失效。Dev scope 只能通过专用转换/reopen 流程改变。

### Active dev

- `defect_fix` 使用 `hotfix-<issue-key>`。
- `feature_development` 使用 `feature-<issue-key>`。
- 首次 Repository 从 Deployment branch 创建本地 branch 和专属 worktree。
- Existing Repository 保留 Issue row 中的历史 `base_branch` 与 `workspace_name`。
- Service 新增 Repository 在后续 prepare 中加入；删除前相关 worktree 必须 clean。
- 完整集合先 prepare，再 finalize filesystem 和 DB；失败按 batch rollback 恢复。

Prod/test `smart_analysis` 在满足 idle、ready、read-only 等条件时可通过专用动作转换为 dev `defect_fix`。转换保留 Attachment、Comment 和 Pi JSONL。

### Released dev

只有 resolved、idle、布局完整且 clean 的 dev workspace 可 release：

1. 深检 DB、root 和 Git。
2. 预检全部 Repository。
3. 受管移除 worktree。
4. 中途失败时从本地 branch 原 commit 恢复已删除 worktree。
5. 全部成功后清空 `local_path`，Workspace 变为 `stopped`。
6. 从本地 working branch tip 生成 immutable checkout 和只读 runtime。

Reopen 从全部本地 working branch 准备 worktree/runtime，再事务更新 Repository、Workspace 和 Issue。系统不从 remote Issue branch fallback。

## Runtime、Source 与项目工具

```text
issues/<issue-key>/runtime/
  <workspace-name> -> active worktree or immutable checkout
  bin/              # 仅 writable dev
    node-project
    maven-project
```

Runtime 使用 temporary + previous 目录原子替换，不包含 Attachment。Wrapper 通过 versioned Unix socket 只发送 Issue key、workspace name、relative project、action 和 args。Broker 从 SQLite 重新验证 Issue、Repository、真实 project path、配置文件和 cache 权限。

Source Browser：

- 只接受 Repository alias 和 relative path。
- 拒绝 absolute、`..`、symlink escape、`.git` tree item、binary 和超限内容。
- Search 使用 literal `rg --json`。
- History/commit 必须位于 current HEAD ancestry。
- Prod/test 和 released snapshot 只读。
- Active dev 可创建、保存、删除、重命名文件/目录，并 Stage、Unstage、Discard、Commit。
- 保存既有文件携带读取时 SHA-256，使用原子替换避免覆盖并发修改。

Workbench 使用 access-aware virtual filesystem 和固定 LocalProcess extension。Markdown Preview 直接使用 `marked + DOMPurify + github-markdown-css`，不依赖 extension-host render command。Iframe 通过显式 `ready/error/layout` 消息区分启动结果与布局；Terminal、Node extension host、gallery 和任意宿主命令不可用。

## Agent 与 Pi

一次轮次：

1. Workspace 设为 `preparing`。
2. 读取 Issue、Service、Environment、Deployment 和全局模型。
3. 关闭旧内存 session。
4. 准备代码和 runtime。
5. 从实际 access 与 typed Deployment config 生成最小 `AgentSessionContext`。
6. 打开现有 Pi JSONL 或原子创建 `0600` session file。
7. 用 Pi SDK `customTools` 创建 session，并核对 model、thinking level、tool 集。
8. 持久化 session binding。
9. 事务设置 Issue `in_progress`、Workspace `running`。
10. 记录 visible user message 并执行 prompt。
11. 成功转 `pending/ready`；失败 abort/dispose 并转 `open/failed`。

Resource loader 禁用 extension、skill、prompt template、theme、context file 和宿主 prompt 自动发现。Issue Pilot 显式提供 system prompt、model 和 tools。

Model output idle watchdog 只在等待模型输出时计时；assistant 增量重置计时，tool 执行暂停计时。超时以 `model_response_idle_timeout` 进入可重试失败状态。

`AgentSessionContext` 只包含：

- `issueKey`、`serviceKey`、`environmentKey`
- provider、model ID、thinking level
- capability names
- `canModifyCode`

它不包含 credential、完整 Deployment config、Repository path 或 commit。Writable context 获得 `read/bash/edit/write/grep/find/ls`；其他 context 只有 `read/grep/find/ls`。

Capability 调用：

```text
Service save -> Registry parse -> typed Deployment config -> SQLite
Pi customTool -> TypeBox input parse -> session-local typed protocol client
```

DMS 只注册单一 `dms` 工具，runtime 只匹配远端唯一的 `executeScript`，强制注入 Deployment DatabaseId，并验证单条只读 SQL。`listInstances/getDatabase` 只用于受信配置解析。DMS argument/result 不设置应用层 byte limit；其余 capability 按各自 budget 完整失败，不静默截断。

## Attachment 事务

唯一 durable 文件：

```text
issues/<issue-key>/attachments/<uuid>-<basename>
```

Create 先应用 multipart budget、计算 SHA-256、独占 claim 空 Issue root、以 `0400` 写文件，再在一个 transaction 中写 Issue/Workspace/CC/Attachment。失败只删除本次文件，并以 `rmdir` 回收本次空目录。

Edit 先把待删除文件 rename 到 `.deleting` quarantine，写入新文件，再 transaction 更新 metadata/CC/Attachment；rollback 恢复 quarantine 并删除新文件，commit 后 finalize 删除 quarantine。GET 验证直属路径、regular file、mode、size 和 SHA-256。不存在独立 Attachment write route。

## SSE 与 Web 状态

```text
Pi JSONL replay
  -> current non-durable run replay
  -> snapshot_ready
  -> buffered/live events
  -> heartbeat
```

Server 先订阅 live bus，再读取 snapshot。Event bus 只保留当前进程中尚未被 JSONL 接管的 assistant 增量、运行中 tool、queue 和 `agent_start`；完成后释放，API 重启不恢复。Snapshot 期间的新 event 进入连接私有 buffer，并按 event ID 去重。

Ordered writer 按顺序处理 backpressure、close 和 error；当前不设置 pending-byte 截断。Web controller 用 generation 失效旧 EventSource/timer，在 `snapshot_ready` 前保存 private replay，随后原子提交；静默超过配置窗口会重连。

首页 `OverviewView` 唯一拥有 Issue 请求、轮询、取消和 latest-wins 状态，`Dashboard` 与 `Statistics` 只消费同一份摘要。配置资源由 `ApplicationResources` 统一管理。

## 并发

| Lock domain | 粒度 |
| --- | --- |
| Agent run/steer | Issue ID |
| Issue reservation | Issue set |
| Configuration scope | API instance |
| Lifecycle | API instance |
| Inspection | Issue ID |
| Repository operation | state root + URL hash |

固定顺序：

```text
configuration read: scope -> SQLite snapshot
Service/Issue scope write: scope -> reservation
release/reopen: lifecycle -> inspection -> reservation
```

`SerialQueue`/`KeyedSerialQueue`只复用 mechanics，不能合并不同业务锁域。

## 启动与关闭

启动顺序：

1. 创建/打开 `0600` SQLite，设置 WAL/busy timeout，执行 migration。
2. 验证 Workspace 和 resolution 结构，首次插入 bootstrap user，同步 Environment。
3. 收敛中断状态并拒绝 unmanaged Issue/workspace。
4. 验证和受管清理 generated checkout/runtime。
5. 启动 `0600` project-tool socket。
6. 重建 active/released dev runtime 和已有 session 的 read-only runtime。
7. 确保全局模型行存在。
8. 执行一次 maintenance，注册 route，启动 timer。

关闭会停止并 drain maintenance/lifecycle/inspection，拒绝新 Agent activity 并 drain reservation，停止 sessions，关闭 model runtime 和 project broker，最后关闭 SQLite。Cleanup 会全部尝试，多个错误聚合为稳定失败。

## Durable 与 generated 数据

| 数据 | 类型 | 自动处理 |
| --- | --- | --- |
| SQLite/WAL/SHM | Durable | 不自动删除 |
| Attachment | Durable | 只随 Issue edit transaction 删除 |
| Pi JSONL | Durable | 不随 workspace 删除 |
| Bare store/local branch | Durable | 不作为 cache 清理 |
| Active dev worktree | Conditionally durable | 仅受管 release |
| Runtime/socket | Generated | 启动/prepare 重建 |
| Immutable checkout | Generated | 验证后受管重建 |
| Backup/legacy evidence | Operator-owned | 人工管理 |

DB 不存在但 `issues/<key>` 或 `workspaces/<key>` 存在时为 `unmanaged_issue_state`；启动在清理生成物前失败。

## 安全边界

- API 没有内置认证；所有入口必须置于可信 TLS/auth/authorization proxy 后。
- `X-Issue-Pilot-Subject` 只选择 active user 和提交署名，不是身份认证。
- Config GET 有意返回完整 Deployment credential 给受信配置 UI；不得记录响应或 request body。
- Credential 不进入 Agent context、prompt、tool schema/input、argv、日志、监控或诊断。
- DMS Bearer 只进入 SQLite、受信配置流和 session-local HTTPS Authorization header。
- SLS AccessKey 写入调用级临时 `0600` profile；query/scope 可能出现在 process argv。
- Capability result 会进入模型上下文与 Pi JSONL，可能包含敏感业务数据。
- Workbench 和 Source API 返回内部源码，dev mutation 会直接修改 Issue worktree。
- Pi built-in tools 和项目脚本不是 OS sandbox。

## 必须保持的不变量

1. Issue key 是 `ISSUE-YYYYMMDD-NNN...`。
2. 每 Issue 恰有 Workspace row，`resolved/resolved_at` 成对。
3. 每个 Issue scope 有对应 Deployment。
4. 全局模型唯一，Deployment 不含模型覆盖。
5. Prod/test、active dev、released dev 分别对应三种合法 Repository state。
6. Released dev 只从本地 working branch 恢复。
7. Existing dev `base_branch` 和 `workspace_name` 是历史。
8. Unsafe/unknown filesystem 和 Git state 显式失败并保留。
9. Attachment 只有一个 `0400` durable 副本，写入只属于 Issue create/edit。
10. Runtime 和 checkout 不成为 durable 事实源。
11. Repository 集合变化先 prepare filesystem，再 commit DB，并可 rollback。
12. Credential 只存在于明确授权的数据流中。
13. Pi tool input 只解析一次；DMS Agent 只可调用 `executeScript`。
14. 所有 state owner 使用同一 state root。
15. Published migration/journal 不修改、重排或删除。
16. SQLite User 是唯一用户事实源，且至少保留一名 active user。
