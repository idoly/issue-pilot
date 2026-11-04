# Agent 与能力

[文档导航](README.md) · [配置与协议](CONFIGURATION.md) · [存储](STORAGE.md)

## 责任与准备

Engine 负责工单排队、活动预约和恢复；Pi 负责模型会话与工具管线；应用 owner 负责身份、服务／环境范围、凭证、只读、文件和 Git。提示词只是工作指引，不是安全边界。

一轮工作依次准备工单上下文、当前合法 owner、模型组、代码与运行视图，再创建或恢复 Pi 会话。共享模型组为全局默认，个人完整组整组替换它；选择规则见[凭证与 owner](CONFIGURATION.md#凭证与-owner)。

## 构建与验证策略

默认优先源码、配置和已有证据的静态分析，不把安装依赖或完整构建当作例行步骤。用户要求验证，或明确的正确性问题无法静态确认时，才选择最小相关测试／检查，并说明执行原因与未验证范围；缓存缺失不构成自动重装或重构建的理由。该规则是 Agent 工作指引，不禁用工具，也不允许把未执行的构建／测试声称为通过。

## 工具执行路径

| 工具 | 实现与范围 |
| --- | --- |
| read／write／edit／bash／grep／find／ls | Pi 原生工具，经 SRT 中的短期 executor 执行，cwd 为工单根 |
| workspace | 由 workspace owner 提供服务说明、代码 list／include／remove |
| service_query | 原生 DMS／SLS 只读证据查询 |
| 服务 MCP 工具和 resources | Pi 管理连接，应用筛选 Deployment 和入口／已包含服务范围；include／remove 改变范围后，本轮结束即关闭会话，下一轮按新范围重建工具 |
| Codemode | 编排已授权工具，不新增文件或网络权限 |

输入在边界按当前 schema 解析。Pi 的初始工具规范化位于可变钩子之前，所以 execute 仍校验输入和授权；扩展改写公开 schema 不能扩大执行权限。应用 schema 使用 Pi Schema，外部协议保持官方 SDK 兼容。

沙箱的受保护文件列表在命令或会话启动时生成快照，之后新建的受保护文件不在其中。因此附件、会话文件等只在工单没有沙箱进程存活时写入：编辑附件、重置会话等操作先取得工单预约并关闭会话。

主要 owner：[pi-session.ts](../src/agent/pi-session.ts)、[native-tools.ts](../src/agent/native-tools.ts)、[service-query-tool.ts](../src/agent/service-query-tool.ts)、[pi-extension.ts](../src/mcp/pi-extension.ts)。

## 原生证据查询

查询必须保留准确服务、环境、目标与来源。调查选择本环境，开发显式选择 prod/test；代码操作仍留在 Issue 环境。凭证由服务端注入，模型不传连接密钥，也不能用凭证创建未配置目标。

### DMS

连接前检查只读 SQL，通过 SSE 执行。只读检查拒绝写语句、多语句、注释、锁定读取，以及 MySQL／PostgreSQL 中已知有副作用、读取服务器文件或执行 SQL 文本的函数；这是黑名单，不能替代数据库权限，DMS 账号本身必须只读。默认预算为操作 120 秒、首次握手 12 秒；最多两次握手，429 仅按合法 Retry-After 有界重试一次，401／403 不重试。操作超时是运行参数，可在“配置 → 参数”修改。已经发送的 SQL 不自动重放。

错误返回稳定 code 与脱敏阶段诊断：connect、discovery、execute、export、close，以及耗时、sqlDispatchAttempted 和可用的 retryAfterSeconds。发送尝试不证明服务端已执行，诊断不包含 URL、SQL 或认证；取消原因和关闭失败分别保留。

查询、导出与范围解析在取消时仍尝试关闭一次；操作与关闭都失败时聚合保留。超时映射为 `dms_mcp_timeout` 时保留原错误链，不能以取消或超时代码覆盖关闭失败。

内联结果与其他能力共用 `limits.capability.resultBytes`，超出返回 `dms_mcp_result_too_large_use_export`，需改用 export。DMS 导出只有内容写完且协议收尾成功才原子替换旧工作文件。失败不重查 SQL，不以空文件覆盖旧结果。模型工作指引要求串行批次、间隔、有界恢复探测与断点；这不是服务端限流器，不能据此声称外部调用必定安全。

### SLS

固定调用 `aliyun sls GetLogsV2`，通过 0600 临时配置传递选定凭证，强制 HTTPS、禁用 CLI 自动重试，结束或取消后删除，不修改宿主默认 profile。

仅接受 `meta.progress=Complete`。SQL 分析按 LIMIT／ORDER BY 返回一页，普通查询按 offset 分页，后页失败则整次失败。超时／取消终止进程组；已知错误映射为稳定诊断，未知错误隐藏。CLI 缺失返回 `sls_cli_not_available`。

临时凭证清理失败返回 `sls_credential_cleanup_failed`，优先于取消／超时分类；原查询或取消错误与清理错误分别保留，避免隐藏磁盘上可能残留的凭证。

### DBHub 与业务敏感值

DBHub 是部署所属 stdio MCP，不是 service_query 的原生适配器；数据库只读要求还依赖真实账号权限，配置见 [DBHub](CONFIGURATION.md#dbhub)。

连接凭证与业务查询结果不同：用户明确要求的登录／会话 token 可在授权结果中返回来源和时间，不扩大访问范围；连接 Key、Authorization 仍不得进入提示词、argv、诊断或普通日志。

## MCP 与 Codemode

入站 `/mcp` 供外部客户端操作工单；服务 MCP 为 Agent 提供能力；钉钉连接仅供应用导入。不能因协议名称相同而混用权限。

Pi 管理服务 MCP 发现、命名、注册、连接、资源和 shutdown。应用保留配置权、同源／无重定向、预算、取消及发送前检查。会话失效报告本次失败，下一次显式调用再连接，不重放原操作；只读 hint 不等于授权。

| Codemode | 声明方式 |
| --- | --- |
| off | 直接工具调用 |
| on | 直接工具与 Codemode 并存，按需发现 |
| only | SDK 主要通过 Codemode 发现和编排工具 |

on／only 不预载所有外部 schema。进程级可取消 FIFO 同时运行一个脚本，为 SDK 的退出缓冲保留槽位；默认队列 32、等待 120 秒，等待取消／超时不执行脚本。脚本内部可并行独立调用，不能据此绕过 DMS 工作指引或 owner 队列。

## 文件处理与会话

工单根是 cwd，也是唯一持久可写边界。使用普通命令和已安装库处理格式，不另设格式专用执行框架。Python/openpyxl 可读写 xlsx 和保留公式，不计算公式；网页不解析 Excel，xls 不在支持范围。

附件原件校验后只读使用，不自动复制为可编辑文件。粘贴图片属于 Pi 消息。SDK 图片、MCP 二进制与截断输出通过受控 saveOutput 回调进入普通工作文件，详见[补丁](../patches/README.md)。

JSONL 保存消息、工具结果与分支，恢复读取 active branch。只读轮次结束后关闭会话，下轮重新准备快照并恢复对话；开发空闲会话可复用。模型响应超时只累计等待模型输出的时间，工具期间暂停。资源来自 Operator 全局 Pi 目录，不执行工单本地扩展。

### 消息受理与恢复

输入在同工单队列等待后重新检查会话，文字／图片持久保存并绑定后才返回 HTTP 202；代码、凭证或 SDK 尚未准备成功不妨碍先保存输入。202 只表示受理，执行队列仍在内存，启动不自动开始模型工作。

| JSONL 记录 | 恢复意义 |
| --- | --- |
| issue-pilot-user | 可见输入，含交付版本和原范围 |
| delivery started | 可能已交付，不保证完成，不自动再次注入 |
| delivery rejected | 原范围已失效，保留原文并拒绝恢复 |
| 明确排队且无 started／rejected | 用户主动重试／继续时按序恢复 |
| 无排队元信息 | 不推断为待办 |

恢复使用当前合法 owner／模型，不保存密钥，不重复追加可见输入。未知或损坏记录报错。模型瞬时失败按 Pi retry 预算处理；最终失败保留已记录费用、会话和文件，允许主动重试。

后台轮次失败在同工单串行队列内完成会话清理与失败状态写入，随后总是把原错误交给诊断回调；清理或状态写入也失败时聚合报告。公开失败原因仍使用稳定错误码，诊断回调失败不阻塞后续轮次。

运行中的回合仅在没有更早排队消息时接收 steer，否则新消息排在其后，保持发送顺序；回合在 Pi 接纳 steer 前结束时，取回该输入并排入下一回合，不记为已交付。未交给 Pi 的消息可在会话结束后转普通回合；已交付而会话被替换返回 `agent_message_outcome_unknown`，不重放、不写回旧会话。应用没有客户端提交幂等 ID、跨进程自动调度或外部副作用恰好一次保证。

### 重置与关闭

重置在 scope 和工单预约内进行，以读取的 session ID 检查并发，关闭空闲会话后创建私有 JSONL 并事务更新绑定；绑定失败只清理新文件。旧会话保留审计关系与只读历史，新会话不自动执行。“保存并重置”通过 `PATCH /api/issues/:key` 的 `resetSession: true` 在同一预约内先提交字段与附件，再重置会话且不排队元数据轮次；提交后重置失败返回 `issue_saved_session_reset_failed`。

缺失或末尾不完整 JSONL 报错并保留原文件，不截断、改绑或新建替代会话。打开前校验每条记录都是完整 JSON 且首条为会话头；已校验的字节前缀会缓存，追加后的会话只解析新增部分。shutdown 等待活动、排队和预约，依次尝试 abort／shutdown／dispose，聚合操作与清理错误。

## 会话页面与统计

页面直接投影 SDK 事件，不嵌入 TUI／PTY，也不另存聊天数据库。消息按 ID、块按 contentIndex 使用函数 keyed For；Match 使用带参数 render callback，避免零参数 accessor 重建 DOM。已完成消息在后续流式更新时保留节点；未完成正文保持纯文本，最终块才解析并清洗 Markdown。

草稿和发送失败属于应用资源中的具体工单记录，导航后仍可恢复。身份切换移除旧记录后，迟到响应不能恢复旧图片、错误或修改新身份输入框；提交图片在响应结束后释放，应用资源销毁时释放未发送草稿的图片 URL。

工具默认折叠，展开后挂载已保留文本、diff、图片和嵌套调用，收起卸载。运行中使用 Codemode details.calls，SDK nestedCalls 存在时优先，避免重复；complete=false 明示记录不完整。完整输出链接复用工单文件解析和授权，不直接打开任意外部路径。

费用使用 SDK `usage.cost.total`，不另行计价。非零费用按 totalFromProvider 合并为供应商报告、估算、来源未标明或混合；零费用不改变来源。统计包含 assistant、工具、独立 usage、压缩和分支摘要，重连以快照替换，不累计回放或改写历史。

## 关联工单

关联目录为源工单真实根的只读引用，元信息和可用的 JSONL 引用在准备时生成。关联不扩大当前查询权限，开发会话复用也不会自动刷新摘要；引用重要证据时核对文件、版本与时点。

## 执行边界

SRT 使用 Linux user／PID／mount／network namespace 和 seccomp 约束模型本地工具与 stdio MCP。宿主文件系统只读，当前工单根可持久写入，相关工单只读，数据库与私有配置隐藏。管理文件、Git 控制指针另受保护，启动检查跨目录硬链接，写入重新验证路径。

网络经代理及 proxychains 统一出口，默认关闭 Unix socket 旁路和嵌套 namespace，拒绝宿主控制地址及 API／Web 端口。追加域名不改变这些拒绝。危险 loader 环境覆盖拒绝，依赖或隔离能力不足时失败。

私有 Git 索引、工作分支和新对象可写，共享对象、config／hooks／alternates 和绑定指针只读。developer 的临时 SSH 私钥为 0600、严格校验 known_hosts，仅 native 工具获得该身份，stdio MCP 不获得。

Pi SDK、Operator 扩展、应用 owner 是可信代码，远程 MCP 拥有独立执行权限；SRT 不替远程服务实施只读或业务授权。Source API 与查询 owner 必须继续检查各自边界。本地执行和 workspace 变更按工单串行，共享代理队列不能替代业务锁。
