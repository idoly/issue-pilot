# 系统架构

[文档导航](README.md) · [开发](DEVELOPMENT.md) · [存储](STORAGE.md)

## 进程与事实来源

当前部署是一个 Node API；[production.ts](../src/http/production.ts) 启动 [buildApi](../src/http/api.ts)，同源提供 Web 静态资源、HTTP、SSE 和入站 MCP。Vite 4173 只用于独立开发／预览，不是第二个业务后端。state lease 阻止同一根目录出现两个 API，当前根为 `data`。

```text
浏览器／入站 MCP 客户端
          │ HTTP 请求／身份与输入检查
          ▼
HTTP 协调层 ──调用──► configuration ──读写──► SQLite
     │
     ├──调用──► Agent Engine ──调用──► Pi 模型／工具管线
     │                                  ├──协议请求──► DMS／SLS／外部 MCP
     │                                  └──本地命令──► SRT 工单边界
     └──调用──► workspace／storage ──读写──► Git／JSONL／普通文件

JSONL／当前 Agent 事件 ──投影为 SSE──► 浏览器会话视图
```

箭头文字说明调用、读写或事件投影，不表示跨介质事务或完整复制。入站 MCP 操作工单，服务 MCP 提供外部能力，方向不同。SQLite、JSONL、Git、附件和工作文件共同保存事实，恢复任一介质不自动恢复其他介质。

## Owner 与依赖方向

| 责任 | 入口 |
| --- | --- |
| 角色、处理方式、状态与业务谓词 | [domain/contracts.ts](../src/domain/contracts.ts) |
| 路径、硬预算和默认参数 | [根配置](../issue-pilot.config.ts)、[config.ts](../src/config.ts) |
| Schema、不可变升级和初始化 | [schema](../src/db/schema.ts)、[bootstrap](../src/db/bootstrap.ts)、[drizzle](../drizzle) |
| 持久配置、凭证选择、热参数 | [configuration](../src/configuration) |
| 身份及等待后重授权 | [route-context.ts](../src/http/route-context.ts) |
| 受理、排队、预约、消息恢复 | [engine.ts](../src/agent/engine.ts) |
| Pi 会话、模型隔离与生命周期 | [pi-session.ts](../src/agent/pi-session.ts)、[model-runtime.ts](../src/agent/model-runtime.ts) |
| 本地／证据工具边界 | [agent](../src/agent)、[capabilities](../src/capabilities) |
| Git、运行视图与回收 | [workspace](../src/workspace) |
| 附件事务、工作文件 | [attachment-store.ts](../src/http/attachment-store.ts)、[work-files.ts](../src/workspace/work-files.ts) |
| Web 请求、共享资源和投影 | [client.ts](../src/web/src/data/client.ts)、[ApplicationResources.tsx](../src/web/src/app/ApplicationResources.tsx)、[agent-stream.ts](../src/web/src/app/agent-stream.ts) |

路由负责协调 owner，不重做 Git、协议、存储或命令授权。Pi 负责模型管线与 MCP 发现／连接；应用负责身份、服务范围、预算、持久事实及可变钩子后的执行校验。业务设置只以 SQLite 为准，不从历史 YAML 或私有文件回填。

## 一轮处理

1. 创建按 workMode 解析类型／环境，检查 Deployment 和活跃用户，独占空工单根；协调附件与 DB，插入唯一 Workspace。
2. 消息进入同工单串行范围，持久保存文字／图片并建立会话绑定；HTTP 的 201／202 表示保存／受理，不是模型处理完成。
3. Engine 排队取得全局名额，选择处理人、否则报告人为 owner，准备模型凭证、个人 Git、代码与运行视图。
4. Pi 发起模型请求，工具再按服务／环境、参数、只读和路径策略执行。输出进入 JSONL 或普通工作文件。
5. SSE 投影历史和实时事件。正常结束或失败收尾都在同工单串行范围内进行，旧轮次失败不能覆盖新轮次状态。

`idle`／`queued`／`running` 表示 Agent 活动；`agentRunning` 包含排队和准备，业务 `status` 与 Workspace 状态另外表达结论和资源准备。完整状态契约见[使用指南](USAGE.md#状态与完成条件)。

`maxConcurrentIssues` 限制取得执行名额的轮次，不限制 HTTP 并发、内存队列长度或同工单累计消息。当前没有队列容量／等待超时；优先级和个人置顶不参与执行调度。重启不重建执行队列，待处理输入的显式恢复规则见 [Agent](AGENT.md#消息接收与恢复)。

## 并发与失败清理

| 操作 | 固定获取次序 |
| --- | --- |
| 配置读取 | scope queue → SQLite read snapshot |
| 服务／工单范围写入 | scope queue → Issue reservation |
| 回收／重开 | lifecycle queue → inspection queue → Issue reservation |

Agent 活动、Issue 集合预约、配置 scope、生命周期、单工单 inspection 和仓库队列保护不同事实，不能合成全局 mutex 或反转顺序。仓库键包含 state root 与 URL hash。在相关队列等待后重读身份、状态和权限；消息固定发送者，失活后不换默认用户。

SQLite rollback 不恢复文件和 Git，各 owner 必须完成 prepare／rollback／finalize。操作、诊断和清理错误分别保留；诊断回调异常不能阻塞后续轮次。失败／取消／部分提交的恢复边界分别见[接口](HTTP.md)、[Agent](AGENT.md)与[运维](RUNBOOK.md)。

## 启动与关闭

API 先取得 state 租约，再打开 DB、升级并 bootstrap，校验布局与共享快照，恢复开发／只读运行视图，装载参数并初始化维护和路由，最后监听。冷启动可能访问 Git 并刷新 prod/test commit 基线，不重置开发历史，也不采用未知目录。

只读运行视图准备失败，须先写回 runtimeReady=false 再报告该工单受阻；写回失败导致启动失败。批次及工单内准备都结束后才返回，避免回滚与遗留 Git／文件操作重叠。依据：[runtime.ts](../src/workspace/runtime.ts)、[project.ts](../src/workspace/project.ts)、[read-only.test.ts](../tests/workspace/read-only.test.ts)。

关闭先停止接收、结束 SSE、有界关闭卡住的 HTTP 连接，再等待 Engine／配置队列／模型运行时／DB／租约释放。Engine 排空没有独立截止时间，HTTP 的 shutdownGraceMs 不等于整轮上限。启动回滚也尝试关闭每个 owner 并聚合错误；health 不能证明外部链路或所有清理已成功。回归见 [api-startup.test.ts](../tests/http/api-startup.test.ts)。

## Web 与事件投影

ApplicationResources 持有身份、共享配置、每工单草稿、保存和失败状态，页面导航不会丢弃草稿；身份变化取消旧身份未发送的工作，迟到响应按 generation 拒绝。

SSE 顺序为回放、snapshot_ready、live 与 heartbeat。回放按 entry ID 去重并处理发送背压，慢连接超预算断开后重放；非法帧作废连接，不能跳过后接受不完整快照。历史视图不强制滚到底部，输入区独立于历史滚动。会话块按稳定 ID／contentIndex 维护，流式纯文本，完成后解析 Markdown；工具详情和 CodeBrowser 惰性加载，Monaco editor／model 独立释放。

首页每 10 秒轮询完整工单摘要，前一轮未结束时跳过定时请求；不是服务端分页或推送。资源统计有[独立采样缓存](STORAGE.md#容量统计)。SSE 字节预算限制局部队列，工具展示字符预算限制页面，不能推导总进程容量或持久 JSONL 大小。

## 参数与安全边界

启动装载 SQLite 参数覆盖并安装进程快照；保存先校验 revision、持久化，再更新快照并通知 Engine／维护／网络。大多数预算在操作开始时读取，在途操作保留原预算；调低并发不取消已有轮次。参数更新不等于模型凭证或会话重建，精确语义集中在[配置](CONFIGURATION.md#运行参数)。

本地模型操作统一经过 SRT，当前工单根可持久写，相关工单只读；SDK、Operator 扩展和应用 owner 属于可信代码，远程 MCP 自行授权。提示词、readOnlyHint、页面按钮或容器名称都不是访问控制；协议和文件边界见 [Agent](AGENT.md#执行边界)。
