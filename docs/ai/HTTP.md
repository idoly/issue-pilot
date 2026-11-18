# HTTP, SSE and Inbound MCP

AI reference. [Index](README.md) · [Configuration](CONFIGURATION.md)

These are current source contracts, not a generated complete schema. Route owners live in [src/http](../../src/http), Web requests/DTOs in [client.ts](../../src/web/src/data/client.ts), and inbound MCP in [server.ts](../../src/mcp/server.ts).

## Identity and access

The application issues no login session. X-Issue-Pilot-Subject selects a DB user; it is not authentication. A trusted gateway must authenticate, overwrite client identity and protect Web/API/download/SSE/MCP without direct-access bypass. There is no per-Issue ACL.

[requireCurrentUser](../../src/configuration/access.ts) requires active identity, pins implicit selection by createdAt/subject, and reloads authorization after relevant waits. Deactivation never switches identity. developer and isAdmin are independent.

Code lives in analysis (prod/test) or code-writable (dev) environments, and only the developer role may change it: every Source mutation and every Agent message/retry that can run a dev Issue requires `role=developer` (403 `developer_role_required`). isAdmin does not grant it. Metadata and relation edits by other roles may save, but cannot enqueue a dev Agent round. Analysis Issues still accept Agent messages from every role. [canWriteIssueCode](../../src/domain/contracts.ts) is the one predicate the server and Web use; the routes re-read the person, the Issue and its environment kind after reservation/admission waits.

Session lists, history pages and complete query reads reauthorize inside the configuration scope after waiting. Complete query reads also reauthorize after session preparation. SSE reauthorizes after catalog/transcript preparation and before sending headers; a deactivated reader receives an ordinary error, not a successful replay. This admission check does not revoke an already established stream. Regression: [session-read-identity.test.ts](../../tests/http/session-read-identity.test.ts).

Not every GET checks identity: examples include /api/issues, /api/issues/:key, /api/users, /api/catalog and /api/config. Work-file list/download, attachment originals and Source reads require an active current user and reauthorize after the scope queue or shared-checkout wait. Assignee/reporter relations are not read access control. API/MCP private,no-store headers (selected by matched route, so query strings do not bypass them) are not authorization or encryption.

Root `http.identity` (server-only, default "selectable") selects the identity mode; buildApi's identity option overrides it for tests. GET /api/me returns the person plus identityLocked (true for "gateway"). When locked, the Web hides the account switcher, never sends a page-selected subject header and forgets the remembered choice; it keeps the resolved subject only as a late-response guard. Requests issued before the first /api/me response may still carry a previously remembered subject, so the gateway must overwrite it. The flag is not authentication.

In "selectable" mode a missing subject header selects the oldest active user. In "gateway" mode an onRequest hook in [api.ts](../../src/http/api.ts) rejects any /api/* or /mcp request (by matched route, otherwise path without query) whose X-Issue-Pilot-Subject is missing or empty with 401 {"error":"current_subject_required"}; there is no implicit selection. /health and Web assets are exempt.

Native browser EventSource does not send the page-selected subject header. In "gateway" mode the gateway must inject the header into SSE requests too, or the stream is refused; in "selectable" mode the server uses its implicit user selection. Protect SSE as well as ordinary fetches.

## Requests and responses

:key is the business key, accepted case-insensitively. Issue DTO id also returns the canonical key; do not substitute the internal UUID. Ordinary writes use JSON; file/stream responses are different protocols.

| Request | Meaning |
| --- | --- |
| GET /health | {"ok":true} after a lock-free `SELECT 1` on the open database connection; 503 {"ok":false,"error":"database_unavailable"} when it fails. Fastify also answers 503 while closing. No model/external-service health guarantee |
| GET /api/me, /api/catalog | Current user and service/environment catalog |
| GET /api/issues | Full summaries from one SQLite statement, sorted by creation/key descending; no server filtering/paging. Summaries (and the detail, which extends them) include reporterSubject and sorted ccSubjects, loaded by a correlated subquery in the same statement. The shared [summary projection](../../src/http/issue-summary.ts) includes the actual sorted CC list and the [internal detail counter](STORAGE.md#relations-and-identifiers) in the revision digest. Same-second edits invalidate open details without reading descriptions or other detail rows in the poll. |
| GET /api/issues/:key | Details, workspace (status, sourceAvailable, runtimeReady, lastError, retryable), attachments, repositories, relations and scope history from one SQLite read snapshot. Live Agent state and filesystem availability are sampled separately. |
| POST /api/issues | 201, persisted and scheduled, not model completion |
| PATCH /api/issues/:key | 200, complete metadata form, not arbitrary partial merge |
| POST .../agent-messages | 202, empty body, input admitted; developer required while the Issue's environment can modify code, rechecked by the engine's reauthorize callback. Inbound MCP issue_message uses this route |
| GET .../agent-messages/:id | Sender-scoped durable receipt; queued / started / rejected / unknown |
| GET .../sessions/:sessionId/query-results/:entryId | Exact saved successful native query text, text/plain, private/no-store; validated Issue/reset chain and displayed branch, at most 1 MiB UTF-8. Unknown/non-query entries are 404; oversized results are 413. No filesystem path input or query execution. |
| POST .../abort | 200 after current/queued cancellation cleanup |
| POST .../retry | 202 when unresolved, the environment's role gate allows the caller and reservation checks permit |
| PATCH .../status | Manual pending → resolved or resolved → open; Web rereads after a transition conflict without repeating the write |
| DELETE /api/issues/:key | Admin permanent deletion, 204; not code release |
| GET .../files?path=... | Directory entries; managed files list-only; active current user |
| GET .../files/download?path=... | Authorized ordinary file download; active current user |
| GET .../attachments/:attachmentId | Original verified for mode, size, hash and path; active current user |
| GET /api/workspaces/stats | Last sampled statistics without waiting. refresh=true requires an active current user and starts a full scan at most once per root `http.workspaceStatisticsRefreshIntervalMs` (30 s); earlier refreshes return 429 workspace_statistics_refresh_too_frequent |

Issue comments are retired: there is no comment write route, detail has no comments field and inbound MCP exposes none. [Migration 0081](../../drizzle/0081_drop_issue_comments.sql) dropped the issue_comments table and its rows.

Configuration, users, repositories, MCP, capability switches, pins and statistics have separate owners. Do not infer bodies/permissions or impose one concurrency mechanism on all endpoints. Admin PUT /api/config/agent replaces the shared model, runtime and optional key update; it requires `expectedRevision` from GET /api/config `agent.revision`, checks it after Issue reservation but before closing sessions, and returns `{ ok: true, revision }`. A stale draft gets `configuration_changed`; the Web keeps it and offers a reload.

Failure classification follows owner outcomes first. A constraint nested in AggregateError or SuppressedError cannot make a combined operation/cleanup failure a retryable conflict. The shared diagnostic reader traverses causes, aggregate members and suppressed failures; logging projects the outer error without exposing private nested messages or SQL parameters.

## Issue vector search

Owner: [issue-search-routes.ts](../../src/http/issue-search-routes.ts) and [issue-index.ts](../../src/search/issue-index.ts). See the [configuration guide](../CONFIGURATION.md#工单语义搜索) for the operator workflow.

- Search configuration is owned by the [runtime parameters](CONFIGURATION.md#runtime-parameters) editor API: admin GET /api/config/parameters?include=issueSearch exposes enabled, accountId, tokenConfigured and revision in issueSearch, and PUT /api/config/parameters saves that group together with parameter overrides. Updates require expectedRevision, enabled and accountId; omitted apiToken keeps it for the same account, null clears it. The Token is only sent to the fixed Cloudflare HTTPS origin. A committed settings change aborts in-flight search operations. Ordinary catalog exposes only issueSearchEnabled when true.
- POST /api/issue-search takes a nonempty query (max 500 characters). Any active user can search across all accounts. Results are at most 10 business keys with current title, status and assignee name (subject if unnamed, null if unassigned). Each Issue ranks once by the lowest local cosine distance across its chunks. Deleted Issues and Issues whose full text no longer matches the indexed digest are skipped. One embedding request ranks IDs/digests into a connection-local temporary table; batches of 40 are checked against current Issue text until 10 valid hits or exhaustion. Distances are computed once, but ranking sorts all candidates; each batch rechecks cancellation and authorization. Closing the connection discards the ranking. This is not a cross-database mutation snapshot. There is no keyword fallback or implicit refresh.
- Admin POST /api/issue-search/refresh starts with {} and follows nextCursor by sending { after }. Each call checks up to 256 Issue rows. It embeds the title and complete description in chunks of at most 7,000 UTF-8 bytes, normally up to 16 chunks per call; an oversized historical Issue uses serial batches of up to 16. A write replaces all chunks for an Issue atomically. Counts refer to Issues, and a full pass also removes deleted entries. Cursor traversal is not a cross-mutation snapshot. Completed batches remain useful if a later batch fails; restart traversal to pick up earlier edits.
- Cloudflare uses the Qwen3 embeddings REST endpoint with separate document (12-second deadline) and query (20-second deadline) inputs. Timeout, access denial, malformed results and rate limits return stable errors without a provider body. Requests are not retried automatically. Disabled search, missing credentials or a client that disconnected before admission cannot start a provider request. A later disconnect aborts ongoing work. Startup and settings saves do not open or build the index.

## Creation and complete-form edits

Creation requires title, priority, serviceKey and workMode. Mappings belong to [contracts.ts](../../src/domain/contracts.ts); environmentKey/type are not extra create inputs. HTTP requires p0–p3 explicitly, unlike MCP defaults.

```json
{
  "title": "Inspect the demonstration module",
  "description": "Read-only analysis; do not modify code.",
  "priority": "p2",
  "serviceKey": "demo-service",
  "workMode": "test_analysis",
  "assigneeSubject": null,
  "ccSubjects": [],
  "relatedIssueKeys": []
}
```

Replace the example service with a configured service. Dev requires active developer creator and credential owner; reassigning to a non-developer fails. Unassigned Issues use reporter credentials and appear in no one's assigned queue scope.

Attachments use multipart: issue holds complete JSON; files can carry uploads. Issue creation and edit check the current active subject before staging multipart files, then reauthorize after queue waits. Originals are part of Issue transactions, not an independent upload-write API. HTTP file streaming has no business file-size/count ceiling, but fields, transport and proxies retain limits. MCP Base64 and pasted Agent images have distinct budgets.

PATCH still requires title/priority. Omitted description/assigneeSubject/ccSubjects become empty/unassigned/empty list. removedAttachmentIds removes named originals; others remain. Service/environment/type/workMode/relations cannot be changed through ordinary editing.

GET detail includes editVersion, a SHA-256 digest of metadata, scope, attachment IDs and CC subjects. The Web editor captures this version when opened and sends expectedEditVersion; background refresh never changes the draft's baseline. PATCH compares it inside the scope queue and Issue reservation before side effects, returning 409 issue_edit_conflict on mismatch. Agent progress and timestamps do not invalidate the version. Conflicts retain the local draft and uploads until explicit reload succeeds; identity/navigation guards reject late reloads. expectedEditVersion is required for every edit, including multipart and save-with-reset requests; missing or malformed versions return 400 invalid_issue_edit_version. There is no unconditional-write path.

resetSession:true preflights developer/unresolved/session checks and prepares the new session file. Metadata, attachment records, CC recipients and session binding commit in one SQLite transaction. Failure rolls back these records and removes only the prepared file; attachment originals retain their own rollback/finalize owner. After a confirmed save or outcome=committed error, the Web editor offers a read-only refresh without repeating uploads.

Owner: [issue-routes.ts](../../src/http/issue-routes.ts). Tests: [issue-api.test.ts](../../tests/http/issue-api.test.ts), [session-reset.test.ts](../../tests/http/session-reset.test.ts).

## Messages, cancellation and retry

Text uses {"message":"..."}, trimmed and nonempty, bounded by limits.agentMessageChars. Identity and X-Issue-Pilot-Message-Id are checked before the body (including multipart images) is read, and identity is checked again afterwards. Multipart images require one message field and repeated images files, declared PNG/JPEG/GIF/WebP. Root [agentImage limits](../../issue-pilot.config.ts) independently bound file bytes, total bytes and count; text is still required.

Persist before dispatch/acknowledgment, pin sender and reauthorize after waits. X-Issue-Pilot-Message-Id accepts 1–128 ASCII letters, digits, underscores or hyphens; absent IDs are generated by the server. The Web composer generates its ID with Web Crypto randomness available on both HTTP and HTTPS. The existing JSONL admission stores the ID and sender. Repeating an admitted ID with identical text/images acknowledges it without execution; changed payloads return agent_message_id_conflict (409). Receipts cover the current session and its validated reset history. started is a conservative dispatch marker, not evidence of completion. unknown is inconclusive and never authorizes automatic replay. Resolved Issues reject new input but can acknowledge an existing receipt. In-flight development sessions may accept steering input. Sessions that retire after each read-only round persist follow-up input for the next serialized round instead of steering, because Pi exposes no per-message delivery receipt for its queue. A steer that Pi refuses after its admission was marked started, or whose session was replaced meanwhile, returns agent_message_outcome_unknown (409); the receipt keeps started. agent_message_outcome_unknown does not mean unsent; never automatically resend. Receipt lookup reuses an in-memory index of archived reset generations keyed by file identity (device, inode, size, mtime); the bound session is always read again. Closing the page or stream does not cancel Engine work.

Abort has no required body and waits for cancellation/cleanup, without undoing completed effects. The detail-view retryable flag is not the retry endpoint's complete permission rule. Delivery/recovery metadata belongs to [Agent](AGENT.md#admission-and-recovery).

## Relations, scope and sessions

### Related Issues

PUT .../related-issues takes the complete relatedIssueKeys set. Omission and [] both clear it. Reject self, duplicates, missing keys and excess count.

Require unresolved current Issue, ready/stopped usable workspace and reservations for current/old/new related Issues. An unchanged set returns 204 without scheduling after checks; a change closes the current instance, persists relations, invalidates the view and schedules preparation. There is no revision precondition; reread after uncertain outcomes.

### Scope transitions

POST .../scope-transition/plan takes target serviceKey/workMode. Planning is read-only, not a guarantee that later credential/worktree/activity checks pass.

Apply sends the same target with expectedIssueUpdatedAt and expectedPlanHash. scope_transition_plan_stale requires renewed confirmation, not merely replacing the hash. Allowed transitions are described in [Usage](../USAGE.md#范围解决与重开); owner: [scope-transition.ts](../../src/workspace/scope-transition.ts).

### Independent session reset

GET sessions, select the current sessionId, then an active developer POSTs reset-session with expectedSessionId. Success returns a new sessionId, status=open, no automatic run, with the old JSONL retained.

Require idle/unresolved state. Reusing an old ID conflicts; do not reread a new ID and automatically reset again after an uncertain response. Reset is not root, Git or JSONL repair.

### Permanent deletion

Admin deletion requires no activity/inbound relations and valid clean registered roots/worktrees. No force option. DB commit and file finalization can partially succeed; after 500/disconnection follow [Storage](STORAGE.md#deletion-and-cross-medium-failure), not blind retries.

## Source APIs

Prefix: /api/issues/:key/source/. First GET repositories for name/url/branch/access. Later operations use the returned repository name and dedicated headers, not arbitrary host paths.

| Request | Inputs / concurrency |
| --- | --- |
| GET .../tree | Repository required, Path optional; returns path/entries/truncated |
| GET .../file | Repository/Path; returns content/size/sha256 |
| PUT .../file | Same plus previously read Sha256, text/plain full content |
| POST .../file, .../directory | Dedicated creation, not simulated with PUT |
| DELETE .../path, POST .../rename | Dedicated transactions and cleanup |
| GET .../history | nextCursor; subsequent Revision/Offset headers |
| POST .../stage, .../unstage, .../commit | Current writable dev repository; earlier access=write is not permanent permission |

Headers include X-Issue-Pilot-Repository, X-Issue-Pilot-Path and X-Issue-Pilot-Sha256. Encode Source-specific values with encodeURIComponent; identity/Content-Type follow their own contracts. Reads require an active current user and reauthorize after the shared-checkout wait. Mutations require the developer role before and after the reservation, refuse a resolved Issue with 403 source_read_only, and retain repository/Git checks. A test/prod repository stays read via the repository owner, not this route.

Hash conflict is source_file_changed; read-only is source_read_only. Finalization failure may leave a complete target: reread before retrying. Owners: [source-browser-routes.ts](../../src/http/source-browser-routes.ts), [source-contracts.ts](../../src/workspace/source-contracts.ts).

## DingTalk import

GET /api/dingtalk/source reports preferences/connection configuration, not remote connectivity.

POST /api/dingtalk/import requires url/serviceKey/workMode/priority; assigneeSubject/startAgent are optional. HTTP starts only for explicit true. The page defaults assignee to current user and explicitly starts. MCP defaults priority p2, no start, omitted assignee=current caller. Duplicate imports do not reassign/restart.

The response includes created/existing status and issueKey. A successful import with connectionCleanup: "failed" means the Issue result is committed or confirmed but MCP connection closure failed; inspect connection diagnostics without retrying creation solely for cleanup. If closure and import both fail, the server retains both causes and returns dingtalk_connection_close_failed. Source deduplication/manual matching rules are in [Configuration](CONFIGURATION.md#service-mcp-and-dingtalk).

Each import shares its start-time timeout signal, with client disconnect cancellation. Cancellation is not an immediate bound on all queues/cleanup. Ordinary timeout is 408; staging/stream cleanup failure remains a 500, not ordinary cancellation. Read existing Issues after uncertain outcomes.

## Global MCP connections

There is no Web editor; administrators use these routes directly. Rows without a deployment are global connections used only by DingTalk import (the preference names one, default `dingtalk`) and are never Agent tools. Generated DBHub rows are deployment-bound and refuse PATCH/DELETE with mcp_managed_by_service (409).

| Route | Access and behavior |
| --- | --- |
| GET /api/mcp-services | Projection without secrets: id, name, public URL (query removed), transport, enabled, credentialConfigured |
| GET /api/mcp-services/:id/configuration | Admin; private `mcpServers` entry including Authorization header or stdio command/args/env |
| POST /api/mcp-services | Admin; `{name, transport: "streamable_http"\|"sse"\|"stdio", url, enabled, credentialUpdate}` → 201 projection. HTTP transports need an https URL without user info or fragment; stdio uses `url: ""` |
| POST /api/mcp-services/import | Admin; standard `{"mcpServers": {...}}` (`type` http/streamable_http/sse or `command` for stdio; only an Authorization header) inserted atomically, never executed → 201 projections |
| PATCH /api/mcp-services/:id | Admin; same body as POST, or one `mcpServers` entry; unchanged input is a no-op |
| DELETE /api/mcp-services/:id | Admin; 204 |
| POST /api/mcp-services/:id/test | Admin; connects, lists tools and closes → `{tools: [{name, readOnly}]}`; failures return stable `mcp_*` codes (502) |

credentialUpdate is `{mode: "replace", values: {authorization}}` or `{mode: "replace", values: {stdio: {command, args?, env?, cwd?}}}`, `{mode: "preserve"}` (same transport and URL) or `{mode: "clear"}`; an enabled stdio row needs a launch configuration. Writes reserve every Issue affected by a global change and fail with mcp_has_running_issues while one runs; duplicate names return mcp_name_conflict. Bounded stdio diagnostics go to host operator logs; only the actual connection credentials configured in this system are masked, without generic filtering of business tokens, SQL, paths or upstream error text. They never enter responses or prompts. Oversized stderr is counted but its text is omitted to avoid leaking a credential cut by truncation. Owners: [mcp-routes.ts](../../src/http/mcp-routes.ts), [mcp.ts](../../src/configuration/mcp.ts), [client.ts](../../src/mcp/client.ts).

## Async execution, SSE and paging

GET .../agent-stream sends durable/current replay, then snapshot_ready, then live events/heartbeat. Ordinary frames have id/data; named frames have event. Snapshot always includes agent model, footer, runState, issueStatus and issueRevision. Start buffering live events at the same synchronous boundary as transcript, current replay and runState capture. A reset observed while preparing the initial response invalidates that replay before headers.

Shutdown ends admitted streams. A request still preparing when shutdown starts cannot start a stream and receives 503 agent_stream_closing if still connected and otherwise valid.

Reconnect is full replay, not Last-Event-ID continuation. Deduplicate durable entry/event IDs and replace totals with snapshots. Preserve backpressure and queue budgets; slow clients disconnect on overflow. http.sseQueuedBytes bounds frames waiting behind the head frame (the next one to write); the head frame itself is exempt, so a single frame larger than the budget (for example pasted images up to agentImage.requestBytes) waits instead of disconnecting every viewer. Invalid frames invalidate the client connection; generation checks reject late old-stream events.

A backpressured replay resumes on either drain or completion of the blocked write. ServerResponse can finish writing without emitting drain; waiting only for that event can strand replay before snapshot_ready and before heartbeats start. Late callbacks from earlier frames must not release a newer blocked write, and close/error must release replay waits.

Tool text is bounded before HTTP serialization by web.agentToolOutputCharacters, retaining head/tail and displayTruncated; Web applies the same fallback. Do not modify originals or treat this as a bound on images, metadata or total transcript size. Owners: [agent-routes.ts](../../src/http/agent-routes.ts), [sse.ts](../../src/http/sse.ts), [event-display.ts](../../src/agent/event-display.ts).

Events arriving during replay are projected before entering the display buffer. Its UTF-8 byte budget counts the projected event, including all remaining images/metadata, and retains each queued size for draining. The oldest buffered event is exempt, as at the writer head. Raw events remain unchanged for other observers. Projection failure closes the subscription and reports the error, as does queue overflow.

| Reader | Paging |
| --- | --- |
| HTTP GET Issues | No server paging |
| HTTP sessions/:sessionId | Zero-based offset, 50 events/page, events/nextOffset |
| MCP lists/conversation | Zero-based offset, default 30/max 100, total/offset/items/nextOffset |
| Source history | Dedicated cursor, not caller-incremented offset |

Pages are not stable cross-mutation cursors. Incomplete sessions fail SSE before headers with agent_session_file_incomplete; no Agent startup or automatic file repair.

## Inbound Issue MCP

/mcp supports stateless Streamable HTTP POST only; GET/DELETE return 405. It uses HTTP-selected identity. The Web endpoint configuration page generates the client entry (`mcpServers.issue-pilot`, `type: http`, with the `X-Issue-Pilot-Subject` header) for Pi, Cursor, Claude Code, VS Code and Codex.

Tools: services_list, users_list, issues_search, issue_get, issue_create, issue_message, issue_conversation, dingtalk_import, attachment_read, work_files, work_file_read. Discover users/services first. Success JSON is in content[].text; HTTP 200 can still carry isError=true.

- Base64 has no data prefix. Root default: at most 20 attachments, 20 MiB each and decoded aggregate.
- Raw JSON request budget is 32 MiB, enforced before parsing; tool-level budget failures can be isError. Do not split/repeat creation on failure.
- Text defaults to 200 lines/page, max 1000; whole-file read budget 64 MiB and response budget 1 MiB. Non-inline responses do not authorize arbitrary host paths.
- issues_search filters sorted summaries by key/title/service/environment/status, not description full text.
- issue_message accepts an optional messageId (same 1–128 character rule) forwarded as X-Issue-Pilot-Message-Id. Retrying with the same ID and text acknowledges the admitted message without re-running it; without an ID every call is a new message.
- Managed files are list-only; attachments retain original validation and work files retain storage authorization.

Owner: [server.ts](../../src/mcp/server.ts). Tests: [application-mcp.test.ts](../../tests/http/application-mcp.test.ts), [application-mcp-create.test.ts](../../tests/http/application-mcp-create.test.ts).

## Errors and retry

Ordinary errors usually return {"error":"stable_code"}; framework routing errors are exceptions. After file/SSE headers, failure may terminate the connection instead of returning JSON. Owners throw `DomainError(code, category)` and the [HTTP boundary](../../src/http/api.ts) maps the category once (bad_request 400, forbidden 403, not_found 404, conflict 409, payload_too_large 413, rate_limited 429, internal 500, upstream 502); routes do not keep code-to-status catalogs or infer status from message text. `ApiError` is reserved for a route's own request-shape or transport-state refusals (for example 408 cancellation or 503 closing). Request parsing shared by routes and configuration owners lives in [domain/input.ts](../../src/domain/input.ts). SQLite constraint failures are translated once by [constraints.ts](../../src/db/constraints.ts) from the driver's structured constraint code: UNIQUE/primary key → `conflict`, foreign key → `resource_in_use`, and the schema triggers `issue_deployment_required`, `deployment_is_used_by_issues` and `issue_resolution_state_invalid` → their own code, all 409; other trigger codes stay internal, and query parameters are never read. `OperationError` outcomes and operational failure codes found anywhere in the chain take precedence over a nested constraint. A route that names a fallback code for unexpected failures (for example `user_credentials_save_failed`) passes classified failures through unchanged. The [DMS](../../src/capabilities/dms.ts) and [MCP client](../../src/mcp/client.ts) owners throw their stable `dms_*`/`mcp_*` failures as `upstream` (502) `DomainError`s whose message is the code, so tool results keep the same text; the DMS scope test and MCP connection test log the code and publish any other failure as `dms_scope_resolve_failed`/`mcp_connection_failed` 502. Lifecycle and scope-transition refusals are conflict `DomainError`s that keep the owner failure as cause; they republish only stable codes, never `OperationError` outcomes, [operational failure codes](../../src/domain/errors.ts) or unpublishable messages. Issue summaries, detail and SSE snapshots carry the same opaque change token (`revision` on HTTP projections, `issueRevision` on SSE). Its fixed-length digest covers Issue, Workspace, Agent and joined display facts without including the source text. Clients compare tokens for equality.

| Condition | Required handling |
| --- | --- |
| 400 input/identity | Correct request, no automatic repeat |
| 403 role/admin | Do not switch identities to bypass |
| 404 missing resource | Verify canonical key and actual resource |
| 409 activity/revision/hash/plan conflict | Reread and confirm changes |
| 413/415 | Respect channel-specific size/type limits |
| 500 missing/invalid root or session | Preserve state, inspect; do not recreate |
| Rollback/finalize/post-commit failure | Do not assume complete rollback or safe retry |

Ordinary creation has no generic client idempotency key; Agent messages use the scoped admission IDs above. Lost responses do not prove no effect. Read Issues/conversations/files first. DingTalk source deduplication does not generalize to other mutations.

Configuration revisions, source hashes and Git CAS protect different facts. Do not apply one retry/locking rule everywhere. Fixture tests do not prove comprehensive real-model/external-service safety.

Mutation owners report known commit boundaries as { error, outcome }, where outcome is committed, not_committed or unknown. These structured operation failures take precedence over nested SQLite conflicts; causes remain diagnostic-only. Absence of outcome does not prove no side effect. A committed cleanup failure calls for rereading the result, not repeating the mutation.
