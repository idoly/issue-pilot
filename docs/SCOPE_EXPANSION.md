# Scope Expansion

Issue Pilot starts with services and modules explicitly selected on an issue. The runner may expand that scope through configured service relationships so pi can inspect required dependencies without granting unrelated repositories.

A service relationship has a source service, target service, and relation type. Optional relation-module rows narrow the target to specific modules. If no modules are configured for a permitted target, the whole target service is available.

Expansion is constrained by the issue environment:

- A related service is usable only when it has a deployment in the same environment.
- Its repository uses the base branch recorded by that deployment.
- Evidence tools receive only capabilities recorded for that deployment.
- Repository paths and base commits are frozen into the per-issue capability file.

The web API exposes scope candidates separately from the issue's explicit service bindings. This lets users see dependency context without silently changing issue ownership or primary service selection.
