# Architecture

## Runtime

Issue Pilot has three cooperating surfaces:

1. The Fastify API owns SQLite writes, issue configuration, uploads, terminal tickets, and WebSocket-to-PTY forwarding.
2. The agent runner prepares Git worktrees, persists pi sessions, writes capability grants, and starts the interactive pi CLI in a managed PTY.
3. The Solid web client consumes the API and embeds the shared code-server plus an xterm view of that exact pi PTY.

SQLite is accessed through Drizzle and `@libsql/client`. Runtime files live below `.issue-pilot` by default. The database and capability files are created with owner-only permissions.

## Issue Execution

A created issue binds one or more services to one environment. Each service binding references a unique deployment, which supplies the base branch and allowed evidence capabilities.

The runner:

1. Expands explicitly configured service relationships and module scopes.
2. Fetches each repository into a shared cache and creates an issue-specific Git worktree.
3. Writes a frozen capability grant containing repository paths, base commits, module paths, and allowed capabilities.
4. Creates or resumes a persistent pi session file.
5. Starts interactive `pi --session ... -a` in the managed PTY, loads the evidence extension, and supplies the issue context as the initial CLI prompt.
6. Lets the browser attach to that same PTY while the agent is running. The extension emits an owner-only `agent_settled` signal so the runner can update issue state without terminating the interactive CLI.

Runs for one issue are serialized. Different issues can run concurrently.

## Trust Boundaries

Capability grants are keyed by the normalized issue key and accepted only from the matching managed workspace. A grant must not be readable by group or other users.

Configuration reads use files from the recorded base commit. Nacos hosts must be allowlisted. Bootstrap credentials are written only to a temporary owner-only profile and are not included in tool output. Loaded repository/Nacos sources and missing Nacos targets are reported separately so a `404` cannot be mistaken for a complete effective configuration.

Database reads accept one issue-relevant read-only SQL statement at a time. The capability grant fixes the service and environment datasource; validation rejects comments, multiple statements, writes, DDL, locks, file output, delay functions, and unbounded `SELECT` queries. Test MySQL access and production DMS access run through pinned disposable containers. Passwords are passed through temporary environment files rather than command arguments.

Node and Maven tools expose fixed actions instead of arbitrary shell commands. Project paths must stay below the issue workspace.

Terminal access uses short-lived, single-use tickets. The browser neither formats agent events nor inserts status text into the terminal buffer: output, input, and resize messages are forwarded to the Runner-owned interactive pi PTY. PTY output has a bounded backlog. A running CLI is retained without a browser; after `agent_settled`, an unattached CLI is terminated after the idle timeout.

The API and web client have no built-in authentication or authentication database. They are loopback-only services. Any remote exposure must terminate authentication in a local reverse proxy before forwarding to the loopback listeners.

## Shared Code Server

One `code-server` container mounts the managed workspace root. Per-issue URLs select a folder through the `folder` query parameter. This avoids one persistent container per issue while preserving isolated Git worktrees.
