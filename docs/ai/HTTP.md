# HTTP, SSE and Inbound MCP

AI reference. [Index](README.md) · [Configuration](CONFIGURATION.md)

These are current source contracts, not a generated complete schema. Route owners live in [src/http](../../src/http), Web requests/DTOs in [client.ts](../../src/web/src/data/client.ts), and inbound MCP in [server.ts](../../src/mcp/server.ts).

## Identity and access

The application issues no login session. X-Issue-Pilot-Subject selects a DB user; it is not authentication. A trusted gateway must authenticate, overwrite client identity and protect Web/API/download/SSE/MCP without direct-access bypass. There is no per-Issue ACL.

[requireCurrentUser](../../src/http/route-context.ts) requires active identity, pins implicit selection by createdAt/subject, and reloads authorization after relevant waits. Deactivation never switches identity. developer and isAdmin are independent.

Session lists and history pages reauthorize inside the configuration scope after waiting. SSE reauthorizes after catalog/transcript preparation and before sending headers; a deactivated reader receives an ordinary error, not a successful replay. This admission check does not revoke an already established stream. Regression: [session-read-identity.test.ts](../../tests/http/session-read-identity.test.ts).

Not every GET checks identity: examples include /api/issues, /api/issues/:key, /api/users, /api/catalog and /api/config. Assignee/reporter relations are not read access control. API/MCP private,no-store headers are not authorization or encryption.

Native browser EventSource does not send the page-selected subject header. Without a trusted gateway identity binding, the server uses its implicit user selection. Protect SSE as well as ordinary fetches.

## Requests and responses

:key is the business key, accepted case-insensitively. Issue DTO id also returns the canonical key; do not substitute the internal UUID. Ordinary writes use JSON; file/stream responses are different protocols.

| Request | Meaning |
| --- | --- |
| GET /health | {"ok":true}; no model/external-service health guarantee |
| GET /api/me, /api/catalog | Current user and service/environment catalog |
| GET /api/issues | Full summaries from one SQLite statement, sorted by creation/key descending; no server filtering/paging |
| GET /api/issues/:key | Details, workspace, attachments, repositories, relations and scope history from one SQLite read snapshot. Live Agent state and filesystem availability are sampled separately. |
| POST /api/issues | 201, persisted and scheduled, not model completion |
| PATCH /api/issues/:key | 200, complete metadata form, not arbitrary partial merge |
| POST .../agent-messages | 202, empty body, input admitted |
| GET .../agent-messages/:id | Sender-scoped durable receipt; queued / started / rejected / unknown |
| POST .../abort | 200 after current/queued cancellation cleanup |
| POST .../retry | 202 when unresolved and reservation checks permit |
| PATCH .../status | Manual pending → resolved or resolved → open; Web rereads after a transition conflict without repeating the write |
| POST .../comments | 201 human comment; not sent to Agent |
| DELETE /api/issues/:key | Admin permanent deletion, 204; not code release |
| GET .../files?path=... | Directory entries; managed files list-only |
| GET .../files/download?path=... | Authorized ordinary file download |
| GET .../attachments/:attachmentId | Original verified for mode, size, hash and path |

Configuration, users, repositories, MCP, capability switches, pins and statistics have separate owners. Do not infer bodies/permissions or impose one concurrency mechanism on all endpoints.

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

Replace the example service with a configured service. Dev requires active developer creator and credential owner; reassigning to a non-developer fails. Unassigned Issues use reporter credentials and do not enter a personal assignee queue.

Attachments use multipart: issue holds complete JSON; files can carry uploads. Issue creation and edit check the current active subject before staging multipart files, then reauthorize after queue waits. Originals are part of Issue transactions, not an independent upload-write API. HTTP file streaming has no business file-size/count ceiling, but fields, transport and proxies retain limits. MCP Base64 and pasted Agent images have distinct budgets.

PATCH still requires title/priority. Omitted description/assigneeSubject/ccSubjects become empty/unassigned/empty list. removedAttachmentIds removes named originals; others remain. Service/environment/type/workMode/relations cannot be changed through ordinary editing.

GET detail includes editVersion, a SHA-256 digest of metadata, scope, attachment IDs and CC subjects. The Web editor captures this version when opened and sends expectedEditVersion; background refresh never changes the draft's baseline. PATCH compares it inside the scope queue and Issue reservation before side effects, returning 409 issue_edit_conflict on mismatch. Agent progress, timestamps and comments do not invalidate the version. Conflicts retain the local draft and uploads until explicit reload succeeds; identity/navigation guards reject late reloads. expectedEditVersion is required for every edit, including multipart and save-with-reset requests; missing or malformed versions return 400 invalid_issue_edit_version. There is no unconditional-write path.

resetSession:true preflights developer/unresolved/session checks and prepares the new session file. Metadata, attachment records, CC recipients and session binding commit in one SQLite transaction. Failure rolls back these records and removes only the prepared file; attachment originals retain their own rollback/finalize owner. After a confirmed save or outcome=committed error, the Web editor offers a read-only refresh without repeating uploads.

Owner: [issue-routes.ts](../../src/http/issue-routes.ts). Tests: [issue-api.test.ts](../../tests/http/issue-api.test.ts), [session-reset.test.ts](../../tests/http/session-reset.test.ts).

## Messages, cancellation and retry

Text uses {"message":"..."}, trimmed and nonempty, bounded by limits.agentMessageChars. Multipart images require one message field and repeated images files, declared PNG/JPEG/GIF/WebP. Root [agentImage limits](../../issue-pilot.config.ts) independently bound file bytes, total bytes and count; text is still required.

Persist before dispatch/acknowledgment, pin sender and reauthorize after waits. X-Issue-Pilot-Message-Id accepts 1–128 ASCII letters, digits, underscores or hyphens; absent IDs are generated by the server. The Web composer generates its ID with Web Crypto randomness available on both HTTP and HTTPS. The existing JSONL admission stores the ID and sender. Repeating an admitted ID with identical text/images acknowledges it without execution; changed payloads return agent_message_id_conflict (409). Receipts cover the current session and its validated reset history. started is a conservative dispatch marker, not evidence of completion. unknown is inconclusive and never authorizes automatic replay. Resolved Issues reject new input but can acknowledge an existing receipt. In-flight sessions may accept steering/follow-up input. agent_message_outcome_unknown does not mean unsent; never automatically resend. Closing the page or stream does not cancel Engine work.

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

Headers include X-Issue-Pilot-Repository, X-Issue-Pilot-Path and X-Issue-Pilot-Sha256. Encode Source-specific values with encodeURIComponent; identity/Content-Type follow their own contracts. Mutations reauthorize after reservation and retain repository/Git checks.

Hash conflict is source_file_changed; read-only is source_read_only. Finalization failure may leave a complete target: reread before retrying. Owners: [source-browser-routes.ts](../../src/http/source-browser-routes.ts), [source-contracts.ts](../../src/workspace/source-contracts.ts).

## DingTalk import

GET /api/dingtalk/source reports preferences/connection configuration, not remote connectivity.

POST /api/dingtalk/import requires url/serviceKey/workMode/priority; assigneeSubject/startAgent are optional. HTTP starts only for explicit true. The page defaults assignee to current user and explicitly starts. MCP defaults priority p2, no start, omitted assignee=current caller. Duplicate imports do not reassign/restart.

The response includes created/existing status and issueKey. A successful import with connectionCleanup: "failed" means the Issue result is committed or confirmed but MCP connection closure failed; inspect connection diagnostics without retrying creation solely for cleanup. If closure and import both fail, the server retains both causes and returns dingtalk_connection_close_failed. Source deduplication/manual matching rules are in [Configuration](CONFIGURATION.md#service-mcp-and-dingtalk).

Each import shares its start-time timeout signal, with client disconnect cancellation. Cancellation is not an immediate bound on all queues/cleanup. Ordinary timeout is 408; staging/stream cleanup failure remains a 500, not ordinary cancellation. Read existing Issues after uncertain outcomes.

## Async execution, SSE and paging

GET .../agent-stream sends durable/current replay, then snapshot_ready, then live events/heartbeat. Ordinary frames have id/data; named frames have event. Snapshot includes model/footer/run state/Issue state.

Shutdown ends admitted streams. A request still preparing when shutdown starts cannot start a stream and receives 503 agent_stream_closing if still connected and otherwise valid.

Reconnect is full replay, not Last-Event-ID continuation. Deduplicate durable entry/event IDs and replace totals with snapshots. Preserve backpressure and queue budgets; slow clients disconnect on overflow. Invalid frames invalidate the client connection; generation checks reject late old-stream events.

A backpressured replay resumes on either drain or completion of the blocked write. ServerResponse can finish writing without emitting drain; waiting only for that event can strand replay before snapshot_ready and before heartbeats start. Late callbacks from earlier frames must not release a newer blocked write, and close/error must release replay waits.

Tool text is bounded before HTTP serialization by web.agentToolOutputCharacters, retaining head/tail and displayTruncated; Web applies the same fallback. Do not modify originals or treat this as a bound on images, metadata or total transcript size. Owners: [agent-routes.ts](../../src/http/agent-routes.ts), [sse.ts](../../src/http/sse.ts), [event-display.ts](../../src/agent/event-display.ts).

Events arriving during replay are projected before entering the display buffer. Its UTF-8 byte budget counts the projected event, including all remaining images/metadata, and retains each queued size for draining. Raw events remain unchanged for other observers. Projection failure closes the subscription and reports the error, as does queue overflow.

| Reader | Paging |
| --- | --- |
| HTTP GET Issues | No server paging |
| HTTP sessions/:sessionId | Zero-based offset, 50 events/page, events/nextOffset |
| MCP lists/conversation | Zero-based offset, default 30/max 100, total/offset/items/nextOffset |
| Source history | Dedicated cursor, not caller-incremented offset |

Pages are not stable cross-mutation cursors. Incomplete sessions fail SSE before headers with agent_session_file_incomplete; no Agent startup or automatic file repair.

## Inbound Issue MCP

/mcp supports stateless Streamable HTTP POST only; GET/DELETE return 405. It uses HTTP-selected identity. See [mcp.json](../../examples/mcp.json).

Tools: services_list, users_list, issues_search, issue_get, issue_create, issue_message, issue_conversation, dingtalk_import, attachment_read, work_files, work_file_read. Discover users/services first. Success JSON is in content[].text; HTTP 200 can still carry isError=true.

- Base64 has no data prefix. Root default: at most 20 attachments, 20 MiB each and decoded aggregate.
- Raw JSON request budget is 32 MiB, enforced before parsing; tool-level budget failures can be isError. Do not split/repeat creation on failure.
- Text defaults to 200 lines/page, max 1000; whole-file read budget 64 MiB and response budget 1 MiB. Non-inline responses do not authorize arbitrary host paths.
- issues_search filters sorted summaries by key/title/service/environment/status, not description full text.
- Managed files are list-only; attachments retain original validation and work files retain storage authorization.

Owner: [server.ts](../../src/mcp/server.ts). Tests: [application-mcp.test.ts](../../tests/http/application-mcp.test.ts), [application-mcp-create.test.ts](../../tests/http/application-mcp-create.test.ts).

## Errors and retry

Ordinary errors usually return {"error":"stable_code"}; framework routing errors are exceptions. After file/SSE headers, failure may terminate the connection instead of returning JSON.

| Condition | Required handling |
| --- | --- |
| 400 input/identity | Correct request, no automatic repeat |
| 403 role/admin | Do not switch identities to bypass |
| 404 missing resource | Verify canonical key and actual resource |
| 409 activity/revision/hash/plan conflict | Reread and confirm changes |
| 413/415 | Respect channel-specific size/type limits |
| 500 missing/invalid root or session | Preserve state, inspect; do not recreate |
| Rollback/finalize/post-commit failure | Do not assume complete rollback or safe retry |

Ordinary creation and comments have no generic client idempotency key; Agent messages use the scoped admission IDs above. Lost responses do not prove no effect. Read Issues/conversations/files first. DingTalk source deduplication does not generalize to other mutations.

Configuration revisions, source hashes and Git CAS protect different facts. Do not apply one retry/locking rule everywhere. Fixture tests do not prove comprehensive real-model/external-service safety.

Mutation owners report known commit boundaries as { error, outcome }, where outcome is committed, not_committed or unknown. These structured operation failures take precedence over nested SQLite conflicts; causes remain diagnostic-only. Absence of outcome does not prove no side effect. A committed cleanup failure calls for rereading the result, not repeating the mutation.
