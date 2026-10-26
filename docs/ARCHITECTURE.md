# 系统架构

[文档导航](README.md) · [Agent](AGENT.md) · [存储](STORAGE.md)

Issue Pilot 是一个 Node 应用，提供网页、HTTP、SSE 和入站 MCP。同一 state root 只允许一个 API 实例；可选的 4173 前端入口转发到该 API。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| HTTP／入站 MCP | 解析输入、建立身份、协调 owner 与返回 DTO |
| 配置 | 用户、凭证、仓库、部署、MCP 和全局 Agent 设置 |
| Engine | 工单队列、并发轮次、预约、投递恢复与失败收尾 |
| ModelRuntime／Pi | 模型会话、资源、工具、Codemode 和 MCP 生命周期 |
| Workspace | 代码集合、共享快照、工单 worktree、回收与重开 |
| 存储 owner | SQLite 事务、附件、工作文件及会话绑定 |

请求先校验身份与部署范围，工单创建独占空目录并插入唯一 Workspace。Engine 按工单排队，准备凭证、代码与 Pi 会话后执行；对话进入 JSONL，结果保存在普通工作文件，用户继续反馈或解决。

正式／测试调查使用只读快照，开发使用独立分支。身份、目标配置和服务工具的范围见[配置与协议](CONFIGURATION.md)，工具执行与会话恢复见[Agent](AGENT.md)。

## 并发与失败清理

Agent 活动、Issue-set reservation、配置 scope、生命周期、工单 inspection 和仓库操作分别排队，不能互换或合成全局锁。仓库键包含 state root 和 URL hash。

| 操作 | 固定顺序 |
| --- | --- |
| 配置读取 | scope queue → SQLite read snapshot |
| 服务／工单范围写入 | scope queue → Issue reservation |
| 回收／重开 | lifecycle queue → inspection queue → Issue reservation |

排队后重新授权。失败清理属于串行范围，旧失败不能覆盖新轮次；关闭等待已接收活动、队列与预约。SQLite 回滚不恢复文件和 Git，各 owner prepare、rollback、finalize，并保留操作与收尾两类错误。

## Web 与实时更新

ApplicationResources 持有共享资源和编辑状态。切换身份取消旧身份未发送工作，迟到响应按身份与 generation 拒绝。代码浏览器、对话与请求 DTO 分别由所属模块维护。

SSE 顺序为持久／当前回放、snapshot_ready、live／heartbeat。临时事件 ID 使用有界窗口，持久条目按连接生命周期去重；待发送帧队列没有独立字节上限。

工作区统计共享正在执行的扫描及短期完成快照。生命周期操作前后使缓存失效，真实释放重新检查，首次采样仍受磁盘 I/O 影响。

## 数据与执行边界

SQLite、Pi JSONL、普通文件和 Git 共同构成持久事实，分类与一致性规则见[存储设计](STORAGE.md)。模型本地工具和 stdio MCP 经过 SRT；SDK、Operator 扩展与应用 owner 是可信代码，远程服务实施自己的授权，详见[执行边界](AGENT.md#执行边界)。

源码入口与验证方法统一见[开发指南](DEVELOPMENT.md)，发布和恢复见[运维手册](RUNBOOK.md)。
