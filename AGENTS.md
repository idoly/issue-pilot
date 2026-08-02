# Issue Agent Project

This repository builds a browser-based engineering issue agent on top of pi.

## Operating Rules

- Treat Keycloak identity as the source of user identity in production. Never trust user or role headers supplied directly by a browser.
- Search for duplicate issues before creating a new one.
- Record material investigation findings and test evidence as issue comments.
- Do not mark an issue resolved until its acceptance criteria have been verified.
- Use the relevant skill before changing Java, React, database, browser-test, or code-server integration code.
- Never put access tokens, passwords, cookies, or connection strings in issues, comments, logs, or test snapshots.

## Commands

- `npm test`: run store unit tests
- `npm run typecheck`: type-check the pi package
- `pi -e ./src/extension.ts -a`: run pi with the issue extension during development

Issue data defaults to `.issue-agent/issues.json`. Set `ISSUE_AGENT_DATA_FILE` to override it.
