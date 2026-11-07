# Agent 与能力

[文档导航](README.md) · [架构](ARCHITECTURE.md) · [配置](CONFIGURATION.md)

## 处理范围

Engine 协调持久输入、工单串行队列、全局执行名额和会话；Pi 执行模型／工具管线。当前宿主机的模型配置来自 SQLite，模型目录和 Operator 资源来自运行用户 `~/.pi/agent`，不维护另一套应用 skills／extensions。

调查保持工单的正式或测试环境；开发代码在 dev，证据查询须显式选择 prod/test。原生证据按实际配置目标和能力开关开放，不硬编码禁用某环境；包含／关联服务和部署工具的边界见[配置](CONFIGURATION.md#服务和查询目标)。

## 原生证据查询

`service_query` 按 environment、service、capability 分发 DMS 或 SLS。工具参数是公开目标与查询，连接凭证由服务端按活跃工单 owner 选择，不进入模型提示、工具输入或 argv。个人组残缺或所选凭证失败不换共享身份。

### DMS

经 HTTPS SSE MCP 发现和调用。输入 schema 必须是配置的精确 schema；instanceAlias／schema 意图由当前凭证解析为实例和数据库，不信任客户端上传的 ID／host／port。

SQL 在连接前接受只读检查：拒绝写入、多语句、注释、锁定读取和已知副作用／服务器文件／动态 SQL 函数。这是边界检查，不保证识别每一种数据库扩展，远端账号仍必须只读。

默认操作预算 120 秒，可热更新；首次握手预算 12 秒。每次连接最多两次握手，只有首次握手超时或符合有界 Retry-After 的 429 可重试；401／403 不重试。退避和第二次握手共享操作预算；发现或 SQL 调用失败不重新握手，已发送 SQL 不自动重放。

诊断包括稳定错误码、phase、elapsedMs、phaseElapsedMs、sqlDispatchAttempted 和可用的 retryAfterSeconds。发送尝试不能证明服务器已执行。连接／查询与关闭都失败时保留两个原因，不能吞掉清理失败或把它重分类成普通取消。DMS 批次串行并保持间隔，根据实测失败退避，不假定固定配额。

内联超预算要求 export，导出到普通 JSON 工作文件，协议关闭成功后才替换旧文件；失败不重查或覆盖为空文件。owner 与回归：[dms.ts](../src/capabilities/dms.ts)、[dms.test.ts](../tests/capabilities/dms.test.ts)。

### SLS

固定调用 aliyun sls GetLogsV2。必须显式提供精确 region／project／logstore，按部署中的完整组合授权，不接受旧 target 参数；`*` 是配置通配意图，查询仍要具体日志库。

CLI 使用 0600 临时凭证配置、HTTPS、禁用自动重试，不改宿主 profile。连接和执行预算取当前参数，取消／超时终止子进程组并清理凭证。只接受 Complete；普通日志按 offset 拉完，SQL 分析保留自身 LIMIT／ORDER BY 返回一页。后页失败、证据不完整或结果超限时整次失败，不返回部分成功。

单次 stdout、累积 JSON 和最终响应都有字节预算；页面展示预算不改变这些限制。错误只返回稳定映射，隐藏未知 CLI 原文；凭证目录清理失败优先报告 sls_credential_cleanup_failed。来源保留真实地域、Project、日志库和时间。owner 与回归：[sls.ts](../src/capabilities/sls.ts)、[sls-cli.ts](../src/capabilities/sls-cli.ts)、[sls.test.ts](../tests/capabilities/sls.test.ts)。

真实厂商查询与本地 CLI 协议验收不是同一件事。本次实际模型／DMS／SLS 结果和具体覆盖范围见[迁移记录](records/2026-11-07-host-migration.md)，协议夹具见[开发](DEVELOPMENT.md#真实-sls-cli-协议验收)。

## MCP 与 Codemode

入站 `/mcp` 用于操作工单；服务 MCP 为 Agent 提供工具；全局钉钉连接仅用于导入。服务 MCP 要求部署归属及工单入口／包含服务范围。readOnlyHint 是描述，不能代替授权。

DMS 和 SLS 都通过 Codemode 的 `tools.service_query` 调用，由 capability 区分。DMS 串行指引不表示从 Codemode 排除 DMS；缺凭证在 execute 阶段明确失败。off 为直接工具，on 为直接与编排并存，only 主要经编排发现；on／only 不预载所有 schema。

编排执行使用进程级 FIFO，一次一个脚本，等待容量 32，等待预算默认 120 秒，等待取消／超时不执行。脚本中的并行不绕过工单、仓库或 DMS 约束。依据：[service-query-tool.ts](../src/agent/service-query-tool.ts)、[codemode.ts](../src/agent/codemode-extension.ts)。

Pi 管理 MCP 发现、注册、连接和关闭，应用保留同源／禁止重定向、预算、取消、范围及可变钩子后输入检查。连接失败不自动重放远端调用，下次显式请求重新连接。DBHub 是部署 MCP，MySQL 不走原生 DMS 以外的另一个自制执行器。

## 文件、模型与资源

工单根是唯一持久可写模型目录，相关工单只读。格式处理用普通程序及已安装库，Python/openpyxl 能读写 xlsx 和保留公式，不计算公式；不加格式专用执行框架。

附件原件读取前核对权限／hash，不自动复制可编辑副本；图片粘贴属于会话。输出和导出统一为普通工作文件，SDK 截断输出及图片保存回调见[补丁](../patches/README.md)。

模型请求使用 SQLite 选中的完整个人组或共享组。Operator auth.json／models.json 中的密钥和 headers 被请求运行时隔离，不能成为 fallback。模型私有临时目录清理失败仍保留所有权供 close 再尝试；初始化和关闭失败聚合，不切 Key 重试。

资源检查只发现路径不执行扩展。实际会话加载运行用户全局资源，不加载工单本地扩展，Operator 扩展不能覆盖应用保护工具名。只读轮次结束关闭会话，下轮恢复对话并准备快照；开发空闲会话可复用。

## 消息接收与恢复

同工单队列等待后再次检查，保存可见输入与会话绑定才返回 202。代码、凭证或 SDK 准备失败不会丢弃已受理输入；内存执行队列不是持久调度器，重启不自动开始模型工作。

| 持久记录 | 恢复语义 |
| --- | --- |
| issue-pilot-user | 可见输入、交付版本和原范围 |
| delivery started | 可能已交付，不证明完成，不自动再注入 |
| delivery rejected | scope_changed 或 cancelled，不恢复 |
| 明确排队且无 started／rejected | 用户主动继续／重试时按顺序恢复 |
| 无排队元信息 | 不推定待办 |

更早排队输入未处理时，新消息不能 steer 插队；Pi 接纳前回合结束则取回排入下一轮。交付结果未知为 agent_message_outcome_unknown，不重放旧会话或覆盖新状态。应用不承诺外部副作用恰好一次。

### 主动取消

abort 重检调用者、标记当前及排队轮次取消，等待接收队列、Pi abort 和收尾，再把未开始输入记为 rejected/cancelled。同工单重复取消共享操作，收尾期间拒绝冲突的新输入／预约。

成功不等于回滚已发生副作用。取消或状态写入失败时保留诊断，先检查对应工单当前状态和受影响文件，不强改状态重放。页面只用 Esc 提示，不新增停止按钮。回归：[cancellation.test.ts](../tests/agent/cancellation.test.ts)。

## 重置、完整性与关闭

重置要求空闲、未解决和 expectedSessionId 检查，在预约／事务内切换绑定。失败只清理新文件，旧会话留在历史。组合保存提交后重置失败统一为 issue_saved_session_reset_failed；先核对已保存字段，仅重试重置。

绑定会话必须为完整 regular JSONL：非空、换行结尾、合法逐行 JSON 和正确会话头；空白、截断或坏行不由应用自动修补。SSE 和 MCP 读取也先校验，损坏时保留字节和绑定。缺失绑定的读取语义不同：SSE 跳过持久回放，MCP 失败，均不创建替代文件。完整旧版本仍可能被 SDK 格式迁移，不能由此保证所有历史读取永不写文件。依据：[pi-session.ts](../src/agent/pi-session.ts)、[读取完整性回归](../tests/http/session-read-integrity.test.ts)。

modelResponseIdleMs 检查连续无模型更新的等待，更新重置，工具执行时暂停；不是整轮总时长。关闭等待活动／排队／预约排空，再尝试 abort、shutdown、dispose；HTTP shutdownGraceMs 不会到期撤销全部模型工作。持久清理故障按[运维](RUNBOOK.md#启动与清理失败的处理边界)处理。

## 页面投影与费用

Web 直接投影 Pi JSONL／事件，不嵌入 PTY、不另建聊天库。仅有效 snapshot_ready 应用完成后才判定就绪；重连保留旧正文，非法帧要求重新回放。工具详情惰性加载，SDK nestedCalls 与 Codemode calls 不重复展示，complete=false 明示不完整。

费用和 Token 沿用 SDK usage；供应商值、估算和未知来源分别标记。重连快照替换统计，不累计重放或改写历史。Web 草稿生命周期见[使用指南](USAGE.md#阅读与补充)。

## 执行边界

SRT 使用 Linux user／PID／mount／network namespace 和 seccomp，宿主只读，当前工单根可持久写，相关工单只读，数据库和私有配置隐藏。私有 Git 可写部分与共享对象、hooks、config、指针分离；跨目录硬链接和危险 loader 环境受检查。

本地网络通过代理／proxychains，open／allowlist 的范围和即时生效边界见[配置](CONFIGURATION.md#工单网络访问)。开放网络不区分远端网站读写，也不解除控制地址／应用端口拒绝或文件隔离。临时个人 SSH 仅交给 native Git，不传给 stdio MCP。

Pi SDK、Operator 扩展和应用 owner 是可信应用代码，远程 MCP 仍有自己的权限。不能把 SRT 或只读提示解释为远端数据库权限保证。
