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
| Runtime | `issues/<key>/runtime` 下供Agent和内置代码浏览器使用的Repository链接与wrapper生成目录 |
| Session | 一张 Issue 对应的持久 Pi JSONL active branch |
| IssuePolicy | 每次 Pi session 冻结的 model、Repository 和无 credential capability scope |
| Capability | 受限的Agent外部读取工具，例如 Nacos、MySQL、DMS 或 SLS；Playwright不属于capability |

## 事实源

Issue Pilot 不把所有状态放在同一个介质中。每个事实只有一个权威来源：

| 事实 | 权威来源 |
| --- | --- |
| User、Issue、Service、Deployment、Workspace 和 Attachment 元数据 | SQLite |
| 应用路径、端口、默认值、retention 和上限 | `issue-pilot.config.ts` |
| 当前业务常量 | `src/domain/contracts.ts` |
| Dev Issue 工作结果 | Bare repository 中的本地 working branch ref |
| Prod/test 代码 | 当前 Deployment base branch 最新 fetched commit |
| 对话历史 | 每 Issue Pi JSONL active branch |
| Attachment 内容 | Durable file；数据库保存 object path、size 和 SHA-256 |
| Runtime link、wrapper | `src/workspace` 的生成器 |
| Capability 保存 contract 和无 credential scope | `src/capabilities/registry.ts` |
| 配置中心脱敏 DTO 和 credential 更新状态 | `src/configuration/contracts.ts` |

生成物不能反向成为业务事实源。Runtime link、checkout 或页面状态都不能覆盖 SQLite、JSONL 或本地 Git ref。

## 组件与模块边界

```text
Browser
        |
TLS/auth proxy
        |
Application container: Fastify routes + static SolidJS/Workbench ---- SQLite / Drizzle
        |
AgentEngine ---- PiSessionRuntime ---- Pi JSONL
        |
IssueProjectManager ---- WorktreeManager ---- Git stores
        |
SourceBrowser ---- bounded file / rg / Git reads
        |
IssuePolicy ---- Capability tools ---- Broker ---- Protocol clients / ProcessToolRuntime
        |
ProjectToolBroker ---- ProcessToolRuntime ---- current process PATH

Application test harness ---- temporary Podman Playwright container
```

| 模块 | 责任 |
| --- | --- |
| `src/http` | HTTP 边界、用户管理、reservation、数据库事务和 SSE |
| `src/configuration` | 配置中心共享 DTO、credential 脱敏/合并、内容 revision，以及 snapshot projection |
| `src/agent` | 每 Issue Agent 队列、Pi session 生命周期、事件与 prompt |
| `src/pi` | Model catalog、冻结 policy、built-in/custom tool 授权 |
| `src/workspace/project.ts` | Issue 项目的 prepare、dev restore、read-only/dev runtime hydration |
| `src/workspace/git.ts` | Bare store、fetch、checkout、worktree、批量 prepare/remove/rollback |
| `src/workspace/runtime.ts` | 原子生成Issue runtime Repository链接 |
| `src/workspace/source-browser.ts` | 按SQLite关系解析runtime、限制文件树/文件/搜索/diff读取 |
| `src/workspace/project-tools.ts` | Unix socket授权、Issue路径校验和Node/Maven受控执行 |
| `src/workspace/lifecycle.ts` | 深检、统计、release、reopen 和 retention/quota maintenance |
| `src/capabilities/registry.ts` | 配置解析、credential-free scope、tool schema 和 metadata |
| `src/capabilities/broker.ts` | Capability allowlist、输入解析和 handler dispatch |
| 各 capability client | 协议、scope、timeout、abort 和结果预算的最终校验 |
| `src/serial.ts` | 通用串行原语；不定义业务锁域 |
| `src/tool-runtime.ts` | 当前API进程中的命令白名单、环境收敛和调用级临时HOME |
| `src/web/src/app/agent-stream.ts` | EventSource generation、replay、snapshot、重连和关闭状态机 |
| `src/web/src/app/conversation.ts` | Pi/Issue event 到可见对话的纯投影 |

Route 不实现 Git 或外部协议。AgentEngine 不拼 Deployment Repository join。Capability client 不信任 registry、tool schema 或 broker 已经完成检查。

## 生产进程与容器边界

生产镜像使用多阶段构建：Node 26 build stage生成`src/web/dist`并裁剪开发依赖，Maven stage提供Maven 3.9/Temurin 8，Ubuntu 26.04 runtime stage包含API生产依赖、Pi、Aliyun CLI、静态Web、migration、Git 2.48或更高版本、SSH、ripgrep和curl。Fastify在容器内同一个`0.0.0.0:3000`入口提供Web、`vscode.html`和API；Compose使用bridge网络且只向宿主`127.0.0.1:3000`发布。根配置通过`infra/application-compose.mjs`投影为只含一个application service的Compose JSON。

应用镜像在构建时把当前checkout绝对路径写入OCI label，并把代码安装到同一路径。启动脚本只把state root和运行账号所需的Pi/package manager配置及cache按原绝对路径挂载；路径、UID/GID或镜像label不匹配时拒绝启动。这样SQLite `local_path`、bare Git worktree metadata和runtime symlink继续共享同一命名空间。

API只从application容器启动，并使用唯一的`ProcessToolRuntime`。它只从镜像PATH解析`npm`、`mvn`和`aliyun`，不接受image或任意可执行文件。Broker先校验真实project/config/cache路径；执行器只收敛环境，并在调用未指定HOME时创建临时HOME并于finally清理。Node和Maven版本系列直接由Containerfile定义，不进入应用运行配置。

进程执行没有调用级文件系统和cgroup隔离：npm/Maven项目脚本与API使用application容器中的同一OS身份，理论上能读取该身份可读的state、Pi和package配置。该部署只适用于可信内部Repository，不应描述为Agent sandbox；处理不可信Repository前必须另行实现进程sandbox。

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

Issue状态描述业务进度，Workspace状态描述执行基础设施。每张Issue必须有且只有一条`issue_workspaces`行；缺失时启动和执行都明确失败。`runtimeReady`映射当前物理列`runtime_ready`，表示受管runtime已生成并可供Agent/Source API使用。

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

Reopen会从全部本地working branches先准备可写worktree、runtime和wrapper，再在一个数据库事务中更新Repository、Workspace和Issue状态。失败清理只移除本次创建的受管worktree和空根，并恢复只读runtime；未知内容会导致显式失败。

## Runtime、代码浏览器与项目工具

每个已准备代码的Issue使用相同runtime结构：

```text
issues/<issue-key>/runtime/
  <workspace-name> -> worktree 或 immutable checkout
  bin/
    node-project
    maven-project
```

`bin`只存在于writable dev runtime。Wrapper解析真实project path，要求它位于当前Issue workspace，再通过`control/project-tools.sock`提交版本化请求。API broker从SQLite重新确认Issue、Repository alias和`local_path`并按Issue串行。客户端不能指定可执行文件、配置路径、cache路径或宿主绝对路径。`ProcessToolRuntime`只从application大镜像PATH执行，使用镜像中的Node 26和Maven 3.9/Temurin 8。

Node只允许npm `install|test|build|typecheck`，拒绝其他package manager、`start/dev/serve/preview`和`--watch*`并固定`CI=1`；Maven只允许`test|verify|package`。唯一进程执行机制保留timeout和output限制、单Repository workdir、只读挂载的npmrc/Maven settings及读写cache，但不提供调用级rootfs或PID/内存隔离；生产仅受application容器总cgroup约束。

Runtime在临时目录完整生成后原子替换。附件不会复制或链接进runtime。Web代码浏览器使用`@codingame/monaco-vscode-api`启动真实VS Code Workbench；每次打开使用独立iframe生命周期，关闭时销毁该Workbench单例。Workbench通过`registerCustomView()`在Bottom Panel注册Agent View、在Secondary Side Bar注册工单详情View，并把两个原生View body的实时矩形通过同源、Issue绑定的`postMessage`上报父应用；父应用只覆盖View body，原生标题、关闭和sash resize由Workbench负责，两个View不展示最大化动作。同一个Agent会话和工单详情组件继续由父应用维护，因此SSE、草稿、表单和附件状态不复制也不重建。顶部开关与原生Part关闭动作双向同步layout visibility，隐藏时编辑器占用释放后的真实Part空间。Workbench滚动区保留VS Code原生按需显示的透明轨道；工单与Agent共享GitHub Dark scrollbar token。Agent使用覆盖整个View body的单一滚动容器，对话、队列、运行状态、输入区和底部状态按顺序处于同一滚动流，输入区和底部状态只在滚动到内容末尾时出现。窄屏隐藏原生Secondary Side Bar，工单详情由固定图标切换为受边界约束的抽屉。

只读文件系统overlay把每个Repository alias映射为multi-root workspace，Explorer、Editor Groups/Tabs、breadcrumb、minimap和语言模式均由VS Code/Monaco提供。Source API只接受Issue key、Repository alias和相对路径，拒绝绝对路径、`..`、越界symlink、`.git`树项、binary和超限文件。Workbench文件系统调用`/repositories`、`/tree`和`/file`；Search view通过自定义provider调用受预算的literal `/search`，支持大小写和整词模式但不开放regex；Source Control通过`ISCMService`注册只读Changes和History provider，分别用`/diff`、`/history`和`/commit`投影工作区变更、提交图及提交文件；Graph文件节点提供前后revision URI，单击后通过专用只读文件系统按需调用`/commit-file`并打开Diff。三个主视图由父页面固定图标工具栏发送白名单view command，原生Activity Bar保持隐藏。所有history/commit仍受HEAD ancestry及输出预算限制。

文件系统声明`Readonly`和`FilePermission.Readonly`，所有write/mkdir/delete/rename返回`FileWriteLocked`。Workbench不启用Terminal、本地或Node extension host、extension gallery、remote agent、保存、stage、commit、revert或任意Git命令。固定language/grammar contribution、经过剥离的GitHub Dark Default和Material Icon Theme均无可执行入口；内置`markdown-language-features`只在受控Web Worker extension host中提供`markdown.api.render`。Preview图标和Markdown Preview命令打开通过`registerEditorPane()`注册的只读Workbench Editor Pane；Pane从当前只读Monaco模型调用扩展render API，DOMPurify清洗扩展HTML后写入隔离Shadow DOM，并使用Workbench原生`DomScrollableElement`、Editor Group、Tab和关闭行为。Preview不创建浏览器Webview、内容iframe或Service Worker，不引入第二个Markdown解析器、外部资源、脚本或写接口。拖放、文件粘贴和移动时更新链接均关闭。

## Issue 项目准备

`IssueProjectManager` 是项目准备的单一协调者：

- `prepare()`：Agent轮次使用，解析Deployment、准备Git、更新Repository行并生成runtime/wrapper。
- `hydrateDevelopmentRuntime()`：API 冷启动重建 active/released dev runtime。
- `hydrateReadOnlyRuntime()`：冷启动为已有session的prod/test Issue fetch当前基线，runtime成功生成后提交Repository/workspace行。
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
5. 空`subjects`表插入一次根配置bootstrap用户；已有用户绝不由配置覆盖。
6. 确保 `prod/test/dev` Environment 存在并同步配置名称。
7. 检查 `issues/` 和 `workspaces/` 中没有 unmanaged Issue 目录。
8. 验证并受管移除disposable shared checkout；清理生成runtime。
9. 启动`0600` Unix socket项目工具broker。
10. 重建dev runtime。
11. 为已有session的prod/test Issue重建当前read-only runtime。
12. 执行一次Workspace maintenance。
13. 注册HTTP route并启动定时maintenance。

`SIGINT`/`SIGTERM`触发Fastify close。关闭顺序为停止maintenance并等待lifecycle/inspection队列、等待Agent activity/reservation、停止所有内存Pi session、关闭项目工具broker并等待活动容器、关闭SQLite。清理失败会继续尝试后续步骤并聚合错误。Broker启动会探测已有socket；活动socket使第二API实例明确失败，只有`ECONNREFUSED`的stale socket可移除。关闭只按启动时记录的device/inode删除自己拥有的socket。

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
  control/project-tools.sock
  backups/
```

| 数据 | Durable | 自动删除/重建规则 |
| --- | --- | --- |
| SQLite | 是 | 从不自动删除 |
| Attachment | 是 | 只随 Issue edit 事务删除 |
| Pi JSONL / runtime sidecar | 是 | 不随 workspace 删除 |
| Bare repository / local Issue branch | 是 | 不作为缓存清理 |
| Runtime link / wrapper / control socket | 否 | 启动或prepare原子重建 |
| Immutable checkout | 否 | 启动验证后受管重建 |
| Dev workspace | 有条件 | 仅 resolved dev 通过受管 release |
| Backup | 是 | Operator 管理 |

数据库中不存在但 `issues/` 或 `workspaces/` 中存在的目录属于 unmanaged state。启动会在删除生成物之前返回 `unmanaged_issue_state`。

## 安全边界

- 应用运行在可信单机，没有内置认证。
- 内置VS Code Workbench代码浏览器只读，不启用终端、保存、本地/Node扩展host或扩展市场；唯一Web Worker扩展宿主只运行打包的Markdown功能。Source API仍会返回内部源码，必须按敏感数据保护。
- Compose只向宿主loopback发布application容器端口。任何集群或外部入口都必须由认证、授权和TLS proxy保护。
- 项目工具Unix socket mode为`0600`；wrapper请求中的Issue和Repository路径必须由broker按SQLite重新授权。
- 普通工作台只读取不含 Repository URL、model 和 credential 的 `/api/catalog`；配置视图按需读取 `/api/config`，其中包含可编辑 scope 和 `credentialConfigured`，但不返回已存 password、AccessKeyId 或 AccessKeySecret。
- `/api/config` 在一个 SQLite snapshot transaction 中读取 Service、Repository、Deployment 和 branch 关系，并为每个 Service 返回完整配置内容的 HMAC-SHA-256 opaque revision。HMAC key 每次 API 启动随机生成、不落盘；响应不能作为 credential 猜测 oracle，重启后旧表单会安全失效。
- Service PATCH/DELETE 必须用 `If-Match` 提交该 revision。缺失返回 428，内容已变化返回 409，防止多个已打开表单按最后写入静默覆盖。
- Service 保存对每个已选 capability 显式要求 `preserve`、`replace` 或 `clear`；API 只在内存中把该意图与当前 SQLite credential 合并，再走完整 registry 校验和事务提交。
- Pi built-in tools 不是 OS sandbox；API/Pi 必须使用专用低权限账号。
- Aliyun capability每次创建临时`0600` profile并只交给application容器内受限`aliyun dms-enterprise/sls`命令，不使用operator持久profile。
- Playwright只由operator通过应用自测脚本启动临时容器；Service、Deployment、IssuePolicy、Pi tool和capability broker都没有Playwright入口，也不读取Deployment credential或Issue workspace。
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
13. API、migration、Git、runtime、source browser和project-tool broker使用同一个state root。
14. Published migration 和 journal 不修改、不重排、不删除。
15. 已存 Deployment credential 不进入配置读取响应；未轮换的保存请求只携带 `preserve` 意图，不回传 secret 值。
16. Service 配置写入必须匹配基于完整内容生成的 revision；陈旧编辑不能静默覆盖当前配置。
17. User以SQLite为唯一事实源；停用不删除历史主体，且始终至少有一名启用用户。
