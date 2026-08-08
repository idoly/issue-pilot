# Issue Pilot

Issue Pilot 是一个基于 Pi 的本地优先工单处理系统。它使用 SQLite 保存工单和 deployment 配置，为每个工单准备隔离的 Git worktree，通过同进程 Pi SDK 运行持久会话，并用 SolidJS 提供工单、配置和 Agent 对话界面。

## 运行边界

- 工单状态固定为 `open`、`in_progress`、`pending`、`resolved`。
- 环境固定为 `prod`、`test`、`dev`。
- 每个服务包含一个或多个仓库，以及每个环境一份 deployment 配置。
- 每份 deployment 必须选择一个已认证 Pi 模型和该模型支持的 thinking level。
- Pi 使用内置本地工具；只有所有仓库均为可写开发 worktree 时才启用 `bash`、`edit`、`write`。
- Redis、MySQL、Elasticsearch、RabbitMQ 和 Nacos 使用受限的宿主原生客户端；SLS 使用固定宿主 Aliyun CLI。
- Playwright 使用宿主全局 `playwright-core@1.62.1` 和按调用创建的固定浏览器容器。
- code-server 使用一个共享官方容器，通过 `folder` 参数打开对应工单工作区。
- capability 结果必须完整返回；命中行数、大小或动作边界时明确失败，不静默截断。

详细设计见 [架构说明](docs/ARCHITECTURE.md)，页面字段和授权规则见 [配置说明](docs/CONFIGURATION.md)，部署、升级和故障处理见 [运维说明](docs/OPERATIONS.md)。

## 固定依赖

- Linux 或 WSL
- Node.js 24 或更高版本：`/usr/local/node`
- Pi 0.84.1：`/usr/local/node/bin/pi`，配置位于 `~/.pi/agent`
- Git：`/usr/bin/git`、`/usr/libexec/git-core`、`/usr/share/git-core`
- Java：`/usr/local/java`
- Maven：`/usr/local/maven`
- Maven settings/cache：`~/.m2/settings.xml`、`~/.m2/repository`
- npm config/cache：`~/.npmrc`、`~/.npm`
- Aliyun CLI 3.4.11 或兼容版本：`/usr/local/sbin/aliyun`
- Podman：只承载 Playwright 浏览器和共享 code-server

Capability runtime 的路径、版本和镜像是代码内固定约定，不从环境变量覆盖。

## 安装

```bash
npm ci
infra/playwright.sh prepare
infra/playwright.sh status
```

项目使用单一根 package。`solid-js` 和 `@solidjs/web` 精确固定为 `2.0.0-beta.29`。

## 初始化

```bash
npm run db:migrate
```

默认状态目录为 `.issue-pilot`，数据库为 `.issue-pilot/issues.db`。API 启动时也会自动迁移、恢复中断状态，并确保 `prod`、`test`、`dev` 三个环境存在。当前用户由 `ISSUE_PILOT_SUBJECT` 或本地默认 subject 创建；服务、仓库和 deployment 应通过配置页面维护，不执行带业务数据的 seed。

## 本机启动

```bash
npm run server
npm run dev:web
infra/code-server.sh ensure
```

默认地址：

- API：<http://127.0.0.1:3000/>
- Web：<http://127.0.0.1:4173/>
- code-server：<http://127.0.0.1:18080/>

生产部署不要运行 Vite dev server；执行 `npm run build` 后由同机静态服务器提供 `src/web/dist`，并把 `/api` 转发到 loopback API。完整示例和 SSE 代理要求见 [运维说明](docs/OPERATIONS.md#生产部署)。

## 验证

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

## 目录

```text
src/agent/          Agent 生命周期、Pi SDK session、事件和 footer
src/capabilities/   外部只读能力、边界和固定 runtime 调用
src/db/             SQLite/Drizzle schema、迁移和启动恢复
src/domain/         跨层业务契约
src/http/           Fastify 装配及配置、工单、附件、Agent 路由
src/pi/             Pi 模型目录、custom tools 和冻结 policy
src/web/            SolidJS Web 应用
src/workspace/      Git worktree、project wrappers 和 code-server
infra/              固定 Playwright/code-server 脚本和浏览器 runner
drizzle/            不可删除的顺序 SQLite migration 历史
tests/              后端与基础设施测试
```

## 安全边界

当前 API 没有内置身份认证。`GET /api/config` 会返回真实保存的 password 和 AccessKey，用于配置页面完整回写。API 固定监听 `127.0.0.1`；外部访问只能通过同机、带身份认证、TLS 和访问控制的代理转发。

页面表单不是安全边界。HTTP 保存校验、冻结 policy、tool schema、broker 和具体客户端分别验证自己的授权范围。Deployment credentials 不进入 policy、prompt、session、capability 结果或进程命令行。
