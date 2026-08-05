# Issue Pilot

Issue Pilot is a local-first intelligent issue-processing system built around pi. It stores issue configuration in SQLite, prepares isolated Git worktrees, runs persistent policy-bound pi sessions, exposes external capabilities through a typed pi extension, and provides a Solid web interface.

## Requirements

- Node.js 24 or newer
- npm
- Git
- Podman for code-server and evidence tool containers
- pi installed and configured in `~/.pi/agent`

The Pi packages are peer dependencies. In this workspace they are provided by the global pi installation.

## Install

```bash
npm ci
npm --prefix apps/web ci
```

## Initialize

```bash
npm run db:migrate
SEED_USER_SUBJECT=demo-owner npm run db:seed
```

The default state directory is `.issue-pilot` and the default database is `.issue-pilot/issues.db`. Both can be changed with `ISSUE_PILOT_STATE_ROOT` and `ISSUE_PILOT_DATABASE`.

Each issue run creates an owner-only execution policy that allowlists pi tools, the selected service environment, every attached repository, and exact issue attachment grants. Managed sessions disable arbitrary shell access and all automatically discovered pi resources. Attachments are readable only through bounded `attachment_read` calls by granted ID. External capabilities execute only when pi calls their typed tools; for example, `database_read` resolves the service's frozen repository configuration, repository-resolved Nacos imports, and unique datasource before running a bounded read-only query in a disposable container.

## Run

Start the API:

```bash
npm run server
```

Start the web client in another terminal:

```bash
npm --prefix apps/web run dev -- --host 127.0.0.1
```

The API listens on `http://127.0.0.1:3000` and Vite on `http://127.0.0.1:4173` by default. There is no browser authentication or authentication database. Both services are restricted to loopback; any remote exposure must use an authenticated local reverse proxy.

Prepare the pinned disposable capability images and shared code-server container with:

```bash
infra/pi-tools.sh prepare
infra/code-server.sh ensure
```

## Verify

```bash
npm run typecheck
npm test
npm --prefix apps/web run typecheck
npm --prefix apps/web run build
```

## Structure

- `src/http`: Fastify API, uploads, terminal tickets, and interactive PTY WebSocket forwarding
- `src/agent`: issue orchestration, service repository preparation, prompts, and per-issue execution coordination
- `src/pi`: versioned issue policy, pi extension, path enforcement, and fixed repository inspection
- `src/evidence`: containerized configuration, database, Node, and Maven capability implementations
- `src/db`: libSQL client, SQLite schema, migration, and seed
- `src/workspace`: Git worktrees, shared code-server, policy-bound PTY sessions, and terminal bridge
- `apps/web`: Solid web client
- `drizzle`: generated SQLite migration
- `infra`: shared code-server and pinned tool preparation scripts

See `docs/ARCHITECTURE.md` for trust boundaries and runtime flows.
