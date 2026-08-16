# Issue Pilot

Issue Pilot 是一个运行在可信单机上的本地优先 AI 工单系统。它把工单、Service/Deployment 配置、代码上下文、Pi Agent 会话、附件和受限外部查询能力组织成一条可追踪的处理流程。

## 当前能力

- 用 Service 管理一个或多个带稳定别名的 Git Repository。
- 为 `prod`、`test`、`dev` 分别配置 Repository 基线分支、Pi model 和 capability。
- 为每张 Issue 持久保存独立 Pi JSONL 会话、附件和 workspace 状态。
- Prod/test 每轮使用 Deployment 当前基线分支的最新 commit，并保持只读。
- Dev 使用 Issue 专属本地分支和 worktree，可编辑、测试和构建。
- Released dev 在释放大体积 worktree 后，仍可从本地 Issue branch 展示只读快照并恢复开发。
- 通过内置VS Code Workbench只读浏览multi-root Repository，使用Explorer、Editor Groups/Tabs、Search、带提交图的Source Control和Markdown Preview；Agent会话嵌入Bottom Panel，工单详情显示在Secondary Side Bar。
- Dev项目命令通过Unix socket broker授权并由application容器内唯一的`ProcessToolRuntime`执行，使用镜像中的Node 26、Maven 3.9/Temurin 8和Aliyun CLI。
- 生产大镜像把Fastify、Pi、Node、Maven/JDK、Aliyun CLI、静态Web和只读Workbench收敛为单一入口；Compose只向宿主loopback发布，不挂Podman socket或启动工具子容器。
- 提供SQLite用户管理页面，支持添加、编辑和启停用户并保留历史署名。
- 提供 Nacos、MySQL、Redis、RabbitMQ、Elasticsearch、DMS 和 SLS 只读 Agent capability。
- 在严格验证状态、Git cleanliness 和目录所有权后自动回收 resolved dev workspace。

## 代码模式

| Issue 场景 | 代码来源 | Agent 代码权限 |
| --- | --- | --- |
| Prod/test | 当前 Deployment 各 Repository `baseBranch` 的最新 fetched commit | 只读 |
| Active dev | Issue 专属 `hotfix-*` 或 `feature-*` 本地分支和 worktree | 可读写，可运行项目命令 |
| Released dev | Bare repository 中本地 Issue branch tip 的 immutable checkout | 只读，可重开恢复 |

附件、Pi JSONL、SQLite、bare repository 和本地 Issue branch 是持久状态。Runtime和 immutable checkout 是可重建生成物。Dev workspace 只有通过受管 release 才能回收，dirty、untracked 或结构异常时不会自动删除。

## 系统组成

```text
Browser
    |
Fastify API + static Web/Workbench ---- SQLite
    |
AgentEngine ---- Pi SDK
    |
IssueProjectManager ---- bare Git / worktree / checkout / runtime
    |
Source browser ---- bounded file / rg / Git reads
    |
Capability broker ---- bounded protocol clients / ProcessToolRuntime

Project tool broker ---- ProcessToolRuntime ---- current process PATH
Application test harness ---- temporary Playwright container
```

详细状态模型与所有权见 [架构说明](docs/ARCHITECTURE.md)。

## 快速开始

宿主只需要项目构建使用的Node.js/npm、Podman和Compose provider。API、Pi、Git、ripgrep、curl、Node/npm、Maven/JDK和Aliyun CLI全部由application大镜像提供；容器不要求Podman API socket，也不启动工具子容器。Playwright容器只用于Operator浏览器验收。构建和首次检查见[部署说明](docs/DEPLOYMENT.md)。

```bash
npm ci
infra/playwright.sh prepare
infra/application.sh config
infra/application.sh prepare
npm run server
```

application容器已同源提供Web。前端迭代时可在另一个终端启动Vite：

```bash
npm run dev:web
```

开发地址：

| 服务 | 地址 |
| --- | --- |
| Vite Web | <http://127.0.0.1:4173/> |
| API | <http://127.0.0.1:3000/> |

生产构建由Fastify在`http://127.0.0.1:3000/`同源提供Web、Workbench和API。生产Compose只管理一个application大容器，项目工具和Aliyun CLI按请求在容器内启动受控子进程。准备命令为：

```bash
infra/application.sh config
infra/application.sh prepare
infra/application.sh status
```

生产切换前必须按[部署说明](docs/DEPLOYMENT.md#生产应用容器)停止现有API并备份；不需要启用rootless Podman API socket。不要在当前API仍运行时直接执行`start`。API启动也会自动执行未应用的数据库migration。首次进入Web后，先创建Service、Repository和至少一个Deployment，再创建Issue。

## 配置

所有应用路径、端口、默认值、retention、timeout 和 size/count 上限都来自根目录：

```text
issue-pilot.config.ts
```

应用不接受环境变量覆盖。Node、Web 和 `infra/*.sh` 均读取同一配置；Shell 通过 `infra/config-value.mjs` 获取标量值。

User、Service、Deployment、model、Repository branch 和 capability credential 保存在 SQLite。根配置中的bootstrap用户只用于初始化空库。字段说明见 [配置说明](docs/CONFIGURATION.md)。

## 状态目录

默认状态根是 `.issue-pilot`：

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

这个目录可能包含真实工单、credential、生产查询结果、附件、Pi JSONL 和本地 Git branch，不是普通缓存。不要在 API 运行时移动它，也不要直接删除未知目录。备份、升级和恢复见 [运维手册](docs/RUNBOOK.md)。

## 安全边界

Issue Pilot 没有内置认证。右上角用户切换和 `X-Issue-Pilot-Subject` 只决定本地视角与写入署名，不构成身份验证。内置代码浏览器不提供终端或文件写入能力。

生产部署必须满足：

- Compose只向宿主loopback发布application容器端口。
- Web和API由同机TLS + authentication/authorization proxy保护。
- API/Pi 使用专用低权限宿主账号，不能以 root 运行。
- 项目脚本与API在application容器中使用同一OS身份和可读state；只适用于可信内部Repository，不构成Agent sandbox。
- `/api/config` 不返回已存 credential，但仍包含内部 Repository、model 和 capability scope；Service 写请求可能携带新 credential，配置路由必须严格授权且不得记录 body。
- Credential 不进入 AgentSessionContext、Agent prompt 或 tool input；完整 Deployment config 只保留在 API session 闭包中。
- Capability 查询结果会发送给 Agent，并写入该 Issue 的 Pi JSONL；结果本身可能包含敏感业务数据。

更多部署约束见 [部署说明](docs/DEPLOYMENT.md#安全边界)。

## API 摘要

当前 Web 使用以下公开路由：

- 用户：`/api/users`、`/api/users/manage`、`/api/users/:subject`、`/api/me`
- 配置：`/api/catalog`、`/api/config`、`/api/services/*`
- Issue：`/api/issues`、`/api/issues/:key`、`/status`、`/comments`
- Agent：`/retry`、`/agent-messages`、`/agent-stream`
- Attachment：只读 `GET /api/issues/:key/attachments/:attachmentId`
- Workspace：`GET /api/workspaces/stats`、`DELETE /api/issues/:key/workspace`
- Source：`/api/issues/:key/source/repositories`、`/tree`、`/file`、`/search`、`/history`、`/commit`、`/commit-file`、`/diff`、`/diff-file`

附件只能随 Issue 创建或编辑事务增删。不存在独立 attachment write route，也不存在 `/api/issues/:key/sync`。

## 开发验证

自动测试使用临时 SQLite、临时 state root 和本地 Git remote，不使用项目真实 `.issue-pilot`。

```bash
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
git diff --check
```

## 文档

| 文档 | 负责内容 |
| --- | --- |
| [架构说明](docs/ARCHITECTURE.md) | 状态、所有权、Agent/Git/runtime、并发和安全不变量 |
| [配置说明](docs/CONFIGURATION.md) | Service、Deployment、model 和 capability 字段 |
| [部署说明](docs/DEPLOYMENT.md) | 宿主依赖、进程、容器、代理和首次验收 |
| [Kubernetes基线](docs/KUBERNETES.md) | 单大容器、单副本StatefulSet、PVC、Secret和恢复边界 |
| [开发指南](docs/DEVELOPMENT.md) | 源码边界、改动方法、测试和 review checklist |
| [运维手册](docs/RUNBOOK.md) | 健康检查、容量、备份、升级、恢复和故障处理 |
| [Agent Guide](AGENTS.md) | Coding Agent 的状态保护和完成标准 |
