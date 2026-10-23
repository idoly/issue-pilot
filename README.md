# Issue Pilot

基于 [pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 的 AI 工单协作系统，用于问题调查、数据处理和代码开发。每张工单保存自己的对话、工作文件、代码工作区和处理过程，可以跨轮次继续。

应用用一个 Node 主进程协调 HTTP、Agent 和工作区。Pi 管理模型会话、原生工具、Codemode 和 MCP；Issue Pilot 管理身份、服务与环境范围、凭据、文件事务和 Git 生命周期。模型控制的本地工具及 stdio MCP 通过 SRT 执行，同一份状态只由一个 API 实例管理。

## 处理流程

```mermaid
flowchart LR
  Entry[Web / 钉钉单条导入 / 入站 MCP] --> Issue[校验并保存工单]
  Issue --> Queue[按工单排队]
  Queue --> Prepare[选择 owner 凭据并准备目录和代码]
  Prepare --> Pi[恢复或创建 Pi 会话]
  Pi --> Evidence[代码 / 日志 / 数据库 / 外部 MCP]
  Evidence --> Work[当前工单的普通工作文件和处理记录]
  Work --> Review[人工确认解决 / 继续处理]
```

- 正式／测试调查使用共享只读代码快照。
- 开发工单使用独立分支和 worktree；可写 Git 索引、分支及新对象属于该工单，公共基线对象只读复用。
- Agent 轮次按工单串行，不同工单可并行；关闭等待已接收工作排空。
- Node、Python/openpyxl、npm、Maven 和 Git 使用普通命令及库。没有每工单常驻容器、项目命令 broker 或独立成果发布步骤。

## 当前能力

| 能力 | 行为 |
| --- | --- |
| 问题调查 | 显式选择环境、服务和目标，通过 DMS、aliyun SLS CLI 或已配置 MCP 读取证据 |
| 代码开发 | 独立开发分支，浏览器编辑、差异、暂存和提交；使用工单 owner 的个人模型及 SSH 身份 |
| 文件处理 | 原始附件只读，工作副本可编辑；脚本、检查点、日志和报告直接保存在工单目录 |
| 持续协作 | SSE 展示对话和工具执行；补充信息、关联工单、确认解决及重开 |
| 关联工单 | 单行卡片展示编号、处理人、状态、服务和环境；标题仅悬停显示，点击打开完整工单 |
| 导航与下载 | 工单链接使用 `/?issue=<key>`，关联跳转支持浏览器后退／前进和新标签；文件通过受控下载 API 访问 |
| 钉钉接入 | 按单条记录链接直接导入，使用 YAML 字段映射，重复记录不重复创建 |
| 外部接入 | 同源入站 MCP；Pi 管理全局外部 MCP 的发现、连接及工具调用 |

关联工单的原始目录和会话通过只读引用提供，元信息在准备工作区时生成快照。目前没有关联预览弹窗、自动摘要或后台结论同步；不能把快照当成始终实时更新的原工单。

## 数据布局

```text
issue-pilot/
├── node_modules/、.venv/          # 安装产物
└── .issue-pilot/
    ├── service.yaml              # 服务、环境、仓库、Agent 配置
    ├── user.yaml                 # 用户凭据与来源配置
    ├── mcp.json                  # 外部 MCP 配置
    ├── issues.db{,-wal,-shm}      # 业务事实及运行绑定
    ├── git/repositories/         # 共享 Git 基线与保留分支
    ├── git/checkouts/            # 共享只读代码快照
    ├── workspaces/<issue-key>/    # 代码、附件、对话、工作文件
    │   └── .issue-git/           # 工单持久 Git 状态
    └── control/                  # 实例互斥与迁移记录
```

全局 Pi 资源默认使用 Operator 的 `~/.pi/agent`；完整恢复点放在 state root 之外。私有 YAML/MCP 文件存在时是配置来源，SQLite 保存校验投影和历史事实。配置及磁盘布局的详细约定见下列文档。

## 界面示意

以下截图使用演示工单和数据；字段和交互以当前页面及文档说明为准。

![工单工作区](docs/images/workspace.jpg)

![代码浏览器](docs/images/code-browser.jpg)

## 文档

| 文档 | 内容 |
| --- | --- |
| [部署指南](docs/DEPLOYMENT.md) | 本地运行、容器构建、配置与挂载、上线验收 |
| [配置与协议](docs/CONFIGURATION.md) | 文件配置、身份与凭据、工具及 MCP 接入 |
| [系统架构](docs/ARCHITECTURE.md) | 工单流程、执行边界、实时事件、并发和导航 |
| [Agent 与能力](docs/AGENT.md) | 工具、证据、Codemode、MCP 和关联材料 |
| [数据存储设计](docs/STORAGE.md) | 业务表、目录、文件事务与 Git 恢复 |
| [开发指南](docs/DEVELOPMENT.md) | 版本、代码入口、测试与浏览器验证 |
| [运维手册](docs/RUNBOOK.md) | 排空、备份、部署、恢复及空间清理 |
| [依赖补丁](patches/README.md) | Pi 输出保存回调与 node-forge RSA 验签回补 |
