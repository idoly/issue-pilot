# Issue Pilot

Issue Pilot 把工单、Pi 对话、附件、工作文件与 Git 工作区放在同一个持久处理流程中，用于正式／测试问题调查、文件处理和开发修复。调查使用部署的只读代码，开发使用每张工单独立的分支和 worktree。

本文档已按 Debian 13 目标机的代码与实际部署重新核对，源码基线为 `96d347fffa3b3d78388986a56f9ad43b9e2ce87e`。当前安装直接在宿主机运行；[版本与验证范围](docs/README.md#适用范围与读者)区分源码、机器配置和本次验收。

## 先完成你的任务

| 任务 | 文档 |
| --- | --- |
| 打开应用、查看状态或重启 | [当前宿主机部署](docs/DEPLOYMENT.md#当前宿主机) |
| 从空目录安装独立开发环境 | [首次本地运行](docs/DEPLOYMENT.md#首次本地运行) |
| 创建、补充、检查和解决工单 | [使用指南](docs/USAGE.md) |
| 配置用户、模型、服务和查询来源 | [配置说明](docs/CONFIGURATION.md) |
| 接入 HTTP／SSE／MCP | [接口约定](docs/HTTP.md) |
| 理解模块、状态与持久边界 | [架构](docs/ARCHITECTURE.md) · [Agent](docs/AGENT.md) · [存储](docs/STORAGE.md) |
| 修改、测试和发布 | [开发](docs/DEVELOPMENT.md) · [运维](docs/RUNBOOK.md) |
| 追溯这次迁移 | [宿主机迁移与验收记录](docs/records/2026-11-07-host-migration.md) |

## 当前运行方式

一个 Node API 在 3000 端口同源提供网页、HTTP、SSE 和 `/mcp`，同一数据根只允许一个 API。当前应用位于 `/home/idoly/issue-pilot`，唯一业务数据根为 `/home/idoly/issue-pilot/data`，没有 `.issue-pilot` 兼容目录、链接或挂载。

用 `idoly` 登录目标机，在 Bash 中执行：

```bash
cd /home/idoly/issue-pilot
./restart.sh status
curl -fsS http://127.0.0.1:3000/health
```

需要重启时执行 `./restart.sh`。没有 systemd service、开机自启或故障自动拉起；启动、停止和日志位置见[部署指南](docs/DEPLOYMENT.md)。应用没有登录服务，账号选择与 `X-Issue-Pilot-Subject` 不能代替认证；不可信网络必须经可信认证网关访问。

## 核心约定

- 工单的 Service／Environment 必须对应实际 Deployment；开发基线取同服务的正式部署。
- 凭证 owner 是处理人，否则报告人，必须活跃。个人模型完整组替换共享组；所选凭证失败不换用户或 Key。
- DMS 和 SLS 是 `service_query` 的原生只读能力；DBHub 与其他外部 MCP 属于部署连接，权限边界各自存在。
- 附件原件只读，需要编辑时另存普通工作文件。关联工单提供只读证据，不扩大查询权限。
- SQLite、JSONL、普通文件和 Git 共同保存事实。数据库检查点不能恢复丢失的附件、会话、工作文件或私有 Git。

生产数据不作测试夹具。源码、依赖或前端构建的变更先在独立 checkout 验证，不能在正在服务的目录安装依赖或构建。

既有界面图保留为[历史演示材料](docs/images/README.md)，不充当当前页面或本次迁移的验收结果。
