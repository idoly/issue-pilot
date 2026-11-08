# AI Maintenance Reference

For coding agents and maintainers who need implementation contracts. Human-facing guides are in [the documentation index](../README.md).

## Reading order

1. Read the root [AGENTS.md](../../AGENTS.md) for authorization, data protection, design and verification rules.
2. Read [Architecture](ARCHITECTURE.md) for ownership and concurrency.
3. Read the relevant contract, then its current owning code and focused tests before changing behavior.

| Concern | Reference |
| --- | --- |
| Configuration, identity, models and credentials | [Configuration](CONFIGURATION.md) |
| Admission, scheduling, Pi, tools and sandbox | [Agent](AGENT.md) |
| Database, attachments, Git and recovery | [Storage](STORAGE.md) |
| HTTP, SSE, Web DTOs and inbound MCP | [Protocols](HTTP.md) |
| Host tools, deployment and operations | [Tools](../TOOLS.md), [Deployment](../DEPLOYMENT.md), [Runbook](../RUNBOOK.md) |
| Tests and dependency patches | [Development](../DEVELOPMENT.md), [Patches](../../patches/README.md), [Fixtures](../../tests/fixtures/README.md) |

## Interpretation

- These documents describe the current source tree, not proof that working-tree changes are deployed. Verify source, running process, dependencies, Web artifacts and host tools separately.
- Source links identify owners; they do not imply cross-medium atomicity, authorization or external-service guarantees.
- Preserve error meaning, cancellation, retry, idempotency, rollback/finalize, shutdown and secret projection. Do not turn failures into empty or successful results.
- Never use real application state as a fixture. Examples do not authorize mutations, migrations, live queries or restarts.
- Maintain host-native deployment only. Do not restore application container builds, remote CI, application-private skills/extensions, retired YAML projection or output publication layers.
- Maintain current guides without compatibility redirects, per-round reports or obsolete screenshot archives. Preserve the bounded [host migration record](../records/2026-11-07-host-migration.md) as retrospective evidence, not current instructions. This does not authorize deleting durable Issue history, immutable migrations, fixtures or operational recovery evidence.
