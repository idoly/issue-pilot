# Current recovery snapshot

This directory intentionally contains sensitive production-like recovery data for the private Issue Pilot repository.

It includes:

- `issue_agent.dump`: complete Issue Pilot PostgreSQL database.
- `keycloak.dump`: complete Keycloak database, including realm, users, password hashes, organization membership, and OIDC client configuration.
- `issue-agent-state.tar.gz`: `.issue-agent` state including pi sessions, attachments, repositories, workspaces, and runtime secrets; PostgreSQL physical files are excluded.
- `pi-agent-config.tar.gz`: Pi provider authentication, models, and settings.
- `infra.env`: current PostgreSQL, Keycloak, API, and code-server environment values.
- `manifest.txt`: source/runtime versions and expected row counts.
- `keycloak-baseline.json`: non-secret Keycloak acceptance baseline.
- `SHA256SUMS`: integrity checksums.

Anyone who can read this private repository can obtain application credentials and authentication data. Repository access must therefore be treated as production secret access.

SSH private keys are not included. A new server must be provisioned with GitHub access before cloning this private repository.

Restore by following [`docs/DEPLOYMENT_AND_RECOVERY.md`](../../docs/DEPLOYMENT_AND_RECOVERY.md).
