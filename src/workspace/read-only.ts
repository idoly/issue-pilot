import { eq, inArray } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { agentSessions, environments, issues } from "../db/schema.ts";
import { IssueProjectManager } from "./project.ts";
import { prepareIssueRuntimeBatch, type RuntimePreparationResult } from "./runtime.ts";

export async function prepareReadOnlyIssueRuntimes(
  database: Database,
  stateRoot: string,
): Promise<RuntimePreparationResult> {
  const readOnlyIssues = await database.select({
    id: issues.id,
    key: issues.key,
    type: issues.type,
    serviceId: issues.serviceId,
    environmentId: issues.environmentId,
    environmentKind: environments.kind,
  }).from(issues)
    .innerJoin(environments, eq(environments.id, issues.environmentId))
    .innerJoin(agentSessions, eq(agentSessions.issueId, issues.id))
    .where(inArray(environments.kind, ["prod", "test"]));
  const project = new IssueProjectManager(database, stateRoot);
  return prepareIssueRuntimeBatch(
    database,
    readOnlyIssues,
    (issue) => project.hydrateReadOnlyRuntime(issue, issue.environmentKind as "prod" | "test"),
  );
}
