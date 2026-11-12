# Agent, Tools and Sessions

AI reference. [Index](README.md) · [Architecture](ARCHITECTURE.md) · [Configuration](CONFIGURATION.md)

## Responsibilities and scope

[engine.ts](../../src/agent/engine.ts) owns durable admission, per-Issue serialization, execution slots and reservations. Pi owns the model/tool pipeline, MCP discovery, connections and shutdown. Application identity, target authorization and budgets cannot be delegated to prompts or read-only hints.

Prod/test analysis keeps its environment's code/evidence scope. Dev code belongs to dev; evidence queries explicitly select prod/test. Included services expand allowed service/deployment tools; related Issues only add read-only evidence.

## Admission and recovery

HTTP 201/202 does not mean model completion. Persist input and bind the session inside the per-Issue scope; preparation failures must not lose admitted messages. Pin the request sender and reauthorize after steering/session waits without switching identity.

Running-session input is durably admitted with a conservative started marker before steering. A sole undelivered steer can return to queued only after Pi removes it; the same entry is reused, never appended as another message. Request IDs and sender identity live in this admission entry, not a second delivery database. Receipt lookup and sends share the per-Issue admission queue. Earlier pending inputs cannot be bypassed. Queued work must not use a disposed or replaced instance.

[message-delivery.ts](../../src/agent/message-delivery.ts) owns durable delivery metadata:

| Record | Recovery meaning |
| --- | --- |
| issue-pilot-user | Visible input and recorded scope |
| delivery started | May have been delivered; not completion; never automatically inject again |
| delivery rejected | Cancelled/scope changed; not automatically recovered |
| queued without started/rejected | Recover in order when the user explicitly continues |
| no queue metadata | Do not infer pending work |

agent_message_outcome_unknown is not permission to resend. Never replay an old session or overwrite newer state. Restart does not reconstruct the in-memory execution queue or automatically run unfinished rounds. Verify [message-admission.test.ts](../../tests/agent/message-admission.test.ts) and [engine.test.ts](../../tests/agent/engine.test.ts).

## Cancellation

Abort reauthorizes, marks current/queued rounds cancelled, drains input admission and waits for Pi abort/cleanup. Repeated aborts share the operation; conflicting reservations/new work are rejected while cleanup is active.

Cancellation retains sessions and admitted input. It does not roll back completed file or remote effects, and cancelled input is not automatically restored by retry. Preserve state/diagnostics on failure instead of marking success. Model idle timeout measures continuous absence of model updates, resets on updates and pauses during tools; it is not a round deadline.

Owners: [engine.ts](../../src/agent/engine.ts), [pi-session.ts](../../src/agent/pi-session.ts). Regression: [cancellation.test.ts](../../tests/agent/cancellation.test.ts). Web Esc only initiates cancellation; it is not authorization.

## Reset, integrity and shutdown

Independent reset requires an active developer, an idle unresolved Issue and matching expectedSessionId. Close the old instance, create a new file and transactionally change its binding. Keep the old JSONL, set status=open and do not auto-run. After an uncertain response, read the current session rather than retrying with a fresh ID.

Combined editing prepares the new session then commits metadata, attachment records, CC recipients and session binding in one SQLite transaction. Rollback removes only the prepared session; the old JSONL remains unchanged. Attachment files still use their own prepare/rollback/finalize owner. Owners: [session-reset.ts](../../src/agent/session-reset.ts), [issue-routes.ts](../../src/http/issue-routes.ts). Regression: [session-reset.test.ts](../../tests/http/session-reset.test.ts).

Before reading a bound session validate a nonempty regular JSONL, valid header/records and final newline. Never repair blanks, malformed lines or truncation automatically. SSE may skip missing durable replay; MCP follows its failure contract. Neither creates a replacement empty file. SDK reading of a complete old format may migrate it, so do not promise that every read is byte-preserving. Verify [session-read-integrity.test.ts](../../tests/http/session-read-integrity.test.ts).

The binding must name a private `.session-` file directly under its own Issue root. Summary and transcript validation share `openRegularSessionFile` in [pi-session.ts](../../src/agent/pi-session.ts): refuse special files without blocking on a FIFO and check the opened descriptor's path to reject symlinks in the parent directories as well as at the file. Reset writes its link as the first entry after the header; summary listing stops at that first entry and never follows later reset-shaped conversation records. This avoids scanning large tool outputs merely to list sessions. Full validation samples and parses through one descriptor; its bounded append cache changes only after successful validation, so a rejected session-ID rewrite remains rejected on retry while cached. This cache is an optimization, not a durable identity ledger or protection against every concurrent external rewrite; Pi subsequently opens the validated path.

Read-only rounds close instances at completion and restore from durable history next round; idle dev instances may be reused. The application defaults Pi cache warming to streaming; warming between rounds requires explicit configuration. Failure cleanup stays serialized and cannot overwrite a newer round. Aggregate abort/shutdown/dispose and storage cleanup errors.

## Native evidence queries

[service-query-tool.ts](../../src/agent/service-query-tool.ts) parses unknown boundary input and dispatches environment/service/capability to its owner. Targets come from authorized deployments, not credentials. Keep execution checks required after mutable Pi hooks.

### DMS

Use HTTPS SSE MCP with the selected owner's complete personal or shared group. Accept configured instanceAlias/schema intent, never model-supplied arbitrary hosts/databaseIds.

Before connecting, enforce read-only SQL checks against writes, multiple statements, comments, locks and known side effects. These checks are not a proof for every SQL extension; the remote account must itself be read-only.

Root defaults are 120 seconds per execution and 12 seconds for first handshake. At most two handshakes: only first-handshake timeout or bounded Retry-After 429 permits retry; never retry 401/403. Backoff and retry share the budget. Discovery/execution failure does not reconnect/replay; dispatched SQL is not automatically queried again.

One DmsQueryRound owns connections and tool discovery for one Agent prompt, keyed by the exact selected URL/Authorization. Queries serialize within that round and include queue wait in their timeout; no connection crosses Issues, credentials or rounds. The handshake borrows the request deadline, but an established transport belongs to the round lifetime. A failed call invalidates its connection without SQL replay. Successful evidence/export returns before round disposal; disposal failure is reported separately at round completion. Standalone queries retain per-call ownership. Diagnostics retain phase, elapsedMs, sqlDispatchAttempted and retryAfterSeconds without secrets. Preserve operation and close failures together; cleanup failure is not ordinary cancellation.

Exports use ordinary work files and replace only after content/protocol success; preserve prior files on failure. Owner: [dms.ts](../../src/capabilities/dms.ts); regression: [dms.test.ts](../../tests/capabilities/dms.test.ts).

### SLS

Use aliyun sls GetLogsV2. Authorize exact region/project/logstore, even when configuration permits a wildcard. CLI uses 0600 temporary credentials, HTTPS and disabled automatic retries; never mutate the host profile or place keys in argv.

Accept only Complete. Page ordinary logs by offset; SQL analysis retains its query limits and returns its analysis result page. A later-page failure, budget failure or incomplete result is not successful partial evidence. Return source and time.

Cancellation/timeout terminates the process group and cleans credentials. Do not expose arbitrary CLI error text. Credential-directory cleanup failure keeps its stable error and is not downgraded to cancellation. Owners: [sls.ts](../../src/capabilities/sls.ts), [sls-cli.ts](../../src/capabilities/sls-cli.ts); tests: [sls.test.ts](../../tests/capabilities/sls.test.ts), [CLI fixture](../../tests/integration/sls-cli.acceptance.ts).

### MCP and Codemode

Inbound /mcp operates Issues; service MCP provides deployment tools; global DingTalk connections serve application imports only. Do not combine their authority. MySQL uses configured external MCP; retired adapters do not execute.

DMS/SLS can run through Codemode tools.service_query. off exposes direct tools, on combines direct/orchestrated use, only primarily uses orchestration discovery. Execution is process-wide FIFO, one script at a time; root queue budgets are 120 seconds/32 entries. Cancelled waiters do not execute; script parallelism does not bypass Issue/repository/DMS constraints.

Pi owns registration, discovery, connection, cancellation and shutdown. The application retains same-origin/redirect checks, SQLite authority, literal credentials, budgets and authorization. See [client.ts](../../src/mcp/client.ts), [pi-extension.ts](../../src/mcp/pi-extension.ts), [codemode-extension.ts](../../src/agent/codemode-extension.ts) and [patches](../../patches/README.md).

## Files, host tools and resources

The Issue root is the only persistently writable model directory; related Issues are read-only. Local tools can read only the validated shared snapshots and required Git storage for the current and explicitly related Issues. A successful workspace include/remove updates the native tool read roots immediately; stdio connections retain their launch policy until the session is retired. Preparation reads attachment originals without automatic editable copies; explicit edits create ordinary work files. Pasted images belong to Pi messages. Query exports and SDK large outputs use ordinary files; no second publication/snapshot layer.

Node/npm, Java/Maven and Python use host PATH/shared libraries. Do not inject a project .venv or create an Issue environment by default. Host tools are read-only; administrators install shared dependencies. Project dependencies and writable .npm-cache/.maven-cache remain Issue-local. [network-exec.ts](../../src/agent/network-exec.ts) redirects Java temporary files and caches to the Issue. Use normal programs/libraries for formats, not format-specific executors, nested sandboxes or selectable runtime frameworks.

Pi resources use the runtime user's getAgentDir(). No application-private skills/extensions or Issue-local extensions. Inspection discovers without executing extensions; Operator extensions cannot override protected application tools. Owners: [pi-runtime.ts](../../src/configuration/pi-runtime.ts), [pi-session.ts](../../src/agent/pi-session.ts).

## Conversation and cost projection

[events.ts](../../src/agent/events.ts) projects the current active branch, hiding internal context-edit/usage entries while footer accounting includes applicable usage. SDK nested-call records must not be interpreted as success when incomplete.

[event-display.ts](../../src/agent/event-display.ts) bounds tool text at the root-configured 40,000 characters before HTTP serialization and as a Web fallback. Keep head/tail and displayTruncated; do not mutate JSONL or model results. Images, details, nestedCalls and total history are not bounded by this text rule. SSE/history use the same projection.

Cost preserves SDK usage and provider/estimated/unknown provenance. Reconnect replaces totals rather than adding replay; failure/cancellation retain reported charges. Web draft lifetime is described in [Usage](../USAGE.md#阅读与补充).

## Execution boundary

[issue-sandbox.ts](../../src/agent/issue-sandbox.ts) owns the single SRT boundary. Linux namespaces, seccomp and a read-only host view constrain local operations. Only the current Issue root is persistently writable; private configuration/database paths are hidden. Protect Git config/hooks/pointers, reject cross-boundary hardlinks and retain launch-environment checks.

Network uses proxy/proxychains. open/allowlist does not grant arbitrary local file or website authority; see [network policy](CONFIGURATION.md#issue-network-access). Temporary personal SSH is passed to native Git, not stdio MCP.

Pi SDK, Operator extensions and application owners are trusted code. Remote MCP has independent authority. Never present local isolation, prompts or readOnlyHint as remote database authorization.
