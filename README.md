# Issue Pilot

Issue Pilot 是面向可信内部代码库的本地优先 AI 工单系统。它在一个有状态应用中统一管理 Issue、Service/Deployment 配置、Git 代码上下文、Pi Agent 会话、附件和受限的只读外部数据访问。

## 主要能力

- Service 管理一个或多个带稳定 alias 的 Git Repository。
- Deployment 按 Environment 配置每个 Repository 的基线分支和可用 capability。
- 所有 Service 和 Environment 共享唯一的全局 Pi provider、model 和 thinking level。
- Prod/test 每轮使用当前 Deployment 分支最新 fetched commit，Agent 和 Workbench 均只读。
- Dev 使用 Issue 专属本地 branch 和 worktree，可修改代码并运行受限 npm/Maven action。
- Resolved dev workspace 可受管释放；代码由 bare store 中的本地 working branch 持久保存，可只读浏览并在 reopen 时恢复。
- 每张 Issue 持久保存 Pi JSONL conversation、Attachment、Comment、Repository 投影和 Workspace 状态；Agent 输入框可直接粘贴图片并随消息发送给模型。
- 内置 Workbench 提供 Explorer、Search、SCM Changes/Graph、revision Diff、blame、history 和安全的 Markdown Preview。
- Nacos、MySQL、Redis、RabbitMQ、Elasticsearch、DMS MCP 和 SLS 作为 Deployment-scoped 只读 Pi tools；DMS 可配置多个 schema，Agent 每次只能选择一个已授权目标。
- 用户由 SQLite 管理，停用用户不会删除历史署名。

## Web 界面

顶级导航只有“首页 / 工单 / 配置”：

- 首页展示完整团队工单动态和“产出 / 分布 / 团队 / 资源”运营视图。
- 工单页左侧只展示处理人为当前登录用户的工单，并支持状态、服务、环境和关键词筛选；首页团队动态可打开跨人员工单详情，但不会把该工单注入当前用户队列。
- 配置页包含“用户 / 模型 / 服务”三个保持挂载的 Tab，默认打开“服务”。
- 服务编辑器按“代码仓库 / 环境部署 / 服务描述”组织；Deployment 折叠标题始终显示环境名和已启用 capability，展开后编辑分支、添加或移除 capability 及其参数。

## 代码模式

| 场景 | 代码来源 | 权限 |
| --- | --- | --- |
| Prod/test | 当前 Deployment 各 `baseBranch` 的最新 commit | Agent、Source 和 Workbench 只读 |
| Active dev | `hotfix-*` 或 `feature-*` 本地 branch 的 Issue worktree | 读写，可运行受限项目命令 |
| Released dev | 本地 working branch tip 的 immutable checkout | 只读，可 reopen |

Dirty、untracked、running、结构异常、changed checkout 或数据库未登记的状态不会被自动删除或猜测修复。

## 运行拓扑

```text
Browser
  -> trusted TLS/auth proxy
  -> one application container
       Fastify + static Solid Web/Workbench
       SQLite/Drizzle
       AgentEngine + Pi SDK + Pi JSONL
       Git bare stores/worktrees/generated runtimes
       protocol clients + authorized process runtime
```

生产保持一个 Kubernetes Pod。应用不访问 Kubernetes API，不挂载 Docker/Podman socket，也不为 Agent 创建工具容器。项目代码仅适用于可信内部 Repository；application 进程不是恶意代码 sandbox。

## 快速验证

需要 Node/npm：

```bash
npm ci
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
```

前端开发：

```bash
npm run dev:web
```

Vite 默认监听 `0.0.0.0:4173` 并代理本机 API，只能用于可信开发网络。

构建镜像：

```bash
podman build --pull=always -f Containerfile \
  -t registry.example.com/issue-pilot:0.1.0 .
```

生产部署前必须准备 `/var/lib/issue-pilot`、`/etc/issue-pilot`、节点标签和可信 TLS/auth Ingress，详见[部署说明](docs/DEPLOYMENT.md)。升级前必须停机并创建一致备份，详见[运维手册](docs/RUNBOOK.md)。

## 配置与 State

应用配置不接受环境变量覆盖：

- 路径、端口、默认值、retention、timeout 和 budget：`issue-pilot.config.ts`
- User、Service、Repository、Deployment、全局 Agent model 和 capability credential：SQLite
- Image、资源、挂载和 probe：`Containerfile` 与 `deploy/issue-pilot.yaml`
- Pi/npm/Maven/SSH 原生配置：Operator 管理的 `/etc/issue-pilot`

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

`.issue-pilot` 可能包含生产凭据、业务查询结果、内部源码、附件、Pi JSONL、本地 branch 和备份。不要提交、缓存化或用作开发实验目录。

## 安全边界

- API 没有内置 authentication/authorization；`X-Issue-Pilot-Subject` 只选择启用用户和写入署名，不是认证。
- ClusterIP Service 必须由带 TLS 和组织认证授权的可信 Ingress 保护。
- `GET /api/config` 有意返回配置页需要的完整 Deployment credential；不得记录、监控或导出该响应。
- Credential 不进入 `AgentSessionContext`、prompt、tool schema/input、日志或诊断。
- DMS Bearer 只作为 session-local HTTPS Authorization header；SLS AccessKey 只写入调用级临时 `0600` profile。
- Capability result 会进入模型上下文和该 Issue 的 Pi JSONL，可能包含敏感业务数据。
- Source 和 Workbench 返回内部源码；dev mutation 会直接修改 Issue worktree，均属于敏感接口。

## API 范围

Web 使用以下 API 域：

- User：active user、current user、管理列表、创建与更新。
- Configuration：catalog、完整 config、全局 model、DMS scope resolve、Service CRUD。
- Issue：用户级固定个人队列、创建、正式跟进、关联开发工单管理、编辑、详情、状态转换和 Comment。
- Agent：retry、message、SSE stream。
- Attachment：完整性校验后的只读 GET；写入只属于 Issue create/edit multipart transaction。
- Workspace：stats、带审计历史的无状态 Scope Transition plan/apply 和受管 release/reopen。
- Source：Repository、tree、file/directory/path/rename、search、blame、history、commit、diff，以及受限 Stage、Unstage、Discard、Commit。

不存在独立 Attachment write route、Issue sync route、Terminal 或任意宿主 Git command endpoint。Source mutation 只允许 active development workspace，并按 Issue reservation 串行。

## 文档

| 文档 | 主题 |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | 所有权、状态、Git/runtime、Agent、并发和不变量 |
| [Configuration](docs/CONFIGURATION.md) | 根配置、SQLite 配置、全局模型、capability 和 secret 流 |
| [Deployment](docs/DEPLOYMENT.md) | Image、Kubernetes、挂载、网络和首次部署 |
| [Development](docs/DEVELOPMENT.md) | Module owner、修改配方、测试和 review |
| [Runbook](docs/RUNBOOK.md) | 健康检查、容量、备份、升级、恢复和故障处理 |
| [Agent Guide](AGENTS.md) | Coding Agent 的状态保护和完成标准 |
