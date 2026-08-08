# 架构说明

## 总览

Issue Pilot 是一个单 Node.js package，由四个主要运行边界组成：

1. Fastify API 管理工单、服务配置、附件、Agent 命令和 SSE。
2. SolidJS Web 应用消费 HTTP API，并把原始 Pi 事件组织为对话界面。
3. AgentEngine 管理工作区、持久 Pi session 和工单生命周期。
4. Capability tools 根据冻结的工单 policy 调用受限的外部只读客户端。

```text
SolidJS Web
    |
    | HTTP + SSE
    v
Fastify API ---- SQLite
    |
    | enqueue / message
    v
AgentEngine ---- Git worktrees ---- shared code-server
    |
    | Pi AgentSession SDK + immutable session JSONL
    v
Pi session + policy-selected built-in/custom tools
    |
    v
Capability clients
    +-- native: Nacos / MySQL / Redis / Elasticsearch / RabbitMQ
    +-- local CLI: SLS
    +-- browser container: Playwright
```

## 代码组织

- `src/http/api.ts` 只装配数据库、Fastify、共享依赖和关闭流程；配置、工单、附件和 Agent 路由分别拥有自己的模块。
- `src/agent/engine.ts` 维护工单执行顺序和业务状态；`pi-session.ts` 管理 Pi SDK session；`session.ts` 初始化私有 JSONL；`events.ts` 负责持久会话回放。
- `src/pi/policy.ts` 创建部署 policy 和工具 allowlist；`tools.ts` 创建 policy-scoped Pi custom tools。
- `src/capabilities/` 中每个独立客户端保留自己的网络、进程或结果大小边界。
- `src/web/src/app/App.tsx` 维护顶层导航和工作台布局；各视图和 Agent conversation reducer 按职责拆分。

小文件只在拥有独立协议、进程、流控、事务或安全边界时保留，不通过通用 service/repository 层隐藏数据库事务和授权检查。

## 数据模型

SQLite 是配置和工单状态的事实源。核心关系包括：

- `services`、`service_repositories`、`service_deployments`
- `issues`、`issue_repositories`、`issue_workspaces`
- `agent_sessions`、`issue_attachments`

数据库以私有权限创建，并启用 WAL、foreign keys 和 busy timeout。`openApplicationDatabase()` 负责迁移、中断运行恢复、固定环境初始化和启动失败清理。

## 工单生命周期

对外状态只有四种：

```text
open -> in_progress -> pending -> resolved
                     -> open      失败
resolved -> open                  显式 reopen
```

API 启动时会把被进程重启中断的 workspace 标记为失败，并恢复可重试的工单状态。

## 工作区和 Git

```text
.issue-pilot/
  issues.db
  repositories/<url-hash>/
  workspaces/<issue-key>/<repository-name>/
  sessions/<issue-key>/<pi-session>.jsonl
  code-server/
```

仓库缓存使用 URL SHA-256 前缀；工单目录使用可读仓库名，同名时追加稳定 hash。

- `prod`、`test`：最新远端基线的 detached worktree，只读。
- `dev` + `defect_fix`：`hotfix-<issue-key>`，可写。
- `dev` + `feature_development`：`feature-<issue-key>`，可写。

Git 2.55.0 使用 relative worktree metadata，使同一 worktree 在宿主和 code-server 的同构 `workspaces/`、`repositories/` 挂载下都可解析。code-server 必须使用同一个宿主 Git runtime，否则旧 Git 会因 `extensions.relativeWorktrees` 拒绝仓库。

## Pi SDK 和会话

Issue Pilot 是 Node 应用，直接使用 Pi 推荐的 `createAgentSession()` SDK：

- `SessionManager` 首次创建私有 JSONL，后续运行复用 session ID 和文件。
- `ModelRuntime` 在 prompt 前刷新目录，验证 provider/model credential readiness。
- session 创建后核验实际 session ID、model、thinking level 和 active tools。
- `AgentSession.subscribe()` 事件转换成 Pi 官方 `JsonAgentSessionEvent` 后通过 SSE 原样发送；`message_update` 仅移除 JSON mode 同样不携带的 cumulative `partial`。
- `prompt()` 等待 retry、compaction 和 continuation 完整 settle；`abort()`、`dispose()` 负责失败和关闭清理。
- 同一工单由 keyed serial queue 串行执行，不同工单可并行。

`DefaultResourceLoader` 显式关闭 extension、skill、prompt template、theme、context file 和自定义 `SYSTEM.md` 自动发现。基础 system prompt 为空，让 Pi 根据实际工具生成原生默认提示，再追加 Issue Pilot policy 提示。

工具集合完全由 policy 计算：

- 只读：`read`、`grep`、`find`、`ls`。
- 所有仓库都可写：再启用 `bash`、`edit`、`write`。
- 外部能力：只追加 deployment 页面明确授权的 capability custom tool。

Capability custom tool 在同进程中直接调用 broker 函数，不再经过 RPC extension、内部 HTTP endpoint、bearer token 或 runtime 配置文件。deployment credentials 只存在于运行时闭包，不写入 policy、prompt 或 session。

### Session format 和 Web replay

持久文件严格使用 Pi session format v3 JSONL 和 append-only tree，不创建 Issue Pilot transcript 副本。SSE replay 调用官方 `SessionManager.buildContextEntries()` 与 `sessionEntryToContextMessages()`：

- 只回放 active leaf，并遵循 compaction 的 `firstKeptEntryId` 边界。
- assistant、tool result、compaction summary、branch summary、displayable custom message 和 bash execution 保留官方 message role。
- `model_change`、`thinking_level_change`、`label` 和 `session_info` 与官方 TUI 一样不伪装成聊天消息。
- Issue Pilot 页面用户消息另存为不参与 LLM context 的 `custom` entry；内部带运行时间的 Pi user prompt 不显示，避免把运行包装误当用户原文。
- compaction 完成后 Web 重新订阅 SSE，从 authoritative active context 重建消息区。

Pi 官方 TUI component 输出带 ANSI 的 terminal lines，不能直接挂载到 Solid DOM。Web 复用同版本官方 `dark.json`、session 投影和 JSON events，再按官方 user/assistant/thinking/tool/custom/editor/footer 语义做响应式 DOM presentation；不引入第二套 PTY 或 xterm session。业务 UI 和对话正文通过 Google Fonts CSS 使用 variable `Noto Sans SC`，技术内容和 thinking 使用带 normal/italic variable face 的 `JetBrains Mono`。项目不安装或打包字体，也不显式依赖微软雅黑或 `system-ui`。capability browser 不为字体放宽同源网络策略，因此跨域 Google Fonts 被阻止时使用 Noble 镜像的 generic sans/monospace fallback。

## Project wrappers

可写 Agent 的 bash PATH 包含当前工单 `.issue-pilot/bin`：

- `node-project` 校验项目位于工单 workspace 后，使用宿主 Node/npm/corepack 执行 install、test、build 或 typecheck。
- `maven-project` 校验相同路径边界后，使用宿主 Maven/Java 执行 test、verify 或 package。
- Maven 默认直接使用宿主 `~/.m2/settings.xml` 和 `~/.m2/repository`。

Wrapper 是可重复生成的 workspace 文件，不是独立容器或长驻服务。

## Capability policy

每次运行根据工单、环境和页面 deployment 配置创建 `IssuePolicy`。Policy 冻结：

- issue key、类型和 workspace 根目录
- provider、model ID 和 thinking level
- 服务、环境和 deployment ID
- 仓库绝对路径、base commit 和读写权限
- 已启用能力及无凭据 scope

能力输入使用 TypeBox schema，并在 broker 再次做语义校验。结果必须完整返回；超过大小、行数、key 数或动作数限制时显式失败，不返回截断证据。

## 外部能力

- Nacos：原生 HTTP 登录一次，流式读取页面列出的精确 Data ID，共享 1 MiB 预算，拒绝 redirect 和 glob。
- MySQL：只接受一个 read-only statement；URL、SQL、只读事务和数据库账号是独立防线。
- Redis：隔离 worker 中使用原生 client，仅开放约定的只读操作。
- Elasticsearch：仅 search、count、mapping，拒绝 redirect。
- RabbitMQ：仅 Management API metadata，不消费消息。
- SLS：宿主 Aliyun CLI 内置 `sls GetLogs`，临时私有 profile 注入页面 credential，不依赖 CLI plugin。
- Playwright：宿主全局 `playwright-core@1.62.1` 提供 runner，固定临时浏览器容器执行声明式动作；只允许固定 deployment origin。

## SSE

`GET /api/issues/:key/agent-stream` 先回放当前 active branch，再发送实时事件。`AgentEventBus` 负责 issue isolation；SSE writer 在 `write()` 返回 false 时等待 `drain`，客户端断开时释放 listener 和 backpressure wait。

## code-server

所有工单共享一个官方 code-server 4.131.0 容器。容器不构建自定义镜像，直接挂载宿主 Node/Pi、Java、Maven、Git、Maven repository、npm cache/config 和 Pi agent 目录。详细固定路径、读写属性和更新流程见 [运维说明](OPERATIONS.md#code-server-部署)。
