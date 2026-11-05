# 系统架构

[文档导航](README.md) · [开发指南](DEVELOPMENT.md)

## 进程与事实来源

单个 Node API 同源提供网页、HTTP、SSE 与入站 MCP。可选 Vite dev／preview 只提供前端入口，不是第二个业务后端。状态租约确保同一 state root 只有一个 API。

```text
浏览器／MCP 客户端 → HTTP 身份和输入边界 → 业务 owner
                                         ├─ configuration → SQLite
                                         ├─ Agent Engine → Pi／工具
                                         ├─ workspace → Git／运行视图
                                         └─ storage → 原件／JSONL／工作文件
```

SQLite、JSONL、普通文件与 Git 共同构成事实；任一介质都不是其他介质的完整备份。路由负责协调，不实现第二套 Git、协议、存储或授权逻辑。

## Owner 与入口

| 责任 | 代码入口 |
| --- | --- |
| 角色、处理方式、owner 和稳定业务谓词 | [domain/contracts.ts](../src/domain/contracts.ts) |
| 路径、硬预算、参数默认值 | [根配置](../issue-pilot.config.ts)、[config.ts](../src/config.ts) |
| 参数校验、持久覆盖、有效快照 | [configuration/parameters.ts](../src/configuration/parameters.ts) |
| schema、迁移与启动约束 | [db/schema.ts](../src/db/schema.ts)、[db/bootstrap.ts](../src/db/bootstrap.ts) |
| HTTP 身份及重授权 | [route-context.ts](../src/http/route-context.ts) |
| 业务配置、凭证与服务投影 | `src/configuration` |
| 工单队列、预约与消息恢复 | [engine.ts](../src/agent/engine.ts) |
| Pi 会话、资源与模型身份 | [pi-session.ts](../src/agent/pi-session.ts)、[model-runtime.ts](../src/agent/model-runtime.ts) |
| 本地执行和证据查询 | `src/agent/native-*`、`src/capabilities` |
| 外部／入站 MCP | `src/mcp` |
| Git、Source API 和生命周期 | `src/workspace` |
| 附件／工作文件 | [attachment-store.ts](../src/http/attachment-store.ts)、[work-files.ts](../src/workspace/work-files.ts) |
| Web 资源和 DTO | [ApplicationResources.tsx](../src/web/src/app/ApplicationResources.tsx)、[client.ts](../src/web/src/data/client.ts) |

Pi 管理模型管线、发现、注册和连接；应用继续拥有配置、身份、业务范围、预算和可变钩子后的 execute 校验。

## 一轮处理

1. 创建校验活跃用户、工作方式和 Deployment，独占空工单根并协调附件／DB，插入唯一 Workspace。
2. 消息在同工单队列内保存，Engine 管理活动和全局名额；持久输入与内存执行队列不是同一个保证。
3. 按 assignee、否则 reporter 选择活跃 owner；准备模型组、Git 身份、代码及运行视图。
4. 创建或恢复 Pi 会话，在应用边界内执行工具，将结果写入会话或工作文件。
5. 事件通过 SSE 投影；结束和失败清理仍属于该工单串行范围，不允许旧失败覆盖新轮次。

`idle` 无活动，`queued` 等待执行名额，`running` 已取得名额并包含准备与收尾。预约使用的 agentRunning 包含排队，不可只检查 running 状态。

## 并发与失败清理

| 操作 | 固定获取顺序 |
| --- | --- |
| 配置读取 | scope queue → SQLite read snapshot |
| 服务／工单范围写入 | scope queue → Issue reservation |
| 回收／重开 | lifecycle queue → inspection queue → Issue reservation |

Agent 活动、集合预约、scope、生命周期、inspection 与仓库操作分别保护不同事实；仓库键包含 state root 和 URL hash。不要反转队列或合成全局 mutex。等待后重新检查身份、角色与状态，授权错误保持原 HTTP 含义。

SQLite rollback 不恢复文件或 Git；owner 协调 prepare、rollback、finalize，操作错误与清理错误分别保留。后台轮次失败总是报告诊断，即使清理或状态写入也失败；诊断回调异常不阻塞之后轮次。

## 参数与资源生命周期

启动从 SQLite 载入参数，安装进程内不可变有效快照，然后才启动 Engine、维护及其他 owner。保存参数通过 scope、revision 和字段／交叉校验更新 SQLite，再替换快照并通知 Engine、维护与沙箱网络。

这条路径不同于模型／凭证配置变更：运行参数不预约全部工单、不关闭会话，操作通常在开始时读取预算；并发升高可放行队列，降低不取消已有轮次。精确语义见[运行参数](CONFIGURATION.md#运行参数)。

资源检查不执行扩展；实际会话加载运行用户全局 Pi 资源。SDK、Operator 扩展和应用 owner 为可信代码；模型本地工具／stdio MCP 才在 SRT 边界内。

## 启动与关闭

[buildApi](../src/http/api.ts) 先取得租约，再打开 DB、迁移、检查布局和共享快照，恢复开发与只读运行视图，初始化配置和维护，最后注册服务。

冷启动会恢复中断状态，并按部署准备 prod/test 快照、刷新对应 commit 基线；不等于重置开发分支。未知目录、漂移或损坏状态 fail closed，不自动采用历史目录。

[production.ts](../src/http/production.ts) 使用统一脱敏诊断。关闭先停止接收、结束 SSE，允许在途请求完成，有界关闭卡住连接，并等待 Engine／协议／数据库／租约释放。不能仅停监听端口就宣称所有写入已结束。

## Web 与事件投影

ApplicationResources 持有共享请求、编辑状态和每工单草稿。身份切换取消未发送工作，迟到响应按 identity／generation 拒绝。

SSE 顺序为持久／当前回放、snapshot_ready、live 与 heartbeat。历史逐帧等待排空，临时事件有界去重，慢连接预算超限断开重放，不静默丢帧；快照复用上下文计算 footer，不跨请求缓存。

会话使用不可变归约和 Solid keyed For，块按 contentIndex 保持身份；流式不解析 Markdown，工具详情惰性挂载。CodeBrowser 按需加载，独立释放 editor／model，维护撤销、冲突与导航状态。统计采样和排序优化不代替实际操作前重新检查。

## 安全与持久边界

身份、凭证、Source 策略和只读查询各有 owner，提示词不是授权。SRT 不替远程服务实施数据库权限。文件／Git 事务和恢复单位见[存储](STORAGE.md)，发布与清理见[运维](RUNBOOK.md)。
