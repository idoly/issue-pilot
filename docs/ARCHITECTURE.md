# 架构说明

## 总览

Issue Pilot 是一个单 Node.js package，由四个主要运行边界组成：

1. Fastify API 管理工单、deployment 配置、附件、Agent 命令和 SSE。
2. SolidJS Web 应用消费 HTTP API，并把原始 Pi 事件组织为对话界面。
3. `AgentEngine` 管理共享只读代码快照、开发 worktree、持久 Pi session 和工单生命周期。
4. Capability tools 根据每次执行创建并冻结的 `IssuePolicy` 调用受限外部客户端。

```text
SolidJS Web
    |
    | HTTP + SSE
    v
Fastify API -------- SQLite
    |
    | keyed serial queue
    v
AgentEngine -------- shared snapshots / dev worktrees -------- shared code-server
    |
    | Pi AgentSession SDK + private append-only JSONL
    v
Pi session + policy-selected built-in/custom tools
    |
    +-- native host clients: Nacos / MySQL / Redis / Elasticsearch / RabbitMQ
    +-- fixed host CLI: SLS
    +-- ephemeral container: Playwright Chromium
```

只有 code-server 和 Playwright browser 是容器边界。数据库、Agent、Git、Node/Maven project command 和其他外部能力都在宿主进程或受限宿主子进程中运行。

## 代码组织原则

- `src/http/api.ts` 只装配数据库、Fastify、共享依赖和关闭流程；配置、工单、附件和 Agent 路由分别拥有自己的事务边界。
- `src/agent/engine.ts` 维护工单执行顺序和业务状态；`pi-session.ts` 管理 Pi SDK session；`session.ts` 初始化私有 JSONL；`events.ts` 负责 replay/live 事件顺序。
- `src/pi/policy.ts` 创建 deployment policy 和工具 allowlist；`tools.ts` 创建 policy-scoped custom tools。
- `src/capabilities/` 中每个客户端拥有自己的协议、输入、超时和结果大小边界。
- `src/workspace/` 管理共享 checkout、开发 worktree、只读 session runtime、可重复生成的 project wrappers 和共享 code-server。
- `src/web/src/app/App.tsx` 维护顶层导航和工作台布局；conversation reducer 只做 UI projection，不改变原始 Pi 事件。

小文件只在拥有独立协议、进程、流控、事务或安全边界时保留。历史 Drizzle migration 是顺序升级契约，不按当前 schema 合并或删除。

## 数据模型和启动所有权

SQLite 是 deployment 配置、工单状态和 session binding 的事实源。核心关系包括：

- `services`、`service_repositories`、`service_deployments`
- `issues`、`issue_repositories`、`issue_workspaces`
- `issue_pilot_sessions`、`issue_attachments`、`issue_comments`

数据库文件以 `0600` 创建，并启用 WAL、foreign keys 和 busy timeout。`openApplicationDatabase()` 负责：

1. 按 journal 顺序执行 migration。
2. 恢复被进程重启中断的 `preparing`/`running` workspace。
3. 把 ready workspace 对应的遗留 `in_progress` 工单恢复为 `pending`。
4. 确保固定环境 `prod`、`test`、`dev` 存在。
5. 初始化失败时关闭数据库 client。

## 工单生命周期

对外状态只有四种：

```text
open -> in_progress -> pending -> resolved
                     -> open      Agent 失败
resolved -> open                  用户显式 reopen
```

`resolved` 工单不能运行或发送 Agent 消息，必须先 reopen。同一工单通过 keyed serial queue 串行执行；不同工单可以并行。进程关闭、启动失败或 prompt 失败都会 abort/dispose SDK session，并把可恢复状态写回数据库。

## 工作区和 Git

```text
.issue-pilot/
  issues.db
  repositories/<url-sha256-prefix>/
  checkouts/<url-sha256-prefix>/<branch-hash>-<commit>/
  workspaces/<dev-issue-key>/<repository-name>/
  sessions/<issue-key>/<pi-session>.jsonl
  sessions/<issue-key>/runtime/<repository-link>
  attachments/<issue-key>/
  code-server/
```

仓库 cache 使用 URL SHA-256 前缀；工单目录使用可读仓库 basename，同名时追加稳定 hash。

| 环境/类型 | 本地代码形态 | policy repository access |
| --- | --- | --- |
| `prod` + `data_processing`/`smart_analysis` | prod deployment 最新 commit 的共享 immutable checkout | read |
| `test` + `smart_analysis` | test deployment 最新 commit 的共享 immutable checkout | read |
| `dev` + `defect_fix` | 从 dev deployment 配置分支创建 `hotfix-<issue-key>` | write |
| `dev` + `feature_development` | 从 dev deployment 配置分支创建 `feature-<issue-key>` | write |

共享 bare repository 的 fetch 按 URL 串行。prod/test checkout 以 branch hash 和完整 commit 定址：同一 commit 被多个 Issue 复用，远端前进时创建新目录，因此已有 Agent 读取的代码不会被 reset 覆盖。每个只读 Issue 只在 `sessions/<issue-key>/runtime` 生成 repository/attachment 链接，不创建 `workspaces/<issue-key>`、代码分支、依赖目录或 code-server。API 冷启动删除可重建 runtime/checkouts，再 prune bare repository worktree metadata；下一次执行重新 fetch 最新基线。

每个 deployment（包括 dev）都必须配置 `baseBranch`；开发工作分支以 dev deployment 的配置分支为基线。Git 2.55.0 使用 relative worktree metadata，使共享 checkout 和开发 worktree 在固定状态目录中可恢复。已有 dirty 开发 workspace 不会被自动删除或覆盖。code-server 必须使用与宿主一致的 Git binary、exec path、templates 和动态库。

开发 Issue workspace 是可释放、可重建的 cache。释放前串行检查 Issue idle 状态、全部 worktree 的 modified/untracked 状态和根目录布局；成功后通过 Git worktree remove 清理 metadata，并在一个数据库事务中清空所有 `local_path`、关闭 code-server ready 状态。branch、base commit、Pi session binding/JSONL 与持久附件不属于 cache。附件原件存放在 `attachments/<issue-key>`；开发 Agent 获得 workspace 内 `0400` 副本，只读 Agent 通过 session runtime 链接读取原件。API 提供手动释放、dry-run 容量统计、resolved 保留期清理和 high-water/target 配额清理。旧 prod/test detached workspace 会在该 Issue 下次运行时经过完整 layout/clean 预检后删除；任何 dirty 或未知内容都会阻止迁移。

## Pi SDK 和 session

Issue Pilot 直接使用 Pi `createAgentSession()` SDK，不启动 Pi RPC 子进程：

- `SessionManager` 首次创建私有 session format v3 JSONL，后续运行复用 session ID 和文件。
- Session binding 在任何可见用户事件发布前写入 SQLite，避免 SSE 能看到事件却找不到 session。
- `ModelRuntime` 在 prompt 前刷新模型目录，验证 provider/model credentials readiness。
- Session 创建后核验实际 session ID、model、thinking level 和 active tools。
- `AgentSession.subscribe()` 事件转换成官方 `JsonAgentSessionEvent` 后原样发送；Web normalization 只属于 presentation。
- `prompt()` 等待 retry、compaction 和 continuation 完整 settle；`abort()`、`dispose()` 负责失败和关闭清理。

`DefaultResourceLoader` 显式关闭 extension、skill、prompt template、theme、context file 和宿主自定义 prompt 自动发现。基础 system prompt 为空，让 Pi 根据实际工具生成原生默认提示，再追加 Issue Pilot policy context。

### Session replay

持久文件是唯一 transcript，不创建 Issue Pilot 消息副本。SSE replay 使用 `SessionManager.buildContextEntries()` 和 `sessionEntryToContextMessages()`：

- 只回放 active leaf，并遵循 compaction 的 `firstKeptEntryId`。
- 保留 assistant、tool result、compaction/branch summary、displayable custom message 和 bash execution。
- `model_change`、`thinking_level_change`、`label`、`session_info` 不伪装成 chat message。
- 页面用户消息保存为不参与 LLM context 的 custom entry；带 runtime time 的内部 prompt 不显示。
- SSE 先取得 replay snapshot，再通过 buffered subscription 接入 live event，避免 replay/live 之间丢事件。
- compaction 完成后 Web 重新订阅，从 authoritative active context 重建。

Web 使用结构化 Solid DOM 复现 Pi 的 user/assistant/thinking/tool/custom/editor/footer 语义，不引入第二套 PTY 或 xterm session。主题基于同版本官方 `dark.json`；业务文字使用 Google Fonts variable `Noto Sans SC`，技术内容使用 `JetBrains Mono`，项目不安装或打包字体。

## Policy 构建

Deployment 配置是模型、连接、credential 和 capability 授权的唯一事实源。每次新 session 按以下顺序创建 policy：

```text
HTTP deployment config
    -> save-time validation
    -> issue + environment + deployment + prepared repositories
    -> createDeploymentPolicy()
    -> strip credentials / canonicalize scopes
    -> createIssuePolicy()
    -> deep freeze
    -> built-in allowlist + custom tool definitions
    -> Pi AgentSession
```

`IssuePolicy` 只包含：

- normalized issue key、工单类型和 session runtime 或开发 workspace 绝对路径
- provider、model ID、thinking level
- service/environment identity 和 environment kind
- repository 绝对路径、base commit、read/write grant
- canonical capability names
- 无凭据 scope，例如 deployment ID、Nacos exact Data ID、SLS logstore、RabbitMQ virtual host、Playwright base URL

它不包含 username、password、AccessKey 或 bearer token。Policy、嵌套 scope、数组和 repository grant 均被冻结，session 运行期间不能被页面更新或其他调用者修改。

### 本地工具矩阵

| repository policy | Pi built-in tools |
| --- | --- |
| 零仓库或任一仓库只读 | `read`、`grep`、`find`、`ls` |
| 至少一个仓库且全部可写 | 上述工具加 `bash`、`edit`、`write` |

写权限还要求 environment 为 `dev`，且 issue type 为 `defect_fix` 或 `feature_development`。页面配置不能直接授予本地 mutation tool。

Pi built-in file tools以 session workspace 为 cwd，但不是操作系统 sandbox；宿主进程文件权限仍是最终本地文件边界。因此 API/Pi 进程必须使用专用、低权限账号运行，不能以 root 启动。

### Custom capability 工具

只有 `policy.service.capabilities` 中的名称会创建 tool。每个 tool 通过闭包读取 session 启动时 clone 的 deployment config，并直接调用 broker；不存在内部 HTTP endpoint、bearer token 或 RPC extension。

| tool | policy scope | runtime enforcement |
| --- | --- | --- |
| `nacos` | server/namespace/group/exact Data IDs | exact target、同 origin、共享结果预算 |
| `db` | deployment ID | MySQL URL、单条只读 SQL、read-only transaction |
| `redis` | deployment ID | allowlisted action、key/count/result budget |
| `es` | deployment ID | search/count/mapping、redirect forbidden |
| `mq` | deployment ID + virtual host | Management API metadata only |
| `sls` | region/project/logstores | exact logstore、time range、fixed CLI |
| `playwright` | exact base URL | declarative actions、same origin、ephemeral browser |

授权和输入分层验证：页面表单用于 UX；HTTP save parser 验证持久配置；policy canonicalize 授权；TypeBox tool schema 验证结构；broker 和客户端再验证语义、scope 未变化和协议边界。

## Credential 生命周期

1. Credential 只保存在 SQLite deployment config 中。
2. Agent 启动时 configuration clone 被 capability tool closure 持有，不写入 policy 或 prompt。
3. Nacos/MySQL/Redis/ES/RabbitMQ client 只在请求构造时使用 credential。
4. SLS 为单次调用创建 `0700` 临时 HOME 和 `0600` Aliyun profile，子进程结束后递归删除。
5. Playwright username/password 写入单次 `0600` 文件，只挂载给临时 browser container；Podman 命令行只有文件路径。
6. code-server password 写入私有 `container.env`，`status` 不输出完整 container inspect。

Capability 结果可能包含目标系统本身返回的敏感业务字段，因为完整证据不能静默过滤；调用方必须按 deployment data classification 保护 session 和日志。

## 完整结果原则

Capability 不返回 `truncated: true` 或“前 N 条但看起来成功”的结果。超过约定的 bytes、rows、keys、Data IDs、SLS records 或 browser actions 时返回 `capability_result_too_large`。调用者应缩小 SQL、query、时间范围或目标集合后重试。

SLS 是显式分页：累计到调用方 `limit` 后再探测下一条；存在更多记录时整次调用失败。MySQL 使用 streaming rows，在加入结果前检查行数和序列化大小。Nacos 多 Data ID 共用一个结果预算。

## Project wrappers

可写 Agent 的 bash PATH 包含当前工单 `.issue-pilot/bin`：

- `node-project` 校验项目位于 issue workspace 后，按 `packageManager` 使用宿主 npm/corepack 执行 install、test、build 或 typecheck。
- `maven-project` 验证相同路径边界后，使用宿主 Maven/Java 执行 test、verify 或 package。

Wrapper 是可重复生成的 workspace 文件，不是容器或长驻服务。

## SSE 和 backpressure

`GET /api/issues/:key/agent-stream` 回放 active branch 后发送实时事件。`AgentEventBus` 负责 issue isolation；ordered SSE writer 在 `write()` 返回 false 时等待 `drain`，客户端断开时释放 listener、heartbeat 和 backpressure wait。Footer totals 从完整 session entries 累计，context usage 使用 active context 和当前模型 context window。

## code-server

所有开发工单共享一个官方 code-server 4.131.0 容器。容器不构建自定义镜像，直接挂载固定宿主 Node/Pi、Java、Maven、Git、Maven repository、npm cache/config 和 Pi agent 目录。容器只监听 `127.0.0.1:18080`，使用 `userns=keep-id`、`no-new-privileges`、`cap-drop ALL`。详细路径、更新和恢复流程见 [运维说明](OPERATIONS.md#code-server-部署)。
