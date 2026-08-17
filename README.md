# Issue Pilot

Issue Pilot 是面向可信内部代码库的本地优先 AI 工单系统。它把 Issue、Service/Deployment 配置、Git 代码上下文、Pi Agent 会话、附件和受限只读数据查询组织在一个可追踪的有状态应用中。

## 能力

- 一个 Service 管理一个或多个带稳定 alias 的 Git Repository。
- 每个 Environment 配置 Repository 基线分支、Pi model 和 capability。
- Prod/test 每轮读取当前 Deployment 分支的最新 fetched commit，始终只读。
- Dev 使用 Issue 专属本地 branch 和 worktree，可编辑代码并运行受限 npm/Maven action。
- Resolved dev workspace 可受管释放；代码继续由本地 working branch 保存，并可只读浏览或 reopen。
- 每张 Issue 持久保存 Pi JSONL、Attachment、Comment、Repository 和 Workspace 状态。
- 内置 VS Code Workbench 提供 Explorer、Search、SCM Changes/Graph、revision Diff 和 Markdown Preview；开发环境可编辑并保存现有workspace文件，测试和正式环境只读。
- Nacos、MySQL、Redis、RabbitMQ、Elasticsearch、DMS 和 SLS 作为有界只读 Pi tools。
- 用户由 SQLite 管理，支持新增、编辑、启用和停用，同时保留历史署名。

## 代码模式

| 场景 | 代码来源 | Agent 权限 |
| --- | --- | --- |
| Prod/test | 当前 Deployment 各 `baseBranch` 的最新 commit | 只读 |
| Active dev | `hotfix-*` 或 `feature-*` 本地 branch 的 Issue worktree | 读写，可运行受限项目命令 |
| Released dev | Bare store 中本地 working branch tip 的 immutable checkout | 只读，可 reopen |

SQLite、Attachment、Pi JSONL、bare repository、本地 Issue branch 和 active dev worktree 是 durable state。Runtime link 和 immutable checkout 是可重建生成物。Dirty、untracked、running、结构异常或数据库未登记的状态不会被自动删除。

## 运行模型

```text
Browser
  -> trusted TLS/auth proxy
  -> one application container
       Fastify + static Web/Workbench
       AgentEngine + Pi SDK
       SQLite + Git/workspace managers
       protocol clients + ProcessToolRuntime
```

生产只使用一个Kubernetes application Pod。SQLite、Git、Agent和Web不拆成独立服务，并保持单副本。Node/Maven项目命令由Issue-scoped Unix socket broker重新授权，再由application进程中的`ProcessToolRuntime`执行。DMS/SLS同样通过该执行器调用镜像PATH中的Aliyun CLI。Agent不拥有容器或Kubernetes API。

## 快速开始

本地验证需要Node/npm；image构建需要Podman或Docker：

```bash
npm ci
npm run typecheck
npm test
npm run build
scripts/playwright.sh prepare
podman build --pull=always -f Containerfile -t registry.example.com/issue-pilot:0.1.0 .
```

准备`/etc/issue-pilot`运行配置目录并执行`kubectl apply -f deploy/issue-pilot.yaml`即可部署，完整命令见[部署说明](docs/DEPLOYMENT.md)。生产端口只通过带TLS/auth的Ingress开放。前端迭代可另启：

```bash
npm run dev:web
```

Vite 默认监听 `0.0.0.0:4173` 并代理 API，只能用于可信开发网络。

升级应按[运维手册](docs/RUNBOOK.md#升级)隔离流量、停止Pod、创建一致备份并验证migration副本。

## 配置

所有应用路径、端口、默认值、retention、timeout和budget来自根目录`issue-pilot.config.ts`。Image、资源、挂载和probe只由`deploy/issue-pilot.yaml`拥有，不在应用配置中重复。

User、Service、Repository、Deployment、model、branch 和完整 capability credential 存在 SQLite。根配置的 bootstrap user 只在 `subjects` 为空时插入一次。Pi/npm/Maven 原生配置由 Operator 文件管理，不进入 SQLite。

完整字段见[配置说明](docs/CONFIGURATION.md)。

## State

默认 state root：

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

`.issue-pilot` 可能包含生产 credential、查询结果、源码、附件、Pi JSONL 和本地 branch。不要把它当作缓存，不要在 API 运行时移动或复制数据库主文件，也不要直接删除 unknown Issue/workspace、bare store 或历史 `code-server` 数据。

## 安全边界

- API 没有内置 authentication/authorization。
- 页面用户切换和 `X-Issue-Pilot-Subject` 只选择启用用户及写入署名，不是认证。
- Kubernetes Service必须由带TLS/auth的可信Ingress保护。
- Application、Pi 和项目脚本使用同一低权限 OS 身份；容器不是不可信代码 sandbox。
- Workbench 和 Source API 会返回内部源码；开发环境还允许保存现有workspace文件，属于敏感接口。
- `GET /api/config` 不返回已存 secret，但包含内部 Repository、model 和 scope。
- Deployment credential 不进入配置 GET、`AgentSessionContext`、prompt、tool schema、tool input、argv 或日志；DMS/SLS 使用临时 `0600` CLI profile。
- Capability result 会进入模型上下文和该 Issue 的 Pi JSONL。
- DMS SQL 和 SLS query 会短暂出现在 application 进程列表；需要隐藏 query 时必须改为 SDK 或签名 HTTP client。

## API 范围

Web 使用以下域：

- User：`/api/users`、`/api/users/manage`、`/api/users/:subject`、`/api/me`
- Configuration：`/api/catalog`、`/api/config`、`/api/services/*`
- Issue：`/api/issues`、`/api/issues/:key`、status、comments 和 development conversion
- Agent：retry、messages 和 SSE stream
- Attachment：只读 GET；写入只属于 Issue create/edit multipart transaction
- Workspace：stats 和受管 release
- Source：repositories、tree、file、search、blame、history、commit、commit-file、diff、diff-file

不存在独立 Attachment write route、Issue sync route、Terminal或任意Git command route。Source write仅保存开发workspace中的现有UTF-8文件，不提供创建、删除、重命名、stage或commit。

## 验证

```bash
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
git diff --check
```

自动测试只使用临时 SQLite、state root 和 Git remote，不应接触真实 `.issue-pilot`。

## 文档

| 文档 | 内容 |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | 状态、所有权、Git/runtime、Agent、并发和不变量 |
| [Configuration](docs/CONFIGURATION.md) | 根配置、Service/Deployment、model、capability 和 secret 数据流 |
| [Deployment](docs/DEPLOYMENT.md) | Container image、单节点Kubernetes、网络和首次验收 |
| [Development](docs/DEVELOPMENT.md) | Module owner、改动方法、测试和 review |
| [Runbook](docs/RUNBOOK.md) | 健康检查、容量、备份、升级、恢复和故障 |
| [Comprehensive Audit](docs/COMPREHENSIVE-AUDIT.md) | `0e1924d`历史基线的全项目完整审查 |
| [File Audit](docs/FILE-AUDIT.md) | 当前tracked文件逐文件设计清单 |
| [Module Audit](docs/MODULE-AUDIT.md) | 按目录/功能模块评估边界、重复和精简空间 |
| [Agent Guide](AGENTS.md) | Coding Agent状态保护和完成标准 |
