# Agent Guide

This file is the entry point for coding agents working in Issue Pilot. It defines how to inspect, change, verify, and maintain the repository without damaging durable state.

## Read Order

Before changing code:

1. Read [Architecture](docs/ARCHITECTURE.md) for terminology, state ownership, Agent execution, Git/runtime, and authorization principles.
2. Read [Development](docs/DEVELOPMENT.md) for source entry points, change recipes, testing, and review checks.
3. Read the task-specific reference:
   - [Configuration](docs/CONFIGURATION.md) for Service, Deployment, model, and capability behavior.
   - [Deployment](docs/DEPLOYMENT.md) for host runtime, processes, containers, proxy, and security boundaries.
   - [Runbook](docs/RUNBOOK.md) for health checks, retention, recovery, upgrade, and troubleshooting.

Use `README.md` only as the product overview and quick-start entry. The documents above are the detailed current contract.

## Start Every Task Safely

1. Run `git status --short` and distinguish pre-existing changes from your own work.
2. Locate the owning module and its tests before proposing an implementation.
3. Inspect current schema, domain constants, and helpers instead of inferring behavior from old migrations or filenames.
4. Decide whether the task touches durable data, generated state, or disposable workspace data.
5. Keep the change scoped to the requested behavior and current model.

Do not revert unrelated changes. Do not commit or push unless the user explicitly asks.

## Protect Real State

The repository's `.issue-pilot` may contain real Issues, attachments, Pi JSONL, local branches, and active workspaces. Do not use it for development experiments.

Application entry points resolve state from `issue-pilot.config.ts`; the current directory is the repository's `.issue-pilot`, with no environment-variable override. Automated tests inject temporary roots through `buildApi({ stateRoot })` and manager constructors. For an isolated manual server, use a separate project copy instead of changing the active checkout's state configuration.

Use temporary local Git remotes and temporary SQLite databases. Do not start the API or call destructive workspace, attachment, or database operations against real state unless the task explicitly requires an operational change and a recovery path has been verified.

Never automatically delete or rewrite evidence when state is dirty, untracked, running, structurally invalid, or not represented by the current database.

## Know the Facts

| Fact | Authoritative source |
| --- | --- |
| Issue, Deployment, workspace, repository rows | SQLite |
| Project paths, server, retention, runtime, and limits | `issue-pilot.config.ts` |
| Current business constants and states | `src/domain/contracts.ts` |
| Repository state classification | `src/workspace/state.ts` |
| Dev Issue code after workspace release | Local bare-store working branch ref |
| Prod/test code | Latest fetched Deployment base-branch commit |
| Conversation history | Per-Issue Pi JSONL active branch |
| Attachments | `issues/<key>/attachments` plus database hash/size |
| Current database model | `src/db/schema.ts` |
| Schema upgrade order | Immutable `drizzle/*.sql` plus journal |
| Generated code-server resources | Runtime builders under `src/workspace` |

Do not create a second source for one of these facts.

## Route Changes to the Owning Layer

| Change | Start here |
| --- | --- |
| Business enum or state | `src/domain/contracts.ts` |
| Table, column, or constraint | `src/db/schema.ts` and a new migration |
| HTTP behavior | `src/http/*-routes.ts` and route tests |
| Agent lifecycle or events | `src/agent` |
| Model/tool authorization | `src/pi` |
| External capability | `src/capabilities` |
| Git, checkout, worktree, runtime, release | `src/workspace` |
| Web DTO/request | `src/web/src/data/client.ts` |
| Web interaction | `src/web/src/app` |
| Container/runtime integration | `infra` |

Routes should coordinate managers and transactions, not reimplement Git, policy, attachment, or capability logic. Keep small helpers in the module that owns their fact or lifecycle; create a separate file only for a stable boundary such as a protocol client, process entry point, transaction manager, or reusable UI component. Use short domain names, adding a role suffix only when the local scope needs disambiguation.

## Preserve Current Invariants

Any change must continue to satisfy:

- Issue keys use `ISSUE-YYYYMMDD-NNN...`.
- Prod/test repositories are always `read_only`.
- Active dev repositories are `development_workspace`; released dev repositories are `development_snapshot`.
- Released dev recovery uses local `refs/heads/<workingBranch>`, never a remote Issue-branch fallback.
- Writable dependencies and build trees are never shared across Issues.
- Attachments remain one durable `0400` copy; runtime contains no attachment copy or link.
- Dirty, untracked, running, invalid-layout, and unmanaged state is preserved and fails explicitly.
- Runtime, manifests, wrappers, and immutable checkouts are generated atomically and remain rebuildable.
- Credentials do not enter policy, prompt, session events, logs, process arguments, or generated runtime files.
- Capability clients validate scope and result bounds even if an earlier layer already validated them.
- API, migration, Git, and code-server resolve the same state root.

The full rationale is in [Architecture](docs/ARCHITECTURE.md#必须保持的不变量).

## Do Not Add Compatibility by Default

The runtime supports the current filesystem and state model only. Do not add automatic old-key parsing, directory moves, metadata repair, remote branch fallback, or partial-state guessing.

If current invariants fail:

1. Stop before deleting generated or durable state.
2. Return a stable explicit error.
3. Preserve paths, refs, and database rows as evidence.
4. Document an operator-controlled recovery when needed.

Database migrations are different: published Drizzle migrations remain immutable because they are the schema upgrade contract.

## Implement Across the Full Contract

A complete behavior change may require updates in several places:

- Shared domain constants/types.
- Database schema and migration.
- Save-time and runtime validation.
- Manager or protocol client.
- HTTP DTO and Web client.
- Web states and interaction.
- Focused tests for success and failure.
- The one document that owns the changed fact.

Do not duplicate shared arrays, numeric limits, defaults, or state conditions to make one layer compile. Reuse `issue-pilot.config.ts`, a domain helper, or the owning manager.

## Verification

Run the narrowest relevant test while iterating, then scale validation with risk. Commands and the change-to-test matrix are in [Development](docs/DEVELOPMENT.md#测试).

Before declaring a repository-wide change complete, normally run:

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

For dependency, runtime, or security changes also run:

```bash
npm audit --omit=dev --audit-level=high
infra/playwright.sh status
infra/code-server.sh status
```

For schema or real-state operations additionally verify SQLite integrity, foreign keys, file modes, repository HEAD/ref consistency, and absence of unmanaged Issue directories. Use [Runbook](docs/RUNBOOK.md#日常检查) as the acceptance checklist.

If a verification cannot run, report the exact missing prerequisite and residual risk.

## Completion Standard

Before finishing:

- Re-read the newest user request and confirm the implementation answers it.
- Inspect the final diff for unrelated changes and accidental secret/state files.
- Confirm failure, retry, abort, and repeated-call behavior where relevant.
- Confirm durable state is either unchanged or recoverable by the documented method.
- Update documentation without repeating the same detailed fact in multiple files.
- Report changed behavior, verification performed, and anything not verified.
