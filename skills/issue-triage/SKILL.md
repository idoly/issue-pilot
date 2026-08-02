---
name: issue-triage
summary: Triage incoming engineering and support work into actionable issues.
description: Searches for duplicates, assesses impact and urgency, creates or updates issues, and records a reproducible acceptance boundary. Use for bug reports, incidents, service requests, questions, and engineering tasks.
---

# Issue Triage

1. Restate the observed behavior, expected behavior, affected users, scope, and timing.
2. Search issues using stable symptoms, component names, and error text before creating anything.
3. If a likely duplicate exists, comment with the new evidence instead of creating another issue.
4. Choose type: `incident` for active service impact, `problem` for an underlying recurring cause, `request` for user demand, `question` for information, and `task` for planned engineering work.
5. Choose priority from evidence:
   - `p0`: active critical outage, destructive data loss, or severe exploitable security event.
   - `p1`: major degradation, many blocked users, or no practical workaround.
   - `p2`: normal impact with a workaround or limited scope.
   - `p3`: low urgency, cosmetic work, or backlog improvement.
6. Include reproduction steps, evidence, constraints, and testable acceptance criteria in the description.
7. Assign only when ownership is known. Never invent an owner.
8. Use comments for investigation evidence and decisions. Use field updates for lifecycle state.
9. Resolve only after verification; include the command, browser scenario, query, or observation used as evidence.
