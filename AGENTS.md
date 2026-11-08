# Agent Guide

This file is for coding agents. Human guides are indexed in [docs/README.md](docs/README.md); English implementation contracts are in [docs/ai/README.md](docs/ai/README.md). Read [Architecture](docs/ai/ARCHITECTURE.md), [Development](docs/DEVELOPMENT.md), then the relevant contract and its current owning code/tests before changing behavior.

## Before work

1. Run `git status --short`. Preserve existing changes and compare completion against a task-specific baseline.
2. Locate the owning code, domain contracts, root configuration, schema and focused tests.
3. Classify affected state as durable, conditionally durable or generated; names alone do not establish deletability.
4. Keep the patch scoped. Commit, push, deploy, restart or mutate live state only with user authorization; existing session authorization remains valid.

The configured data root (currently `data`) may contain credentials, JSONL, attachments, private branches, dirty worktrees and recovery evidence. Never use it as a fixture. Tests inject temporary roots through `buildApi({ stateRoot, databaseFile })` or manager constructors. Manual testing needs an independent checkout and root configuration; there is no state-path environment override. Pi tests also need an isolated agent directory.

Operations follow [the Runbook](docs/RUNBOOK.md) and [Storage](docs/ai/STORAGE.md): database-only checkpoints when warranted, bounded retention, no new full Issue-file backups. Preserve unknown paths, DB-unrepresented directories, dirty worktrees and recovery evidence. Never fix branch/path drift by guessing, reset, remote fallback or silent rebinding.

## Ownership and design

See the [ownership table](docs/ai/ARCHITECTURE.md#owners). Routes coordinate owners; do not reimplement Git, protocols, attachment transactions or command authorization. Prefer public Pi APIs, installed libraries and small local helpers.

- Choose the simplest complete design, not merely the shortest code. Every abstraction, interface, module and dependency needs a concrete maintenance benefit.
- Keep each business rule with one owner. Distinguish identity, role, permission and behavior; use closed types for stable domains.
- Isolate actual variation using data/configuration where useful; do not invent speculative extension frameworks, selectable runtimes or format-specific executors.
- Keep workflows traceable across a few owners. Limited repetition is better than combining unrelated semantics; do not split or rewrite reasonable files for style.
- Preserve transactions, concurrency, cancellation, idempotency, budgets, diagnostics, rollback/finalize and shutdown. Never hide failures to simplify code.
- Prefer gradual, justified changes. Test behavior and boundaries, not interfaces that only mirror implementation.
- Before deletion, check static/dynamic references, build and migration effects, current use and unique evidence. Preserve uncertain uses and report gaps.

A review-only request authorizes findings, not edits or upgrades. Confirmed findings must include location, evidence, effect, plausible trigger, minimum remedy, tradeoff and verification. Prioritize actual impact/likelihood/repair cost using P0–P3. Distinguish reproduced failures, predictable risks and theoretical concerns. Report conclusion, overdesign, oversimplification, designs to retain, a minimal plan and coverage gaps; do not manufacture findings.

## Required contracts

### Business and configuration

- Issue keys are `ISSUE-YYYYMMDD-NNN...` in the configured time zone. Creation claims an empty root and inserts exactly one Workspace. Issue scope must match a Service/Environment Deployment; resolved iff resolved_at is non-null.
- SQLite is authoritative for users, repositories, services, credentials and model selection. Do not restore retired YAML loading/import/export/projection or fill gaps from old private files.
- Dev baselines derive from the same service's production branches. Recorded Issue paths/branches remain history; configuration changes do not rewrite them.
- Roles remain product/test/developer; isAdmin is independent. Protect required active users, developers, managers and at least one active developer with management access.
- Shared model provider/model/thinking/Codemode/key and runtime settings are global. Deployments have no model override.

### Identity, secrets and capabilities

- Credential owner is assignee, else reporter, and must be active. Any owner's complete personal model group replaces shared; otherwise use shared. Missing/failed selected keys fail, never switch identity. Operator auth.json/models.json secrets never reach requests.
- Developer Git uses that person's SSH identity only. Missing/failed SSH never falls back to Operator, ssh-agent, another person or a shared identity.
- DMS/SLS credentials belong to users or the shared application group, not deployments. Select the active owner's complete personal group in prod/test, else shared; incomplete personal groups fail without fallback. Credentials do not create targets.
- Shared credential management is admin-only. Ordinary configuration GET projects credentials out. Developer-only selected descriptions/MCP configuration expose only documented fields; native DMS Authorization and SLS keys remain hidden. Connection secrets never enter prompts, tool input, argv, diagnostics or ordinary logs.
- Authorized SLS/DMS business login/session tokens explicitly requested by the user may be returned with source/time. The request suffices; retrieved values do not expand access scope.
- Native queries preserve exact source/target and read-only checks. Development evidence explicitly selects prod/test; code include/remove stays in the Issue environment.
- Native capabilities are DMS and aliyun SLS CLI; MySQL uses configured external MCP. Retired adapters remain private non-executable history.
- Service MCP requires deployment ownership plus Issue entry/included service scope. Global DingTalk import connections are application-only. Availability follows actual targets, without hard-coded prod/test exclusions. Read-only hints are descriptive, not authorization.
- Preserve SQLite authority, literal credentials, SDK transport compatibility, cancellation and budgets. Pi owns MCP discovery, registration, connections and shutdown. Parse unknown input at boundaries; keep execution checks after mutable hooks.
- Resources use the runtime user's global Pi configuration. No application-private skills/extensions or Issue-local extensions. Protect application tool names; inspection must not execute extensions. DingTalk preferences store source/mapping, never gateway credentials.

### Files, Git and execution

- Prod/test use read-only snapshots; active dev uses isolated worktrees; released dev restores from recorded local branches. Source APIs enforce repository policy and optimistic file hashes.
- Each Issue owns one persistent workspaces/<key> root for code, files, originals, sessions and metadata. Only creation claims it. Preparation, exports and admission refuse missing/redirected roots and preserve bindings; never recreate empty durable state.
- All model-controlled local operations cross one SRT boundary: only the current Issue root is persistently writable, related Issues are read-only. SDK, Operator extensions and storage owners are trusted application code; remote MCP retains independent authority.
- Host Node/npm, Java/Maven, Python and shared libraries are read-only to Issues. Do not inject a project .venv or create one by default. Project dependencies, build products and npm/Maven writable caches remain Issue-local; administrators maintain shared tools.
- Each attachment has one durable 0400 regular original verified against DB size/hash. Writes belong to Issue transactions. Preparation reads originals; explicit editing creates ordinary work files. Pasted images belong to Pi messages.
- Query exports atomically replace ordinary work files and retain old content on failure. Retired output snapshots/publication/download layers must not return. Migration indexes are offline evidence, not runtime aliases.
- Runtime manifests/wrappers/clean checkouts are generated, but abnormal/unknown state still requires inspection. Published migration SQL/journal entries are immutable; normal startup never adopts legacy directories or repairs drift.

### Sessions and Web

- Per-Issue serialization includes failure cleanup. Queued work cannot reuse disposed sessions or overwrite a newer round with an old error.
- Persist message admission before acknowledgement; uncertain delivery is not permission to resend. Cancellation does not undo completed side effects; restart does not rebuild the execution queue automatically.
- Web Agent drafts, sends and failures belong to application resources across navigation. Identity changes cancel unsent old-identity work; reject late responses.
- SSE replay becomes usable only at snapshot_ready; reconnect replaces projection, preserves deduplication/backpressure and never skips invalid frames. Display truncation must not modify durable results.

## Concurrency

Keep Agent activity, Issue-set reservations, configuration scope, lifecycle, per-Issue inspection and repository queues distinct. Repository keys include state root and URL hash.

```text
configuration read: scope queue → SQLite read snapshot
service/Issue scope write: scope queue → Issue reservation
release/reopen: lifecycle queue → inspection queue → Issue reservation
```

Never reverse these orders or replace them with a global mutex. Reauthorize after relevant waits. SQLite rollback cannot restore files/Git; each owner must prepare, roll back and finalize its own medium.

## Verification and completion

Maintain host-native application deployment and local independent-checkout verification only. Do not restore application container builds, Kubernetes or remote CI. Playwright/SSH test containers remain verification tools.

For code changes run focused behavior tests and applicable full checks:

```bash
npm run typecheck
npm test
npm run build
npm run format:check
npm run lint
git diff --check
```

Use backend --test-concurrency=2 and Vitest --maxWorkers=1 on constrained hosts as documented in Development. Runtime/dependency/protocol-security changes also require production dependency audit and available deployment health checks.

Match checks to affected state. Routine Web/backend releases without migrations need health, artifact and focused behavior checks, not a full state scan. Schema/data migrations, live storage/Git repair or abnormal recovery need relevant integrity/FK, modes, refs/worktrees and unmanaged-directory checks; broaden only when justified.

Cover failure, retry, cancellation, repetition, rollback/finalize and shutdown where relevant. Update the owning document without duplicating contracts. Human guides use concise Chinese; AGENTS.md and docs/ai use English. Maintain current guides without compatibility redirects, per-round reports or obsolete screenshot archives. Preserve the bounded host migration retrospective as reusable evidence, not current deployment instructions. This does not authorize deleting durable business history, immutable migrations, test fixtures or recovery evidence.

Inspect the final diff for unrelated edits, generated state and secrets. Report changes, checks and material gaps; do not claim complete safety or exhaustive unused-code discovery. Document-only changes require link/anchor/command-syntax checks and git diff --check, not service restarts or live-state scans.
