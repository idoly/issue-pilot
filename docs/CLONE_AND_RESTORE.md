# Clone and restore

This document separates reproducible source setup from recovery of sensitive runtime state.

## Reproducible source checkout

Prerequisites:

- Linux or WSL2
- Node.js 24
- npm 12
- Git
- rootless Podman 5 for PostgreSQL, Keycloak, and code-server
- pi coding agent 0.83 or a compatible newer version

Clone and verify the source tree:

```bash
git clone https://github.com/idoly/issue-pilot.git
cd issue-pilot
./infra/verify-clone.sh
```

The web application uses the published package `@idoly/ant-design-solid@0.2.4`. A sibling checkout under `/home/idoly` is not required.

Prepare local infrastructure with unique local secrets:

```bash
cp infra/.env.example infra/.env
chmod 600 infra/.env
# Replace every change-me value before starting containers.
./infra/podman-stack.sh start
DATABASE_URL='postgres://issue_agent:<local-password>@127.0.0.1:5432/issue_agent' npm run db:migrate
```

A clean database does not contain a Keycloak realm, organization, business user, service repository, or issue history. Those are runtime state, not source fixtures.

## Exact runtime recovery

Exact recovery requires all of the following from one consistent backup window:

- Issue Pilot PostgreSQL dump
- Keycloak PostgreSQL dump
- `.issue-agent` sessions, attachments, repositories, worktrees, and runtime state
- pi provider configuration
- container environment file
- source commit manifest and checksums

These artifacts contain user records, password hashes, provider credentials, repository contents, issue attachments, and uncommitted issue fixes. Do not commit a newly generated snapshot to GitHub. Generate the encrypted GPG archive described in [DEPLOYMENT_AND_RECOVERY.md](DEPLOYMENT_AND_RECOVERY.md), transfer it through an approved secret-storage channel, and restore it only on an authorized machine.

The historical `recovery/current/` directory is already present in repository history. It must be treated as production-secret material. It is not automatically refreshed by source commits and must not be assumed to represent the current live database.

## Acceptance checks

A source checkout is reproducible when `infra/verify-clone.sh` passes in a clean clone.

A runtime restore is complete only after all checks below pass:

- PostgreSQL and Keycloak are healthy.
- Drizzle migrations are current.
- Browser PKCE login succeeds.
- Environment, service, module, issue, and relationship counts match the encrypted backup manifest.
- pi session files exist and their database bindings resolve to managed paths.
- issue worktrees retain their expected branch and dirty state.
- code-server SCM sees the expected repository changes.
- the browser terminal and code-server terminal attach to the same persistent pi PTY.
- no credentials appear in application logs or issue comments.
