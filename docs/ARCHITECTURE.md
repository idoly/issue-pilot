# 架构

Issue Pilot 在一个 Node 进程中运行 Fastify、SQLite/Drizzle、工单 Agent 调度和工作区管理。浏览器使用 Solid 与本地代码浏览器；Pi SDK 持有模型会话、原生编码工具与 JSONL。

## 事实所有权

| 事实 | 所有者 |
| --- | --- |
| 路径、默认值、预算、回收策略 | [根配置](../issue-pilot.config.ts)，绝对路径由 [config.ts](../src/config.ts) 解析 |
| 业务枚举、处理方式和权限谓词 | [domain/contracts.ts](../src/domain/contracts.ts) |
| 用户、配置、工单、仓库、附件元数据、会话绑定、Workspace | SQLite；当前结构见 [schema.ts](../src/db/schema.ts) |
| 升级顺序 | [drizzle](../drizzle) 的 SQL 与 journal |
| 对话 | 每工单 Pi JSONL 的 active branch |
| 附件 | 文件内容及 DB object key、size、SHA-256 |
| 工作文件 | 每工单 work 目录，跨轮次保留 |
| 成果 | 每工单 outputs 目录，仅发布后作为交付物 |
| 开发代码 | bare store 的本地 working branch 和活动 worktree |
| 正式/测试代码 | 当前 Deployment base branch 最近获取的 commit 快照 |
| runtime 和 wrapper | workspace owner 生成，可验证并重建 |

页面状态、日志和派生描述不反向覆盖这些事实。能力配置、凭证及 MCP 合同见[配置](CONFIGURATION.md)。

## 主要调用路径

```text
Browser -> Web client -> Fastify route -> reservation/transaction -> owner
AgentEngine -> project preparation -> Pi session -> tools -> protocol/process
Pi events + JSONL -> SSE snapshot/live -> Web conversation projection
External AI -> inbound MCP -> existing HTTP routes -> Issue/Agent owners
```

[src/http/api.ts](../src/http/api.ts) 组装 owner、队列、路由和关闭流程。HTTP 负责输入边界、身份、预约与事务协调；协议在 capabilities/MCP client，Git/文件操作在 workspace，通用 spawn 在 process，项目命令授权在 tool-runtime。

## 工单与工作区

新建入口只接收 `workMode` 与 `serviceKey`。处理方式唯一确定环境、Issue type 和代码权限，不额外存一套 work mode。创建先独占 claim 空目录，再事务写入 Issue、Workspace、关系与附件，成功后入队。

Agent 执行时工单转为 `in_progress`，成功后 `pending`，失败且未解决时回到 `open`；人工可将 pending 标记为 resolved，再重开为 open。`resolved_at` 必须与 resolved 状态一致。

Workspace 状态为 `not_created`、`preparing`、`running`、`ready`、`stopped`、`failed`。`runtime_ready` 表示已经生成 runtime，不能替代读取源码时的物理路径和 Git 状态校验。

普通编辑只修改元数据、抄送和附件。范围变更使用 [scope-transition.ts](../src/workspace/scope-transition.ts) 的 plan/apply：在锁内重新计算版本与 plan hash，拒绝过期计划，成功转换与审计同事务提交。支持范围包括 prod/test 只读重绑、同服务调查转开发修复，以及保持开发 branch mode 的跨服务迁移；未支持的转换显式拒绝。

## Git 与代码集合

[src/workspace/state.ts](../src/workspace/state.ts) 按整组 Repository rows 分类：

| 状态 | local_path | working_branch |
| --- | --- | --- |
| read_only | 全 NULL | 全 NULL |
| development_workspace | 全非空 | 全非空 |
| development_snapshot | 全 NULL | 全非空 |
| invalid | 空集合、混合或其他布局 | 拒绝 |

bare store 按 Repository URL hash 共享 objects/refs。正式和测试每轮读取当前部署分支并获取 commit，使用受管 detached checkout；活动开发工单拥有独立 worktree，本地 branch 为修复或功能模式。已有开发仓库保留历史 base branch、workspace name 和未提交内容。

`workspace list/describe/include/remove` 可发现并调整同环境的附加服务代码。`issue_service_scopes` 保存意图，仓库按 URL 去重；同 URL 分支冲突拒绝，移除开发代码要求 clean。失败保留意图、refs、rows 和文件，后续 prepare 可重试。

释放只处理 resolved、空闲、布局有效且 clean 的开发工单。批量移除失败会从原本地 ref/commit 恢复；成功清空 local_path、保留 working branch，再生成只读 runtime。重开从本地 branch 恢复，不使用远程 Issue branch 兜底。实现入口为 [project.ts](../src/workspace/project.ts)、[git.ts](../src/workspace/git.ts)、[lifecycle.ts](../src/workspace/lifecycle.ts)。

## 关联证据与文件

每张工单可关联其他环境/类型工单。更新预约目标、旧关联和新关联，关闭旧会话、更新关系、标记 runtime 待重建并重新入队。关联目录提供只读 issue.json；有受管 session 时提供 conversation.jsonl；有有效开发 working branch 时提供其提交快照，不包含未提交改动。

附件写入属于 Issue create/edit：上传先暂存并计算 hash，durable copy 为 `0400`；删除先进入 quarantine，事务失败恢复，成功后 finalize。错误时保留可调查证据。Agent 粘贴图片直接写入 Pi message/JSONL，不生成 Attachment。

正式数据处理可写 outputs。Agent 使用普通代码和环境中的库生成任意格式文件，output 工具只列出或发布文件；发布限定当前工单 work 目录中的 regular file，按字节流复制后原子替换，失败保留旧文件。MySQL/DMS 可直接保存完整查询结果，再由普通脚本处理。Excel parser 用于 Web/MCP 预览，不拥有脚本执行或成果编码流程。协议见[配置](CONFIGURATION.md)。

## Agent 会话与工具

[engine.ts](../src/agent/engine.ts) 拥有工单队列、预约和状态；[pi-session.ts](../src/agent/pi-session.ts) 封装 Pi 会话、显式工具和持久绑定。每轮先准备代码，再构建最小上下文，打开或创建私有 JSONL，提交运行状态后执行 prompt。失败、取消和关闭均清理会话；JSONL、成果和 worktree 保留。

Pi SessionManager 是对话上下文事实源。应用不从宿主自动加载 extensions、skills、prompt templates 或项目 context；使用显式 prompt、模型、原生工具与内置编码指导。

所有工单都获得 Pi 原生 read/bash/edit/write/grep/find/ls，cwd 为私有 work 目录。代码仓库通过 prompt 中的受管路径访问，避免把处理脚本写进 Git 根目录或可重建 runtime。正式数据处理额外获得 output；workspace 管理代码集合，service_query 调用已配置集成。模型、查询工具与 session 适配集中在 src/agent。

这是单应用容器内的可信执行模型，工作目录不构成 OS 隔离。Source API 的只读策略、service_query 的来源/目标/只读校验仍有效；原生代码拥有应用用户权限，可以绕过文件层面的业务约束。当前不运行额外容器沙盒、QuickJS 处理链或每工单执行服务。

## 事件与前端

SSE 顺序为持久 JSONL 回放、当前未持久轮次回放、`snapshot_ready`、缓冲/实时事件和心跳。服务端先订阅再读取 snapshot，按 event ID 去重；当前运行增量仅存内存，JSONL 接管后释放。写入器处理顺序、背压、连接关闭和错误。

Web 的 `agent-stream.ts` 管理 EventSource、generation 和重连；`conversation.ts` 纯投影消息。`ApplicationResources.tsx` 共享配置/用户，`OverviewView.tsx` 唯一拥有首页工单请求和轮询。取消与 generation 防止旧工单、旧身份响应覆盖当前视图。

本地 CodeBrowser 使用现有 Source API：文件树、搜索、纯文本编辑、Git 变更/暂存/提交、历史和行信息。保存携带读取时 SHA-256，冲突保留草稿；文件与仓库切换保护未保存内容。差异算法复用 diff 库，界面提供行号、增删颜色和并排/行内显示。Source owner 继续验证相对路径、symlink、Git ancestry 和 dev mutation。前端没有 iframe、编辑器 worker、扩展宿主或 VS Code 服务层。

## 并发与启动

锁域分别是每工单 Agent、Issue-set reservation、配置 scope、lifecycle、每工单 inspection，以及 state root + URL hash 的 Git 操作。

```text
configuration read: scope -> SQLite read snapshot
service/Issue scope write: scope -> Issue reservation
release/reopen: lifecycle -> inspection -> Issue reservation
```

配置快照使用 libSQL read transaction，避免取得不必要写锁。文件/Git 不由 SQLite rollback，跨介质 owner 必须准备、提交、回滚和最终化。

启动迁移并验证数据库，检查 unmanaged state，清理经验证的生成物，启动 project broker，重建 runtime，初始化全局模型并执行维护。关闭 drain 维护与 Agent，关闭会话、模型 runtime、broker，最后关闭数据库；清理步骤全部尝试并聚合失败。持久性分类和恢复操作见[运维](RUNBOOK.md)。
