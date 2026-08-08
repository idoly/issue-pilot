# 架构说明

## 总览

Issue Pilot 是一个单 Node.js package，由四个主要运行边界组成：

1. Fastify API 管理工单、服务配置、附件、Agent 命令和 SSE。
2. SolidJS Web 应用消费 HTTP API，并把原始 Pi 事件组织为对话界面。
3. AgentEngine 管理工作区、持久 Pi session、RPC 子进程和工单生命周期。
4. Capability broker 根据冻结的工单 policy 调用受限的外部只读客户端。

```text
SolidJS Web
    |
    | HTTP + SSE
    v
Fastify API ---- SQLite
    |
    | enqueue/message/abort
    v
AgentEngine ---- Git worktrees ---- shared code-server
    |
    | Pi RPC + immutable session JSONL
    v
Pi process + Issue Pilot extension
    |
    | bearer token, issue ID, typed input
    v
Capability broker
    +-- native: MySQL / Redis / Elasticsearch / RabbitMQ / SLS CLI
    +-- brokered containers: Nacos / Playwright
```

## 数据模型

SQLite 是配置和工单状态的事实源。核心关系包括：

- `services`：服务基本信息，按创建顺序展示。
- `service_repositories`：服务关联的前端或后端 Git 仓库。
- `service_deployments`：服务在 `prod`、`test`、`dev` 环境的基线分支、模型和能力配置。
- `issues`：工单主体、环境、服务、类型、状态和版本。
- `issue_repositories`：工单建立时冻结的仓库/worktree 信息。
- `issue_workspaces`：工作区准备和 Agent 运行状态。
- `agent_sessions`：工单对应的 Pi session ID、JSONL 文件和 workspace 路径。
- `issue_attachments`：私有附件路径、媒体类型、大小和 SHA-256。

数据库文件以 `0600` 创建，并启用 WAL、foreign keys 和 busy timeout。迁移位于 `drizzle/`。

## 工单生命周期

对外状态只有四种：

- `open`：尚未运行，或运行失败后可重试。
- `in_progress`：Agent 正在准备或处理。
- `pending`：Agent 已完成当前轮次，等待人工确认。
- `resolved`：人工确认解决；必须显式 reopen 后才能再次运行或发送 Agent 消息。

正常运行路径：

```text
open -> in_progress -> pending -> resolved
                     -> open      失败
resolved -> open                  显式 reopen
```

API 启动时会修复被进程重启中断的 workspace 状态，避免工单永久停留在 `in_progress`。

## 工作区和 Git

状态目录默认是 `.issue-pilot`：

```text
.issue-pilot/
  issues.db
  repositories/<url-hash>/
  workspaces/<issue-key>/<repository-name>/
  sessions/<issue-key>/<pi-session>.jsonl
  tools/playwright/
  code-server/
```

仓库缓存使用 URL SHA-256 前缀，防止路径碰撞；工单工作区使用可读仓库名，同名仓库追加稳定 hash。

工作区模式由环境和工单类型决定：

- `prod`、`test`：使用最新远端基线的 detached worktree，只读。
- `dev` + `defect_fix`：使用 `hotfix-<issue-key>` 分支，可写。
- `dev` + `feature_development`：使用 `feature-<issue-key>` 分支，可写。

Policy 会再次把不满足开发环境和开发类型的仓库降级为只读。已有 worktree 会验证路径、分支和脏状态，不会静默覆盖本地修改。

## Pi RPC 和会话

AgentEngine 不把 Pi SDK 嵌入 API 进程，而是为每个活动工单启动 Pi RPC 子进程：

- session JSONL 在首次 prompt 前创建，后续运行复用同一文件和 session ID。
- Pi 原始事件通过 RPC 返回，再通过 SSE 原样发送给 Web。
- Web 只做展示归一化，不修改保存的 Pi 结果。
- 自动重试和自动压缩由 Pi session 开启。
- Agent 消息最大 50,000 字符，HTTP、RPC extension 和 AgentEngine 都会验证。
- 同一工单通过 `KeyedSerialQueue` 串行执行，不同工单可以并行。
- 运行失败时移除 runtime token、停止 RPC 客户端并清理临时 runtime 配置。

Pi 使用内置本地工具处理代码和文件。Issue Pilot extension 只注册当前部署已授权的外部能力。

## Capability policy

每次运行都根据工单、环境和当前页面配置创建 `IssuePolicy`。Policy 冻结：

- 工单 key、类型和 workspace 根目录。
- provider、model ID 和 thinking level。
- 服务、环境和 deployment ID。
- 每个仓库的绝对路径、base commit 和读写权限。
- 已启用能力及其无凭据 scope。

Policy 文件和 Pi session 不保存数据库密码、Nacos 密码、Playwright 密码、Redis 密码、RabbitMQ 密码、Elasticsearch 密码或 SLS secret。broker 在执行时从数据库重新读取部署配置，并验证配置仍与冻结 scope 一致。

能力输入使用 TypeBox schema，执行边界会再次做语义校验。统一限制包括：

- 能力超时 15 秒；Playwright/Nacos 进程另有自己的运行时上限。
- 单个能力结果最大 1 MiB。
- MySQL 最多 500 行，SQL 最长 20,000 字符。
- Redis 最多 100 个 key，scan 最多 500 条。
- Elasticsearch 最多 200 条结果。
- SLS 最多 200 条结果。
- Nacos 最多 50 个精确 Data ID。
- Playwright 最多 50 个声明式动作。

结果必须完整返回。超过限制时抛出 `capability_result_too_large` 等显式错误，不返回截断或过滤后的部分证据。

## 外部能力

- MySQL：仅一个只读 statement；SQL 验证、只读事务和只读账号是独立防线。
- Redis：仅 `GET`、`MGET`、`HGET`、`HGETALL`、`TYPE`、`TTL`、`SCAN`。
- Elasticsearch：仅 search、count、mapping；拒绝 redirect。
- RabbitMQ：仅 Management API overview、queues、queue、bindings，不消费消息。
- SLS：通过本地 Aliyun CLI 查询授权 logstore。
- Nacos：临时受限容器读取页面列出的精确 Data ID，不支持 glob。
- Playwright：临时受限容器访问固定 base URL，执行声明式 goto/login/click/fill/select/wait 动作。

## SSE

`GET /api/issues/:key/agent-stream` 先回放当前 active branch，再发送实时事件。SSE writer 保证：

- replay 和实时事件有序。
- `response.write()` 返回 false 时等待 `drain`。
- 客户端断开时释放 backpressure wait。
- 长会话不会因一次背压直接销毁连接。

## code-server

所有工单共享一个 code-server 容器。容器只挂载状态目录中的 workspaces/repositories、持久 code-server 数据、Pi 配置以及只读 Node/Git 运行时。打开工单时使用 `folder` 查询参数定位 `/home/coder/state/workspaces/<issue-key>`。
