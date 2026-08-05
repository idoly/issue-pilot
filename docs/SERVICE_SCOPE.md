# Service Repository Scope

Issue Pilot keeps scope configuration deliberately small. Users maintain services and the Git repositories that belong to each service. There is no configured service relationship graph, module catalog, or repository project path.

## Service Scope

A service contains:

- a name and description;
- one or more Git repositories, each marked as frontend or backend;
- zero or more environment deployment configurations.

Service type is intentionally not modeled. Frontend/backend is repository metadata, so one service may own both roles. Repository ownership and environment deployment are the only service-level execution inputs.

When an issue selects its service, Runner prepares every repository attached to that service. Each repository root is the code boundary.

## Access Rules

- Only the single service selected on the issue contributes repositories.
- No repository is added through configured service relationships or module expansion.
- Production and test issues always use the latest fetched baseline in detached, repository-read-only worktrees. They do not create issue branches.
- Development environments accept only `incident` and `request` issues. Incidents create `hotfix/<issue-key>` branches and requests create `feature/<issue-key>` branches with repository-root write access.
- Development `question` and `smart_analysis` submissions are rejected by the API.
- Build tools run against disposable repository copies and cannot mutate managed worktrees.
- Adding another codebase requires attaching its repository to an explicitly selected service.

Pi may inspect Maven POMs, npm workspace files, imports, configuration, and MQ annotations while investigating. Those findings are evidence only and never become persisted authorization rules.
