# 架构说明

本文描述 Issue Pilot 当前代码的状态模型、数据所有权、Git/runtime 生命周期、Agent 执行、并发和安全边界。用户可配置字段见 [配置说明](CONFIGURATION.md)，安装与网络见 [部署说明](DEPLOYMENT.md)，代码入口见 [开发指南](DEVELOPMENT.md)，操作恢复见 [运维手册](RUNBOOK.md)。

## 核心术语

| 术语 | 当前含义 |
| --- | --- |
| Issue | 工单，也是 Agent、Pi session、附件和代码上下文的隔离单位 |
| Service | 一组带稳定 ID、唯一别名和 URL 的 Repository |
| Deployment | Service 在一个 Environment 下的 Repository 基线分支、Pi model 和 capability 配置；不是发布进程 |
| Repository | Service 使用的一个 Git remote |
| Bare repository | 按 Repository URL 共享的 Git object/ref store |
| Dev workspace | Active dev Issue 的可写 worktree 集合 |
| Immutable checkout | 按完整 commit 定址的 detached、只读、可重建 worktree |
| Runtime | `issues/<key>/runtime` 下供 Agent/code-server 使用的生成目录 |
| Session | 一张 Issue 对应的持久 Pi JSONL active branch |
| IssuePolicy | 每次 Pi session 冻结的 model、Repository 和无 credential capability scope |
| Capability | 受限的外部读取工具，例如 Nacos、MySQL、DMS、SLS 或 Playwright |

## 事实源

Issue Pilot 不把所有状态放在同一个介质中。每个事实只有一个权威来源：

| 事实 | 权威来源 |
| --- | --- |
| Issue、Service、Deployment、Workspace 和 Attachment 元数据 | SQLite |
| 应用路径、端口、默认值、retention 和上限 | `issue-pilot.config.ts` |
| 当前业务常量 | `src/domain/contracts.ts` |
| Dev Issue 工作结果 | Bare repository 中的本地 working branch ref |
| Prod/test 代码 | 当前 Deployment base branch 最新 fetched commit |
| 对话历史 | 每 Issue Pi JSONL active branch |
| Attachment 内容 | Durable file；数据库保存 object path、size 和 SHA-256 |
| Runtime、manifest、wrapper | `src/workspace` 的生成器 |
| Capability 保存 contract 和无 credential scope | `src/capabilities/registry.ts` |
| 配置中心脱敏 DTO 和 credential 更新状态 | `src/configuration/contracts.ts` |

生成物不能反向成为业务事实源。Runtime link、checkout 或页面状态都不能覆盖 SQLite、JSONL 或本地 Git ref。

## 组件与模块边界

```text
Browser / SolidJS
        |
Fastify routes ---- SQLite / Drizzle
        |
AgentEngine ---- PiSessionRuntime ---- Pi JSONL
        |
IssueProjectManager ---- WorktreeManager ---- Git stores
        |
IssuePolicy ---- Capability tools ---- Broker ---- Protocol clients
        |
code-server / Podman Playwright / local Aliyun CLI
```

| 模块 | 责任 |
| --- | --- |
| `src/http` | HTTP 边界、reservation、数据库事务和 SSE |
| `src/configuration` | 配置中心共享 DTO、credential 脱敏/合并、内容 revision，以及 snapshot projection |
| `src/agent` | 每 Issue Agent 队列、Pi session 生命周期、事件与 prompt |
| `src/pi` | Model catalog、冻结 policy、built-in/custom tool 授权 |
| `src/workspace/project.ts` | Issue 项目的 prepare、dev restore、read-only/dev runtime hydration |
| `src/workspace/git.ts` | Bare store、fetch、checkout、worktree、批量 prepare/remove/rollback |
| `src/workspace/runtime.ts` | 原子生成 multi-root runtime 和 manifest |
| `src/workspace/lifecycle.ts` | 深检、统计、release、reopen 和 retention/quota maintenance |
| `src/capabilities/registry.ts` | 配置解析、credential-free scope、tool schema 和 metadata |
| `src/capabilities/broker.ts` | Capability allowlist、输入解析和 handler dispatch |
| 各 capability client | 协议、scope、timeout、abort 和结果预算的最终校验 |
| `src/serial.ts` | 通用串行原语；不定义业务锁域 |
| `src/web/src/app/agent-stream.ts` | EventSource generation、replay、snapshot、重连和关闭状态机 |
| `src/web/src/app/conversation.ts` | Pi/Issue event 到可见对话的纯投影 |

Route 不实现 Git 或外部协议。AgentEngine 不拼 Deployment Repository join。Capability client 不信任 registry、tool schema 或 broker 已经完成检查。

## 业务状态

### Issue 状态

```text
open -> in_progress -> pending -> resolved
  ^         |             |          |
  |         +-- failure --+          +-- reopen -> open
  +-------------- retry / new message
```

- 新建 Issue 为 `open`，创建事务成功后立即入队。
- Agent 开始时从 `open` 或 `pending` 转为 `in_progress`。
- 成功结束转为 `pending`。
- 执行失败时未解决 Issue 回到 `open`。
- 用户只能手动执行 `pending -> resolved` 和 `resolved -> open`。
- Resolved Issue 不能接收 Agent 消息或 retry。
- `status = resolved` 当且仅当 `resolved_at` 非空；API 与 SQLite trigger 双重保证。

### Workspace 状态

| 状态 | 含义 |
| --- | --- |
| `not_created` | 尚未准备代码和 session |
| `preparing` | 正在准备 Repository、runtime、policy 或 session |
| `running` | Pi 正在处理当前轮次 |
| `ready` | 当前轮次完成，可以继续对话 |
| `stopped` | Dev worktree 已释放，保留只读 snapshot runtime |
| `failed` | 准备或执行失败，可以按规则 retry |

Issue 状态描述业务进度，Workspace 状态描述执行基础设施。每张 Issue 必须有且只有一条 `issue_workspaces` 行；缺失时启动和执行都明确失败。

## Repository 状态

`src/workspace/state.ts` 根据整组 `issue_repositories` 的 `local_path` 和 `working_branch` 进行分类：

| 状态 | `local_path` | `working_branch` | 用途 |
| --- | --- | --- | --- |
| `read_only` | 全部 `NULL` | 全部 `NULL` | Prod/test |
| `development_workspace` | 全部非空 | 全部非空 | Active dev |
| `development_snapshot` | 全部 `NULL` | 全部非空 | Released dev |
| `invalid` | 空列表、mixed 或其他组合 | 任意 | 停止并保留现场 |

Dev Repository 的 `workspace_name` 是稳定目录名。Active 状态下它必须与 `local_path` basename 一致；release 只清空 `local_path`，不会丢失工作分支或稳定名称。Reopen 和 Service Repository 集合变化不能重命名已有 worktree。

## Git 与代码生命周期

### 存储布局

```text
.issue-pilot/git/
  repositories/<url-hash>/
  checkouts/<url-hash>/<commit>/

.issue-pilot/workspaces/
  <issue-key>/<workspace-name>/
```

每个 Repository URL 映射到一个 20 字符 SHA-256 前缀目录。Bare store 保存 remote-tracking refs、本地 Issue branches、objects 和 worktree metadata。

Immutable checkout 按完整 40 字符 commit 定址，相同 URL/commit 可跨 Issue 复用。创建或启动清理前会验证：

- 目录名称和层级符合 hash/commit 格式。
- Checkout 属于相同 hash 的受管 bare store。
- `HEAD` 等于目录 commit。
- Modified、untracked 和 ignored 状态均为空。

异常返回 `shared_checkout_changed`，不会强制删除。

### Prod/test

每轮 Agent prepare：

1. `loadDeploymentRepositories()` 读取当前 Service/Environment Deployment。
2. 验证该 Deployment 对 Service 的每个 Repository 恰好有一个 `baseBranch`，没有缺失、额外或跨 Service 关联。
3. 分别 fetch 当前 `origin/<baseBranch>`。
4. 按最新 commit 创建或复用 immutable checkout。
5. 把 `issue_repositories` 原子更新为 `read_only` 状态和当前 commit。
6. 生成只读 runtime。

Prod/test policy 的 Repository path 指向 Issue runtime 中的只读 link，而不是暴露 shared checkout 的物理路径。Pi 轮次结束后内存 session 会关闭；下一轮重新读取当前 Deployment 和最新 commit。

### Active dev

Dev `defect_fix` 使用 `hotfix-<issue-key>`，`feature_development` 使用 `feature-<issue-key>`。首次加入 Issue 的 Repository 从当前 Deployment base branch 创建本地 working branch 和专属 worktree。

之后：

- 已有 Repository 继续使用 `issue_repositories.base_branch`，因为它是该 Issue 的历史基线。
- Service 新增到该 Issue 的 Repository 才使用当前 Deployment branch。
- 待移除 Repository 必须 clean；完整目标集合先 prepare，再在 finalize 中删除旧 worktree并提交数据库行。
- 任一步失败时，批量 Git 操作恢复已创建或已删除的 worktree，数据库继续保留原集合。

Writable dependencies 和构建输出都位于该 Issue worktree，不与其他 Issue 共享。

已完成的 prod `smart_analysis` 可以通过专用动作转为 dev `defect_fix`。转换要求 Issue 为 `pending`、Workspace 为 `ready` 且 Repository 为完整 `read_only` 状态；系统关闭内存 session，按 dev Deployment 创建 hotfix worktree和可写 runtime，再在一个数据库事务中切换 Environment、Issue type、Repository 和 Workspace rows，成功后基于原 Pi session 自动入队继续处理。失败会移除本次 worktree并恢复只读 runtime，且不会启动 Agent；Attachment、Comment 和 Pi JSONL始终沿用原 Issue。

### Released dev

只有 resolved、idle、完整布局且所有 Repository clean 的 dev workspace 可以 release：

1. 深检数据库状态、Issue 根目录和每个 Git worktree。
2. 预检全部 Repository。
3. 逐个执行受管 `git worktree remove`。
4. 若中途失败，从本地 working branch 的原 commit 恢复已删除 worktree。
5. 全部成功后清空 `local_path`，Workspace 标记为 `stopped`。
6. 从本地 `refs/heads/<workingBranch>` 创建 immutable checkout 和只读 runtime。

Released dev 的权威代码是本地 working branch，不是当前 Deployment branch，也不是远程同名 Issue branch。系统不提供远程 fallback。

Reopen 会从全部本地 working branches 先准备可写 worktree、runtime、wrapper 和 code-server，再在一个数据库事务中更新 Repository、Workspace 和 Issue 状态。失败清理只移除本次创建的受管 worktree和空根，并恢复只读 runtime；未知内容会导致显式失败。

## Runtime 与 code-server

每个已准备代码的 Issue 使用相同结构：

```text
issues/<issue-key>/runtime/
  <workspace-name> -> worktree 或 immutable checkout
  <issue-key>.code-workspace
  bin/
    node-project
    maven-project
```

`bin` 只存在于 writable dev runtime。Wrapper 先解析真实 project path，并要求它位于当前 Issue workspace，然后才运行有限的 Node/Maven action。

Runtime 在临时目录完整生成后原子替换。Manifest mode 为 `0400`；只读 runtime 还写入 VS Code `files.readonlyInclude`。附件不会复制或链接进 runtime。

所有 code-server URL 都指向：

```text
?workspace=/home/coder/state/issues/<issue-key>/runtime/<issue-key>.code-workspace
```

一个共享 code-server 容器服务所有 Issue。容器中的 `issues` 和 `git/checkouts` 为只读 mount，`workspaces` 为读写 mount，bare repository 为读写 mount以支持 Git index/worktree metadata。

## Issue 项目准备

`IssueProjectManager` 是项目准备的单一协调者：

- `prepare()`：Agent 轮次使用，解析 Deployment、准备 Git、更新 Repository 行、生成 runtime/wrapper，并尝试 ensure code-server。
- `hydrateDevelopmentRuntime()`：API 冷启动重建 active/released dev runtime。
- `hydrateReadOnlyRuntime()`：冷启动为已有 session 的 prod/test Issue fetch 当前基线并在 code-server 成功后提交 Repository/workspace 行。
- `restoreDevelopmentWorkspace()`：released dev reopen 的两阶段恢复与清理。

AgentEngine 只负责业务状态、session 和 prompt；Lifecycle 只负责 release/reopen policy；二者不再分别实现 Repository 准备。

## Agent 与 Pi session

一次 Agent 轮次的顺序是：

1. Workspace 标记为 `preparing`。
2. 读取 Issue、Service 和 Environment。
3. 关闭旧内存 session。
4. 通过 `IssueProjectManager` 准备项目。
5. 从实际 Repository path/commit/access 和 Deployment config 创建冻结 `IssuePolicy`。
6. 打开现有 Pi JSONL，或以 `0600` 原子创建新 session file。
7. 创建 Pi SDK session，并核对 session ID、model、thinking level 和 active tools。
8. 持久化 session binding。
9. 原子设置 `Issue = in_progress`、`Workspace = running`。
10. 写入可见用户消息并执行 prompt。
11. 成功后设置 `Issue = pending`、`Workspace = ready`；失败则 abort/dispose 并写回 `open/failed`。

Pi resource loader 禁用 extension、skill、prompt template、theme、context file 和宿主自定义 prompt 自动发现。System prompt、tool 列表和 Deployment model 由 Issue Pilot 显式提供。

Streaming session 的 steer 按 Issue 串行。只有 Pi 接受 steer 后才追加 `issue-pilot-user` JSONL entry；若记录失败，会关闭 session并返回失败，避免可见 phantom message。

## Policy 与 capability

IssuePolicy 只包含：

- Issue key/type 和 session workspace root。
- Model provider、model ID 和 thinking level。
- Environment 和 Service 标识。
- Repository path、base commit 和实际 read/write access。
- Capability 名称和 credential-free frozen scope。

Deployment password、AccessKey 和 bearer token 不进入配置读取响应、policy、system prompt 或 tool input。Pi custom tool 闭包持有从 SQLite 读取的 Deployment config session 副本，并把调用交给 broker。

授权链如下：

```text
Service save parser
  -> Registry definition
  -> Frozen credential-free scope
  -> Tool input schema
  -> Broker allowlist/dispatch
  -> Protocol client scope + current config + bounds
```

本地 built-in tools 按实际 Repository access 决定：

- 至少一个 Repository 且全部可写：`read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`。
- 其他情况：`read`, `grep`, `find`, `ls`。

Capability 查询结果会作为工具结果发送给 Agent，并进入 Pi JSONL。查询目标中的业务 secret 可能因此进入会话；调用方必须限制列、日志范围和页面内容。

## Attachment 事务

附件只有一个 durable 副本：

```text
issues/<issue-key>/attachments/<uuid>-<basename>
```

Issue create/edit 是唯一附件写入口。

创建流程：

1. Multipart reader 应用单文件、总请求、文件数和 field 大小限制。
2. 计算 SHA-256。
3. 新 Issue 在数据库 insert 前独占创建空 Issue root。
4. 文件以 `0400` 写入 attachment root。
5. 数据库事务写 Issue、Workspace、CC 和 Attachment 行。
6. 失败时删除本次文件，并仅用 `rmdir` 回收本次创建的空目录。

编辑流程把 metadata、CC、附件新增/删除和一次 Agent metadata update 合并到一个 Issue reservation：

- 待删除文件先原子 rename 到 `.deleting` quarantine。
- 新文件写入后，数据库事务更新全部关系。
- 事务失败恢复 quarantine 并删除本次新文件。
- Commit 后 finalize 删除 quarantine；失败返回 `attachment_finalize_failed` 并保留证据。

Attachment GET 会验证直属路径、普通文件、group/world 权限、size 上限、数据库 size 和 SHA-256，然后才返回。不存在独立 POST/DELETE attachment route，也不存在 `/sync`。

## Issue 读取与 Workspace 深检

`GET /api/issues/:key` 是浅详情读取：读取数据库、session file 是否存在和轻量 Repository state，不执行 `du` 或 `git status`。返回的 Workspace DTO 只有 status、URL、last error 和 retryable 信息。

以下操作才执行深检：

- `GET /api/workspaces/stats`
- Manual release
- Reopen
- Automatic maintenance

深检计算 `du -sk`、验证精确目录布局、Repository state 和 Git cleanliness。它按 Issue 串行，不同 Issue 可以并行；stats/maintenance/release/reopen 仍由 lifecycle 全局队列协调。

## SSE 与 Web stream

SSE route 在读取 JSONL snapshot 前先订阅 live event bus。Snapshot 期间产生的 live event 进入连接私有缓冲。发送顺序为：

```text
Pi JSONL replay -> snapshot_ready -> buffered/live events
```

`snapshot_ready` 携带 model、footer、running 和当前 Issue status。Web `AgentStreamController` 在握手前把 replay 保存在连接私有状态，收到握手后原子替换面板；断线重连期间保留上一份完整画面。

Controller 使用递增 generation 忽略旧 EventSource、旧 refresh 和旧 timer 回调。Compaction 成功后主动重连以获取当前 Pi active branch。传输状态与 `conversation.ts` 的事件投影分离。

服务端 writer 保证有序发送，处理 backpressure、transport close/error、heartbeat 和单连接待发送字节预算。慢连接只关闭自身，不影响 Agent 或其他观察者。

## 并发与锁顺序

共享 `SerialQueue`/`KeyedSerialQueue` 只统一 Promise-tail、异常隔离、tail 清理和 `idle()`；业务锁域保持独立。

| 锁域 | 粒度 | 用途 |
| --- | --- | --- |
| Agent run/steer | Issue ID | Pi 轮次与 streaming message |
| Issue reservation | 一组 Issue ID | 状态、scope、附件、session 和 lifecycle 破坏性操作 |
| Scope queue | API 实例 | 配置 snapshot 读取、Service 配置写入、Issue key/scope 变化 |
| Lifecycle queue | API 实例 | Stats、release、reopen、maintenance 协调 |
| Inspection queue | Issue ID | `du`、布局和 Git clean 深检 |
| Repository queue | State root + Repository URL hash | Fetch 和 worktree metadata 操作 |

固定顺序：

- 配置读取：`scope queue -> SQLite snapshot transaction`
- Service/Issue scope：`scope queue -> Issue reservation`
- Service PATCH/DELETE 在 reservation 前核对完整配置内容 revision；陈旧表单不关闭 session、不进入事务。
- Release/reopen：`lifecycle queue -> inspection queue -> Issue reservation`

不能反向获取，也不能把所有锁合并成一个全局 mutex。

## 启动与关闭

API 启动顺序：

1. 以 `0600` 创建/打开 SQLite，设置 busy timeout 和 WAL。
2. 执行顺序 migration，启用 foreign keys。
3. 验证每张 Issue 有 Workspace 行，且 resolution 状态一致。
4. 把中断的 `preparing/running/in_progress` 收敛为可重试状态。
5. 确保 `prod/test/dev` Environment 存在并同步配置名称。
6. 检查 `issues/` 和 `workspaces/` 中没有 unmanaged Issue 目录。
7. 验证并受管移除 disposable shared checkout；清理生成 runtime。
8. 重建 dev runtime。
9. 为已有 session 的 prod/test Issue重建当前 read-only runtime。
10. 执行一次 Workspace maintenance。
11. 注册 HTTP route 并启动定时 maintenance。

`SIGINT`/`SIGTERM` 触发 Fastify close。关闭顺序为停止 maintenance 并等待 lifecycle/inspection 队列、等待 Agent activity/reservation、停止所有内存 Pi session、关闭 SQLite。清理失败会继续尝试后续步骤并聚合错误。

## 数据所有权

```text
.issue-pilot/
  issues.db
  issues/<issue-key>/
    attachments/
    agent/
    runtime/
  git/
    repositories/
    checkouts/
  workspaces/<issue-key>/
  code-server/
  backups/
```

| 数据 | Durable | 自动删除/重建规则 |
| --- | --- | --- |
| SQLite | 是 | 从不自动删除 |
| Attachment | 是 | 只随 Issue edit 事务删除 |
| Pi JSONL / runtime sidecar | 是 | 不随 workspace 删除 |
| Bare repository / local Issue branch | 是 | 不作为缓存清理 |
| Runtime / manifest / wrapper | 否 | 启动或 prepare 原子重建 |
| Immutable checkout | 否 | 启动验证后受管重建 |
| Dev workspace | 有条件 | 仅 resolved dev 通过受管 release |
| Backup | 是 | Operator 管理 |

数据库中不存在但 `issues/` 或 `workspaces/` 中存在的目录属于 unmanaged state。启动会在删除生成物之前返回 `unmanaged_issue_state`。

## 安全边界

- 应用运行在可信单机，没有内置认证。
- code-server `--auth none` 且提供终端；访问它等同于获得运行账号的开发能力。
- API、code-server 必须只监听 loopback，外部入口由认证、授权和 TLS proxy 保护。
- 普通工作台只读取不含 Repository URL、model 和 credential 的 `/api/catalog`；配置视图按需读取 `/api/config`，其中包含可编辑 scope 和 `credentialConfigured`，但不返回已存 password、AccessKeyId 或 AccessKeySecret。
- `/api/config` 在一个 SQLite snapshot transaction 中读取 Service、Repository、Deployment 和 branch 关系，并为每个 Service 返回完整配置内容的 HMAC-SHA-256 opaque revision。HMAC key 每次 API 启动随机生成、不落盘；响应不能作为 credential 猜测 oracle，重启后旧表单会安全失效。
- Service PATCH/DELETE 必须用 `If-Match` 提交该 revision。缺失返回 428，内容已变化返回 409，防止多个已打开表单按最后写入静默覆盖。
- Service 保存对每个已选 capability 显式要求 `preserve`、`replace` 或 `clear`；API 只在内存中把该意图与当前 SQLite credential 合并，再走完整 registry 校验和事务提交。
- Pi built-in tools 不是 OS sandbox；API/Pi 必须使用专用低权限账号。
- Aliyun capability 每次创建临时 `0600` profile，不使用 operator 持久 profile。
- Playwright credential 只写入单次 `0600` 文件并挂载给临时容器。
- DMS SQL 和 SLS query 会作为 Aliyun CLI 参数短暂出现在宿主进程列表；Credential 不进入 argv。

## 必须保持的不变量

1. Issue key 为 `ISSUE-YYYYMMDD-NNN...`。
2. 每张 Issue 有一条 Workspace 行，且 `resolved/resolved_at` 成对一致。
3. Issue Service/Environment 必须有对应 Deployment。
4. Prod/test 为 `read_only`；active dev 为 `development_workspace`；released dev 为 `development_snapshot`。
5. Released dev 只从本地 working branch ref 恢复。
6. Existing dev Repository 的 `base_branch` 和稳定 `workspace_name` 是 Issue 历史，不随当前配置漂移。
7. Dirty、untracked、running、invalid-layout、changed-checkout 和 unmanaged state 不自动删除。
8. Durable state 不进入 runtime 或 immutable checkout。
9. Attachment 只有一个 `0400` durable 副本，写操作只属于 Issue create/edit 事务。
10. Repository 集合变化先准备完整文件系统目标，再提交数据库关系；失败可回滚并保留证据。
11. Policy、prompt 和 tool input 不含 Deployment credential。
12. Capability client 自己验证 scope、当前 config、协议和结果预算。
13. API、migration、Git、runtime 和 code-server 使用同一个 state root。
14. Published migration 和 journal 不修改、不重排、不删除。
15. 已存 Deployment credential 不进入配置读取响应；未轮换的保存请求只携带 `preserve` 意图，不回传 secret 值。
16. Service 配置写入必须匹配基于完整内容生成的 revision；陈旧编辑不能静默覆盖当前配置。
