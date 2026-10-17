# Agent Guide

Issue Pilot manages durable Issues, Git worktrees, attachments and Pi conversations. Read current owning code before changing behavior. Start with [Architecture](docs/ARCHITECTURE.md), [Development](docs/DEVELOPMENT.md), then the relevant [Configuration](docs/CONFIGURATION.md), [Deployment](docs/DEPLOYMENT.md) or [Runbook](docs/RUNBOOK.md).

## Before changes

1. Run `git status --short`; preserve existing user changes.
2. Locate the owner and focused tests. Read the current root config, domain contracts and schema where relevant.
3. Classify affected state as durable, conditionally durable or generated.
4. Keep work scoped. Do not commit or push unless requested.

The checkout's `.issue-pilot` may contain real data, credentials, JSONL, branches, dirty worktrees and recovery evidence. Never use it for tests. Tests inject temporary roots through `buildApi({ stateRoot, databaseFile })` or manager constructors. A manual isolated server requires an independent project copy with its own root configuration; there is no environment override for state paths.

Do not start, stop, migrate or mutate active state unless an operational change is authorized and the Runbook recovery procedure has been checked. Preserve unknown paths, database-unrepresented directories, changed checkouts and dirty worktrees.

## Owners

| Concern | Source |
| --- | --- |
| Paths, defaults, limits, retention | `issue-pilot.config.ts`, `src/config.ts` |
| Business enums and predicates | `src/domain/contracts.ts` |
| Current database and upgrades | `src/db/schema.ts`, immutable `drizzle/` history |
| Configuration and credentials | `src/configuration` |
| HTTP identity and roles | `src/http/route-context.ts` |
| HTTP coordination | `src/http/*-routes.ts` |
| Service prepare/apply | `src/http/service-configuration.ts` |
| Attachment transactions | `src/http/attachment-store.ts` |
| Agent queue and reservations | `src/agent/engine.ts` |
| Pi sessions and model runtime | `src/agent/pi-session.ts`, `src/agent/model-runtime.ts` |
| Tool input and dispatch | `src/agent/service-query-tool.ts`, `src/capabilities/registry.ts` |
| External protocols | `src/capabilities`, `src/mcp/client.ts` |
| Inbound MCP work orders | `src/mcp/server.ts` |
| Output files and publication | `src/outputs/store.ts`, `src/agent/output-tool.ts` |
| Git, project, runtime and lifecycle | `src/workspace` |
| Web requests and DTOs | `src/web/src/data/client.ts` |
| Web shared state and stream | `ApplicationResources.tsx`, `agent-stream.ts`, `conversation.ts` |
| Code browser | `src/web/src/app/CodeBrowser.tsx`, `src/workspace/source-browser.ts` |
| Browser verification | `scripts/playwright.sh` |

Routes coordinate owners; they do not reimplement protocols, Git, attachment storage or command authorization. Prefer existing Pi APIs and small local helpers over new generic layers.

## Design and review

Judge every change by whether a new maintainer three years from now can still understand and modify the project easily.

1. Choose the simplest implementation that satisfies current requirements.
2. Do not design ahead for unlikely future needs.
3. Do not add complexity to satisfy an imagined enterprise standard.
4. Require a concrete benefit for every abstraction.
5. Require a clear reason for every module to exist.
6. Keep dependencies that lower implementation or maintenance cost; extra navigation alone is not a benefit.
7. Reduce cognitive cost before optimizing the appearance of the code structure.
8. Preserve necessary complexity and remove complexity without value.
9. Allow design to evolve from real needs instead of building the complete future now.
10. Explain decisions in terms of how a new maintainer finds the behavior, understands its constraints, and changes it safely.

## Required contracts

- Issue keys follow `ISSUE-YYYYMMDD-NNN...` in the configured time zone. Creation claims a new empty Issue root and inserts exactly one Workspace.
- Issue scope must have a matching Service/Environment Deployment; `resolved` and non-null `resolved_at` are equivalent.
- One global Agent model applies to all services/environments. Deployments have no model override.
- Prod/test repositories use read-only snapshots; active dev owns isolated Git worktrees; released dev restores from local working branches only. Source API enforces this policy.
- Agent code is trusted inside one application container. All Issues use Pi native coding tools in `issues/<key>/work`; cwd organizes work and does not enforce filesystem isolation. Native code can bypass application file policies, so do not claim strict isolation between Issues.
- Process file formats with normal code and installed libraries. Do not add format-specific execution tools, nested sandbox runtimes, or a selectable executor framework without a concrete requirement.
- Existing dev base branch and workspace name are history. Never repair drift by guessing, reset, remote fallback or silent metadata changes.
- Attachments have one durable `0400` file, validated against DB size/hash. Writes belong to Issue create/edit transactions. Pasted Agent images belong to Pi message content, not Attachment storage.
- Outputs are durable and published atomically from regular files in the Issue's working directory. Preserve working files across rounds. Runtime, wrappers and immutable checkouts remain generated and validated before replacement or removal.
- Configuration GET projects credentials out. A separate developer-only service description may expose selected native credentials; DMS Authorization and SLS keys stay hidden. Secrets never enter Agent context, prompt, tool input, argv, diagnostics or logs.
- Personal production credentials override DMS/SLS independently and completely; missing values use deployment configuration, failed requests never retry as another identity.
- Development evidence queries use explicit prod/test sources and remain read-only. Code include/remove stays within the Issue's environment.
- Tool unknown input is parsed at its boundary; protocol response and authorization checks remain with their owner.
- Published migrations and journal entries are immutable. No automatic legacy parsing, directory adoption or repair.

## Concurrency

Keep the existing lock domains distinct: per-Issue Agent activity, Issue-set reservations, API configuration scope, lifecycle, per-Issue inspection, and repository operations keyed by state root plus URL hash.

```text
configuration read: scope queue -> SQLite read snapshot
service/Issue scope write: scope queue -> Issue reservation
release/reopen: lifecycle queue -> inspection queue -> Issue reservation
```

Do not reverse the order or replace it with a global mutex. Reauthorization after queue waits protects against concurrent permission changes.

## Verification and completion

For code changes, run focused tests and the applicable full checks:

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

On constrained machines use the equivalent backend `--test-concurrency=2` and Vitest `--maxWorkers=1` commands in the development guide. Runtime, dependency, protocol security or container changes also require a production dependency audit, browser harness status and available deployment health checks. Real-state/schema operations require integrity/FK, modes, Git refs and unmanaged-directory checks from the Runbook.

Inspect the final diff for unrelated work, state, generated artifacts and secrets. Check failure, retry, cancellation, rollback/finalize, repeated calls and shutdown where relevant. Keep Web DTOs aligned with HTTP, update the single owning document, and report changes, verification and material gaps. Do not claim tests prove all code is safe or all unused code has been found.
