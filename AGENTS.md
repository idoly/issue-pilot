# Agent Guide

This is the entry point for coding agents working in Issue Pilot. It defines how to inspect, change, and verify the repository without damaging durable state.

## Read Order

Before changing code:

1. Read [Architecture](docs/ARCHITECTURE.md) for terminology, state ownership, Agent execution, Git/runtime behavior, concurrency, and authorization boundaries.
2. Read [Development](docs/DEVELOPMENT.md) for source entry points, change recipes, tests, and review checks.
3. Read the task-specific reference:
   - [Configuration](docs/CONFIGURATION.md) for Service, Deployment, model, and capability behavior.
   - [Deployment](docs/DEPLOYMENT.md) for application runtime, containers, proxy, and security boundaries.
   - [Runbook](docs/RUNBOOK.md) for health checks, retention, backup, recovery, upgrades, and troubleshooting.

Use `README.md` only as the product overview and quick-start entry.

## Start Safely

At the start of every task:

1. Run `git status --short` and separate pre-existing work from your changes.
2. Locate the owning module and focused tests before proposing an implementation.
3. Read current schema, domain constants, and helpers. Do not infer current behavior from old migrations or historical filenames.
4. Decide whether the task touches durable data, generated state, or disposable workspace data.
5. Keep the implementation scoped to the requested behavior.

Do not revert unrelated changes. Do not commit or push unless explicitly requested.

## Protect Real State

The repository's `.issue-pilot` may contain real Issues, Deployment credentials, attachments, Pi JSONL, local branches, active worktrees, legacy code-server data, and backups. Never use it for development experiments.

Application entry points resolve state only from `issue-pilot.config.ts`. There is no environment-variable override. Automated tests inject temporary roots through `buildApi({ stateRoot, databaseFile })` and manager constructors.

Use temporary local Git remotes and temporary SQLite databases. For an isolated manual server, use a separate project copy with its own configured state tree. Do not start the API or call destructive routes against the active state unless the task explicitly requires an operational change and a recovery path has been verified.

Never automatically delete or rewrite evidence when state is dirty, untracked, running, structurally invalid, unmanaged, or not represented by the current database.

## Authoritative Facts

| Fact | Authoritative source |
| --- | --- |
| Runtime paths, ports, defaults, retention, limits, and images | `issue-pilot.config.ts` |
| Business enums and shared state predicates | `src/domain/contracts.ts` |
| Current database model | `src/db/schema.ts` |
| Schema upgrade order | Immutable `drizzle/*.sql` and `drizzle/meta/_journal.json` |
| User, Issue, Service, Deployment, repository, workspace, and attachment rows | SQLite |
| Deployment repository resolution | `src/workspace/deployment.ts` |
| Repository state classification and managed paths | `src/workspace/state.ts` |
| Issue project preparation | `src/workspace/project.ts` |
| Dev code after release | Local bare-store `refs/heads/<workingBranch>` |
| Prod/test code | Latest fetched commit of the current Deployment base branch |
| Conversation history | Per-Issue Pi JSONL active branch |
| Attachment integrity | Durable file plus database path, size, and SHA-256 |
| Capability parsing, credential-free scope, schema, and metadata | `src/capabilities/registry.ts` |
| Configuration credential fields, requiredness, and update states | `src/configuration/contracts.ts` |
| Service configuration content revision | `src/configuration/revision.ts` |
| Capability execution dispatch | `src/capabilities/broker.ts` |
| Generated Issue runtime and project wrappers | `src/workspace/runtime.ts` and `src/workspace/project-wrappers.ts` |
| Read-only source browsing | `src/workspace/source-browser.ts` and `src/http/source-browser-routes.ts` |

Do not create a second source for any of these facts.

## Module Ownership

| Change | Start here |
| --- | --- |
| Business enum, state, or shared predicate | `src/domain/contracts.ts` |
| Table, column, index, trigger, or constraint | `src/db/schema.ts` plus a new migration |
| HTTP behavior | `src/http/*-routes.ts` and focused route tests |
| User lifecycle | `src/http/user-routes.ts`, `subjects`, and `UserManagement.tsx` |
| Configuration DTO, credential projection/merge, revision, and snapshot projection | `src/configuration` |
| Service configuration command prepare/apply | `src/http/service-configuration.ts` |
| Attachment transaction/store behavior | `src/http/attachment-store.ts` |
| Agent queue, state transition, or session lifecycle | `src/agent` |
| Model and tool authorization | `src/pi` |
| Capability value parser | `src/capabilities/registry.ts` |
| Configuration credential update contract | `src/configuration/contracts.ts` and `src/configuration/credentials.ts` |
| Capability execution/client | `src/capabilities/broker.ts` and the protocol client |
| Git, checkout, worktree, runtime, prepare, release, or reopen | `src/workspace` |
| Shared serial primitive | `src/serial.ts` |
| Web DTO/request | `src/web/src/data/client.ts` |
| Agent stream transport state | `src/web/src/app/agent-stream.ts` |
| Agent event projection | `src/web/src/app/conversation.ts` |
| Capability form serialization | `src/web/src/app/configuration-model.ts` |
| Catalog/config request generation and shared state | `src/web/src/app/ApplicationResources.tsx` |
| Web interaction | `src/web/src/app` |
| Container/runtime integration | `infra` |

Routes coordinate managers, reservations, and transactions. They must not reimplement Git, policy, attachment storage, or capability protocols.

## Required Invariants

Every change must preserve these rules:

- Issue keys use `ISSUE-YYYYMMDD-NNN...` and are generated in the configured regional time zone.
- Issue creation claims a new empty Issue root before database insert and never adopts unmanaged state.
- Every Issue has exactly one `issue_workspaces` row.
- `status = resolved` if and only if `resolved_at` is non-null.
- An Issue's `(service_id, environment_id)` must have a matching Deployment.
- Prod/test repositories are always `read_only`.
- Active dev repositories are `development_workspace`; released dev repositories are `development_snapshot`.
- Released dev recovery uses the local working branch ref, never a remote Issue-branch fallback.
- Existing dev `base_branch` values are Issue history. Current Deployment branches apply to prod/test refreshes and repositories newly added to an active dev Issue.
- `workspace_name` remains stable across release, reopen, and Service repository-set changes.
- Writable dependencies and build output are never shared across Issues.
- Attachments have one durable `0400` copy. Runtime contains no attachment copy or link.
- Attachment writes happen only in Issue create/edit transactions. Attachment GET remains read-only.
- Dirty, untracked, running, invalid-layout, changed-checkout, and unmanaged state is preserved and fails explicitly.
- Runtime, manifests, wrappers, and immutable checkouts are generated atomically and remain rebuildable.
- Stored Deployment passwords and AccessKeys do not enter configuration GET responses, unchanged PATCH requests, policy, system prompt, tool schema, or tool input.
- Service PATCH/DELETE requires the full-content revision from the same configuration snapshot; stale edits fail before session close and transaction apply.
- Capability results are Agent evidence and may enter Pi JSONL; do not confuse this with direct Deployment credential exposure.
- Capability clients validate frozen scope, current configuration, input, timeout, and result bounds even if an earlier layer already validated them.
- API, migration, Git, runtime, source browser, and project-tool broker resolve the same state root.

The rationale is in [Architecture](docs/ARCHITECTURE.md#必须保持的不变量).

## Concurrency Rules

Do not merge all synchronization into one global mutex.

- `AgentEngine` serializes runs and steering per Issue.
- Issue reservations exclude Agent enqueue/send and other destructive Issue operations.
- Configuration reads use `scope queue -> SQLite snapshot transaction`; Service changes use `scope queue -> revision check -> Issue reservation`; Issue scope changes use `scope queue -> Issue reservation`.
- Lifecycle release/reopen/maintenance use `lifecycle queue -> per-Issue inspection queue -> Issue reservation`.
- Deep inspection is serialized per Issue; different Issues may inspect concurrently.
- Git operations are serialized by resolved state root plus Repository URL hash.
- `SerialQueue` and `KeyedSerialQueue` only share queue mechanics; their lock domains remain separate.

Never introduce a reverse acquisition order.

## No Automatic Compatibility

The runtime supports the current state model only. Do not add automatic old-key parsing, directory moves, metadata repair, remote branch fallback, mixed-state guessing, or silent truncation.

If current invariants fail:

1. Stop before deleting generated or durable state.
2. Return a stable explicit error.
3. Preserve paths, refs, and database rows as evidence.
4. Document an operator-controlled recovery when needed.

Published database migrations are different: they remain immutable because they are the schema upgrade contract.

## Full-Contract Changes

A complete behavior change may require updates to:

- Shared domain constants and types.
- Database schema and a new migration.
- Save-time parsing and runtime validation.
- Manager, registry, broker, or protocol client.
- HTTP DTO and Web client.
- Web state and interaction.
- Focused success, failure, rollback, retry, and repeated-call tests.
- The one document that owns the changed fact.

Do not duplicate arrays, defaults, limits, state conditions, capability fields, or Deployment repository joins to make one layer compile.

## Verification

Run the narrowest relevant test while iterating. Before declaring a repository-wide change complete, normally run:

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

For dependency, runtime, capability security, or container changes also run:

```bash
npm audit --omit=dev --audit-level=high
infra/playwright.sh status
infra/application.sh status
```

For schema or real-state operations additionally verify SQLite integrity, foreign keys, file modes, repository HEAD/ref consistency, and absence of unmanaged Issue directories. Follow [Runbook](docs/RUNBOOK.md).

If verification cannot run, report the exact missing prerequisite and residual risk.

## Completion Standard

Before finishing:

- Re-read the newest user request.
- Inspect the final diff for unrelated changes, generated output, state files, and secrets.
- Confirm failure, retry, abort, rollback/finalize, shutdown, and repeated-call behavior where relevant.
- Confirm durable state is unchanged or recoverable by a documented operator procedure.
- Confirm frontend DTOs and interactions match the current API.
- Update the document that owns the changed fact without duplicating detailed contracts elsewhere.
- Report behavior changed, verification performed, and anything not verified.
