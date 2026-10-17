# 架构说明

本文定义 Issue Pilot 当前的事实所有权、状态模型、Git/runtime 生命周期、Agent 执行、并发和安全边界。字段和 capability 合同见[配置说明](CONFIGURATION.md)，运行拓扑见[部署说明](DEPLOYMENT.md)，修改方法见[开发指南](DEVELOPMENT.md)，生产操作见[运维手册](RUNBOOK.md)。

## 术语与事实源

| 术语 | 含义 |
| --- | --- |
| Issue | Agent、Pi session、Attachment 和代码上下文的隔离单位 |
| Issue Work Mode | 新建边界使用的处理方式；唯一映射到 Environment、Issue type 和代码权限，不单独持久化 |
| Service | 问题发现/归属标签与 Repository 配置集合；不构成同环境资源访问边界 |
| Deployment | Service 在一个 Environment 下的 branch 与 capability 配置，不是发布任务 |
| Global Agent Configuration | 所有 Service/Environment 共享的唯一 Pi provider/model/thinking level |
| Bare store | 按 Repository URL 共享的 Git object/ref store |
| Dev workspace | Active dev Issue 的可写 worktree 集合 |
| Immutable checkout | 按完整 commit 定址、可重建的 detached checkout |
| Runtime | `issues/<key>/runtime` 中的 Repository link 和可选 project wrapper |
| AgentSessionContext | model、capability 名称、标识与代码写权限的最小 session 上下文 |
| Capability | 由 service_query 调用的服务/环境协议适配器；Playwright 不属于 capability |

| 事实 | 唯一来源 |
| --- | --- |
| User、Issue、Service、Deployment、Repository、Workspace、Attachment、全局模型 | SQLite |
| Path、port、default、retention、runtime、limit | `issue-pilot.config.ts` |
| 业务 enum 和 predicate | `src/domain/contracts.ts` |
| Dev 最终代码 | Bare store 中的本地 working branch ref |
| Prod/test 代码 | 当前 Deployment base branch 的最新 fetched commit |
| Conversation | 每 Issue 的 Pi JSONL active branch |
| Attachment 内容 | Durable file；DB 保存 object key、size、SHA-256 |
| 正式数据处理成果文件 | 每 Issue `outputs/` 受管文件树 |
| Runtime、wrapper | `src/workspace` 生成器 |
| Capability 配置/input schema | `src/capabilities/registry.ts` |
| 统一查询 tool metadata/dispatch | `src/pi/tools.ts` |
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
| `src/workspace/scope-transition.ts` | Issue scope plan/hash、支持矩阵与 apply 协调 |
| `src/capabilities/registry.ts` | Save parser、Pi input schema |
| Capability clients | 外部 target、协议、timeout、abort、response、result contract |
| `src/process.ts` | 通用 spawn、abort、timeout、output budget |
| `src/tool-runtime.ts` | 项目 npm/mvn command/environment allowlist |
| `src/serial.ts` | Promise serial primitive；不拥有业务锁域 |

Route 不实现 Git 或外部协议；AgentEngine 不拼 Deployment Repository join；外部 `unknown` 在 HTTP、Registry、TypeBox 或 protocol response 边界解析，内部调用保持 typed。

## 数据模型

当前 SQLite 表：

```text
subjects
user_credentials
environments
services
repositories
capability_switches
mcp_services
issue_service_scopes
global_agent_configuration
service_deployments
service_repositories
service_deployment_repositories
issues
issue_cc_recipients
issue_relations
issue_pins
issue_scope_transitions
issue_repositories
issue_attachments
issue_comments
issue_pilot_sessions
issue_workspaces
```

核心关系：

- 全局能力总开关存于 `capability_switches`，自定义 MCP 配置存于 `mcp_services`；权限、协议和凭证合同见[配置说明](CONFIGURATION.md#统一能力配置)。应用显式发现并注册远程工具，不加载宿主 MCP 配置。
- `repositories` 是统一仓库名称与地址目录；Service Repository URL 外键引用目录，改址级联同步服务配置，Issue Repository URL 保持历史。维护合同见[配置说明](CONFIGURATION.md#repository)。
- Service/Environment 至多一个 Deployment。
- Deployment 必须覆盖 Service 当前所有 Repository，顺序由 join rows 持久化。
- 每张 Issue 必须引用有效 Service/Environment Deployment，并恰有一条 Workspace row。
- 新建请求只接受 `workMode + serviceKey`；Domain 映射原子生成 Environment/type，`issues` 当前字段仍是唯一事实源。
- 普通 Issue edit 只修改 metadata、CC 和 Attachment，拒绝 Service、Environment、type、work mode 与关联关系字段。
- `issue_relations` 保存所有类型工单选择的关联工单；目标可来自任意 Environment/type，同一目标不重复且不能关联自身，创建后只能通过专用关联接口替换。
- `issue_pins` 保存用户级个人队列固定项；固定只影响该用户的左侧排序，不改变 Issue 本身或团队动态。
- `issue_scope_transitions` 是成功 Scope Apply 的 append-only 轻量审计，保存操作者、前后 Service/work mode、plan hash 和 Repository URL 差异；当前 `issues` 字段仍是 Scope 唯一事实源。
- `user_credentials` 按 User 保存个人 provider API Key 与 Git 凭证，role 与凭证 owner 合同见[配置说明](CONFIGURATION.md#user)；全局配置仍唯一拥有 provider/model/thinking level。
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

普通 edit 不改变 Issue scope，因此不会重绑 Deployment、删除 Repository 投影或重建 runtime。Scope 变更统一使用无状态的 plan/apply：plan 返回当前 `updatedAt`、Repository 差集和 SHA-256，apply 在 scope queue 与 Issue reservation 内重新计算并拒绝 stale plan。当前支持 prod/test read-only 之间重绑、同 Service 的 `smart_analysis -> development_fix`，以及保持 branch mode 的 active dev 跨 Service 迁移；其他转换显式拒绝，不由 metadata API 隐式执行。Scope 转换保留关联关系。成功 mutation 与 `issue_scope_transitions` 审计在同一 SQLite transaction 提交；no-op、stale、拒绝和失败不会写 history。

所有 work mode 的新建工单均可选择最多 20 个其他工单，目标可来自任意 Environment/type。创建在 scope queue 内同时 reservation 新工单与全部关联工单，关联关系写入同一 SQLite transaction。关联上下文始终生成只读 `issue.json`；存在受管 Pi session 时附带 `conversation.jsonl`，仅当目标是开发工单且拥有有效本地 working branch 时，才从该 ref 创建 immutable Repository snapshot。缺少 session 或开发 branch 不阻止关联。

所有类型未 resolved、runtime ready 的工单均可通过专用 `PUT /api/issues/:key/related-issues` 替换关联集合。更新遵循 scope queue → 目标/旧关联/新关联 Issue reservation，并拒绝关联自身；集合未变化时幂等返回。实际变化先关闭当前 session，再在一个 transaction 中按差集更新关系、将 runtime 标记为待重建并更新 Issue version，随后重新入队。这样下一轮 Agent 只会看到新集合；变更关系时运行中的任一相关 Issue 会由 reservation 明确阻止。

### Active dev

- `defect_fix` 使用 `hotfix-<issue-key>`。
- `feature_development` 使用 `feature-<issue-key>`。
- 首次 Repository 从 Deployment branch 创建本地 branch 和专属 worktree。
- Existing Repository 保留 Issue row 中的历史 `base_branch` 与 `workspace_name`。
- Service 新增 Repository 在后续 prepare 中加入；删除前相关 worktree 必须 clean。
- dev 跨 Service 按 Repository URL 求差集：retained 保留 worktree、历史 base branch、staged/untracked 修改和 working branch；added 创建同一 Issue branch；removed 必须 clean。
- Dev 工单不原地转 prod/test；详情中的“创建正式跟进”复用标准 `production_analysis` 创建事务，并把当前 dev 工单作为 related Issue。新工单读取已提交 branch snapshot 和 Pi 对话，不复制附件或可写 worktree。
- 完整集合先 prepare，再生成目标 runtime，最后以 worktree remove batch 包裹 DB finalize；任一步失败都恢复旧 worktree、runtime 和数据库范围。

Prod/test `smart_analysis` 在满足 idle、ready、read-only 等条件时可通过统一 Scope Transition 转换为同 Service dev `defect_fix`。转换保留 Attachment、Comment 和 Pi JSONL，旧 `/development` 特殊路由不存在。

### 跨服务代码集合

Agent 的 `workspace list/include/remove` 按当前 Environment 发现并加入其他服务代码，`issue_service_scopes` 保存附加服务意图。Repository 集合按 URL 去重；同一 URL 配置了不同 base branch 时显式拒绝。Existing dev 的历史 branch、base_branch、workspace_name 和未提交修改仍由原 owner 保留，移除代码必须通过 clean 检查。附加服务意图先持久化并将 runtime 标为待重建，再调用既有 project prepare；失败时保留 refs、rows 和文件，重复操作或下一轮可重试，不能把 runtimeReady=false 当作已准备完成。Issue 入口服务仍保留其发现/归属含义。

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
  related-issues/   # 关联工单的只读调查上下文
    <related-key>/
      issue.json
      conversation.jsonl -> 可选；存在受管 Pi JSONL 时生成
      repositories/<workspace-name> -> 可选；local development branch immutable checkout
  bin/              # 仅 writable dev
    node-project
    maven-project
```

`production_data` 的成果文件位于 `issues/<issue-key>/outputs/`，不属于 generated runtime；retry、Scope 重建和冷启动不会删除。Agent 可通过专用 `output` tool 或授权的 `sandbox export_output` 原子发布；其 `spreadsheet` operation 复用 Pi CodemodeSandbox 的工作线程/QuickJS，处理本工单授权 Excel 附件并生成 XLSX，也可读取本工单成果文件或接收结构化数据，不提供宿主执行或任意文件访问；DMS 可直接将完整查询结果保存到同一成果区，模型只接收摘要。HTTP 只提供列出和 attachment-style 下载，不能写入。Repository snapshot 仍保持只读。

Runtime 使用 temporary + previous 目录原子替换，不包含 Attachment 或成果文件。每个关联目标始终有 `issue.json`；关联开发代码只从 bare store 的本地 working branch ref 创建 immutable checkout，不挂载可写 worktree，因此不包含未提交修改；无开发 branch 时 Repository 目录保持为空。存在受管 Pi session 时，关联对话链接到该 Issue session root 下的当前 Pi JSONL；不存在时不生成链接。每轮 prepare 和 API 冷启动会重建这些资源。开发工单保持 writable workspace root 原布局，关联资源位于其独立 runtime；Agent prompt 提供完整 related-issues 路径。Wrapper 通过 versioned Unix socket 只发送 Issue key、workspace name、relative project、action 和 args。Broker 从 SQLite 重新验证 Issue、Repository、真实 project path、配置文件和 cache 权限。

Source Browser：

- 只接受 Repository alias 和 relative path。
- 拒绝 absolute、`..`、symlink escape、`.git` tree item 和 binary；源码文件本身不设应用层大小限制。
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
5. 从实际 access 与 typed Deployment config 生成最小 `AgentSessionContext`；若有关系，生成关联工单只读 metadata/branch/conversation 上下文。
6. 打开现有 Pi JSONL 或原子创建 `0600` session file。
7. 用 Pi SDK `customTools` 创建 session，并核对 model、thinking level、tool 集。
8. 持久化 session binding。
9. 事务设置 Issue `in_progress`、Workspace `running`。
10. 记录 visible user message（含可选 Pi image content）并执行 prompt。
11. 成功转 `pending/ready`；失败 abort/dispose 并转 `open/failed`。

Resource loader 禁用 extension、skill、prompt template、theme、context file 和宿主 prompt 自动发现。Issue Pilot 显式提供 system prompt、model 和 tools。`src/agent/karpathy-guidelines.ts` 内置 multica-ai/andrej-karpathy-skills 的 Karpathy Guidelines（来源与固定 commit 在代码注释中），由 `agentSystemPrompt()` 默认加入所有工单 Agent；不依赖宿主全局 skill、不开放额外工具，权限策略仍由应用校验。

Model output idle watchdog 只在等待模型输出时计时；assistant 增量重置计时，tool 执行暂停计时。超时以 `model_response_idle_timeout` 进入可重试失败状态。

`AgentSessionContext` 只包含：

- `issueKey`、`serviceKey`、`environmentKey`
- provider、model ID、thinking level
- capability names
- `canModifyCode`
- `canWriteOutputs`

它不包含 credential、完整 Deployment config、Repository path 或 commit。所有 context 额外获得 `sandbox` 离线分析工具；它在独立容器内开放临时写入，不改变 Repository access。只有 `canWriteOutputs` 的 context 可按本工单成果名称导入/原子导出文件，生命周期、部署前提和验证合同见[工单分析沙盒](SANDBOX.md)。Writable dev context 仍获得 `read/bash/edit/write/grep/find/ls`；普通只读 context 获得 `read/grep/find/ls`；`prod + data_processing` 额外获得 `output` tool。SDK codemode 由根配置显式选择，默认关闭。

Capability 调用：

```text
Service save -> Registry parse -> typed Deployment config -> SQLite
Pi customTool -> TypeBox input parse -> session-local typed protocol client
```

所有业务查询统一通过 service_query，显式选择 environment/service/capability；协议适配器继续执行 exact target、只读、预算和取消校验。prod/test 工单只访问本环境，开发工单继承 prod/test 服务能力并保持来源只读。代码 include/remove 仍限工单代码环境。服务描述把手写业务知识与自动生成的各环境公开能力参数合并，仓库/分支在页面矩阵或工具 repositories 中单独返回，页面和 AI 共用同一生成器。DMS/SLS 目标属于 Deployment，DMS/SLS 认证直接保存在部署，个人生产凭证按 owner 优先覆盖；详细合同见[配置说明](CONFIGURATION.md#统一能力配置)。

## Attachment 事务

唯一 durable 文件：

```text
issues/<issue-key>/attachments/<uuid>-<basename>
```

Attachment 不设应用层文件大小、request 总量或数量上限。Multipart 文件边接收边写入进程临时目录并计算 SHA-256，不在内存中聚合；临时文件不是 Attachment object，无论成功或失败都会清理。

Create 独占 claim 空 Issue root，在 transaction 中把 staged 文件复制为 `0400` durable 文件并写 Issue/Workspace/CC/Attachment。失败只删除本次 durable 文件，并以 `rmdir` 回收本次空目录。

Edit 先把待删除文件 rename 到 `.deleting` quarantine，在 transaction 中复制 staged 文件并更新 metadata/CC/Attachment；rollback 恢复 quarantine 并删除新 durable 文件，commit 后 finalize 删除 quarantine。GET 验证直属路径、regular file、mode、size 和 SHA-256。不存在独立 Attachment write route。

## SSE 与 Web 状态

```text
Pi JSONL replay（含用户消息中的 text/image content）
  -> current non-durable run replay
  -> snapshot_ready
  -> buffered/live events
  -> heartbeat
```

Server 先订阅 live bus，再读取 snapshot。Event bus 只保留当前进程中尚未被 JSONL 接管的 assistant 增量、运行中 tool、queue 和 `agent_start`；完成后释放，API 重启不恢复。Snapshot 期间的新 event 进入连接私有 buffer，并按 event ID 去重。

Ordered writer 按顺序处理 backpressure、close 和 error；当前不设置 pending-byte 截断。Web controller 用 generation 失效旧 EventSource/timer，在 `snapshot_ready` 前保存 private replay，随后原子提交；静默超过配置窗口会重连。

首页 `OverviewView` 唯一拥有 Issue 请求、轮询、取消和 latest-wins 状态，`Dashboard` 与 `Statistics` 只消费同一份摘要。配置资源由 `ApplicationResources` 统一管理。

## MCP 工单客户端

src/mcp/server.ts 面向本地外部 AI，仅暴露发现服务/用户、搜索/读取/创建工单、发送消息、读取对话/附件/成果。issue_create 和 issue_message 通过 Fastify inject 复用原 HTTP owner，使用连接的 subject，不直接写 DB 或操纵 Agent；创建和发消息的结果不是处理完成。工具注解区分只读和写入，配置端点列表复用相同定义。对话合并 active JSONL 与当前未持久事件，去重后分页；不暴露内部 prompt、配置或凭证。用户接入与边界见[配置说明](CONFIGURATION.md#外部-ai-工单接入mcp)。

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
- Config GET 只返回 Deployment 公开配置与 credentialConfigured，不返回已存 credential；编辑以 preserve/replace/clear 更新。按用户要求，开发角色可经独立 configuration-description 接口在配置页明文查看凭证；不进入 AI/MCP context 或 Markdown 缓存。不得记录配置响应、configuration write body 或明文。
- Credential 不进入 Agent context、prompt、tool schema/input、argv、日志、监控或诊断。
- Native MySQL 每个目标的独立密码只进入 SQLite、受信配置流和 session-local client；DMS Bearer 只进入 SQLite、受信配置流和 session-local HTTPS Authorization header。
- SLS AccessKey 只进入隔离 worker 内的官方签名 HTTPS SDK，不写 profile 或进入 argv。
- Capability result 和用户粘贴到 Agent composer 的图片会进入模型上下文与 Pi JSONL，可能包含敏感业务数据。
- Workbench 和 Source API 返回内部源码，dev mutation 会直接修改 Issue worktree。
- Pi built-in tools 和项目脚本不是 OS sandbox。

## 必须保持的不变量

1. Issue key 是 `ISSUE-YYYYMMDD-NNN...`。
2. 每 Issue 恰有 Workspace row，`resolved/resolved_at` 成对。
3. 每个 Issue scope 有对应 Deployment；创建的 work mode 必须唯一映射到合法 Environment/type。
4. 普通 Issue edit 不能修改 scope 或关联关系；关联集合只能通过专用接口在完整 reservation 下替换。
5. 全局模型唯一，Deployment 不含模型覆盖。
6. Prod/test、active dev、released dev 分别对应三种合法 Repository state。
7. Released dev 只从本地 working branch 恢复。
8. Existing dev `base_branch` 和 `workspace_name` 是历史。
9. Unsafe/unknown filesystem 和 Git state 显式失败并保留。
10. Attachment 只有一个 `0400` durable 副本，写入只属于 Issue create/edit。
11. Runtime 和 checkout 不成为 durable 事实源。
12. Repository 集合变化先 prepare filesystem，再 commit DB，并可 rollback。
13. Credential 只存在于明确授权的数据流中。
14. Pi tool input 只解析一次；service_query 只能访问已授权来源环境/服务的配置，开发工单可读取 prod/test 来源且仍只读；DMS 只可调用 executeScript。
15. 所有 state owner 使用同一 state root。
16. Published migration/journal 不修改、重排或删除。
17. SQLite User 是唯一用户事实源，且至少保留一名 active user。
18. 关联工单始终提供只读 metadata；conversation 按受管 session 可用性提供，开发代码只来自本地 working branch immutable checkout，所有关联证据对当前工单只读。
