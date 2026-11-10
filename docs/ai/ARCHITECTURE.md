# Architecture and Ownership

AI reference. [Index](README.md) · [Agent rules](../../AGENTS.md)

## Process and sources of truth

[production.ts](../../src/http/production.ts) calls [buildApi](../../src/http/api.ts). One Node process serves static Web assets, HTTP, SSE and inbound MCP. The root configuration currently selects port 3000; Vite 4173 is an independent development server, not a second business backend. Only host-native application deployment is maintained.

```text
Web / HTTP / inbound MCP
        ↓ input, identity and scope checks
HTTP routes coordinate owners
        ├─ configuration → SQLite
        ├─ AgentEngine → Pi model / tool pipeline
        │                  ├─ DMS / aliyun SLS / service MCP
        │                  └─ native tools → SRT Issue boundary
        └─ workspace → Git / originals / work files / JSONL
JSONL + current Agent events → SSE → Web conversation projection
```

SQLite, JSONL, Git, attachments and work files jointly retain facts. There is no cross-medium transaction. A SQLite rollback does not restore files or Git; credential projection is not storage encryption.

## Owners

| Responsibility | Owning code |
| --- | --- |
| Paths, defaults and hard budgets | [root configuration](../../issue-pilot.config.ts), [config.ts](../../src/config.ts) |
| Roles, states, work modes and business predicates | [domain/contracts.ts](../../src/domain/contracts.ts) |
| Schema, bootstrap and immutable upgrades | [schema.ts](../../src/db/schema.ts), [bootstrap.ts](../../src/db/bootstrap.ts), [drizzle](../../drizzle) |
| Configuration, credentials, projections and hot parameters | [configuration](../../src/configuration) |
| HTTP identity and reauthorization after waits | [route-context.ts](../../src/http/route-context.ts) |
| Admission, scheduling, reservations, cancellation and recovery | [engine.ts](../../src/agent/engine.ts), [message-delivery.ts](../../src/agent/message-delivery.ts) |
| Pi sessions, model isolation and resources | [pi-session.ts](../../src/agent/pi-session.ts), [model-runtime.ts](../../src/agent/model-runtime.ts), [pi-runtime.ts](../../src/configuration/pi-runtime.ts) |
| Tool input, targets and dispatch | [service-query-tool.ts](../../src/agent/service-query-tool.ts), [capabilities](../../src/capabilities) |
| External and inbound MCP | [mcp](../../src/mcp) |
| Native tools and the single SRT boundary | [native-tools.ts](../../src/agent/native-tools.ts), [issue-sandbox.ts](../../src/agent/issue-sandbox.ts), [native-tool-executor.ts](../../src/agent/native-tool-executor.ts) |
| Attachment transactions and ordinary files | [attachment-store.ts](../../src/http/attachment-store.ts), [work-files.ts](../../src/workspace/work-files.ts) |
| State lease, Git, runtime views and lifecycle | [workspace](../../src/workspace) |
| Web requests and DTOs | [client.ts](../../src/web/src/data/client.ts) |
| Identity, resources, drafts and late responses | [ApplicationResources.tsx](../../src/web/src/app/ApplicationResources.tsx), [agent-drafts.ts](../../src/web/src/app/agent-drafts.ts) |
| Issue summaries and cross-view refresh | [issue-list.ts](../../src/web/src/app/issue-list.ts), [App.tsx](../../src/web/src/app/App.tsx) |
| SSE, conversation and display budgets | [agent-stream.ts](../../src/web/src/app/agent-stream.ts), [conversation.ts](../../src/web/src/app/conversation.ts), [event-display.ts](../../src/agent/event-display.ts) |
| Source and editors | [source-browser.ts](../../src/workspace/source-browser.ts), [CodeBrowser.tsx](../../src/web/src/app/CodeBrowser.tsx), [SourceText.tsx](../../src/web/src/app/SourceText.tsx), [monaco.ts](../../src/web/src/app/monaco.ts) |

Routes coordinate owners; they do not reimplement Git, attachment transactions, external protocols or command authorization. Keep HTTP and Web DTOs aligned. Prefer public SDK APIs and small local adapters.

## One round

1. Creation derives environment/type from workMode, validates deployment and users, claims an empty Issue root, coordinates attachments and inserts exactly one Workspace.
2. Message admission persists input and binds a session inside the per-Issue serial scope. HTTP 201/202 acknowledges a stage, not model completion.
3. Engine obtains a global slot. Credential owner is assignee, otherwise reporter; prepare the selected model, personal Git identity, code and runtime view.
4. Pi runs the model/tool pipeline. Local operations cross SRT; remote MCP retains its own independent authority.
5. Success and failure cleanup remain in the same per-Issue serial scope. An old failure cannot overwrite a newer round.
6. SSE projects durable history and current events. Human resolution and code release use separate lifecycle coordination.

## State model

| State | Contract |
| --- | --- |
| Issue | open / in_progress / pending / resolved; resolved iff resolved_at is non-null |
| Agent | idle / queued / running; running includes preparation and cleanup |
| agentRunning | Includes queued and executing work, not just runState=running |
| Workspace | not_created / preparing / running / ready / stopped / failed; not a business conclusion |

Manual transitions are pending → resolved and resolved → open. Reopen does not automatically run Agent. Enums and mappings belong to [contracts.ts](../../src/domain/contracts.ts).

## Concurrency

Keep Agent activity, Issue-set reservation, configuration scope, lifecycle, per-Issue inspection and repository queues distinct:

```text
configuration read: scope queue → SQLite read snapshot
service / Issue scope write: scope queue → Issue reservation
release / reopen: lifecycle queue → inspection queue → Issue reservation
```

Read the Operator model catalog before acquiring the configuration scope queue. The queue still covers the SQLite projection and writes, and model selection writes reauthorize once inside. Repository keys include state root and URL hash. Do not reverse acquisition, replace these queues with a global lock or treat initial authorization as permanent. SQLite snapshots, configuration revisions, file hashes and Git CAS protect different facts.

maxConcurrentIssues limits rounds holding execution slots, not HTTP concurrency, queue size or accumulated messages. Lowering it does not cancel existing work. Priority and pinning do not affect scheduling. There is no general queue-capacity or queue-wait-timeout guarantee.

## Startup and shutdown

The production entrypoint enables Node’s compile cache in a private per-user cache directory before loading the API. Cache misses or an unusable directory only cost compilation time. Check the configured Web entrypoint before opening state. Acquire the state lease before opening, migrating or recovering the database. Ordinary restarts recover only interrupted Issue states using the Issue status and partial Workspace indexes, in one transaction. Install saved parameters, validate shared snapshots, seed the model selection only if it is missing, then listen. The shared snapshot check verifies reciprocal Git pointers, detached HEAD and cleanliness before admitting Agent tools, which can read the shared Git directory. Its cost depends on retained shared checkouts. Ordinary startup does not enumerate Issue records or directories, fetch remotes, prune every bare store or rebuild per-Issue views. Run the [Issue state audit](STORAGE.md#issue-state-audit) explicitly for storage diagnosis.

A history read opens the recorded view. Code access verifies the selected repository binding; prod/test reads its recorded commit and released dev reads the recorded local working branch. Ordinary work-file access does not validate unrelated code entries. A new Agent round prepares its own current code and verifies related Issue code references without refreshing or rewriting those Issues. A failed view is handled by the owning Agent retry or development release/reopen operation. Startup never adopts unknown directories, resets recorded branches or retries interrupted Agent rounds.

The listener starts the configured delay for [capacity and retention](STORAGE.md#capacity-sampling); startup itself does not trigger a pass. Shutdown closes SSE/HTTP, stops scheduling and drains workspace lifecycle work, then closes Engine, configuration queue, model runtime, database and lease. Aggregate cleanup failures and retain the lease until writers stop. HTTP shutdownGraceMs is not an Agent round deadline; Engine draining has no separate total deadline. Startup failure follows the same ownership and cleanup discipline.

The private host runner allows up to 1800 seconds for graceful stop and 600 seconds for health, returning immediately on readiness. These are outer waiting policies, not [api.ts](../../src/http/api.ts) shutdown budgets. Timeout does not authorize SIGKILL.

## Web projection

- ApplicationResources owns identity, configuration and per-Issue Agent drafts/failures. Navigation can restore them; identity changes cancel old unsent work and generation checks reject late responses.
- A stream is usable only after replay reaches snapshot_ready. Invalid frames invalidate the connection; reconnect replaces the projection instead of accepting a partial snapshot.
- Stable entry IDs/contentIndex preserve block identity. Streaming is plain text; completed content uses Markdown. Tool details and Monaco load lazily; editors and models are disposed independently.
- ConversationProjection owns display reduction for replay, live batches and history pages. Tool-call and streaming-assistant indexes avoid repeatedly scanning history; snapshots use copy-on-write so an entire replay or batch needs at most one array copy while previously published snapshots remain unchanged.
- [issue-list.ts](../../src/web/src/app/issue-list.ts) owns one application snapshot for the queue, overview and statistics. Mounted Issue/home views sample it every 10 seconds without interrupting an active request; navigation and explicit refresh invalidate older responses. Configuration pauses sampling, disposal cancels it, and failures retain the last successful list. This is not server pagination or cross-client push.
- [App.tsx](../../src/web/src/app/App.tsx) refreshes selected details when its own or a related Issue's sampled summary/execution fields change, or a related Issue disappears, and reloads on returning to the workspace. Per-selection/request guards reject stale details, while background refresh preserves drafts and open editors. Queue sampling does not navigate away when an existing Issue stops matching filters; explicit filter/identity changes and actual removal can choose another Issue. Agent lifecycle events refresh both details and the shared list; authoritative SSE runState includes cleanup and takes precedence over business completion or an older HTTP agentRunning flag.
- SSE queue budgets, display budgets, source limits and durable session size are separate. Local budgets do not bound total process memory.

See [Development](../DEVELOPMENT.md), [Protocols](HTTP.md), [Agent](AGENT.md) and [Storage](STORAGE.md) for focused verification and failure boundaries.
