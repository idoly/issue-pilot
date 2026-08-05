# Architecture

## Core Model

Issue Pilot is an issue-processing system built around pi. Fastify and Solid provide orchestration and interaction; they do not implement a second agent runtime.

The runtime has four surfaces:

1. Fastify owns SQLite writes, issue configuration, uploads, terminal tickets, and WebSocket-to-PTY forwarding.
2. The Runner resolves issue scope, prepares Git worktrees, creates the issue policy, and starts the interactive pi CLI.
3. The Issue Pilot pi extension enforces that policy and exposes bounded tools for external systems and build runtimes.
4. Solid embeds the shared code-server and an xterm view of the exact Runner-owned pi PTY.

SQLite is accessed through Drizzle and `@libsql/client`. Runtime files live below `.issue-pilot` by default. Databases, policies, signals, connector profiles, and secrets are owner-only.

## Service Model

A service has a name, description, one or more frontend/backend Git repositories, and zero or more environment deployment configurations. Repository roots are the only configured code boundaries. Services do not contain a type, project paths, modules, or configured relationships.

An issue selects exactly one service. Runner prepares all repositories attached to that service and does not add repositories through dependency expansion. Maven/npm manifests, imports, configuration, and MQ annotations may be inspected on demand, but discovered dependencies are evidence rather than persisted authorization.

## Issue Execution Policy

Every run produces a version 3 policy at `.issue-pilot/capabilities/<issue-key>.json`. The policy binds:

- one normalized issue key and issue type;
- the exact workspace root;
- the active pi tool allowlist;
- the selected service and environment;
- repository roots and frozen base commits;
- repository-root code boundaries for the selected service;
- deployment evidence capabilities.

Policy files are accepted only from the matching managed workspace and must not be readable by group or other users. Repository paths must remain below that workspace. Existing targets are canonicalized with `realpath`; symlink escapes and writes to Git metadata are rejected.

Issue type determines code mutation access. `incident`, `request`, and `smart_analysis` may use `edit`/`write` at the repository roots attached to the selected service. `question` sessions are entirely code-read-only. Configuration and database tools become active only when at least one selected deployment grants the corresponding capability.

The Runner includes a policy hash in the PTY binding. A policy change invalidates the old binding, so a retained process cannot silently keep stale permissions.

## Locked Pi Runtime

Managed pi starts with automatic resources disabled:

```text
--no-approve
--no-extensions
--no-skills
--no-prompt-templates
--no-context-files
--no-builtin-tools
--tools <issue allowlist>
--extension <issue-pilot extension>
```

The explicit extension loads before project trust and activates only when the Runner sets `ISSUE_PILOT_POLICY_REQUIRED=1`. Outside a managed issue run, the package extension is inert.

The CLI allowlist is the first boundary. The extension is the second boundary: it reloads the policy for every tool call, blocks inactive tools, validates built-in file/search paths, disables `!` shell commands, and prevents session switching/forking. Arbitrary `bash` is never active.

The browser may attach only to an already-running, policy-matching Runner PTY. It cannot create a default pi process. Output, input, and resize bytes are forwarded unchanged. The extension emits an owner-only `agent_settled` signal so the Runner can update issue state without terminating the interactive CLI. Runner also stores a bounded owner-only PTY transcript plus its terminal dimensions; completed Sessions are replayed only when both strict transcript files are valid, Message reconstruction is not supported.

## External Capabilities

External systems are exposed as typed pi extension tools rather than shell access. Tools are allowlisted when policy is created but execute only when pi decides the current investigation needs that evidence:

- `configuration_read`: resolves every repository granted to the selected service, reads bounded configuration from frozen Git revisions, follows approved Nacos imports, and returns sanitized per-repository results.
- `database_read`: validates one bounded read-only SQL statement, searches the selected service repositories for datasource configuration, follows approved Nacos imports, requires exactly one resolved datasource, and executes through MySQL or DMS connectors.
- `node_project_command`: runs a fixed Node action in a pinned disposable container.
- `maven_project_command`: runs a fixed Maven action in a pinned disposable Java 8 container with an issue-isolated cache.
- `repository_status`: exposes only scoped local `git status` and `git diff` operations.

Nacos, MySQL, DMS, Node, and Maven containers use `--rm`, dropped capabilities, `no-new-privileges`, bounded timeouts, and narrow mounts. Build containers have no network and mount an ephemeral copy of one granted repository; build scripts never receive a writable mount of the managed worktree. No capability tool runs as a persistent service.

Configuration reads report repository/Nacos sources and missing targets separately. Nacos servers must be allowlisted. Database resolution fails explicitly when the selected service has no datasource or resolves more than one distinct datasource; pi must investigate the repository configuration rather than guessing. Temporary profiles and database password files are owner-only and removed after execution.

Database results are returned verbatim but bounded by row, field, string, and total byte limits. This exception applies only to query rows; configuration credentials, connection URLs, connector profiles, command arguments, and raw logs remain protected.

## Workspace Flow

A created issue binds exactly one service to one fixed environment. The Runner:

1. Resolves all repositories attached to the selected service.
2. Fetches repositories into a shared cache and creates issue-specific Git worktrees.
3. Freezes repository commits and writes the issue execution policy.
4. Creates or resumes one persistent pi session.
5. Starts the locked interactive pi CLI with the issue prompt.
6. Records the assistant response and workspace state after settlement.

Runs for one issue are serialized. Different issues can run concurrently. Git pushes, merge requests, and remote branch writes are not exposed to pi.

## Issue Status

Issue status describes workflow, while workspace status describes technical runtime state:

- `open`: waiting to start or reopened by a user;
- `in_progress`: Runner/pi is processing the current turn;
- `pending`: pi settled successfully and the result awaits human confirmation;
- `failed`: workspace preparation or the overall pi run failed;
- `resolved`: a human confirmed the issue is solved;
- `closed`: archived.

A successful settlement never marks an issue resolved automatically. Retry changes a failed issue back to `in_progress`; a new message also starts another processing turn. The underlying error remains in `issueWorkspaces.lastError` for failed runs.

## Network Boundary

The API and web client have no built-in authentication or authentication database. They bind to loopback only. Any remote exposure must terminate authentication in a local reverse proxy before forwarding to those listeners.

One shared code-server container mounts the managed workspace root. Per-issue URLs select a folder through the `folder` query parameter, and browser traffic is proxied through `/code-server/` for same-origin cookies and WebSockets.
