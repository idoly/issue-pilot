---
name: java-engineering
summary: Implement and verify Java backend changes for tracked issues.
description: Diagnoses, changes, and tests Java or Spring backend code with attention to API contracts, security boundaries, transactions, and production behavior. Use for Java backend issues.
---

# Java Engineering

1. Read the issue and identify the affected module, runtime version, build tool, and acceptance criteria.
2. Inspect existing package structure and tests before choosing an implementation pattern.
3. For Spring applications, preserve controller-service-repository boundaries already used by the codebase.
4. Treat Keycloak claims as authenticated input but enforce authorization in the backend. Map stable subject IDs, not display names, to ownership records.
5. Define transaction boundaries in the service layer. Avoid remote calls while holding database transactions.
6. Preserve API compatibility unless the issue explicitly authorizes a breaking change.
7. Add focused unit tests and an integration test when changing persistence, security, serialization, or HTTP behavior.
8. Run the repository's formatter, targeted tests, and then the broader relevant test suite.
9. Comment on the issue with changed behavior and exact verification commands. Do not include secrets or raw tokens.
