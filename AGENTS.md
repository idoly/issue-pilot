# Agent Guide

This is the entry point for coding agents working in Issue Pilot. It describes how to inspect, change, and verify the repository without damaging durable application state.

## Read order

Before changing code:

1. Read [Architecture](docs/ARCHITECTURE.md) for ownership, state transitions, Git/runtime behavior, concurrency, and security boundaries.
2. Read [Development](docs/DEVELOPMENT.md) for module owners, change recipes, tests, and review checks.
3. Read the task-specific owner document:
   - [Configuration](docs/CONFIGURATION.md) for Service, Deployment, global model, capability, and credential behavior.
   - [Deployment](docs/DEPLOYMENT.md) for the image, Kubernetes process, mounts, networking, and topology.
   - [Runbook](docs/RUNBOOK.md) for health checks, backup, upgrade, recovery, retention, and troubleshooting.

Use `README.md` only as the product overview. Current owning code is authoritative; these documents explain its contracts. Do not recreate point-in-time audit inventories as architecture documents.

## Start safely

1. Run `git status --short` and separate existing work from your changes.
2. Locate the owning module and focused tests.
3. Read current root config, domain contracts, schema, and owner helpers; do not infer behavior from old migrations.
4. Classify affected data as durable, conditionally durable, or generated.
5. Keep the implementation scoped to the requested behavior.

Never revert unrelated user changes. Do not commit or push unless explicitly requested.

## Protect real state

The checkout's `.issue-pilot` can contain real Issues, Deployment credentials, attachments, Pi JSONL, local branches, active worktrees, backups, and legacy evidence. Never use it for tests or experiments.

Production entry points resolve state from `issue-pilot.config.ts`; there is no environment-variable override. Automated tests inject temporary roots through `buildApi({ stateRoot, databaseFile })` or manager constructors. A manually isolated server requires a separate project copy whose root config points at separate state.

Do not start, stop, migrate, copy, or call destructive routes against active state unless the task explicitly authorizes an operational change and the Runbook recovery path has been checked. Dirty, untracked, running, invalid-layout, changed-checkout, unmanaged, and database-unrepresented evidence must be preserved.

## Authoritative facts

| Fact | Owner |
| --- | --- |
| Paths, ports, defaults, retention, runtime, limits | `issue-pilot.config.ts` |
| Image contents | `Containerfile` |
| Kubernetes mounts, resources, probes | `deploy/issue-pilot.yaml` |
| Business enums and shared predicates | `src/domain/contracts.ts` |
| Current database model | `src/db/schema.ts` |
| Upgrade order | Immutable `drizzle/*.sql` and `drizzle/meta/_journal.json` |
| User, Issue, Service, Deployment, Repository, Workspace, Attachment, global Agent model | SQLite |
| Deployment Repository join/order | `src/workspace/deployment.ts` |
| Repository state and managed paths | `src/workspace/state.ts` |
| Project preparation | `src/workspace/project.ts` |
| Dev code after release | Local bare-store working branch |
| Prod/test code | Latest fetched current Deployment base-branch commit |
| Conversation | Per-Issue Pi JSONL active branch |
| Attachment integrity | Durable file plus DB object key, size, SHA-256 |
| Capability save parser, input schema, metadata | `src/capabilities/registry.ts` |
| Credential fields and update protocol | `src/configuration/contracts.ts`, `credentials.ts` |
| Tool registration and dispatch | `src/pi/tools.ts` and protocol clients |
| Runtime and wrappers | `src/workspace/runtime.ts`, `project-wrappers.ts` |
| Source authorization | `src/workspace/source-browser.ts` |

Do not create a second source for these facts.

## Module ownership

| Change | Start here |
| --- | --- |
| Enum, state, priority, type, predicate | `src/domain/contracts.ts` |
| Table, index, trigger, constraint | `src/db/schema.ts` plus a new migration |
| HTTP boundary | `src/http/*-routes.ts` and focused route tests |
| User lifecycle | `src/http/user-routes.ts`, `UserManagement.tsx` |
| Configuration DTO/projection/credential merge | `src/configuration` |
| Service configuration prepare/apply | `src/http/service-configuration.ts` |
| Attachment transaction/store | `src/http/attachment-store.ts` |
| Agent queue, reservation, state, session | `src/agent` |
| Model catalog and tool registration | `src/pi` |
| Capability config/input | `src/capabilities/registry.ts` |
| Capability protocol | Corresponding `src/capabilities/*.ts` client |
| Generic process execution | `src/process.ts` |
| Authorized commands/environment | `src/tool-runtime.ts` |
| Git/worktree/runtime/release/reopen | `src/workspace` |
| Web request/DTO | `src/web/src/data/client.ts` |
| SSE transport state | `src/web/src/app/agent-stream.ts` |
| Event projection | `src/web/src/app/conversation.ts` |
| Capability form serialization | `src/web/src/app/configuration-model.ts` |
| Shared Web resources | `src/web/src/app/ApplicationResources.tsx` |
| Workbench | `src/web/src/vscode`, `CodeBrowser.tsx` |
| Browser harness | `scripts/playwright.sh` |

Routes coordinate owners, reservations, and transactions. They must not reimplement Git, attachment storage, command authorization, or external protocols.

## Required invariants

- Issue keys are `ISSUE-YYYYMMDD-NNN...` in the configured regional time zone.
- Issue creation claims a new empty Issue root before DB insert and never adopts unmanaged state.
- Every Issue has exactly one Workspace row.
- `status = resolved` if and only if `resolved_at` is non-null.
- Every Issue scope has a matching Service/Environment Deployment.
- One global Agent provider/model/thinking level applies to every Service and Environment; Deployments contain no Agent override.
- Prod/test is `read_only`; active dev is `development_workspace`; released dev is `development_snapshot`.
- Released dev restores only from local working branches, never a remote Issue-branch fallback.
- Existing dev `base_branch` and `workspace_name` remain Issue history.
- Writable dependencies and outputs are not shared across Issues.
- Each Attachment has one durable `0400` copy and no runtime copy/link.
- Attachment writes occur only in Issue create/edit transactions. Clipboard images sent to Agent are Pi message content persisted in JSONL, not Attachment objects.
- Unsafe or unknown filesystem/Git state fails explicitly and remains evidence.
- Runtime, wrappers, and immutable checkouts are generated atomically and remain rebuildable.
- Config GET intentionally returns stored credentials to the trusted configuration UI. Credentials must not enter logs, monitoring, diagnostics, Agent context, prompt, tool schema/input, or process arguments.
- Pi tools parse input once with TypeBox and invoke typed protocol clients directly.
- DMS Agent access is one `dms` tool. Its schema input is an enum of the current Deployment's configured schemas; the server maps the schema to DatabaseId, injects it into MCP `executeScript`, and enforces read-only SQL.
- API, migration, Git, runtime, Source Browser, and project-tool broker use one state root.
- Published migrations and journal entries are immutable.

## Concurrency

Keep lock domains separate:

- Agent run and steering: per Issue.
- Issue reservation: affected Issue set.
- Configuration scope queue: API instance.
- Lifecycle queue: API instance, followed by per-Issue inspection.
- Git operation: resolved state root plus Repository URL hash.

Required order:

```text
configuration read: scope queue -> SQLite snapshot transaction
Service/Issue scope write: scope queue -> Issue reservation
release/reopen: lifecycle queue -> inspection queue -> Issue reservation
```

Do not reverse this order or replace the domains with one global mutex.

## No automatic compatibility

The runtime supports only the current state model. Do not add old-key parsing, automatic directory moves, metadata repair, mixed-state guessing, remote branch fallback, or silent truncation.

On invariant failure:

1. Stop before deleting state.
2. Return one stable error.
3. Preserve paths, refs, rows, and files.
4. Document an Operator-controlled recovery when needed.

Published database migrations are the only supported upgrade contracts.

## Verification

Repository-wide changes normally require:

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

Dependency, runtime, capability-security, or container changes also require:

```bash
npm audit --omit=dev --audit-level=high
scripts/playwright.sh status
kubectl -n issue-pilot get deployment,pod,service
```

Schema or real-state operations additionally require SQLite integrity/FK checks, file-mode checks, Git HEAD/ref consistency, and unmanaged-directory checks. Follow the Runbook.

## Completion

Before finishing:

- Re-read the latest request.
- Inspect the final diff for unrelated changes, generated output, state, and secrets.
- Check failure, retry, abort, rollback/finalize, shutdown, and repeated calls where relevant.
- Confirm durable state is unchanged or recoverable through a documented procedure.
- Confirm Web DTOs and interactions match the API.
- Update the one owning document; link to it instead of copying detailed contracts elsewhere.
- Report changed behavior, verification, and anything not verified.
