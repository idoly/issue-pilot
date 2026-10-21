# Issue Pilot

基于 [pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的 AI 工单协作系统，用于问题调查、数据处理和代码开发。每张工单保存自己的对话、工作文件、代码工作区和交付成果，可以跨轮次继续处理。

Pi 提供模型会话、原生工具、Codemode 和 MCP 扩展；Issue Pilot 在此基础上管理工单流程、服务配置、凭证、Git 工作区及成果交付，并提供浏览器操作界面。

## 主要能力

- **问题调查**：结合代码、日志、数据库和配置定位问题，保留调查过程。
- **代码开发**：为开发工单创建独立 Git worktree，在浏览器中编辑、查看差异和提交。
- **数据处理**：通过 Node、Python/openpyxl 等普通脚本处理数据，生成并发布 `.xlsx` 等成果。
- **持续协作**：实时查看 Agent 对话和工具执行，补充信息、关联工单、确认解决或继续处理。
- **系统接入**：DMS 查询、aliyun SLS CLI，以及 MySQL 等外部 MCP；支持入站 MCP。

## 界面

以下截图来自当前前端，使用演示工单和数据。

工单工作区：查看工单列表、Agent 对话、工具执行和问题详情。

![工单工作区](docs/images/workspace.jpg)

代码浏览器：在同一界面查看代码、处理 Agent 回复和核对工单信息。

![代码浏览器](docs/images/code-browser.jpg)

## 文档

| 文档 | 内容 |
| --- | --- |
| [部署指南](docs/DEPLOYMENT.md) | 本地运行、内置 Node/Python 的容器、配置和挂载 |
| [配置与协议](docs/CONFIGURATION.md) | 服务、模型、用户权限、凭证和 MCP 接入 |
| [系统架构](docs/ARCHITECTURE.md) | 系统组成、工单流程、实时事件和并发 |
| [Agent 与能力](docs/AGENT.md) | 模型如何使用工具、Codemode 与 MCP |
| [数据存储设计](docs/STORAGE.md) | 数据表、目录、文件事务和 Git 恢复 |
| [开发指南](docs/DEVELOPMENT.md) | 开发环境、代码入口和验证 |
| [运维手册](docs/RUNBOOK.md) | 备份、升级、恢复与故障排查 |
