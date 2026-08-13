# Issue Pilot

Issue Pilot 是一个本地优先的 AI 工单处理系统。它把工单、代码上下文、Pi Agent 会话、附件和受限外部能力组织在同一条可追踪的处理流程中，适合在可信主机上处理需要查代码、分析数据或完成开发修改的内部工单。

## 核心能力

- 以 Service、Repository 别名、Environment 和按仓库分支配置的 Deployment 描述业务系统。
- 为每张工单创建独立、持久的 Pi JSONL 会话。
- Prod/test 始终使用最新 Deployment commit 的只读代码。
- Dev 使用工单专属分支和 worktree，支持编辑、测试和构建。
- 通过统一 multi-root code-server workspace 查看代码、Source Control 和 Git 历史。
- 按冻结授权调用 Nacos、MySQL、阿里云 DMS、Redis、RabbitMQ、Elasticsearch、SLS 和 Playwright。
- 持久保存附件、会话、本地 Issue branch 和审计所需状态。
- 在严格检查 clean、idle 和目录布局后回收大型 dev workspace。

## 工单流程

创建工单时选择 Service、Environment 和 Issue type。Service 定义有稳定 ID 和唯一别名的 Repository；Deployment 为每个 Repository 定义环境基线分支，并配置 Pi model 和可用 capability。

| 场景 | 代码来源 | Agent 权限 |
| --- | --- | --- |
| Prod/test | 每轮 fetch Deployment base branch，按 commit 复用只读 checkout | 读取代码和授权 capability |
| 活动 dev | 从 base branch 创建工单专属分支和 worktree | 读取、编辑和执行项目命令 |
| 已释放 dev | 从本地 Issue branch tip 创建只读 checkout | 查看代码、会话和 Git 历史 |

Dev workspace 中的依赖和构建输出可以回收，但附件、Pi JSONL、本地工作分支和数据库记录不会随之删除。工单重开后可以从本地 branch 恢复开发。已有 dev Repository 的 `base_branch` 是工单首次准备时的历史基线；之后修改 Service 分支不会改写它，新加入该工单的 Repository 才使用当前 Deployment 分支。

## 系统组成

```text
SolidJS Web
    |
Fastify API ---- SQLite
    |              |
AgentEngine      Issue / Service / Deployment state
    |
Pi SDK ---- Workspace manager ---- bare Git / worktree / checkout
    |
Capability broker ---- bounded external clients
    |
code-server / temporary Playwright containers
```

系统运行在一台可信主机上：

- Fastify 负责 API、事务、SSE 和启动恢复。
- SQLite 是工单、配置和 workspace 状态的事实源。
- Bare Git repositories 保存共享 objects、refs 和本地 Issue branches。
- SolidJS 提供工单、配置、统计和 Agent 对话界面。
- 一个共享 code-server 容器打开不同工单的 multi-root runtime。
- Playwright 每次调用使用临时容器，不保留持久浏览器进程。

完整设计见 [架构说明](docs/ARCHITECTURE.md)。

## 快速开始

宿主机需要 Node.js 24+、Pi、Git、Java、Maven 和 Podman。固定路径、版本及安全要求见 [部署说明](docs/DEPLOYMENT.md#运行前检查)。

```bash
npm ci
infra/playwright.sh prepare
npm run db:migrate
npm run server
```

另一个终端启动 Web：

```bash
npm run dev:web
```

默认地址：

| 服务 | 地址 |
| --- | --- |
| Web | <http://127.0.0.1:4173/>；受信任开发网络可通过宿主转发地址访问 |
| API | <http://127.0.0.1:3000/> |
| code-server | <http://127.0.0.1:18080/> |

首次启动后，在 Web 配置页创建 Service、为 Repository 设置唯一别名，并为所需 Environment 的每个 Repository 配置 Deployment 分支。

## 配置与状态

所有可调整的路径、端口、默认值、timeout、资源和结果上限集中在根目录 `issue-pilot.config.ts`。应用不接受环境变量覆盖。Shell 通过 `infra/config-value.mjs` 读取同一配置。

默认状态目录 `.issue-pilot` 包含真实业务数据：

```text
issues.db                     SQLite
issues/<key>/attachments      durable attachments
issues/<key>/agent            Pi JSONL
issues/<key>/runtime          generated code-server resources
git/repositories              bare repositories and local branches
git/checkouts                 generated immutable checkouts
workspaces/<key>              writable dev worktrees
```

不要把 `.issue-pilot` 当作普通缓存。数据所有权、备份和恢复要求见 [运维手册](docs/RUNBOOK.md)。

## 安全边界

Issue Pilot 没有内置身份认证，code-server 使用 `--auth none` 并提供终端。API 和 code-server 必须只监听 loopback；外部访问必须经过同机认证、授权和 TLS 代理。

Deployment credential 保存在本机 SQLite。Credential 不进入 policy、prompt、session event、日志或进程参数。Capability client 即使在上层已经校验，也会再次限制目标、动作、timeout 和结果大小。

## 文档

| 文档 | 内容 |
| --- | --- |
| [架构说明](docs/ARCHITECTURE.md) | 状态模型、数据所有权、Git/runtime 和授权原理 |
| [配置说明](docs/CONFIGURATION.md) | Service、Deployment、model 和 capability 字段 |
| [部署说明](docs/DEPLOYMENT.md) | 宿主准备、服务部署、代理和容器 runtime |
| [开发指南](docs/DEVELOPMENT.md) | 源码结构、改动方法、命名约定和测试 |
| [运维手册](docs/RUNBOOK.md) | 健康检查、容量、备份、升级和故障处理 |
| [Agent Guide](AGENTS.md) | Coding Agent 的状态保护和完成标准 |

## 开发验证

自动测试使用临时 SQLite、Git remote 和 state root，不使用项目中的真实 `.issue-pilot`。

```bash
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
git diff --check
```
