import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { issues } from "../db/schema.ts";
import type { IssueStatus } from "../domain/contracts.ts";

type StatusWriter = Pick<Database, "update">;

export interface IssueStatusTransition {
  /** Statuses this call may move from; the caller states its own guard rather than a global table. */
  from: readonly IssueStatus[];
  to: IssueStatus;
  /** Set to clear or stamp the resolution time; omit to leave it untouched. */
  resolvedAt?: Date | null;
  updatedAt?: Date;
}

/**
 * The one Issue status write. Returns undefined when the current status is outside `from`, so each
 * caller keeps its own stable error code; `resolvedAt` is only written when the caller states it.
 */
export async function transitionIssue(writer: StatusWriter, issueId: string, transition: IssueStatusTransition): Promise<typeof issues.$inferSelect | undefined> {
  const [updated] = await writer
    .update(issues)
    .set({
      status: transition.to,
      updatedAt: transition.updatedAt ?? new Date(),
      ...(transition.resolvedAt !== undefined ? { resolvedAt: transition.resolvedAt } : {}),
    })
    .where(and(eq(issues.id, issueId), inArray(issues.status, [...transition.from])))
    .returning();
  return updated;
}
