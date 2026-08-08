# Issue Pilot

Issue Pilot 是一个基于 Pi 的本地优先工单处理系统。它使用 SQLite 保存工单和部署配置，为每个工单准备隔离的 Git worktree，通过 Pi RPC 运行持久会话，并用 SolidJS 提供工单、配置和 Agent 对话界面。

## 当前边界

- 工单状态固定为 `open`、`in_progress`、`pending`、`resolved`。
- 环境固定为 `prod`、`test`、`dev`。
- 每个服务可以包含多个前端或后端仓库，以及每个环境一份部署配置。
- 每份部署配置必须选择一个 Pi 模型和受支持的 thinking level。
- 本地代码操作使用 Pi 内置工具，不提供旧的自定义 Git、附件、BusyBox 或文件工具。
- Redis、MySQL、Elasticsearch、RabbitMQ 和 SLS 使用受限的原生或本地客户端。
- Nacos 和 Playwright 使用临时、受限的 Podman 容器。
- 所有外部能力都是只读、按部署授权、带输入和结果大小限制的工具调用。
- code-server 使用一个共享容器，通过 folder 参数打开对应工单工作区。

详细设计见 [架构说明](docs/ARCHITECTURE.md)，页面配置规则见 [配置说明](docs/CONFIGURATION.md)，部署和维护见 [运维说明](docs/OPERATIONS.md)。

## 环境要求

- Linux 或 WSL
- Node.js 24 或更高版本
- npm
- Git
- 已安装并配置的 Pi，配置位于 `~/.pi/agent`
- Podman，用于 Nacos、Playwright 和 code-server
- 可选：Aliyun CLI，用于 SLS 查询

## 安装

```bash
npm ci
```

项目使用单一根 package，不需要在其他目录单独安装依赖。SolidJS 和 `@solidjs/web` 固定为 `2.0.0-beta.29`。

## 初始化

首次运行前执行迁移，可选执行种子数据：

```bash
npm run db:migrate
npm run db:seed
```

默认状态目录为 `.issue-pilot`，数据库为 `.issue-pilot/issues.db`。API 启动时也会自动执行当前迁移。

准备容器镜像和 Playwright 运行时：

```bash
infra/pi-tools.sh prepare
infra/pi-tools.sh status
```

## 启动

启动 API：

```bash
npm run server
```

默认地址为 <http://127.0.0.1:3000/>。

启动 Web 开发服务器：

```bash
npm run dev:web -- --host 127.0.0.1
```

默认地址为 <http://127.0.0.1:4173/>。

code-server 会在 Agent 准备工作区时自动确保共享容器已启动，也可手动运行：

```bash
infra/code-server.sh ensure
infra/code-server.sh status
```

默认地址为 <http://127.0.0.1:18080/>。

## 验证

```bash
npm run typecheck
npm test
npm run build
```

`npm test` 同时运行后端 Node 测试和 Web Vitest 测试。

## 目录

```text
src/agent/          Agent 生命周期、Pi RPC 会话和事件
src/capabilities/   外部只读能力及统一契约
src/db/             SQLite/Drizzle schema、迁移和种子
src/domain/         跨层业务契约
src/http/           Fastify API、附件、SSE 和配置持久化
src/pi/             Pi extension、模型目录和执行策略
src/web/            SolidJS Web 应用
src/workspace/      Git worktree、状态路径和 code-server
infra/              受限运行器与运维脚本
drizzle/            SQLite 迁移
tests/              后端测试
```

## 安全提示

当前 API 没有内置身份认证。`GET /api/config` 会返回实际保存的 `password` 和 `accessKeySecret`，用于页面编辑后完整回写配置。默认 `HOST=127.0.0.1` 只能本机访问；将 `HOST` 改为外部地址前，必须在 API 前部署经过验证的身份认证、TLS 和访问控制代理。

页面表单不是安全边界。HTTP 保存校验、Agent policy、能力 broker 和具体客户端都会再次验证授权范围和输入。
