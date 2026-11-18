import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { issueRelations, issueWorkspaces, issues } from "../db/schema.ts";

/**
 * Replace an Issue's related-Issue set in one transaction. The caller owns authorization, the runnable-state
 * refusal and session closing; this owner owns the rows and the runtime invalidation that follows a change.
 */
export async function updateIssueRelations(database: Database, issueId: string, currentIds: readonly string[], requestedIds: readonly string[]): Promise<void> {
  const current = new Set(currentIds);
  const requested = new Set(requestedIds);
  const removed = [...current].filter((id) => !requested.has(id));
  const added = [...requested].filter((id) => !current.has(id));
  if (!removed.length && !added.length) return;
  await database.transaction(async (transaction) => {
    if (removed.length) await transaction.delete(issueRelations).where(and(eq(issueRelations.issueId, issueId), inArray(issueRelations.relatedIssueId, removed)));
    if (added.length) await transaction.insert(issueRelations).values(added.map((relatedIssueId) => ({ issueId, relatedIssueId })));
    const now = new Date();
    await transaction.update(issueWorkspaces).set({ runtimeReady: false, updatedAt: now }).where(eq(issueWorkspaces.issueId, issueId));
    await transaction.update(issues).set({ updatedAt: now }).where(eq(issues.id, issueId));
  });
}
