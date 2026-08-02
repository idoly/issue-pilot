---
name: database-engineering
summary: Design, query, migrate, and verify relational database changes for tracked issues.
description: Handles PostgreSQL and relational database investigations, schema migrations, query correctness, concurrency, indexing, and rollback planning. Use for database-related incidents and engineering work.
---

# Database Engineering

1. Identify the database engine/version, schema ownership, data volume, query path, and consistency requirement.
2. Reproduce with sanitized data and inspect the actual query plan before proposing an index.
3. Make migrations forward-compatible with rolling deployments. Separate destructive cleanup from additive schema changes.
4. Use constraints for durable invariants and application validation for actionable user feedback.
5. Consider lock duration, table rewrites, transaction isolation, retries, idempotency, and concurrent writers.
6. Parameterize queries. Never place credentials or production row data in an issue.
7. Provide rollback or roll-forward steps and state whether data transformation is reversible.
8. Test migration from the previous schema, fresh schema creation, and relevant query behavior.
9. Record sanitized plans, row counts, timings, and verification queries in the issue comment.
