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

## 请求与响应

HTTP 路径中的 `:key` 为业务编号（例如 `ISSUE-20260101-001`），不是 SQLite 内部 UUID。HTTP 解析编号不区分大小写；客户端建议始终使用返回的规范编号。普通 JSON 写入使用 `Content-Type: application/json`，下载接口返回文件而非 JSON。

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
| `POST /api/issues/:key/retry` | `202 {"ok":true}`，未解决且空闲时继续处理；运行／预约冲突为 409 |
| `PATCH /api/issues/:key/status` | `200` 摘要，body 只选择 `{"status":"resolved"}` 或 `{"status":"open"}`；转换条件见[状态](USAGE.md#状态与完成条件) |
| `POST /api/issues/:key/comments` | `201` 评论；body 为 `{"body":"人工备注"}`，**不发送给 Agent**，与 agent-messages 不同 |
| `GET /api/issues/:key/files?path=...` | 指定目录的文件条目数组，不递归分页；管理文件只列名 |
| `GET /api/issues/:key/files/download?path=...` | 普通工作文件下载，path 使用列举结果中的相对路径，不接受任意宿主路径 |
| `GET /api/issues/:key/attachments/:attachmentId` | 经过完整性校验的附件原件下载，ID 从工单详情获取 |

配置、Source、范围转换和回收接口有各自权限／并发规则，不宜据此表猜测请求体。Source 保存使用读取时的 SHA-256 检查冲突；配置 revision 和工单元信息不是同一种并发机制。

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

`workMode` 决定环境／类型，不能额外传 `environmentKey` 或 `type`。四种映射见[业务契约](../src/domain/contracts.ts)。HTTP 创建没有 MCP 的默认 priority，调用方必须明确提供。省略／空处理人表示未分配，凭证 owner 此时为报告人。

带附件时用 multipart：一个文本字段 `issue` 放完整 JSON，文件字段可使用 `files`。附件写入随创建／编辑事务完成，没有独立附件上传写接口。HTTP 上传流式落盘，没有业务文件大小／数量上限，但普通字段、传输层和代理仍有限制；不要把它理解为任意大请求都可接受。MCP Base64 和 Agent 粘贴图片各有独立预算，见[配置](CONFIGURATION.md#入站工单-mcp)。

编辑虽使用 PATCH，元信息仍按**完整表单**解析：必须传 `title` 和 `priority`；省略 `description`、`assigneeSubject`、`ccSubjects` 会分别变为空、未分配、空列表，不是全部保留。`removedAttachmentIds` 指定移除原件，未指定移除的原附件保留。不能用普通编辑变更 `serviceKey`、`environmentKey`、`type`、`workMode` 或 `relatedIssueKeys`；范围与关联走专用接口。

`resetSession: true` 的组合编辑在 scope／工单预约内先重检 developer 权限、未解决状态和当前会话，再保存字段／附件并执行重置。已解决或未绑定会话的预检拒绝发生在保存前；会话在预检后变化、丢失或重置事务失败等情况，统一返回 `500 issue_saved_session_reset_failed`，明确表示字段／附件已保存而重置未成功。此时先重读详情和会话列表，只重试独立重置，不要重复上传附件；独立重置接口要求 `expectedSessionId`。其他失败也应按实际错误与当前状态判断，不为所有接口承诺原子回滚。实现见 [工单路由](../src/http/issue-routes.ts)，回归见 [session-reset.test.ts](../tests/http/session-reset.test.ts)，操作见[使用指南](USAGE.md#重置会话)。

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

历史会话用 `GET /api/issues/:key/sessions` 发现 sessionId，再调用 `GET /api/issues/:key/sessions/:sessionId?offset=0`，每页固定 50 个事件，返回 `{ events, nextOffset }`；offset 为非负整数，`nextOffset=null` 到末尾。不要与入站 MCP 的 `{ items, total, offset, nextOffset }` 分页或 Source 的专用分页混用。

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
