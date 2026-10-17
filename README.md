# Issue Pilot

Issue Pilot 是基于 Pi SDK 的工单协作应用。每张工单拥有独立的代码上下文、Agent 对话、附件和处理状态；开发工单使用独立 Git worktree，正式和测试调查使用只读代码快照。

## 可以做什么

- 创建正式调查、测试调查、正式数据处理、开发修复和功能开发工单。
- 在工单中与 Agent 对话，补充文字或粘贴图片，查看执行过程、工具结果和使用量。
- 关联其他工单，读取其元数据、已持久化对话和可用的开发提交快照。
- 跨服务加入代码，通过统一查询工具读取已配置的数据库、日志、缓存、配置中心和远程 MCP 能力。
- 在浏览器查看文件、搜索、比较 Git 差异与历史；开发工单可编辑、管理路径、暂存和提交。
- 通过原生工具和常规库处理文件，在正式数据处理工单中发布、下载和预览任意格式成果。
- 通过入站 MCP 让外部 AI 创建工单、发送补充消息、查询进展并读取交付物。

## 处理方式与权限

| 处理方式 | 环境 | 代码 | 创建角色 |
| --- | --- | --- | --- |
| 正式调查 | prod | 只读 | 全部活跃用户 |
| 测试调查 | test | 只读 | 全部活跃用户 |
| 正式数据处理 | prod | 只读，可写成果区 | developer |
| 开发修复 | dev | 独立可写 worktree | developer |
| 功能开发 | dev | 独立可写 worktree | developer |

用户角色为 product、test、developer。身份选择器用于可信环境下选择用户，**不提供登录认证**。外部部署必须由可信网关完成认证和身份头约束。

## 本地运行

使用支持项目 TypeScript 与依赖版本的 Node.js；应用镜像使用 Node 26。准备 Git、ripgrep，以及开发项目需要的 npm、Java/Maven。完整依赖和镜像内容以 [package.json](package.json) 与 [Containerfile](Containerfile) 为准。

```bash
npm ci
npm run typecheck
npm test
npm run build
node --experimental-strip-types src/http/production.ts
```

默认应用地址为 `http://127.0.0.1:3000`，API 同时提供前端静态页面。前端开发可另运行 `npm run dev:web`，默认端口 4173，代理本机 3000 API。

**启动会迁移数据库、恢复状态并重建受管 runtime。** 首次运行前检查 [issue-pilot.config.ts](issue-pilot.config.ts) 中的初始用户、路径和默认配置。已有 `.issue-pilot` 时先阅读[运维说明](docs/RUNBOOK.md)。实验和测试使用临时状态，手动隔离运行使用独立项目副本及其根配置。

在配置页面维护用户和个人凭证、全局模型、能力、仓库及服务。Agent provider/model/thinking level 全局唯一；模型目录由 Pi runtime 提供。所有工单使用 Pi 原生编码工具，在自己的 work 目录运行普通脚本。

## 状态与集成

状态默认位于项目根目录 `.issue-pilot`，由根配置和 [src/config.ts](src/config.ts) 解析，没有 state root 环境变量覆盖。SQLite、附件、成果、Pi JSONL、本地 Git branches 和开发 worktree 都可能包含需要保留的业务数据。

内建查询包括 Nacos、MySQL、Redis、RabbitMQ、Elasticsearch、DMS 和 SLS。正式/测试工单查询本环境；开发工单可调查正式和测试配置，调用仍受只读授权。Agent 的原生代码在应用容器内可信执行，cwd 不提供工单间强隔离；Source API 的仓库只读策略与脚本权限不同，见[架构](docs/ARCHITECTURE.md)。

外部 AI 使用 `POST /mcp` 的无状态 Streamable HTTP。先发现服务/用户，再创建或搜索工单，发送补充消息，最后轮询状态和对话、读取附件或成果。写入成功表示已受理，详情见[配置与 MCP](docs/CONFIGURATION.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [架构](docs/ARCHITECTURE.md) | 事实所有权、状态、代码生命周期和并发 |
| [配置](docs/CONFIGURATION.md) | 服务、角色、凭证、能力、工具与 MCP |
| [开发](docs/DEVELOPMENT.md) | 模块入口、修改约束和验证命令 |
| [部署](docs/DEPLOYMENT.md) | 镜像、挂载、网络和沙盒前提 |
| [运维](docs/RUNBOOK.md) | 健康检查、备份、升级与恢复 |
| [Agent 指南](AGENTS.md) | 编码代理的状态保护与交付要求 |

这些文档描述当前实现。字段、默认值、迁移顺序和工具 schema 以对应源码为准。
