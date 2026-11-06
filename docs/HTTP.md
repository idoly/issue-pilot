# HTTP 接口约定

[文档导航](README.md) · [使用与状态](USAGE.md#状态与完成条件) · [配置与 MCP](CONFIGURATION.md)

本文供客户端集成与排障使用，覆盖核心流程而非全量 API。路由 owner 为 [src/http](../src/http)，Web 请求／DTO 为 [client.ts](../src/web/src/data/client.ts)，入站 MCP Schema 为 [server.ts](../src/mcp/server.ts)。这些接口随当前源码演进，没有独立于应用版本的兼容承诺。

## 身份与访问边界

- API 没有登录、密码或签发 session token 的流程。`X-Issue-Pilot-Subject` 只是数据库用户选择器，不证明调用者身份；必须由可信网关认证并覆盖客户端传入的头，阻止绕过网关直连 API／Vite。
- 调用 [requireCurrentUser](../src/http/route-context.ts) 的路由要求用户活跃；显式 subject 不存在或失活通常返回 `400 invalid_current_subject`，不是登录挑战。缺省身份的选择规则见[配置](CONFIGURATION.md#身份与权限)。
- **不是每条 GET 都执行身份校验**：例如 `GET /api/issues`、`GET /api/issues/:key`、`GET /api/users`、`GET /api/catalog`、`GET /api/config`。应用没有逐工单 ACL，也不能将“处理人／报告人”理解为只允许本人读取。网关应保护所有业务读取、文件、私有配置、SSE 和 MCP，而不仅是写接口。
- developer 与 isAdmin 分别检查；developer 不自动获得共享密钥管理权限，admin 也不自动获得开发处理方式。具体配置操作权限见[配置](CONFIGURATION.md#身份与权限)。
- 普通 `/api/` 响应和 `/mcp` 使用 `Cache-Control: private, no-store`；这不是访问控制或数据加密。SSE 单独使用流式缓存头。

浏览器的原生 EventSource 不发送页面选中的 subject 头；SSE 路由没有显式头时按默认活跃用户处理。生产网关需要对 SSE 同样绑定认证身份，不能只为普通 fetch 配置身份转发。实现见 [agent-routes.ts](../src/http/agent-routes.ts)。

`agent-messages` 固定本次请求的发送者，在会话／引导队列等待后、受理输入或交给 Pi 前重新检查其活跃状态。等待期间失活会返回 `400 invalid_current_subject`，不改用另一个默认账号；已经受理或交付的消息不会因后续停用自动撤销。竞态修复与回归见[后端审查记录](records/2026-11-06-documentation-audit.md#p2消息等待期间停用发送者仍被受理)。

## 请求与响应

HTTP 路径中的 `:key` 为业务编号（例如 `ISSUE-20260101-001`），不是 SQLite 内部 UUID。工单摘要／详情的 `id` 字段也是该业务编号，创建后用响应的 `id` 继续调用；仓库等其他资源的 `id` 仍有各自含义。HTTP 解析编号不区分大小写；客户端建议始终使用返回的规范编号。普通 JSON 写入使用 `Content-Type: application/json`，下载接口返回文件而非 JSON。

| 请求 | 返回与关键约定 |
| --- | --- |
| `GET /health` | `200 {"ok":true}`，仅说明已完成启动并能处理请求，不检测模型／外部服务 |
| `GET /api/me` | 当前用户的 `subject`、`name`、`email`、`role` 与可选 `isAdmin` |
| `GET /api/catalog` | 创建所需服务与环境目录；不会创建服务或查询目标 |
| `GET /api/issues` | 摘要数组，按 `createdAt` 降序、`key` 降序；**没有服务端分页、过滤和排序参数**，Web 在客户端处理，MCP 另有分页 |
| `GET /api/issues/:key` | 摘要加描述、附件、仓库、workspace、关联、评论等；`workspace.lastError` 用于定位，不是自由重试许可 |
| `POST /api/issues` | `201` 工单摘要；保存并安排入队，不等待模型完成 |
| `PATCH /api/issues/:key` | `200` 摘要；保存元信息／附件，未解决且未请求 reset 时安排一轮元数据反馈 |
| `POST /api/issues/:key/agent-messages` | `202`，空响应体；输入已受理，不返回模型结果 |
| `POST /api/issues/:key/abort` | 活跃用户可调用；`200 {"ok":true}` 表示当前轮次／排队取消与收尾完成，保留对话，不撤销已完成操作；预约冲突为 409 |
| `DELETE /api/issues/:key` | 管理员专用，`204` 表示工单数据库关联记录和工单根已清理；页面无删除入口，重复删除为 404 |
| `POST /api/issues/:key/retry` | `202 {"ok":true}`，未解决且空闲时继续处理；运行／预约冲突为 409 |
| `PATCH /api/issues/:key/status` | `200` 摘要，body 只选择 `{"status":"resolved"}` 或 `{"status":"open"}`；转换条件见[状态](USAGE.md#状态与完成条件) |
| `POST /api/issues/:key/comments` | `201` 评论；body 为 `{"body":"人工备注"}`，**不发送给 Agent**，与 agent-messages 不同 |
| `GET /api/issues/:key/files?path=...` | 指定目录的文件条目数组，不递归分页；管理文件只列名 |
| `GET /api/issues/:key/files/download?path=...` | 普通工作文件下载，path 使用列举结果中的相对路径，不接受任意宿主路径 |
| `GET /api/issues/:key/attachments/:attachmentId` | 经过完整性校验的附件原件下载，ID 从工单详情获取 |

配置、Source、范围转换和回收接口有各自权限／并发规则，不宜据此表猜测请求体。Source 保存使用读取时的 SHA-256 检查冲突；配置 revision 和工单元信息不是同一种并发机制。

`GET /api/repositories` 无需分组参数，返回全部仓库及每个仓库保存的 `group`。页面筛选在本地完成。开发人员登记（`POST /api/repositories`）或编辑（`PATCH /api/repositories/:id`）时必须提供 `name`、`url` 和 `group`；编辑可传 `expectedRevision` 检查冲突。分组名称去掉首尾空白并转成小写，长度为 1 至 64，不能包含控制字符。仅修改分组不会更改服务绑定、分支或工单会话。

### 工单创建与编辑

创建 body 的必填字段为 `title`、`priority`、`serviceKey`、`workMode`。以下是请求体示例，不是初始化服务的脚本；`demo-service` 必须替换为目录中实际服务 key：

```json
{
  "title": "核对演示模块职责",
  "description": "只读分析仓库，不修改或提交代码。",
  "priority": "p2",
  "serviceKey": "demo-service",
  "workMode": "test_analysis",
  "assigneeSubject": null,
  "ccSubjects": [],
  "relatedIssueKeys": []
}
```

`workMode` 决定环境／类型，不能额外传 `environmentKey` 或 `type`。四种映射见[处理方式](USAGE.md#提交一张可处理的工单)。`priority` 接受 `p0`、`p1`、`p2`、`p3`；HTTP 创建没有 MCP 的默认 priority，调用方必须明确提供。省略／空处理人表示未分配，凭证 owner 此时为报告人；未分配工单不会进入任何人的个人处理队列。开发工单的创建者和 owner 都必须是活跃 developer；编辑时也不能把开发工单改派给非开发者，否则返回 `400 issue_developer_owner_required`。

带附件时用 multipart：一个文本字段 `issue` 放完整 JSON，文件字段可使用 `files`。附件写入随创建／编辑事务完成，没有独立附件上传写接口。HTTP 上传流式落盘，没有业务文件大小／数量上限，但普通字段、传输层和代理仍有限制；不要把它理解为任意大请求都可接受。MCP Base64 和 Agent 粘贴图片各有独立预算，见[配置](CONFIGURATION.md#入站工单-mcp)。

编辑虽使用 PATCH，元信息仍按**完整表单**解析：必须传 `title` 和 `priority`；省略 `description`、`assigneeSubject`、`ccSubjects` 会分别变为空、未分配、空列表，不是全部保留。`removedAttachmentIds` 指定移除原件，未指定移除的原附件保留。不能用普通编辑变更 `serviceKey`、`environmentKey`、`type`、`workMode` 或 `relatedIssueKeys`；范围与关联走专用接口。

`resetSession: true` 的组合编辑在 scope／工单预约内先重检 developer 权限、未解决状态和当前会话，再保存字段／附件并执行重置。已解决或未绑定会话的预检拒绝发生在保存前；会话在预检后变化、丢失或重置事务失败等情况，统一返回 `500 issue_saved_session_reset_failed`，明确表示字段／附件已保存而重置未成功。此时先重读详情和会话列表，只重试独立重置，不要重复上传附件；独立重置接口要求 `expectedSessionId`。其他失败也应按实际错误与当前状态判断，不为所有接口承诺原子回滚。实现见 [工单路由](../src/http/issue-routes.ts)，回归见 [session-reset.test.ts](../tests/http/session-reset.test.ts)，操作见[使用指南](USAGE.md#重置会话)。

Web 切换工单或身份后，旧保存请求的迟到失败不会清空新编辑窗口的附件选择或移除列表；切换页面也不撤销已提交的服务端写入。覆盖部分保存失败与刷新失败的回归见 [IssueReset.test.tsx](../src/web/src/app/IssueReset.test.tsx)。

### 发送消息与取消

纯文本使用 `POST /api/issues/:key/agent-messages`，JSON body 为 `{"message":"请核对现有证据并说明尚未验证的部分。"}`。`message` 必须是非空字符串，服务端去掉首尾空白；长度受 [limits.agentMessageChars](../issue-pilot.config.ts) 限制，超限为 `400 agent_message_too_long`。这是一次实际 Agent 请求，可能调用模型和工具；人工备注应使用 comments 接口。

带图片时使用 multipart：恰好一个文本字段 `message`，每个文件字段都命名为 `images`，可重复出现；不能复用附件上传的 `issue`／`files` 字段。声明 MIME 只接受 `image/png`、`image/jpeg`、`image/gif`、`image/webp`；仍须提供文字，不能只传图片。`limits.agentImage.fileBytes` 限制单张图片原始字节，`requestBytes` 限制本次所有图片原始字节之和，`files` 限制图片数量；不是 Base64 后的 JSON 大小或持久会话总量。错误字段、MIME 或数量为 `400 invalid_agent_image`／`invalid_agent_message`，图片字节超限为 `413 agent_image_limit_exceeded`。图片写入 Pi 消息，不成为工单附件。依据：[消息路由](../src/http/agent-routes.ts)、[文本和图片回归](../tests/http/runtime-api.test.ts)。

已解决工单拒绝消息（`409 resolved_issue_cannot_run_agent`）；运行中可能接纳为引导或下一轮输入，受理与恢复规则见 [Agent 消息持久化](AGENT.md#消息接收与恢复)。`409 agent_message_outcome_unknown` 表示交付结果不明，不能当作“尚未发送”自动重试。

`POST /api/issues/:key/abort` 无需 body，会等待当前轮次和已排队轮次的取消收尾。它不删除已受理消息，也不撤销已经完成的工具副作用；取消后的输入不会在 retry 时自动恢复。未解决且空闲时可用 `POST .../retry` 继续，但 `workspace.retryable` 只是详情页的恢复提示，不完整表示 retry 接口的允许条件；最终以操作时的状态和预约检查为准。

### 替换关联工单

`PUT /api/issues/:key/related-issues` 的 JSON body 为 `{"relatedIssueKeys":["ISSUE-20260101-001"]}`，编号需替换为真实工单。这是完整替换列表；空数组清空全部关联，**省略该字段也按空数组处理**。不要把增量新增的一项当作完整列表发送。不能引用自己、重复编号或不存在的工单，数量上限见 [limits.relatedIssues](../issue-pilot.config.ts)。

四种处理方式都支持关联。调用要求活跃用户、当前工单未解决、Workspace 为 `ready`／`stopped` 且内部运行视图已准备好；当前工单、原关联和新关联均参与预约，其中任何一张仍有 Agent 活动都返回 409。相同集合在上述检查通过后返回 204，不另排队；集合变化则关闭当前会话实例、保存关联、使运行视图失效并安排重新准备，204 不表示 Agent 已完成。接口没有 revision 条件；结果不明先重读详情的 `relatedIssues`，不要盲目覆盖另一位用户的变更。依据：[工单路由](../src/http/issue-routes.ts)、[关联回归](../tests/http/all-mode-relations.test.ts)、[重复更新与失败回归](../tests/http/issue-api.test.ts)。

### 独立重置会话

先 `GET /api/issues/:key/sessions`，从 `current: true` 的条目取得 `sessionId`；再以活跃 developer 身份 `POST /api/issues/:key/reset-session`，body 为 `{"expectedSessionId":"从当前会话列表取得的 ID"}`。成功返回 `200 {"sessionId":"新会话 ID"}`，业务状态变为 `open`，不自动启动 Agent；旧会话仍可通过历史接口读取。

重置要求工单空闲且未解决。当前会话变化返回 `409 agent_session_changed`；原 ID 成功使用后再次提交也会冲突，而读取新 ID 后重置会再建一份会话。响应不明时先读会话列表，不能用最新 ID 无条件重试。重置保留代码、附件与普通工作文件；它不是工作区修复工具，不能恢复缺失 JSONL 或解决 Git 异常。依据：[resetIssueSession](../src/agent/session-reset.ts)、[会话重置回归](../tests/http/session-reset.test.ts)。

### 工单删除

`DELETE /api/issues/:key` 是不可逆删除，不是 workspace 回收。要求活跃管理员，等待 scope／生命周期／inspection 队列后再次授权，并预约工单；运行中或排队时返回 `409 issue_already_running`，应先调用 abort 并等待完成。被其他工单作为关联上下文引用时返回 `409 issue_is_related_context`，先通过关联接口移除引用。异常路径、缺失根或 dirty 开发 worktree 会拒绝删除，不支持 force。

删除关闭空闲会话，通过 Git owner 移除干净的登记 worktree，然后将整个工单根移入 `control/deletions/<key>-<uuid>`，以事务删除 Issue 及级联的附件元数据、会话绑定、评论、关联、抄送／置顶、仓库和 Workspace 记录。数据库失败先恢复根，再由 Git owner 回滚 worktree。提交成功后删除暂存根，附件原件、JSONL、工作文件和工单私有 Git 都将永久移除；共享 Git 缓存、共享快照、已发布分支和其他工单不在删除范围。

文件系统与 SQLite 不存在跨介质原子提交。进程崩溃、回滚或提交后清理失败须按[运维手册](RUNBOOK.md#工单删除失败边界)检查；500 或连接中断不表示数据一定未删除。提交后清理失败不会恢复已部分删除的目录，也不会把失败静默报告为成功。

### 范围转换

先 `POST /api/issues/:key/scope-transition/plan`，body 为 `{ "serviceKey": "demo-service", "workMode": "test_analysis" }`（需替换实际服务），检查返回的 `action`、当前／目标范围、仓库增删及会话影响。plan 只读、不预约 Agent，也不证明后续 Git、dirty 状态或凭证检查一定通过。

确认后 `POST .../scope-transition/apply`，提交同一目标和 plan 返回的 `expectedIssueUpdatedAt`、`expectedPlanHash`（取 `planHash`）。计划过期为 `409 scope_transition_plan_stale`，需重新计划；不能只替换 hash 自动确认新影响。当前支持范围见[使用指南](USAGE.md#范围解决与重开)。

成功为 `200 { "issueKey": "..." }`。只读重绑定关闭会话、更新范围并将 workspace 设为 `not_created`，未解决工单安排 Agent；转开发／开发跨服务迁移先准备工作树再安排 Agent。成功均不表示模型已完成。响应不明先重读详情的范围和 `scopeTransitions`，不要盲目重复 apply。实现与回归见 [scope-transition.ts](../src/workspace/scope-transition.ts)、[lifecycle.test.ts](../tests/workspace/lifecycle.test.ts)、[issue-api.test.ts](../tests/http/issue-api.test.ts)。

### 源码读取与保存

Source 路由以 `/api/issues/:key/source/` 开头，仓库名／路径通过请求头传递，不是 query 参数。先 `GET .../repositories` 取 `{ name, url, branch, access }[]`；后续使用返回的 `name`，不能传 URL 或任意绝对路径。

| 请求 | 输入与返回 |
| --- | --- |
| `GET .../tree` | `X-Issue-Pilot-Repository` 必填，`X-Issue-Pilot-Path` 可省略表示根；返回 `{ path, entries, truncated }`，截断不代表有下一页 |
| `GET .../file` | Repository、Path 必填；返回 `{ path, content, size, sha256 }` |
| `PUT .../file` | 同上并携带读取时的 `X-Issue-Pilot-Sha256`；`Content-Type: text/plain; charset=utf-8`，body 为完整文本，成功返回新的 SourceFile |
| `GET .../history` | Repository 必填，Path 可选；返回 `{ commits, truncated, nextCursor }`；后续页把 cursor 的 revision／offset 放入 `X-Issue-Pilot-Revision`／`X-Issue-Pilot-Offset`，不要自行递增页码 |

Source 专用参数头（如 `X-Issue-Pilot-Repository`、`X-Issue-Pilot-Path`）的值使用 `encodeURIComponent` 编码，包括中文路径；身份头和 Content-Type 按各自约定填写。服务端解码并检查路径和仓库策略。文件保存与其他 Source mutation 要求活跃身份，在 Issue 预约中再次校验；实际可写性还取决于未解决开发工单、工作区和 Git 绑定。读到 `access=write` 不是后续写入的永久许可。原子文件替换不等于 Git 提交。

哈希不匹配返回 `409 source_file_changed`，只读返回 `409 source_read_only`，二进制／超预算返回对应 413；调用方先重读合并，不去掉哈希来覆盖。路径新建、删除、重命名、暂存及提交有独立接口，不能用 PUT 保存来模拟。实现、DTO 和边界回归见 [source-browser-routes.ts](../src/http/source-browser-routes.ts)、[source-contracts.ts](../src/workspace/source-contracts.ts)、[source-browser.test.ts](../tests/workspace/source-browser.test.ts)、[source-pagination.test.ts](../tests/workspace/source-pagination.test.ts)。

### 钉钉导入

`GET /api/dingtalk/source` 返回当前用户、记录 URL 偏好和所选连接是否可用；这只是配置检查，不证明上游可连接或具有记录权限。

`POST /api/dingtalk/import` 使用 JSON，必填 `url`、`serviceKey`、`workMode`、`priority`，可选 `assigneeSubject`、`startAgent`，其他字段拒绝。HTTP 的 `startAgent` 只有显式 `true` 才启动，省略为不启动；页面显式选择启动，MCP 的默认值另见[协议](CONFIGURATION.md#入站工单-mcp)。

正常返回 `200`，body 含 `user`、`status: "created" | "existing"`、`issueKey` 和可选 `assignee`；`created` 证明本次导入完成，`existing` 表示返回已有工单，均不能作为 Agent 成功的证明。来源及手工同名匹配规则集中在[配置指南](CONFIGURATION.md#服务-mcp-与钉钉)，先核对返回编号、服务和环境，不能仅凭标题判断创建了新工单。

单次请求在开始时创建 `mcpExecutionMs` 超时信号，供本次导入共享，客户端断开也会发出取消信号；到期是请求取消，不保证在该毫秒数内结束排队、上游处理和失败清理。普通超时／取消返回 `408 dingtalk_request_cancelled_or_timed_out`（若连接已断则无法接收）。响应流或暂存文件清理失败时不会降格成 408，而是记录内部 `dingtalk_attachment_cleanup_failed` 并返回 500，公开 body 可能为 `internal_error` 或匹配到的附件清理码，不保证透传内部码。失败或响应不明时先查询是否已有工单，不因超时自动认定数据未写入。实现和回归见 [dingtalk-routes.ts](../src/http/dingtalk-routes.ts)、[dingtalk.test.ts](../tests/http/dingtalk.test.ts)。

### 最小只读检查

下列 Bash 命令在已启动的**本地独立演示安装**上执行；subject 替换为自己的活跃用户，不要直接对不明实例发送写请求。这里只检查身份和目录，不调用模型、不创建工单：

```bash
BASE_URL='http://127.0.0.1:3000'
SUBJECT='demo-developer@example.invalid'
curl --fail-with-body -sS "$BASE_URL/health"
curl --fail-with-body -sS -H "X-Issue-Pilot-Subject: $SUBJECT" "$BASE_URL/api/me"
curl --fail-with-body -sS -H "X-Issue-Pilot-Subject: $SUBJECT" "$BASE_URL/api/catalog"
```

真实创建与完成的前置条件和验收顺序见[首次运行](DEPLOYMENT.md#首次本地运行)；不具备外部条件时用[隔离流程测试](DEVELOPMENT.md#无需真实模型的核心流程验证)。

## 异步执行、SSE 与分页

工单创建 201、消息发送 202、retry 202 只确认对应阶段完成，不证明模型请求、工具或修复成功。客户端在受理后读取详情的 `agentRunning`、`workspace.status`、`status` 并观察对话；失败时同时保留错误码和工单编号。页面关闭和 SSE 断连不取消 Engine 工作；服务重启也不是重试或撤销机制。

`GET /api/issues/:key/agent-stream` 返回 `text/event-stream`。顺序为持久对话／当前轮次回放 → `event: snapshot_ready` → live 事件及 heartbeat；snapshot 含 `running`、`runState`、`issueStatus`、模型与 footer。普通数据帧为 `id:` 加 `data:` JSON，named events 另有 `event:` 字段。断开后重新连接会重放，不是按 `Last-Event-ID` 增量续传；客户端须按持久 entry ID／事件 ID 去重，并以快照替换统计。慢连接超预算会断开，不应承诺所有瞬时事件永久可取。网关关闭缓冲并保留长连接，详见 [sse.ts](../src/http/sse.ts) 与 [Web 投影](../src/web/src/app/agent-stream.ts)。

当前 Web 收到无法解析或已校验字段非法的消息／快照时，会作废连接并重新回放，而不是跳过坏帧继续累加；旧连接的迟到事件被 generation 检查拒绝。这里只描述客户端已实现的检查，不等于对每个 Pi 事件做完整 Schema 验证。行为回归见 [agent-stream.test.ts](../src/web/src/app/agent-stream.test.ts)。

历史会话用 `GET /api/issues/:key/sessions` 发现 sessionId，再调用 `GET /api/issues/:key/sessions/:sessionId?offset=0`，每页固定 50 个事件，返回 `{ events, nextOffset }`；offset 为非负整数，`nextOffset=null` 到末尾。不要与入站 MCP 的 `{ items, total, offset, nextOffset }` 分页或 Source 的专用分页混用。

当前会话文件不完整时，SSE 在发送响应头前返回 `500 agent_session_file_incomplete`；入站 MCP `issue_conversation` 返回同码的工具错误。此时不启动 Agent，也不自动修复文件；读取完整性规则与缺失文件的行为见 [Agent 完整性说明](AGENT.md#重置完整性与关闭)。

## 错误、并发与重试

普通 API 错误由 [api.ts](../src/http/api.ts) 映射为 `{"error":"稳定错误码"}`；框架未匹配路由等响应不应假定完全相同。下载／SSE 已发送响应头后的失败可能直接终止连接，不能再期待 JSON 错误体。

| HTTP／典型码 | 客户端处理 |
| --- | --- |
| 400 `invalid_json`、`invalid_current_subject`、字段校验错误 | 修正输入／身份，不自动重复请求 |
| 403 `developer_role_required`／`admin_role_required` | 按真实权限处理，不切换账号绕过 |
| 404 `issue_not_found`／`attachment_not_found` | 检查编号与当前资源，不把本地路径当 ID |
| 409 `issue_already_running`、`configuration_changed`、`source_file_changed` | 核对当前活动、版本或文件，重新读取并让人处理冲突 |
| 413 `payload_too_large`／`agent_image_limit_exceeded` | 按具体通道缩减请求；不假设所有上传共用限额 |
| 415 `unsupported_media_type` | 检查 Content-Type 与请求编码 |
| 500 `internal_error` 或专用 operational code | 由维护者查看脱敏日志；rollback/finalize 等错误先保留现场，不循环 mutation |

配置并非所有写接口都使用 revision：有版本检查的端点需携带读取到的 `expectedRevision`；不要对全体 API 自动加同一并发规则。参数 PUT 的 overrides 是完整覆盖快照，详见[运行参数](CONFIGURATION.md#运行参数)。

创建工单、发送消息没有客户端幂等 key，网络超时／丢失响应不证明请求未生效。先搜索工单、读对话和文件，再决定是否显式继续。钉钉按来源记录去重是特定业务保证，不可推广到普通创建；人工评论也没有通用去重保证。

回归依据：[工单 API](../tests/http/issue-api.test.ts)、[附件事务](../tests/http/attachment-api.test.ts)、[SSE](../tests/http/sse.test.ts)、[入站 MCP](../tests/http/application-mcp.test.ts)。通过替代 Agent 的路由测试不等于真实模型、沙箱或外部服务集成通过。
