# Issue Pilot

Issue Pilot 是面向可信内部代码库的本地优先 AI 工单系统。它把 Issue、Service/Deployment 配置、Git 代码上下文、Pi Agent 会话、附件和受限只读数据查询组织在一个可追踪的有状态应用中。

## 能力

- 一个 Service 管理一个或多个带稳定 alias 的 Git Repository。
- 每个 Environment 配置 Repository 基线分支、Pi model 和 capability。
- Prod/test 每轮读取当前 Deployment 分支的最新 fetched commit，始终只读。
- Dev 使用 Issue 专属本地 branch 和 worktree，可编辑代码并运行受限 npm/Maven action。
- Resolved dev workspace 可受管释放；代码继续由本地 working branch 保存，并可只读浏览或 reopen。
- 每张 Issue 持久保存 Pi JSONL、Attachment、Comment、Repository 和 Workspace 状态。
- 内置只读 VS Code Workbench 提供 Explorer、Search、SCM Changes/Graph、revision Diff 和 Markdown Preview。
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

Compose 和 Kubernetes 使用同一个 application 镜像。SQLite、Git、Agent 和 Web 不拆成独立服务；生产必须保持单副本。Node/Maven 项目命令由 Issue-scoped Unix socket broker重新授权，再由 application 进程中的 `ProcessToolRuntime` 执行。DMS/SLS 同样通过该执行器调用镜像 PATH 中的 Aliyun CLI。Agent 不拥有 Podman/Kubernetes API 或 Playwright 工具。

## 快速开始

宿主需要 Node/npm、Podman 和 Compose provider。运行账号还需要只读 Pi/npm/Maven 配置及可写 npm/Maven cache，详见[部署说明](docs/DEPLOYMENT.md)。

```bash
npm ci
install -d -m 0700 .issue-pilot "$HOME/.npm" "$HOME/.m2/repository"
infra/playwright.sh prepare
infra/application.sh config
infra/application.sh prepare
npm run typecheck
npm test
npm run build
npm run server
```

生产 application 在 `http://127.0.0.1:3000/` 可访问，但 Compose 实际发布 `0.0.0.0:3000` 以支持 WSL/Windows 转发；必须用宿主防火墙或可信代理限制来源。前端迭代可另启：

```bash
npm run dev:web
```

Vite 默认监听 `0.0.0.0:4173` 并代理 API，只能用于可信开发网络。

不要在已有 application 容器存在时再次执行 `start`。升级应按[运维手册](docs/RUNBOOK.md#升级)停止服务、创建一致备份、验证 migration 副本，再 remove/start。

## 配置

所有运行路径、端口、默认值、retention、timeout、image 和预算来自根目录 `issue-pilot.config.ts`。应用不接受环境变量覆盖；Shell 通过 `infra/config-value.mjs` 读取同一对象。

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
- Compose 发布端口必须由防火墙或带 TLS/auth 的可信 proxy 保护。
- Application、Pi 和项目脚本使用同一低权限 OS 身份；容器不是不可信代码 sandbox。
- Workbench 和 Source API 只读，但会返回内部源码，仍属于敏感接口。
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
- Source：repositories、tree、file、search、history、commit、commit-file、diff、diff-file

不存在独立 Attachment write route、Issue sync route、Terminal、Source write route 或任意 Git command route。

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
| [Deployment](docs/DEPLOYMENT.md) | Compose 镜像、宿主、网络、proxy 和首次验收 |
| [Kubernetes](docs/KUBERNETES.md) | 单副本 StatefulSet、PVC、Secret 和上线边界 |
| [Development](docs/DEVELOPMENT.md) | Module owner、改动方法、测试和 review |
| [Runbook](docs/RUNBOOK.md) | 健康检查、容量、备份、升级、恢复和故障 |
| [Comprehensive Audit](docs/COMPREHENSIVE-AUDIT.md) | 全项目架构、质量、优先级和逐文件完整审查 |
| [File Audit](docs/FILE-AUDIT.md) | 当前tracked文件逐文件设计清单 |
| [Module Audit](docs/MODULE-AUDIT.md) | 按目录/功能模块评估边界、重复和精简空间 |
| [Agent Guide](AGENTS.md) | Coding Agent状态保护和完成标准 |
