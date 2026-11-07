# 文档导航

[项目首页](../README.md)

## 适用范围与读者

现行指南于 2026-11-07 依据目标机 `/home/idoly/issue-pilot` 重新整理，代码基线为 `96d347fffa3b3d78388986a56f9ad43b9e2ce87e`。目标机的根配置将 `state.directory` 设为 `data`，并有数据忽略规则和本机 `restart.sh`。通用业务契约来自此版本源码；安装路径、工具路径和无 service 的启动方式描述这台机器，不能推定其他 checkout 相同。

```bash
git rev-parse HEAD
git status --short
```

在目标机仓库根执行上述命令可确认后续版本和本机差异。`package.json` 的 `0.1.0`、全局 Pi 版本和镜像 tag 都不能单独标识应用代码。配置以[根配置](../issue-pilot.config.ts)、SQLite 及运行用户 Pi 目录的实际职责为准，详见[配置分层](CONFIGURATION.md#配置分层)。

| 读者／问题 | 主说明位置 |
| --- | --- |
| 使用者如何提交、阅读、补充和确认结果 | [使用指南](USAGE.md) |
| 管理者如何设置人员、凭证、部署和参数 | [配置说明](CONFIGURATION.md) |
| 运维如何启动目标机、访问网页及准备新安装 | [部署指南](DEPLOYMENT.md) |
| 客户端如何区分受理、完成、取消和冲突 | [HTTP 接口](HTTP.md) |
| 维护者如何沿调用链修改并验证 | [架构](ARCHITECTURE.md) → [开发](DEVELOPMENT.md) |
| 文件、会话与 Git 怎么保留和恢复 | [存储](STORAGE.md) → [运维](RUNBOOK.md) |
| Agent 工具、查询及会话如何受约束 | [Agent](AGENT.md) |

## 当前验证与未覆盖范围

迁移时完成数据完整性、附件权限与哈希、会话保留、Git 路径和非干净状态核对；目标机的 HTTP、重启脚本、SRT 聚焦测试和 Chromium 页面 smoke 已验证。本轮又完成真实模型、DMS 常量查询，以及 SLS 正式／测试环境聚合查询。

准确时间、范围、结果和失败尝试统一记在[本次迁移记录](records/2026-11-07-host-migration.md)。真实查询仅代表记录中的凭证链路和所选目标，不代表所有用户、服务、数据库、日志库、模型和外部 MCP 均已验收。生产依赖安装不含完整开发依赖，本轮没有在目标运行全量类型检查、测试或重新构建 Web。

## 文档维护

当前 Markdown 是人工维护的源文件，没有全站生成器。按事实 owner 更新一处主说明，其余页面引用；不复制一份全量接口 Schema、依赖版本或文件目录清单。文档验证方式见[开发指南](DEVELOPMENT.md#文档清理与交付)。

保留的专题：

- [依赖补丁](../patches/README.md)：补丁来源、行为与升级验证。
- [旧布局离线迁移](operations/legacy-layout-migration.md)：只适用于来源已确认的旧布局，不能用来重复迁移当前 `data`。
- [历史演示图](images/README.md)：原始截图版本和生成边界，本轮未重拍。
- [历史记录](records)：特定版本的审查、验证与迁移证据，不作为当前部署指令。
- [代理规则](../AGENTS.md)：修改边界、并发次序、持久契约与必要验证。

当前安装以[宿主机部署](DEPLOYMENT.md#当前宿主机)为准。仓库仍有 Containerfile 和 Kubernetes 示例，它们没有在本次目标部署中使用；Playwright 容器只承担浏览器测试。
