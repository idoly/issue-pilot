# 文档导航

[项目首页](../README.md) · [当前页面图](images/README.md)

现行指南按使用、配置、实现和运维分别维护，不以阶段变更记录代替当前契约。根默认值以 [issue-pilot.config.ts](../issue-pilot.config.ts) 为准，业务类型以 [contracts.ts](../src/domain/contracts.ts) 为准，数据库升级以不可变的 [drizzle](../drizzle) 为准。

## 适用范围与读者

这组指南描述**当前 checkout 的源码实现**，不是某个已发布镜像的功能承诺。本轮核对基线为 `5eaff5d`；之后阅读时用 `git rev-parse --short HEAD` 确认自己的版本，并在同一 revision 下阅读代码、锁文件和部署清单。`package.json` 的应用版本与示例镜像 tag 不足以标识源码能力；页面图和历史记录各自有独立的版本说明。

- 使用者：创建工单、补充证据、检查结果及确认解决。
- 管理者：设置用户、共享模型／凭证、服务部署和运行参数。
- 开发维护者：理解状态、调用边界，安全地测试、发布、定位及恢复故障。

文档以任务为入口，字段和完整类型以链接的 owner 为准，不维护第二份全量配置、依赖版本表或接口 Schema。

## 先读哪一份

| 任务 | 入口 |
| --- | --- |
| 使用工单 | [使用指南](USAGE.md) |
| 设置账号、凭证、服务或参数 | [配置与协议](CONFIGURATION.md) |
| 初次安装、首次工单或容器部署 | [部署指南](DEPLOYMENT.md#首次本地运行) |
| 编写 HTTP 客户端、判断异步结果 | [HTTP 接口约定](HTTP.md) |
| 修改代码 | [系统架构](ARCHITECTURE.md) → [开发指南](DEVELOPMENT.md) |
| 排障、清理、发布或恢复 | [运维手册](RUNBOOK.md) |

## 技术主题

- [Agent 与能力](AGENT.md)：投递与队列、工具、查询、会话和 SRT。
- [数据存储](STORAGE.md)：事实来源、文件事务、Git、容量与恢复单位。
- [依赖补丁](../patches/README.md)：现存补丁、版本覆盖、兼容验证与退出条件。
- [离线旧目录迁移](operations/legacy-layout-migration.md)：仅用于已确认来源的旧 state，不是普通发布步骤。
- [页面图说明](images/README.md)：当前源码演示截图、来源和验证范围。

## 历史材料与代理规则

[records](records) 保存特定版本的审查与验证记录，只用于追溯，不代表之后版本的验收结果。已发布迁移、恢复证据和必要离线工具不能因旧名称而删除。

开发代理遵守 [AGENTS.md](../AGENTS.md)。测试、截图和演练使用独立数据，不能读取真实 `.issue-pilot` 作为夹具；提交、推送、部署和真实状态操作分别需要授权。
