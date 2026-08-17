# Agent Guide

This is the entry point for coding agents working in Issue Pilot. It defines how to inspect, change, and verify the repository without damaging durable state.

## Read Order

Before changing code:

1. Read [Architecture](docs/ARCHITECTURE.md) for terminology, ownership, state transitions, Git/runtime behavior, concurrency, and security boundaries.
2. Read [Development](docs/DEVELOPMENT.md) for module owners, change recipes, tests, and review checks.
3. Read the task-specific reference:
   - [Configuration](docs/CONFIGURATION.md) for Service, Deployment, model, capability, and credential behavior.
   - [Deployment](docs/DEPLOYMENT.md) and [Kubernetes](docs/KUBERNETES.md) for images, processes, networking, and production topology.
   - [Runbook](docs/RUNBOOK.md) for health checks, backup, upgrade, recovery, retention, and troubleshooting.

Use `README.md` as the product overview. [File Audit](docs/FILE-AUDIT.md) and [Module Audit](docs/MODULE-AUDIT.md) record current design assessments but do not replace reading the owning code.

## Start Safely

1. Run `git status --short` and separate pre-existing work from your changes.
2. Locate the owning module and focused tests before editing.
3. Read current schema, domain constants, root config, and helpers. Do not infer current behavior from old migrations or deleted filenames.
4. Classify touched data as durable, conditionally durable, or generated.
5. Keep the implementation scoped to the requested behavior.

Do not revert unrelated changes. Do not commit or push unless the user explicitly requests it.

## Protect Real State

The checkout's `.issue-pilot` may contain real Issues, Deployment credentials, attachments, Pi JSONL, local branches, active worktrees, backups, and legacy editor history. Never use it for development experiments.

Application entry points resolve state from `issue-pilot.config.ts`; there is no environment-variable override. Automated tests inject temporary roots through `buildApi({ stateRoot, databaseFile })` and manager constructors. Manual isolated servers require a separate project copy with a separate configured state tree.

Do not start, stop, migrate, copy, or call destructive routes against active state unless the task explicitly requires an operational change and the Runbook recovery path has been verified. Never automatically delete or rewrite dirty, untracked, running, invalid-layout, changed-checkout, unmanaged, or database-unrepresented evidence.

## Authoritative Facts

| Fact | Source |
| --- | --- |
| Paths, ports, defaults, retention, images, runtime, and limits | `issue-pilot.config.ts` |
| Business enums and shared predicates | `src/domain/contracts.ts` |
| Current database model | `src/db/schema.ts` |
| Upgrade order | Immutable `drizzle/*.sql` and `drizzle/meta/_journal.json` |
| User, Issue, Service, Deployment, Repository, Workspace, Attachment | SQLite |
| Deployment Repository join and order | `src/workspace/deployment.ts` |
| Repository state and managed paths | `src/workspace/state.ts` |
| Issue project preparation | `src/workspace/project.ts` |
| Dev code after release | Local bare-store `refs/heads/<workingBranch>` |
| Prod/test code | Latest fetched current Deployment base-branch commit |
| Conversation | Per-Issue Pi JSONL active branch |
| Attachment integrity | Durable file plus DB object key, size, and SHA-256 |
| Capability save parser, input schema, and metadata | `src/capabilities/registry.ts` |
| Credential fields and update protocol | `src/configuration/contracts.ts` and `credentials.ts` |
| Capability tool dispatch | `src/pi/tools.ts` and the protocol client |
| Generated runtime and wrappers | `src/workspace/runtime.ts` and `project-wrappers.ts` |
| Source authorization | `src/workspace/source-browser.ts` |

Do not create a second source for one of these facts.

## Module Ownership

| Change | Start here |
| --- | --- |
| Enum, state, priority, type, shared predicate | `src/domain/contracts.ts` |
| Table, index, trigger, constraint | `src/db/schema.ts` plus a new migration |
| HTTP boundary | `src/http/*-routes.ts` and focused route tests |
| User lifecycle | `src/http/user-routes.ts` and `UserManagement.tsx` |
| Configuration DTO/projection/credential merge | `src/configuration` |
| Service configuration prepare/apply | `src/http/service-configuration.ts` |
| Attachment transaction/store | `src/http/attachment-store.ts` |
| Agent queue, reservation, state, session | `src/agent` |
| Model catalog and tool registration | `src/pi` |
| Capability config/input | `src/capabilities/registry.ts` |
| Capability protocol execution | Protocol client; DMS/SLS also use `src/tool-runtime.ts` |
| Generic child-process execution mechanics | `src/process.ts` |
| Authorized process command/environment | `src/tool-runtime.ts` |
| Git, checkout, worktree, runtime, release, reopen | `src/workspace` |
| Serial primitive | `src/serial.ts` |
| Web request/DTO | `src/web/src/data/client.ts` |
| SSE client state | `src/web/src/app/agent-stream.ts` |
| Event projection | `src/web/src/app/conversation.ts` |
| Capability form serialization | `src/web/src/app/configuration-model.ts` |
| App resources | `src/web/src/app/ApplicationResources.tsx` |
| Workbench | `src/web/src/vscode` and `CodeBrowser.tsx` |
| Compose/image/operator scripts | `infra` |
| Kubernetes baseline | `deploy/kubernetes/base` |

Routes coordinate owners, reservations, and transactions. They must not reimplement Git, attachment storage, tool authorization, or external protocols.

## Required Invariants

- Issue keys are `ISSUE-YYYYMMDD-NNN...` in the configured regional time zone.
- Issue creation claims a new empty Issue root before DB insert and never adopts unmanaged state.
- Every Issue has exactly one Workspace row.
- `status = resolved` if and only if `resolved_at` is non-null.
- Every Issue scope has a matching Service/Environment Deployment.
- Prod/test repositories are `read_only`; active dev is `development_workspace`; released dev is `development_snapshot`.
- Released dev restores from the local working branch, never a remote Issue-branch fallback.
- Existing dev `base_branch` and `workspace_name` remain Issue history.
- Writable dependencies and outputs are not shared across Issues.
- Attachment has one durable `0400` copy and no runtime copy/link.
- Attachment writes occur only inside Issue create/edit transactions.
- Dirty, untracked, running, invalid-layout, changed-checkout, and unmanaged state fails explicitly and is preserved.
- Runtime, wrappers, and immutable checkout are generated atomically and remain rebuildable.
- Stored passwords and AccessKeys do not enter config GET, unchanged PATCH values, `AgentSessionContext`, prompt, tool schema/input, argv, or logs.
- Pi tools parse input once with TypeBox and call protocol clients directly with typed session-local Deployment config.
- Protocol clients still enforce external target scope, protocol semantics, timeout, abort, response validity, and result bounds.
- API, migration, Git, runtime, Source Browser, and project-tool broker use the same state root.
- Published migrations and journal entries are immutable.

## Concurrency

Keep lock domains separate:

- Agent run and steering: per Issue.
- Issue reservations: affected Issue set.
- Configuration scope queue: API instance.
- Lifecycle coordination: API instance, then per-Issue inspection.
- Git operations: resolved state root plus Repository URL hash.

Required order:

```text
configuration read: scope queue -> SQLite snapshot transaction
Service/Issue scope write: scope queue -> Issue reservation
release/reopen: lifecycle queue -> inspection queue -> Issue reservation
```

Do not reverse acquisition order or replace all domains with one global mutex.

## No Automatic Compatibility

The runtime supports only the current state model. Do not add old-key parsing, automatic directory moves, metadata repair, mixed-state guessing, remote branch fallback, or silent truncation.

When an invariant fails:

1. Stop before deleting state.
2. Return one stable explicit error.
3. Preserve paths, refs, rows, and files as evidence.
4. Document an Operator-controlled recovery if needed.

Database migrations are different: published migrations remain immutable upgrade contracts.

## Full-Contract Changes

A complete behavior change may require updates to domain constants, schema/migration, boundary parsing, manager/client, HTTP DTO, Web client/state, tests, and exactly one owning document. Reuse root config, domain helpers, Registry definitions, and manager state predicates; do not duplicate them to make one layer compile.

Add abstractions only for a stable transaction, protocol, process, or reusable UI boundary. Do not split large owner modules by line count when doing so would duplicate queue, rollback, transaction, or authorization state.

## Verification

Iterate with focused tests, then scale with risk. Repository-wide changes normally require:

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

Dependency, runtime, capability-security, or container changes also require:

```bash
npm audit --omit=dev --audit-level=high
infra/playwright.sh status
infra/application.sh status
```

Schema or real-state operations additionally require SQLite integrity/FK checks, file modes, Git HEAD/ref consistency, and unmanaged-directory checks. Follow [Runbook](docs/RUNBOOK.md).

## Completion

Before finishing:

- Re-read the newest request.
- Inspect the final diff for unrelated changes, generated output, state, and secrets.
- Check failure, retry, abort, rollback/finalize, shutdown, and repeated calls where relevant.
- Confirm durable state is unchanged or recoverable by a documented procedure.
- Confirm Web DTOs and interactions match the API.
- Update the owning document without duplicating its detailed contract elsewhere.
- Report changed behavior, verification, and anything not verified.
