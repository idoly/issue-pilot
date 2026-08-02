---
name: code-server-workspace
summary: Open and operate isolated code-server workspaces for issue implementation.
description: Prepares a code-server workspace tied to an issue, checks repository state, runs development commands, and records reproducible workspace context. Use when implementing an issue through code-server.
---

# Code-server Workspace

1. Resolve the issue ID to an approved repository and workspace path through the platform API. Never accept an arbitrary filesystem path from browser input.
2. Create or reuse an isolated branch/worktree named from the issue ID according to repository conventions.
3. Confirm the repository, branch, dirty state, runtime versions, and issue acceptance criteria before editing.
4. Pass identity through the platform gateway. Do not put Keycloak tokens in code-server URLs, shell history, workspace files, or environment dumps.
5. Restrict workspace commands and network access according to the deployment sandbox policy.
6. Use existing project scripts for install, format, test, and development server startup.
7. Preserve user changes. Never reset or discard an existing dirty worktree without explicit approval.
8. Record branch, commit, tests, and preview URL as sanitized issue comments. The preview URL must be access-controlled.
9. Stop or expire idle workspaces according to retention policy after work is complete.
