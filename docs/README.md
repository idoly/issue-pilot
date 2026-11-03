# 文档导航

[项目首页](../README.md)

本套指南按当前源码的责任边界组织。根默认值见 [issue-pilot.config.ts](../issue-pilot.config.ts)，业务契约见 [contracts.ts](../src/domain/contracts.ts)，已发布数据库升级见 [drizzle](../drizzle)。文档不代替运行时授权与校验。

## 选择阅读路径

| 读者与任务 | 阅读顺序 |
| --- | --- |
| 使用者 | [使用指南](USAGE.md) → [配置与协议](CONFIGURATION.md) |
| 初次部署 | [部署指南](DEPLOYMENT.md) → [配置与协议](CONFIGURATION.md) → [运维手册](RUNBOOK.md) |
| 修改代码 | [系统架构](ARCHITECTURE.md) → [开发指南](DEVELOPMENT.md) → 对应 owner 文档 |
| 排障或恢复 | [运维手册](RUNBOOK.md) → [数据存储](STORAGE.md)／[Agent 与能力](AGENT.md) |

## 主题归属

| 文档 | 回答的问题 |
| --- | --- |
| [使用指南](USAGE.md) | 如何提交问题、继续对话、检查文件和代码、解决或重开 |
| [配置与协议](CONFIGURATION.md) | 谁可以配置、凭证如何选择、部署如何提供能力、MCP 如何接入 |
| [系统架构](ARCHITECTURE.md) | 请求经过哪些 owner、哪些队列不可合并、启动与关闭做什么 |
| [Agent 与能力](AGENT.md) | 消息如何投递、工具如何校验、会话如何恢复、SRT 保护什么 |
| [数据存储](STORAGE.md) | 数据在哪里、哪些状态必须保留、跨 SQLite／文件／Git 如何提交 |
| [开发指南](DEVELOPMENT.md) | 如何隔离测试、运行检查、验证浏览器与依赖 |
| [部署指南](DEPLOYMENT.md) | 如何安装、配置 supervisor、构建容器和提供网络入口 |
| [运维手册](RUNBOOK.md) | 如何发布、核对实际变化、安全清理和恢复 |
| [依赖补丁](../patches/README.md) | 哪些上游能力仍需补丁、如何验证和移除 |
| [离线旧目录迁移](operations/legacy-layout-migration.md) | 只有确认旧状态来源后，如何预检和迁移目录 |

开发代理还须遵守 [AGENTS.md](../AGENTS.md)。历史界面、阶段报告和旧实现通过 Git 历史查询，不作为现行行为依据；数据库迁移与必要恢复工具不因名称含有 legacy 而删除。
