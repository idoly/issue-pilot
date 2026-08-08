# Issue Pilot

Issue Pilot 是一个基于 Pi 的本地优先工单处理系统。它使用 SQLite 保存工单和部署配置，为每个工单准备隔离的 Git worktree，通过 Pi SDK 运行持久会话，并用 SolidJS 提供工单、配置和 Agent 对话界面。

## 当前边界

- 工单状态固定为 `open`、`in_progress`、`pending`、`resolved`。
- 环境固定为 `prod`、`test`、`dev`。
- 每个服务可以包含多个前端或后端仓库，以及每个环境一份部署配置。
- 每份部署配置必须选择一个 Pi 模型和受支持的 thinking level。
- Pi SDK 使用内置文件和 shell 工具；只读环境不启用 `bash`、`edit` 或 `write`。
- Redis、MySQL、Elasticsearch、RabbitMQ、Nacos 和 SLS 使用受限的宿主原生客户端或 CLI。
- Playwright 使用宿主全局 `playwright-core@1.62.1` 和临时浏览器容器。
- code-server 使用一个共享容器，通过 folder 参数打开对应工单工作区。

详细设计见 [架构说明](docs/ARCHITECTURE.md)，页面配置规则见 [配置说明](docs/CONFIGURATION.md)，部署和维护见 [运维说明](docs/OPERATIONS.md)。

## 环境要求

- Linux 或 WSL
- Node.js 24 或更高版本，固定宿主路径 `/usr/local/node`
- Git，固定宿主路径 `/usr/bin/git`
- Java，当前固定宿主路径 `/usr/local/java`
- Maven，固定宿主路径 `/usr/local/maven`
- Pi 0.84.1，配置位于 `~/.pi/agent`
- Maven settings 和本地依赖库位于 `~/.m2`
- npm 配置和缓存位于 `~/.npmrc`、`~/.npm`
- Aliyun CLI 3.4.11 或兼容版本，用于 SLS 内置 `GetLogs`
- Podman，仅用于 Playwright 浏览器和 code-server

## 安装

```bash
npm ci
```

项目使用单一根 package。SolidJS 和 `@solidjs/web` 固定为 `2.0.0-beta.29`。

准备宿主全局 Playwright core 和固定浏览器镜像：

```bash
infra/pi-tools.sh prepare
infra/pi-tools.sh status
```

## 初始化

```bash
npm run db:migrate
npm run db:seed
```

默认状态目录为 `.issue-pilot`，数据库为 `.issue-pilot/issues.db`。API 启动时也会自动执行当前迁移。

## 启动

```bash
npm run server
npm run dev:web -- --host 127.0.0.1
infra/code-server.sh ensure
```

默认地址：

- API：<http://127.0.0.1:3000/>
- Web：<http://127.0.0.1:4173/>
- code-server：<http://127.0.0.1:18080/>

## 验证

```bash
npm run typecheck
npm test
npm run build
```

## 目录

```text
src/agent/          Agent 生命周期、Pi SDK session 和事件
src/capabilities/   外部只读能力及统一契约
src/db/             SQLite/Drizzle schema、迁移和启动恢复
src/domain/         跨层业务契约
src/http/           Fastify 装配及配置、工单、附件、Agent 路由
src/pi/             Pi 模型目录、custom tools 和执行策略
src/web/            SolidJS Web 应用
src/workspace/      Git worktree、宿主 project wrappers 和 code-server
infra/              Playwright runner、Aliyun profile 和运维脚本
drizzle/            SQLite 迁移
tests/              后端测试
```

## 安全提示

当前 API 没有内置身份认证。`GET /api/config` 会返回实际保存的 `password` 和 `accessKeySecret`，用于页面编辑后完整回写配置。默认 `HOST=127.0.0.1` 只能本机访问；外部暴露前必须部署身份认证、TLS 和访问控制代理。

页面表单不是安全边界。HTTP 保存校验、冻结 Agent policy、capability tool schema 和具体客户端都会再次验证授权范围和输入。
