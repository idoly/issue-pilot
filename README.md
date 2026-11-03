# Issue Pilot

Issue Pilot 把问题描述、AI 对话、附件、工作文件和代码状态组织在一张可持续跟进的工单中。应用使用 Pi 管理模型会话与工具，使用 SQLite、Pi JSONL、普通文件和 Git 保存业务事实。

## 能做什么

| 处理方式 | 代码环境 | 主要用途 |
| --- | --- | --- |
| 正式问题调查 | 正式部署的只读快照 | 核对代码、数据库和日志证据 |
| 测试问题调查 | 测试部署的只读快照 | 复现与分析测试环境问题 |
| 开发缺陷修复 | 工单私有分支与 worktree | 修改、验证和检查差异 |
| 开发功能开发 | 工单私有分支与 worktree | 按验收要求实现功能 |

所有方式都可处理普通文件。附件原件保持只读；编辑附件时显式另存工作文件。原生证据查询为 DMS 和阿里云 SLS CLI，其他数据库通过配置的 DBHub／外部 MCP 接入。工具可用性不代替目标范围、只读和凭证校验。

## 一张工单的流程

1. 从页面、入站 MCP 或钉钉单条记录创建工单，选择服务与处理方式。
2. Agent 按工单排队，准备代码和身份，在允许的范围内调查或开发。
3. 查看对话、展开工具结果、下载文件或检查代码差异，再补充信息或确认解决。
4. 解决后保留对话、文件和持久分支；满足安全条件的代码目录可回收，工单可以重开。

消息受理表示输入已保存，不表示模型已经完成。创建或发送结果不明时，先查询工单与对话，避免重复提交。

## 运行模型

- 单个 Node API 提供网页、HTTP API、SSE 和 `/mcp`；同一 state root 只能有一个 API 实例。
- 默认端口为 3000；可选的 4173 Web 入口转发到同一个 API。
- 用户、凭证、仓库、服务部署和 Agent 配置以 SQLite 为准，不从业务 YAML 导入或投影。
- 模型凭证 owner 为处理人，否则为报告人。个人模型组整组替换共享组；缺失、残缺或失败的凭证不切换身份兜底。
- Pi 资源来自运行账号的全局 Pi 目录。Operator 的模型认证文件不能替代数据库选定的请求凭证。
- 模型本地工具和 stdio MCP 使用 SRT；远程 MCP 服务仍负责其自身权限。

## 安装入口

需要支持 SRT 的 Linux 环境、Node、Python 及相关系统工具。先按[部署指南](docs/DEPLOYMENT.md#首次本地运行)检查根配置和 bootstrap 用户，再执行：

```bash
npm ci
python3 -m venv .venv
.venv/bin/python3 -m pip install -r requirements.txt
npm run build
node --experimental-strip-types src/http/production.ts
```

不能跳过 postinstall 补丁校验。不要在运行中的安装目录混合覆盖依赖和网页产物，发布前阅读[运维手册](docs/RUNBOOK.md)。

## 数据与文档

默认 `.issue-pilot` 包含数据库、工单根目录和共享 Git。它是敏感业务状态，不是缓存，也不能作为测试夹具。备份必须同时覆盖数据库、文件、会话和 Git，不能只恢复其中一项。

| 目标 | 文档 |
| --- | --- |
| 创建、处理与解决工单 | [使用指南](docs/USAGE.md) |
| 用户、凭证、部署与 MCP | [配置与协议](docs/CONFIGURATION.md) |
| 模块边界与并发 | [系统架构](docs/ARCHITECTURE.md) |
| Agent、工具、会话与执行边界 | [Agent 与能力](docs/AGENT.md) |
| 数据关系、文件事务和 Git | [数据存储](docs/STORAGE.md) |
| 开发环境、测试与浏览器验证 | [开发指南](docs/DEVELOPMENT.md) |
| 主机／容器安装 | [部署指南](docs/DEPLOYMENT.md) |
| 发布、清理、故障与恢复 | [运维手册](docs/RUNBOOK.md) |

[完整导航](docs/README.md) · [依赖补丁](patches/README.md)
