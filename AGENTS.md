# Agent Guide

Issue Pilot manages durable Issues, Git worktrees, attachments, outputs and Pi conversations. Read [Architecture](docs/ARCHITECTURE.md) and [Development](docs/DEVELOPMENT.md), then the relevant [Configuration](docs/CONFIGURATION.md), [Deployment](docs/DEPLOYMENT.md) or [Runbook](docs/RUNBOOK.md). Read current owning code before changing behavior.

## Before work

1. Run `git status --short`. Preserve existing changes and compare the final result against a task-specific baseline.
2. Locate the owner, domain contracts, root configuration, schema and focused tests.
3. Classify affected state as durable, conditionally durable or generated.
4. Keep the patch scoped. Commit, push, restart or mutate live state only when authorized by the user; existing session authorization remains valid.

The checkout's `.issue-pilot` can contain real credentials, JSONL, attachments, local branches, dirty worktrees and recovery evidence. Never use it as a test fixture. Tests inject temporary roots through `buildApi({ stateRoot, databaseFile })` or manager constructors. A manual isolated server needs an independent project copy and its own root configuration; there is no state path environment override.

Before an authorized operational change, follow the Runbook, including its bounded backup retention and post-verification rotation policy. Do not accumulate a new large snapshot for every agent round or routine check. Preserve unknown paths, database-unrepresented directories, changed checkouts and dirty worktrees. Do not repair branch/path drift by guessing, reset, remote fallback or silent metadata updates.

## Owners

| Concern | Source |
| --- | --- |
| Paths, defaults, budgets and retention | issue-pilot.config.ts, src/config.ts |
| Roles, work modes, states and business predicates | src/domain/contracts.ts |
| Current database and immutable upgrades | src/db/schema.ts, src/db/bootstrap.ts, drizzle/ |
| Configuration, projection and credentials | src/configuration |
| HTTP identity and authorization | src/http/route-context.ts |
| HTTP coordination | src/http/*-routes.ts |
| Service prepare/apply | src/http/service-configuration.ts |
| Attachment transactions | src/http/attachment-store.ts |
| Agent queue, reservations and recovery | src/agent/engine.ts |
| Pi sessions and model runtime | src/agent/pi-session.ts, src/agent/model-runtime.ts |
| Tool input and dispatch | src/agent/service-query-tool.ts, src/capabilities/registry.ts |
| External protocols and Pi MCP integration | src/capabilities, src/mcp/client.ts, src/mcp/pi-extension.ts |
| Inbound Issue MCP | src/mcp/server.ts |
| Local tools and SRT | src/agent/native-tools.ts, src/agent/issue-sandbox.ts, src/agent/native-tool-executor.ts |
| Application state lease | src/workspace/state-lease.ts |
| Working files and legacy downloads | src/workspace/work-file-store.ts, src/outputs/store.ts |
| Git, projects, runtime and lifecycle | src/workspace |
| Web requests and DTOs | src/web/src/data/client.ts |
| Shared configuration and identity | ApplicationResources.tsx |
| SSE and conversation projection | agent-stream.ts, conversation.ts, AgentPanel.tsx |
| Code browser | CodeBrowser.tsx, SourceText.tsx, SourceDiff.tsx, monaco.ts, src/workspace/source-browser.ts |

Routes coordinate owners; they do not reimplement Git, protocols, attachment storage or command authorization. Prefer public Pi APIs and small local helpers over new generic layers.

## Design and review

Correctness comes first. Aim for code that a new maintainer three years from now can understand and safely change with a small, local diff. Avoid both unnecessary abstraction and oversimplification through hard-coded or scattered business rules.

1. Choose the simplest implementation that completely satisfies current requirements. Fewer lines alone do not prove better design.
2. Isolate real variation points. Use data, configuration or mappings where they fit; do not anticipate unlikely features or build speculative extension frameworks.
3. Give each business rule a clear owner. Distinguish identity, roles, permissions and behavior. Keep stable, closed types as enums.
4. Require a concrete maintenance benefit for every abstraction, module, interface and dependency. Prefer language, standard library, framework and official SDK capabilities.
5. Allow limited repetition when semantics differ. Do not force unrelated behavior into one helper or add layers that only forward calls.
6. Keep workflows traceable across a few related owners. Do not split files for length or rewrite reasonable implementations for style.
7. Preserve boundaries, error meaning, transactions, concurrency, cancellation, idempotency, diagnostics and recovery. Do not hide failures or swallow errors to make code shorter.
8. Evaluate common business changes for unnecessary cross-module impact; implement only current needs and justified extension points.
9. Test behavior, boundaries and invariants. Do not create meaningless interfaces or tests that only mirror implementation.
10. Prefer local, gradual evolution and necessary compatibility. Keep a reasonable design when a replacement has no demonstrated benefit.
11. Identify obsolete code, files, directories, dependencies and configuration. Before deletion, verify static and dynamic references, builds, migrations and runtime effects; report uncertain uses and preserve them.

A review-only request authorizes findings and recommendations, not source edits, dependency upgrades or architecture changes. Once changes are authorized, prioritize correctness, security and consistency, implement the minimum useful patch and validate it.

For each confirmed finding, give location, evidence, effect, reasonable trigger, minimum remedy, tradeoff and verification. Prioritize P0/P1/P2/P3 by actual impact, likelihood and repair cost. Distinguish reproduced failures, predictable risks and theoretical concerns. Do not manufacture findings or force a refactor. Report overall conclusion, findings, overdesign, oversimplification, designs to retain and a minimal improvement plan, including coverage and gaps.

## Required contracts

- Issue keys use `ISSUE-YYYYMMDD-NNN...` in the configured time zone. Creation claims an empty Issue root and inserts exactly one Workspace.
- Issue scope must match a Service/Environment Deployment. `resolved` and non-null `resolved_at` are equivalent.
- One global Agent model, thinking level and Codemode setting applies to all services/environments; deployments have no model override.
- Business roles remain product/test/developer. `isAdmin` is independent. User mutations protect active users, developers, managers and at least one active developer with management access.
- Credential owner is assignee, else reporter, and must be active. Developer owners use personal model/SSH identity; failed or missing credentials never fall back to another identity.
- Personal production DMS/SLS groups override independently and completely. Missing groups use deployment configuration; they do not create absent targets.
- Ordinary configuration GET projects credentials out. Developer-only selected descriptions/MCP configuration may expose their documented values; native DMS connection Authorization and SLS connection keys remain hidden. Connection configuration secrets never enter prompts, tool input, argv, diagnostics or ordinary logs. Business login/session tokens explicitly requested from authorized SLS/DMS results may be returned with source and time; the request itself is sufficient, and retrieved values do not expand access scope.
- Native evidence queries retain exact source/target and read-only checks. Development queries explicitly select prod/test; code include/remove stays in the Issue environment.
- Resources use the running user's global Pi configuration; the application does not maintain a separate skills/extensions directory. Protect application tool names and keep global resource inspection free of extension execution.
- Enabled external MCP services expose configured tools through Pi's public MCP integration. Read-only hints are descriptive, not authorization. Preserve authoritative file configuration (or DB configuration when files are absent), literal credentials, SDK transport compatibility, cancellation and input/result budgets; Pi owns discovery, registration, connections and shutdown.
- Native capabilities are DMS and aliyun SLS CLI; MySQL uses configured external MCP. Retired adapter settings remain private historical state and must not execute or appear in public configuration.
- Prod/test use read-only snapshots, active dev uses isolated worktrees, released dev restores from local working branches. Source API enforces repository policy; historical branch and workspace names remain history.
- Each Issue owns one persistent `workspaces/<key>` root containing code, files, original attachments, sessions and runtime metadata. Model-controlled local operations use one SRT boundary; only this root is persistently writable and related Issue directories are read-only. Pi SDK, Operator extensions and application storage owners remain trusted application code; remote MCP services retain their own authority (docs/AGENT.md).
- Use normal code and installed libraries for formats. Do not add format-specific executors, nested sandboxes or a selectable runtime framework without a concrete need.
- Attachments have one durable 0400 regular file validated against DB size/hash. Writes belong to Issue transactions. Pasted Agent images belong to Pi messages, not attachment storage.
- Query exports atomically replace ordinary working files and preserve old content on failure. New output snapshots and publication tools are retired; legacy downloads resolve through explicit migration mappings. Runtime/wrappers/checkouts are generated; abnormal or unknown state still requires owner inspection.
- Per-Issue serialization includes failure cleanup. Queued work cannot reuse a disposed session or overwrite a newer round with old failure state.
- Web Agent drafts, saves and failures belong to application resources, so page navigation does not discard them. Identity changes cancel unsent work for the old identity.
- Unknown tool input is parsed at the boundary; protocol response and authorization checks stay with the owner. Keep execute checks needed after mutable Pi hooks.
- Published migration SQL and journal entries are immutable. Do not automatically parse legacy layouts, adopt directories or repair state.

## Concurrency

Keep Agent activity, Issue-set reservation, API configuration scope, lifecycle, per-Issue inspection and repository operations distinct. Repository keys include state root and URL hash.

```text
configuration read: scope queue -> SQLite read snapshot
service/Issue scope write: scope queue -> Issue reservation
release/reopen: lifecycle queue -> inspection queue -> Issue reservation
```

Do not reverse these orders or replace them with a global mutex. Reauthorize after relevant queue waits. SQLite rollback does not restore files or Git; owners must prepare, roll back and finalize each medium.

## Verification and completion

For code changes run focused behavior tests and applicable full checks:

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

On constrained machines use backend `--test-concurrency=2` and Vitest `--maxWorkers=1` as described in Development. Runtime, dependency, protocol security or container changes also require production dependency audit and available deployment health checks. Real-state operations require integrity/FK, file modes, Git refs/worktrees and unmanaged-directory checks from the Runbook.

Cover failure, retry, cancellation, repeated calls, rollback/finalize and shutdown where relevant. Keep HTTP and Web DTOs aligned and update the owning document. Inspect the final diff for unrelated work, state, generated artifacts and secrets. Report changes, checks and material gaps; do not claim tests prove all code safe or every unused path found.
