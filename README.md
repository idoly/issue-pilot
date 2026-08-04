# Issue Pilot

Issue Pilot is a local-first engineering issue workspace built on pi. It stores issue configuration in SQLite, prepares isolated Git worktrees, runs persistent pi sessions, exposes bounded evidence tools, and provides a Solid web interface.

## Requirements

- Node.js 24 or newer
- npm
- Git
- Podman for code-server and evidence tool containers
- pi installed and configured in `~/.pi/agent`

The Pi packages are peer dependencies. In this workspace they are provided by the global pi installation.

## Install

```bash
npm ci --legacy-peer-deps
npm --prefix apps/web ci --legacy-peer-deps
```

## Initialize

```bash
npm run db:migrate
SEED_USER_SUBJECT=demo-owner npm run db:seed
```

The default state directory is `.issue-pilot` and the default database is `.issue-pilot/issues.db`. Both can be changed with `ISSUE_PILOT_STATE_ROOT` and `ISSUE_PILOT_DATABASE`.

Copy `config/connectors.example.json` or provide an equivalent file, then set `ISSUE_PILOT_CONNECTORS_FILE` when evidence tools need Nacos, MySQL, or DMS access. Credentials must remain in external CLI profiles or runtime environment, never in issue records.

## Run

Start the API:

```bash
ISSUE_PILOT_CONNECTORS_FILE=.issue-pilot/connectors.json npm run server
```

Start the web client in another terminal:

```bash
npm --prefix apps/web run dev -- --host 127.0.0.1
```

The API listens on `http://127.0.0.1:3000` and Vite on `http://127.0.0.1:4173` by default. There is no browser authentication or authentication database. Both services are restricted to loopback; any remote exposure must use an authenticated local reverse proxy.

Prepare the pinned evidence tool images and shared code-server container with:

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
- `src/agent`: issue runner and per-issue execution coordination
- `src/db`: libSQL client, SQLite schema, migration, and seed
- `src/evidence`: capability grants and bounded read-only tools
- `src/workspace`: Git worktrees, shared code-server, PTY sessions, and terminal bridge
- `apps/web`: Solid web client
- `drizzle`: generated SQLite migration
- `infra`: shared code-server and pinned tool preparation scripts

See `docs/ARCHITECTURE.md` for trust boundaries and runtime flows.
