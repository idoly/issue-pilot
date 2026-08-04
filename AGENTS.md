# Issue Pilot Project

This repository builds a local-first browser-based engineering issue agent on pi.

## Operating Rules

- Treat capability grant files as the authority for service and environment access.
- Keep production credentials in external CLI profiles; never write secrets to issues, comments, logs, snapshots, or capability files.
- Database evidence must use named read-only templates from the frozen repository commit.
- Node and Maven actions must use the fixed disposable-container actions in `src/evidence/toolchains.ts`.
- Preserve per-issue Git worktrees and pi sessions unless cleanup is explicitly requested.
- Do not mark an issue resolved without recorded verification evidence.

## Commands

- `npm test`: run backend tests
- `npm run typecheck`: type-check backend source and tests
- `npm run db:migrate`: apply SQLite migrations
- `npm run server`: start the Fastify API
- `npm --prefix apps/web run typecheck`: type-check the web client
- `npm --prefix apps/web run build`: build the web client

Runtime data defaults to `.issue-pilot`. Set `ISSUE_PILOT_STATE_ROOT` and `ISSUE_PILOT_DATABASE` to override it.
