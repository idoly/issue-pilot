# Issue Pilot

Issue Pilot 是基于 Pi SDK 的工单协作应用，将问题、代码工作区、Agent 对话、附件和交付成果放在同一条处理流程中。后端使用 Fastify、SQLite/Drizzle，前端使用 Solid 2 和独立 Monaco 编辑器。

## 主要能力

- 创建正式调查、测试调查、正式数据处理、开发修复和功能开发工单。
- 与 Agent 对话、粘贴图片、查看工具执行、上下文和使用量；失败后保留对话及工作文件，支持继续处理。
- 为开发工单准备独立 Git worktree，为正式和测试调查准备只读提交快照；按需加入同环境的其他服务代码。
- 在浏览器编辑开发代码、搜索、查看差异和历史、暂存及提交。文件保存携带 SHA-256，冲突时保留草稿。
- 通过内建查询访问 Nacos、MySQL、Redis、RabbitMQ、Elasticsearch、DMS 和 SLS，通过全局 MCP 配置接入外部工具。
- 用原生工具和普通脚本处理文件，在正式数据处理工单中发布、下载和预览成果。
- 通过入站 MCP 让外部 AI 创建工单、发送消息、查询进度及读取附件和成果。

## 处理方式与身份

| 处理方式 | 环境 | 受管代码访问 | 创建权限 |
| --- | --- | --- | --- |
| 正式调查 | prod | 只读快照 | 活跃用户 |
| 测试调查 | test | 只读快照 | 活跃用户 |
| 正式数据处理 | prod | 只读快照，可发布成果 | developer |
| 开发修复 | dev | 独立可写 worktree | developer |
| 功能开发 | dev | 独立可写 worktree | developer |

业务角色为 `product`、`test`、`developer`。全局管理标记 `isAdmin` 独立于角色，用于外部 MCP 新增、导入和管理权限维护。具体操作权限见[配置](docs/CONFIGURATION.md)。

浏览器用户选择器和 `X-Issue-Pilot-Subject` 只选择身份，不提供登录认证。外部访问应经过可信认证网关，由网关约束身份头。

## 首次本地运行

开发与 CI 使用 Node 24.18.0，应用镜像使用 Node 26；依赖版本以 [package.json](package.json) 和 [Containerfile](Containerfile) 为准。需要 Git、ripgrep，以及目标开发项目使用的 npm、Java/Maven 等工具。

在新的项目副本中检查 [issue-pilot.config.ts](issue-pilot.config.ts)，准备 Pi 模型目录和运行凭证，再执行：

```bash
npm ci
npm run typecheck
npm test
npm run build
node --experimental-strip-types src/http/production.ts
```

应用默认监听 `http://127.0.0.1:3000`，同时提供 API、编译后的页面和 `/mcp`。前端开发可另运行 `npm run dev:web`，默认端口 4173，代理本机 3000 API。

启动会迁移数据库、恢复中断状态、校验 Git 布局并准备 runtime。已有数据时先阅读[运维](docs/RUNBOOK.md)，不要同时运行第二个 API。

## 配置与工作目录

设置页提供基座、用户、能力、仓库、服务和端点。基座使用一份全局 provider/model/thinking level，Codemode 默认开启；修改停止后自动保存，失败保留草稿并提供重试，切换页面后仍可恢复编辑状态。

状态默认位于项目根目录 `.issue-pilot`，路径由根配置及 [src/config.ts](src/config.ts) 解析，没有 state root 环境变量覆盖。开发 worktree、SQLite、Pi JSONL、附件、成果和工作文件都可能包含真实业务数据。

每张工单的 Agent cwd 为 `issues/<key>/work`，工作文件跨轮次保留。全部工单获得 Pi 原生编码工具；正式数据处理额外提供成果发布工具。Skills、Prompts、扩展及附加指令通过应用 `.pi` 目录管理。

原生 Agent 代码在应用用户权限下可信执行，cwd 只组织工作，不构成工单间 OS 隔离。Source API 和内建查询保留业务访问约束；外部 MCP 向所有工单提供已启用服务的全部工具。详见[架构](docs/ARCHITECTURE.md)和[配置](docs/CONFIGURATION.md)。

## 文档导航

| 文档 | 用途 |
| --- | --- |
| [架构](docs/ARCHITECTURE.md) | 事实所有权、执行流程、数据一致性和并发 |
| [配置](docs/CONFIGURATION.md) | 身份与权限、凭证、服务部署、Agent 资源及双向 MCP |
| [开发](docs/DEVELOPMENT.md) | 修改入口、审查约束、测试和浏览器验证 |
| [部署](docs/DEPLOYMENT.md) | 运行前提、systemd、容器、挂载和网络 |
| [运维](docs/RUNBOOK.md) | 健康检查、备份、升级、清理与恢复 |
| [Agent 指南](AGENTS.md) | 代码代理的设计标准、状态保护和交付要求 |

文档说明当前合同；字段、默认值、工具 schema 和迁移顺序以对应源码为准。历史实验原始数据保留在 [docs/experiments](docs/experiments)，不代表当前应用仍使用旧执行方案。
