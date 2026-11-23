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
| Roles, states, work modes and business predicates (code write access, developer owner, development environment by kind, scope-transition and related-Issue eligibility) shared by server owners and the Web | [domain/contracts.ts](../../src/domain/contracts.ts) |
| Stable failure codes, transport-neutral categories and untrusted-input parsing | [domain/errors.ts](../../src/domain/errors.ts), [domain/input.ts](../../src/domain/input.ts) |
| Schema, bootstrap and immutable upgrades | [schema.ts](../../src/db/schema.ts), [bootstrap.ts](../../src/db/bootstrap.ts), [drizzle](../../drizzle) |
| SQLite constraint and trigger failures as conflict categories | [constraints.ts](../../src/db/constraints.ts) |
| Single-process state lease shared by the server and offline scripts | [state-lease.ts](../../src/state-lease.ts) |
| Configuration, credentials, service deployments, projections and hot parameters | [configuration](../../src/configuration), [service-deployments.ts](../../src/configuration/service-deployments.ts) |
| Issues affected by a configuration change (reserved and closed before the write) | [impact.ts](../../src/configuration/impact.ts) |
| Optional Issue vector search, its settings and generated index | [search](../../src/search), [settings.ts](../../src/search/settings.ts), [issue-search-routes.ts](../../src/http/issue-search-routes.ts) |
| Identity selection, role checks and Issue lookup (HTTP and the application MCP server) | [access.ts](../../src/configuration/access.ts) |
| HTTP route context, reauthorization after waits and Issue reservations | [route-context.ts](../../src/http/route-context.ts) |
| Admission, scheduling, reservations, cancellation and recovery | [engine.ts](../../src/agent/engine.ts), [message-delivery.ts](../../src/agent/message-delivery.ts); callers depend on [contracts.ts](../../src/agent/contracts.ts) |
| Round preparation (workspace, evidence, credentials, tools, prompt context) | [round-preparation.ts](../../src/agent/round-preparation.ts) |
| Issue creation: key claim, root claim, attachment publication, one transaction and rollback | [issues/create.ts](../../src/issues/create.ts) |
| Issue status writes: one guarded transition; callers own their stable refusal codes | [issues/status.ts](../../src/issues/status.ts) |
| Issue edit persistence (attachments, recipients, rollback) and related-Issue sets | [issues/edit.ts](../../src/issues/edit.ts), [issues/relations.ts](../../src/issues/relations.ts) |
| Pi sessions, model isolation and resources | [pi-session.ts](../../src/agent/pi-session.ts), [model-runtime.ts](../../src/agent/model-runtime.ts), [pi-runtime.ts](../../src/configuration/pi-runtime.ts) |
| Opening a bound session file (path rule, completeness, Pi resolution) | [session-file.ts](../../src/agent/session-file.ts) |
| Agent method per work mode (investigation, defect fix, feature development) | [playbooks.ts](../../src/agent/playbooks.ts) |
| Tool input, targets and dispatch | [service-query-tool.ts](../../src/agent/service-query-tool.ts), [capabilities](../../src/capabilities) |
| External and inbound MCP | [mcp](../../src/mcp) |
| Native tools and the single SRT boundary | [native-tools.ts](../../src/agent/native-tools.ts), [issue-sandbox.ts](../../src/agent/issue-sandbox.ts), [native-tool-executor.ts](../../src/agent/native-tool-executor.ts) |
| Attachment transactions and ordinary files | [attachments.ts](../../src/workspace/attachments.ts), [work-files.ts](../../src/workspace/work-files.ts) |
| Git, runtime views and lifecycle; the one trusted Git runner | [workspace](../../src/workspace), [git-command.ts](../../src/workspace/git-command.ts) |
| HTTP response projections shared with the Web typecheck | [http/contracts.ts](../../src/http/contracts.ts), [scope-contracts.ts](../../src/workspace/scope-contracts.ts) |
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
| Release | `released_at` is the sole marker, committed with the snapshot repository rows; runtime readiness is a separate generated view |

Manual transitions are pending → resolved and resolved → open. Reopen does not automatically run Agent. Enums and mappings belong to [contracts.ts](../../src/domain/contracts.ts).

## Concurrency

Keep Agent activity, Issue-set reservation, configuration scope, lifecycle and repository queues distinct:

```text
configuration read: scope queue → SQLite read snapshot
service / Issue scope write: scope queue → Issue reservation
scope-transition apply / Issue delete: scope queue → lifecycle queue → Issue reservation → repository queue
release / reopen: lifecycle queue → Issue reservation
capacity background jobs: background queue → lifecycle queue per batch / release → Issue reservation for removal
```

Background capacity passes occupy the lifecycle queue one batch at a time instead of holding it for the whole pass. Scope conversion/migration may fetch remotes, and permanent deletion removes the staged directory after commit; those operations still have to finish under the acquired order, so reversing the queue order would not remove the waits.

Read the Operator model catalog before acquiring the configuration scope queue. The queue still covers the SQLite projection and writes, and model selection writes reauthorize once inside. Repository keys include state root and URL hash. Do not reverse acquisition, replace these queues with a global lock or treat initial authorization as permanent. SQLite snapshots, configuration revisions, file hashes and Git CAS protect different facts.

maxConcurrentIssues limits rounds holding execution slots, not HTTP concurrency, queue size or accumulated messages. Lowering it does not cancel existing work. Priority and pinning do not affect scheduling. There is no general queue-capacity or queue-wait-timeout guarantee.

## Failure ownership

Prefer leaving authoritative state untouched until publication, and keep each recovery action with the owner of that medium. A shared rollback framework cannot make SQLite, Git and files commit together. The principal failure boundaries are:

| Entry / owner | Recovery that remains necessary | How the design limits compensation |
| --- | --- | --- |
| Issue create/edit, HTTP and inbound MCP → [issue-routes.ts](../../src/http/issue-routes.ts), [attachments.ts](../../src/workspace/attachments.ts) | Remove newly published originals after DB failure; finalize exact recorded retirements after commit | Stage immutable bytes once, retain old originals until commit; no directory sweep or file backup |
| Permanent deletion → [lifecycle.ts](../../src/workspace/lifecycle.ts) | Move the staged Issue root back on DB failure; report committed cleanup failure | Validate after session shutdown, stage the entire private root intact; no Git worktree removal/reconstruction |
| Prepare/release/scope change → [git.ts](../../src/workspace/git.ts), [project.ts](../../src/workspace/project.ts) | Undo owned worktree changes across repository/DB failure, restore the captured analyzed view | Keep private branches authoritative, validate before mutation and use Git CAS; never recover by fetching a new remote version |
| Generated view → [runtime.ts](../../src/workspace/runtime.ts) | Restore changed flat entries if manifest publication fails | Update only differences; unchanged entries never leave their public paths |
| Source / tool Git writes → [git-command.ts](../../src/workspace/git-command.ts), [source-browser.ts](../../src/workspace/source-browser.ts) | Unstage newly introduced gitlinks; restore a replaced nonempty directory after rename failure | One Git rule shared by Web and Agent, literal paths, explicit failed-cleanup outcome; ordinary files use atomic publication |
| Work-file/export/search writes → [work-files.ts](../../src/workspace/work-files.ts), [issue-index.ts](../../src/search/issue-index.ts) | Clean only owned temporary files/connections | Publish complete files atomically, update existing index pages transactionally; never rerun an uncertain query |
| Message admission / session reset → [engine.ts](../../src/agent/engine.ts), [message-delivery.ts](../../src/agent/message-delivery.ts), [session-reset.ts](../../src/agent/session-reset.ts) | Persist delivery transitions; remove a prepared reset session on DB failure; inspect incomplete archived tails | Preserve acknowledged input and old JSONL, query receipts instead of resending; never infer absence from uncertain delivery |
| Remote protocols → [client.ts](../../src/mcp/client.ts), [dms.ts](../../src/capabilities/dms.ts), [pi-extension.ts](../../src/mcp/pi-extension.ts) | Await transport cleanup and preserve both errors; bound connection retries/cancellation | Use SDK transports and Pi ownership; no identity fallback or automatic replay of business operations |
| Local tools → [issue-sandbox.ts](../../src/agent/issue-sandbox.ts), [native-tools.ts](../../src/agent/native-tools.ts), [process.ts](../../src/process.ts) | Stop child processes and close owned sandbox/proxy resources after failure or cancellation | One SRT boundary and bounded process termination; closing resources never implies completed effects were undone |
| Web navigation / SSE → [ApplicationResources.tsx](../../src/web/src/app/ApplicationResources.tsx), [agent-stream.ts](../../src/web/src/app/agent-stream.ts) | Cancel stale reads, reject late results and reconnect invalid projections | Application-owned drafts/receipts, snapshot replacement and generation checks; never compensate by repeating a write |
| Startup / shutdown / offline migration → [api.ts](../../src/http/api.ts), [bootstrap.ts](../../src/db/bootstrap.ts), [Storage](STORAGE.md#issue-state-audit) | Drain owned resources, aggregate cleanup failures, recover interrupted state or reviewed migration steps | One state lease and explicit offline recovery; no startup adoption, silent repair or automatic queue replay |

Removing the remaining cross-medium recovery requires a different commit boundary, not deleting catch blocks. In particular, atomic publication of an entire generated view would change the flat-path contract; staging Git changes in a private index would require a reviewed index-lock/publication protocol shared by trusted Git and SRT. Neither is implied by a local cleanup or dependency upgrade.

## Startup and shutdown

The production entrypoint enables Node’s compile cache in a private per-user cache directory before loading the API. It flushes loaded modules before listening so native tool subprocesses can reuse the cache with NODE_COMPILE_CACHE_READONLY=1; the SRT host write boundary remains unchanged. NODE_DISABLE_COMPILE_CACHE=1 reaches the native tools too. Cache misses or an unusable directory only cost compilation time. buildApi first verifies that the [dependency patches](../../patches/README.md) are applied, then checks the configured Web entrypoint before opening state. Acquire the state lease before opening, migrating or recovering the database. Ordinary restarts recover only interrupted Issue states using the Issue status and partial Workspace indexes, in one transaction. Install saved parameters, seed the model selection only if it is missing, then listen. Ordinary startup does not enumerate Issue records, directories or shared Git snapshots, fetch remotes, prune every bare store or rebuild per-Issue views. Run the [Issue state audit](STORAGE.md#issue-state-audit) explicitly for storage diagnosis.

A history read opens the recorded view. Code access verifies the selected [repository binding](STORAGE.md#git-and-workspaces); prod/test reads its recorded commit and released dev verifies the recorded private working branch against its publication commit. A released view needs no per-Issue checkout or readiness flag. Ordinary work-file access does not validate unrelated code entries. A new Agent round prepares its own current code and verifies related Issue code references without refreshing or rewriting those Issues. A new Agent round prepares its own view; released code is resolved by the reader that needs it. Startup never adopts unknown directories, resets recorded branches or retries interrupted Agent rounds.

The listener starts the configured delay for [capacity and retention](STORAGE.md#capacity-sampling); startup itself does not trigger a pass. Shutdown closes SSE/HTTP, stops scheduling and drains workspace lifecycle work, then closes Engine, configuration queue, model runtime, database and lease. Process signal handlers are removed on close and listen failure. Aggregate cleanup failures and retain the lease until writers stop. HTTP shutdownGraceMs is not an Agent round deadline; Engine draining has no separate total deadline. Startup failure follows the same ownership and cleanup discipline; database bootstrap retains both initialization and cleanup failures when both fail.

`/health` probes the open database connection with `SELECT 1`, so a closed or failed connection reports 503 instead of `{ok:true}`; it takes no SQLite lock and checks no model or external service. The private host runner allows up to 1800 seconds for graceful stop and 600 seconds for health, returning immediately on readiness. These are outer waiting policies, not [api.ts](../../src/http/api.ts) shutdown budgets. Timeout does not authorize SIGKILL.

## Web projection

- ApplicationResources owns identity, configuration and per-Issue Agent drafts/failures. Panels require this store explicitly; there is no module-global draft fallback. A submitted snapshot (ID/text/images) is independent of the next draft; receipt queries never resend it. Navigation can restore them; identity changes cancel old unsent work and generation checks reject late responses.
- Confirmed configuration writes refresh application-owned data even after their editor closes or identity changes. Editor generations guard local drafts, busy state and notices, not shared-data freshness. Refreshes read under the current identity instead of applying the old editor's response. Application resource reads are cancellable; provider disposal invalidates pending reads and refuses new ones, while leaving a panel alone does not cancel them. Aborting a read never cancels or repeats a submitted write.
- A hidden browser document releases its conversation EventSource and reconnect timers; becoming visible replays only the currently selected Issue, without restarting Agent work or resending input. This frees HTTP/1 connection slots for foreground tabs at the cost of another replay on return. A stream is usable only after replay reaches snapshot_ready with a complete snapshot (agent, footer, runState, issueStatus, issueRevision); a missing or invalid field is a protocol error. After that snapshot, only issue_run_state changes execution state; Pi completion, business status and HTTP send acknowledgements do not infer it. Invalid frames invalidate the connection; reconnect replaces the projection instead of accepting a partial snapshot. Consecutive failures back off exponentially with jitter from agentStreamReconnectMs up to 30 seconds; an accepted snapshot_ready or switching Issues resets the delay.
- Stable entry IDs/contentIndex preserve block identity. Streaming is plain text; completed content uses Markdown. [Markdown.tsx](../../src/web/src/ui/Markdown.tsx) caches the parse and sanitized rendering by source; Issue file-link rewriting reuses the cached parse and sanitizes again only when the content contains links. Tool details, Monaco and configuration code load on demand; editors and models are disposed independently. A failed lazy chunk is contained by [AsyncBoundary.tsx](../../src/web/src/ui/AsyncBoundary.tsx) (`Errored`) with a retry that remounts the subtree; without that boundary an unhandled error stops every effect in Solid 2.0.
- ConversationProjection owns display reduction for replay, live batches and history pages. Tool-call and streaming-assistant indexes avoid repeatedly scanning history; snapshots use copy-on-write so an entire replay or batch needs at most one array copy while previously published snapshots remain unchanged.
- Components with one latest-wins request lane use [latest.ts](../../src/web/src/data/latest.ts) for generation, abort and disposition; genuinely independent lanes (editors, parallel panels) keep separate tasks instead of a global request mutex.
- [issue-list.ts](../../src/web/src/app/issue-list.ts) owns one application entity map for the queue, overview, statistics and selected detail. The list supplies membership and order; a selected detail can update the shared summary immediately. Overlapping reads publish common fields in request order, so a slower earlier response cannot overwrite them. Equal server revisions reuse summary objects across samples while still advancing request freshness. Home and Issues share one list subscription: switching between them neither cancels a sample nor starts another full read. Visible tabs sample every 10 seconds and on return without interrupting an active request; leaving for configuration cancels the read, and explicit refresh still supersedes older samples. Configuration and hidden tabs skip periodic sampling, disposal cancels it, and failures retain the last successful list.
- Settings categories and service choices each have one tab stop at the selected tab. Left/Right wrap and Home/End activate through the same selection path as a click. Settings panels still mount on first visit and retain drafts; service actions remain outside the tablist.
- Issue action dialogs live for one Issue, subject and role. Detail samples preserve their drafts; changing any part of that identity disposes the old handlers so late responses cannot navigate or close a new dialog.
- [Modal.tsx](../../src/web/src/ui/Modal.tsx) uses native modal dialogs for the top layer and background focus isolation; callers still own open state and whether cancellation is allowed. [Select.tsx](../../src/web/src/ui/Select.tsx) mounts dropdowns inside their containing dialog, tracks the highlight by option value and limits it to enabled options. Callers own the selected value; only an explicit choice, chip removal or clear action changes it, never focus or typing on a closed trigger.
- [App.tsx](../../src/web/src/app/App.tsx) uses one cancellable lane for the selected detail. It reloads on returning to the workspace and compares server revisions for the selected and related Issues after list samples, including samples published during a detail read. While revalidating on return, the last confirmed workspace can render immediately only for the same Issue, viewer and matching selected/related revisions. Other selections show their own summary (or key) without previous-Issue actions until detail arrives. Background refresh preserves drafts and open editors. Queue sampling does not navigate away when an existing Issue stops matching filters; explicit filter/scope/identity changes and actual removal can choose another Issue.
- The queue scope (assigned / reported / CC / all, default assigned; predicates in [issue-list.ts](../../src/web/src/app/issue-list.ts)) is relative to the current identity; pins stay assignee-only as the server requires. Opening an Issue from outside the queue (link, history, home, search, related card, created follow-up) never changes identity: after its detail loads, App publishes a reveal that keeps the current scope if it contains the Issue, else picks the first containing scope in that order, else all, and clears the other filters. A reveal published before identity loads applies once the identity is known. Only the header switcher changes identity, and it is hidden when /api/me reports identityLocked. Queue, detail and overview badges share one execution-state label: an unresolved Issue shows running, preparing or failed execution before its business status. Agent lifecycle events refresh both details and the shared list; authoritative SSE runState includes cleanup and takes precedence over business completion or an older HTTP agentRunning flag.
- Issue action availability uses the shared predicates in [contracts.ts](../../src/domain/contracts.ts) (canChangeIssueScope, relatedIssueUpdateRefusal with the detail's workspace.runtimeReady and whether the edit only detaches relations, canResetIssueSession, isIssueActive, canModifyIssueCode) instead of client re-derivations; the server still enforces them after waits. Work-mode/service choices come from availableWorkModes/servicesForWorkMode in [model.ts](../../src/web/src/app/model.ts). Configuration role checks stay UI presentation of route-level requireDeveloper/requireAdmin, which have no shared predicate. The follow-up button is a UI-only rule.
- [error-text.ts](../../src/web/src/app/error-text.ts) owns error-code display text: one shared table plus small per-context overrides and optional fallbacks; unknown codes stay visible as diagnostics.
- Related-Issue pickers (create, edit relations) read the shared Issue list and refresh it when opened instead of issuing their own list reads. The queue scope is App-owned UI state and survives remounting the Issue view; DingTalk import "open" uses the same reveal navigation as links and search.
- SSE queue budgets, display budgets, source limits and durable session size are separate. Local budgets do not bound total process memory.

See [Development](../DEVELOPMENT.md), [Protocols](HTTP.md), [Agent](AGENT.md) and [Storage](STORAGE.md) for focused verification and failure boundaries.
