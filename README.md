# Issue Pilot

Issue Pilot 是一个基于 [pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的 AI 工单协作系统，支持问题调查、数据处理和代码开发。它将问题描述、AI 对话、附件、处理结果和代码改动保存在同一张工单中，便于持续跟进和复核。

## 工作方式

1. **提交问题**：选择服务和处理方式，描述现象与预期结果，按需上传附件。工单可从页面创建、从钉钉单条记录导入，或通过 MCP 接入。
2. **处理与反馈**：Agent 准备代码和执行环境，查询证据、处理文件或修改代码。使用者可以查看执行过程，在对话中补充信息和调整要求。
3. **检查结果**：查看报告与代码差异，确认解决或继续处理。对话和文件会保留，已解决工单也可以重开。

## 代码与文件

| 任务 | 工作方式 |
| --- | --- |
| 问题调查 | 正式／测试环境使用共享只读代码快照，按服务配置查询 DMS、SLS、DBHub 数据库或其他 MCP 数据源 |
| 代码开发 | 每张工单使用独立分支和工作树，支持浏览器编辑、差异、暂存与提交，采用负责人的个人模型和 Git 身份 |
| 文件处理 | 附件原件只读，需要修改时另存工作文件；用普通脚本和已安装库整理数据、生成表格或报告 |

关联工单以只读引用提供代码、文件和会话。关联元信息在准备工作区时取快照，引用结论时应核对源文件和版本。

## 运行与配置

应用运行在一个 Node 主进程中，提供网页、HTTP API、SSE 和入站 MCP。同一份业务状态只由一个 API 实例管理；Agent 任务按工单串行，不同工单可以并行。

Pi 负责模型会话、原生工具、Codemode 和外部 MCP 连接。Issue Pilot 负责身份、服务与环境范围、凭据，以及文件和 Git 的生命周期。模型本地工具与 stdio MCP 通过 SRT 执行。

用户、凭据、仓库和服务等业务配置由页面和 API 维护，SQLite 是配置的唯一来源。Agent 使用工单入口及已包含服务所对应的部署工具，钉钉连接仅用于导入。Pi 的模型定义、设置和扩展默认从运行账号的 `~/.pi/agent` 加载。

## 数据目录

```text
.issue-pilot/
├── issues.db{,-wal,-shm}      # 配置、工单元数据与运行绑定
├── git/
│   ├── repositories/        # 共享 Git 基线与保留分支
│   └── checkouts/           # 只读代码快照
├── workspaces/<issue-key>/  # 代码、附件、对话与工作文件
│   └── .issue-git/          # 工单持久 Git 状态
└── control/                # 实例互斥与控制记录
```

对话保存在 Pi JSONL，附件与报告保存为普通文件，代码状态由 Git 管理。数据恢复需要数据库、文件和 Git 相互匹配，完整恢复点存放在状态目录之外。

## 界面

以下截图使用独立演示数据。

![工单工作区](docs/images/workspace.jpg)

![代码浏览器](docs/images/code-browser.jpg)

## 文档

| 阅读目标 | 文档 |
| --- | --- |
| 创建、处理和解决工单 | [使用指南](docs/USAGE.md) |
| 安装、启动和部署 | [部署指南](docs/DEPLOYMENT.md) |
| 配置人员、凭据、服务与接入 | [配置与协议](docs/CONFIGURATION.md) |
| 理解系统和 Agent | [系统架构](docs/ARCHITECTURE.md) · [Agent 与能力](docs/AGENT.md) |
| 理解数据与 Git | [数据存储设计](docs/STORAGE.md) |
| 开发与验证 | [开发指南](docs/DEVELOPMENT.md) · [依赖补丁](patches/README.md) |
| 发布、排障和恢复 | [运维手册](docs/RUNBOOK.md) |

[界面预览](docs/images/index.html) · [文档导航](docs/README.md)
