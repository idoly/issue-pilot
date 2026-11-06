# Agent 与能力

[文档导航](README.md) · [配置](CONFIGURATION.md) · [存储](STORAGE.md)

## 运行原则

Engine 管理工单队列、预约与恢复；Pi 管理模型和工具管线；应用 owner 实施身份、范围、凭证、只读、文件与 Git 校验。提示词是行为指引，不是权限边界。

默认先读源码、配置和已有证据，不例行安装依赖或完整构建。用户要求或具体正确性问题确需执行时，选择最小相关检查，并报告执行原因和未验证范围。缓存缺失不是自动重装理由，未运行的测试不可声称通过。

## 工具执行路径

| 工具 | 边界 |
| --- | --- |
| read／write／edit／bash／grep／find／ls | Pi 原生定义，SRT 中的短期 executor，cwd 为当前工单根 |
| workspace | owner 管理服务说明及代码 list／include／remove |
| service_query | 原生 DMS／SLS 只读证据查询 |
| 服务 MCP tools／resources | Pi 管理生命周期，应用筛选 Deployment、服务和来源环境 |
| Codemode | 编排已授权工具，不新增文件／网络权限 |

应用在 execute 再校验输入及授权，因为 Pi 的初始规范化在可变钩子之前；公开 schema 改写不能放宽独立执行快照。只读、目标与身份继续由 owner 检查。

include／remove 改变工具范围后，本轮结束关闭会话，下一轮按新范围重建。管理文件保护列表也是执行时快照；写入新附件或重置会话须先预约工单并关闭沙箱会话，不能在旧保护列表下写入新原件。

## 原生证据查询

每次查询保留精确服务、来源环境和目标。调查使用本环境，开发显式选择 prod/test，代码操作仍留在 Issue 环境。连接凭证由服务端注入，不进入模型输入。

### DMS

通过 SSE 执行，SQL 在连接前接受只读检查：拒绝写入、多语句、注释、锁定读取及已知副作用／服务器文件／动态 SQL 函数。它是防御性黑名单，不保证识别所有数据库扩展，账号本身必须只读。

默认操作预算 120 秒、首次握手 12 秒；操作预算可热更新。每次连接最多尝试两次握手：首次握手超时可再试一次；首轮 HTTP 429 使用有效 `Retry-After`，缺失／无效时使用 `retryDelayMs`，仅等待值不超过 `maxRetryDelayMs` 时才有界退避一次。第二次握手、退避和查询仍共享本次操作预算。401／403 不重试；工具发现或 SQL 调用阶段失败不重新握手，已发送 SQL 不自动重放。实现与回归见 [dms.ts](../src/capabilities/dms.ts)、[dms.test.ts](../tests/capabilities/dms.test.ts)。

诊断只返回稳定码、阶段、耗时、sqlDispatchAttempted 和可用的 retryAfterSeconds，不含 URL／SQL／认证。发送尝试不证明已执行。取消也尝试关闭，操作与关闭都失败时聚合保留，不能被 timeout 重新分类吞掉。

内联结果超预算要求 export；导出写入普通工作文件，只有协议收尾成功才原子替换旧文件。失败不重查 SQL、不用空文件覆盖旧交付。批次间隔、恢复探测和断点属于模型指引，不是服务端限流器。

### SLS

查询参数必须显式指定 region、project、logstore，按部署配置中的完整组合授权；没有自定义目标名，也不接受旧 `target` 参数。结果保留实际地域、Project 和日志库来源，不回传目标别名。

固定 aliyun sls GetLogsV2，使用 0600 临时配置、HTTPS 和禁用自动重试，不修改宿主 profile。执行预算来自运行参数，取消／超时终止进程组并清理凭证。

仅接受 Complete；SQL 分析按 LIMIT／ORDER BY 返回一页，普通查询 offset 分页，后页失败整次失败。已知错误映射稳定码，未知 CLI 文本隐藏。凭证清理失败优先报告 sls_credential_cleanup_failed，同时保留原查询／取消原因。

分页期间累计结果仍受预算限制，不是每页成功就向用户交付部分成功。单次 CLI stdout 和最终完整 JSON 都有 UTF-8 字节预算，后者还包含来源／查询元数据；任何一页、累积记录或最终结果超限整次失败，不自动重放。普通分页按记录数推进 offset、返回 newest_first；SQL 分析保留查询顺序和 LIMIT，不承诺额外分页。实现见 [sls-cli.ts](../src/capabilities/sls-cli.ts)，边界回归见 [sls.test.ts](../tests/capabilities/sls.test.ts)，真实 CLI 的本地协议验收见[开发指南](DEVELOPMENT.md#真实-sls-cli-协议验收)。

### 外部数据库与敏感结果

DBHub 是部署所属 MCP，不是 service_query 的原生适配器，其真实只读仍依赖数据库权限。连接密钥受保护；用户明确要求的业务登录／会话 token 可从已授权查询结果附来源和时间返回，但不扩大权限。

## MCP 与 Codemode

入站 MCP 供外部客户端操作工单，服务 MCP 为 Agent 提供能力，钉钉连接仅用于导入。不要按协议名称混用权限。

Pi 负责发现、注册、连接、资源和 shutdown。应用保留配置权、同源／不重定向、输入／结果预算、取消与发送前检查。连接过期报告当前失败，下次显式调用重新连接，不自动重放；readOnlyHint 只是说明。

Codemode off 为直接调用，on 为直接工具与编排并存，only 主要经编排发现工具。on／only 不预载全部 schema。进程级 FIFO 同时运行一个脚本，等待容量 32、默认 120 秒；等待取消或超时不执行。脚本内部并行不替代工单／仓库队列，也不绕过 DMS 指引。

## 文件、资源和模型

工单根是唯一持久可写模型边界，相关工单只读。格式使用普通命令和已安装库；Python/openpyxl 支持 xlsx 读写及公式保留，不计算公式，网页不解析 Excel。

附件原件校验后只读读取，不自动复制可编辑副本；编辑须显式另存。粘贴图片属于 Pi 消息。SDK 图片、二进制和截断输出通过 saveOutput 回调交给工作文件 owner，详见[补丁](../patches/README.md)。

模型组由 SQLite 的 owner／共享规则选择，Operator 认证不会混入请求。资源使用运行用户全局 Pi 目录，工单扩展不加载；资源检查不执行扩展。只读轮次结束关闭会话，下轮重新准备快照并恢复对话，开发空闲会话可复用。

模型运行时只在私有临时目录删除成功后放弃该目录的所有权。初始化与清理同时失败时保留两个原因，随后 `close()` 仍尝试清理；并发关闭共用同一个 Promise，关闭后不再接受加载。持久文件系统故障仍需 Operator 处理，不自动重试模型请求或切换凭证。依据：[model-runtime.ts](../src/agent/model-runtime.ts)、[初始化与清理失败回归](../tests/agent/model-runtime.test.ts)；遇到此类错误先按[运维清理故障](RUNBOOK.md#启动与清理失败的处理边界)检查，不手工删除不明临时目录。

## 消息接收与恢复

同工单队列等待后重新检查会话，保存文字／图片并绑定后才返回 202。凭证、代码或 SDK 准备失败也不会丢弃已受理输入；执行队列仍在内存，进程启动不自动开始模型工作。

| 持久记录 | 含义 |
| --- | --- |
| issue-pilot-user | 可见输入及交付版本／原范围 |
| delivery started | 可能交付，不保证执行完成，不自动再注入 |
| delivery rejected | `scope_changed` 表示原范围不合法，`cancelled` 表示明确取消；两者都保留可见输入且不再恢复 |
| 明确排队、无 started／rejected | 用户主动重试／继续时按序恢复 |
| 无排队元信息 | 不推断为待办 |

有更早排队消息时新消息继续排队，不能 steer 插队；Pi 接纳引导前回合结束则取回输入排入下一回合。已交付而会话替换报 agent_message_outcome_unknown，不重放、不写回旧会话。没有外部副作用恰好一次保证。

错误清理与失败状态写入仍在该工单串行队列，随后报告原诊断；清理／写状态也失败则聚合。Pi retry 有界处理瞬时模型失败，最终失败保留记录、费用和文件。

### 主动取消

`POST /api/issues/:key/abort` 进入 [Engine.abort](../src/agent/engine.ts)：先重检调用者，标记该工单当前和排队轮次取消，等待消息接收队列、Pi abort 与轮次收尾，再将未开始的持久输入标为 `rejected/cancelled`。同工单并发取消共享正在进行的操作；收尾期间拒绝新消息／预约，取消不等待其他工单释放执行名额。

成功返回表示这次取消及收尾完成，保留会话和用户输入；不是回滚已发生的文件修改或远程操作。准备过程在检查点响应取消，工具完成时间取决于取消传播，因此不能给取消请求承诺固定时长。取消或写状态失败会聚合为内部 `agent_abort_failed`；失败响应后先检查状态、对话、文件和诊断，不将失败视作从未执行，也不强改状态后重放。已取消输入在之后 retry 时不会再次注入，见 [message-delivery.ts](../src/agent/message-delivery.ts) 与[取消回归](../tests/agent/cancellation.test.ts)。页面快捷键见[阅读与补充](USAGE.md#阅读与补充)，HTTP 权限与响应见[接口](HTTP.md)。

## 重置、完整性与关闭

重置要求空闲及 session ID 并发检查，在 scope／预约内创建私有 JSONL、事务切换绑定；失败仅清理新文件，旧会话通过历史只读查看。保存并重置在同一 scope／预约内先重检开发者权限、未解决状态和当前会话，再提交字段／附件，不额外排队元数据回合；提交后任何重置失败统一返回 `issue_saved_session_reset_failed`，不能误报为尚未保存的普通会话冲突。预检后仍保留重置时的文件完整性和 session ID 检查，失败不回放或覆盖旧会话。

执行、历史查看和重置不会为缺失或损坏的绑定会话新建替代。JSONL 完整性检查要求非空 regular file、完整的换行结尾、合法 JSON 记录和首条会话头；纯空白也不算有效会话。校验前缀可缓存，追加后仅解析新增部分。

当前会话的 SSE 回放和入站 MCP `issue_conversation` 也在交给 Pi SDK 前执行同一检查；空白、截断和非法 JSON 返回 `agent_session_file_incomplete`，保留原字节及绑定，避免 SDK 自动补换行、重建空文件或忽略坏行。SSE 在校验期间缓冲 live 事件，回放时按 entry ID 去重。缺失绑定文件的既有读取语义不同：SSE 跳过持久回放，MCP 读取失败；两者都不创建文件。此检查不禁用 SDK 对完整旧版本会话的格式迁移，不能理解为所有历史格式读取都绝不写文件。依据：[完整性 owner](../src/agent/pi-session.ts)、[读入口回归](../tests/http/session-read-integrity.test.ts)、[回放竞态](../tests/http/runtime-api.test.ts)。

`modelResponseIdleMs` 检测连续无模型更新的等待：`message_update` 重置计时，工具执行期间暂停。因此持续有输出的长轮次不受这个总时长上限约束；它不是整轮截止时间。依据：[AgentResponseWatchdog](../src/agent/pi-session.ts)。

关闭先等待排队、活动与预约排空，再对会话尝试 abort／shutdown／dispose，操作与清理错误独立保留。Engine 没有独立的排空截止时间；`http.shutdownGraceMs` 仅强制关闭卡住的 HTTP 连接，不会在该时间后自动撤销全部排队模型工作。停机前应减少新请求并等待队列，平台强杀仍可能产生中断状态，恢复见[运维](RUNBOOK.md#按风险发布与重启)。

## 页面投影与费用

直接投影 Pi 事件，不嵌入 TUI／PTY、不存第二份聊天库。消息按 ID、文本／思考块按 contentIndex keyed，Match 使用带参数 render callback。动画帧批量处理增量，流式为纯文本，最终才解析和清洗 Markdown。

只有有效 `snapshot_ready` 回放应用完成后才判定会话就绪、清除连接错误。首次等待显示「正在加载对话…」，完成后才判断是否无对话；重连保留旧正文及已有连接错误，不能把传输连接建立等同于历史加载完成。回归见 [AgentPanel.test.ts](../src/web/src/app/AgentPanel.test.ts)、[agent-stream.test.ts](../src/web/src/app/agent-stream.test.ts)。

工具详情惰性挂载，Codemode details.calls 与 SDK nestedCalls 只展示一份，后者优先；complete=false 明示不完整。输出链接仍经授权文件解析，不直接打开任意路径。

草稿按应用资源、身份和工单持有，旧响应不能重建已移除草稿或覆盖新输入。图片 URL 在提交结束、丢弃或资源销毁时释放。

费用沿用 SDK usage，不另计价。非零费用按 totalFromProvider 合并成供应商报告、估算、未知或混合；assistant、工具、独立 usage、压缩与分支摘要均计入。重连快照替换统计，不累计重放或改写历史。

## 执行边界

SRT 使用 Linux user／PID／mount／network namespace 与 seccomp，宿主只读、当前 Issue 根可持久写、相关 Issue 只读，数据库和私有配置隐藏。Git 指针、管理文件和跨目录硬链接有额外检查。

网络通过代理／proxychains，支持全局 `open`／`allowlist` 模式，默认 `open`；模式、生效时点及部署影响见[工单网络访问](CONFIGURATION.md#工单网络访问)。开放模式不按网站读写操作过滤。Unix socket 旁路与嵌套 namespace 仍关闭，既有宿主控制地址及 API／Web 端口拒绝继续生效。危险 loader 环境拒绝，隔离能力不足时失败。

私有 Git 索引／分支／新对象可写，共享对象及 config／hooks／alternates／指针只读。临时个人 SSH 身份只向 native 工具开放，不向 stdio MCP 传递，严格校验 known_hosts。

SDK、Operator 扩展与应用 owner 属于可信代码；远程 MCP 自行实施权限。本地执行、workspace 变更和代理生命周期各有 owner 队列，不能相互替代。
