# Issue Pilot Project

This repository builds a local-first browser-based engineering issue system with pi as its agent runtime.

## Architecture Rules

- Pi is the only issue-processing agent. Add external capabilities as typed tools in `src/pi/extension.ts` instead of adding parallel agent runtimes.
- Treat the versioned issue policy in `.issue-pilot/capabilities/<issue>.json` as the authority for tools, the selected service/environment, and repository grants.
- Managed pi sessions are deny-by-default: no arbitrary bash, project-local extensions, skills, prompt templates, context files, session switching, or paths outside the issue grant.
- Route Nacos, MySQL, DMS, Node, and Maven operations through fixed disposable Podman commands. Never add long-lived evidence containers.
- Keep local Git status/diff operations argument-based and read-only. Never expose arbitrary Git commands or remote push operations to pi.
- Keep production credentials in external CLI profiles; never write secrets to issues, comments, logs, snapshots, policy files, or command arguments.
- Database reads accept bounded direct read-only SQL. Return database rows verbatim, but continue protecting configuration credentials, connection URLs, temporary files, and raw logs.
- Preserve per-issue Git worktrees and pi sessions unless cleanup is explicitly requested.
- Do not mark an issue resolved without recorded verification evidence.

## Commands

- `npm test`: run backend tests
- `npm run typecheck`: type-check backend source and tests
- `npm run db:migrate`: apply SQLite migrations
- `npm run server`: start the Fastify API
- `npm --prefix apps/web run typecheck`: type-check the web client
- `npm --prefix apps/web test`: run web tests
- `npm --prefix apps/web run build`: build the web client

Runtime data defaults to `.issue-pilot`. Set `ISSUE_PILOT_STATE_ROOT` and `ISSUE_PILOT_DATABASE` to override it.
