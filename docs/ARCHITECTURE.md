# 系统架构

[文档导航](README.md) · [开发指南](DEVELOPMENT.md)

## 进程与事实来源

Issue Pilot 的 API 是单实例 Node 应用，提供同源网页、HTTP、SSE 和无状态入站 MCP。可选 Web preview／开发服务器不是第二个业务后端。同一 state root 由状态租约排他占用。

```text
浏览器／MCP 客户端
        │  身份、输入与响应
        ▼
HTTP routes／入站 MCP
        │  协调业务 owner
        ├── Configuration ── SQLite
        ├── Agent Engine ── Pi 会话／工具
        ├── Workspace ── Git／运行视图
        └── Storage owners ── 附件／工作文件／JSONL
```

SQLite 保存配置、关系和绑定，Pi JSONL 保存对话，文件保存原件与结果，Git 保存代码事实。这些介质不是彼此的完整备份，恢复必须匹配。

## Owner 与入口

| 责任 | 主要代码 |
| --- | --- |
| 状态、角色、处理方式和业务谓词 | [domain/contracts.ts](../src/domain/contracts.ts) |
| 路径、默认值和预算 | [根配置](../issue-pilot.config.ts)、[config.ts](../src/config.ts) |
| 数据库结构、升级与启动检查 | [db/schema.ts](../src/db/schema.ts)、[db/bootstrap.ts](../src/db/bootstrap.ts) |
| 身份与 HTTP 协调 | [route-context.ts](../src/http/route-context.ts)、`src/http/*-routes.ts` |
| 配置投影、凭证和服务范围 | `src/configuration` |
| 轮次队列、预约与恢复 | [engine.ts](../src/agent/engine.ts) |
| Pi、资源和模型运行时 | [pi-session.ts](../src/agent/pi-session.ts)、[model-runtime.ts](../src/agent/model-runtime.ts) |
| 原生查询与外部协议 | `src/capabilities`、`src/mcp` |
| Git、代码视图与生命周期 | `src/workspace` |
| 附件与工作文件 | [attachment-store.ts](../src/http/attachment-store.ts)、[work-files.ts](../src/workspace/work-files.ts) |
| Web 状态与请求契约 | [ApplicationResources.tsx](../src/web/src/app/ApplicationResources.tsx)、[client.ts](../src/web/src/data/client.ts) |

路由调用 owner，不重新实现 Git、协议、附件事务或工具授权。Pi 管理模型管线、工具发现和连接；应用保留业务配置、身份、范围、预算及必要的 execute 检查。

## 工单与任务路径

1. 创建请求校验活跃用户、工作方式及有效的服务／环境 Deployment。
2. 存储 owner 独占空工单根，协调附件写入与数据库事务，插入且只插入一条 Workspace。
3. 已保存输入交给 Engine；同工单串行，不同工单受全局并发名额控制，名额来自可热更新的运行参数。
4. owner 选择凭证、准备代码与运行视图，再创建或恢复 Pi 会话。
5. 事件经 SSE 投影到页面；会话和工作文件独立持久化。
6. 轮次结束进行失败清理与收尾，不能让旧轮次覆盖新轮次状态。

`idle` 表示无活动，`queued` 表示等待名额，`running` 表示已取得执行名额，包括准备和收尾。预约使用的 `isRunning`／`agentRunning` 包含排队，不能只用 `runState === running` 判断是否允许配置或生命周期操作。

## 并发与失败清理

下列队列分别保护不同事实，不使用一个全局锁替代：配置 scope、Agent 活动、工单集合预约、生命周期、工单 inspection、仓库操作。仓库串行键包含 state root 和 URL hash。

| 操作 | 获取顺序 |
| --- | --- |
| 配置读取 | scope queue → SQLite read snapshot |
| 服务／工单范围写入 | scope queue → Issue reservation |
| 回收／重开 | lifecycle queue → inspection queue → Issue reservation |

排队后重新校验身份与相关条件。SQLite rollback 不能撤销文件或 Git；每个 owner 必须提供相应 prepare、rollback、finalize，原失败和清理失败分别保留。关闭等待排队、活动和预约结束，不能强杀后假定提交状态可知。

## 启动与关闭

[buildApi](../src/http/api.ts) 获取状态租约后打开数据库、执行迁移与结构检查，再准备开发和只读运行视图、加载 Agent 配置、启动维护并注册路由。冷启动会按部署刷新 prod/test 只读快照及对应 commit 基线；它不等于重置开发分支。启动也会按既定恢复逻辑处理被中断的运行状态，发布核对时须区分这些变化与业务修改。

生产入口为 [production.ts](../src/http/production.ts)。退出通过 owner 关闭会话、协议、数据库和租约，不能只停止监听 socket。

## Web 与实时更新

ApplicationResources 保存共享数据、编辑状态和 Agent 草稿。切换身份取消旧身份未发送的工作；迟到响应按身份和 generation 拒绝。

SSE 依次发送持久／当前回放、`snapshot_ready`、实时事件和 heartbeat。临时事件 ID 有界去重，持久条目按连接去重；慢连接超预算时断开并重放恢复，不静默丢帧。模型和 footer 优先使用已记录会话；同一快照复用会话上下文，不建立跨请求缓存。

会话投影沿用不可变归约和 Solid 2 keyed For，消息以 ID、内容块以 contentIndex 保持身份。Markdown 在流式阶段不解析；工具详情惰性挂载。代码浏览器独立管理 Monaco editor／model、冲突和撤销状态。

总览排序只为每条工单计算一次排序键；工作区统计共享正在进行的采样和短期快照，生命周期变化使缓存失效。这些优化不代替执行时重新检查。

## 安全与恢复边界

业务授权、Source API 策略、只读查询和凭证选择由各自 owner 执行，不依赖提示词。SRT 限制模型本地操作与 stdio MCP；Pi SDK、Operator 扩展和应用存储 owner 属于可信代码，远程 MCP 有独立权限。

详细约束分别见[配置](CONFIGURATION.md)、[Agent](AGENT.md)、[存储](STORAGE.md)和[运维手册](RUNBOOK.md)。
