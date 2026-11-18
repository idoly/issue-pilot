import { sql } from "drizzle-orm";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { OperationError } from "../operation-error.ts";
import type { Database } from "../db/client.ts";
import { dingtalkIssueImports, issueCcRecipients, issueKeySequences, issueRelations, issueWorkspaces, issues } from "../db/schema.ts";
import type { IssuePriority, IssueType } from "../domain/contracts.ts";
import { claimIssueRoot, removeEmptyIssueRoot } from "../workspace/state.ts";
import { insertPublishedAttachments, publishPendingAttachments, removeWrittenAttachments, type PendingAttachment } from "../workspace/attachments.ts";

export type DingtalkImportClaim = Pick<typeof dingtalkIssueImports.$inferInsert, "baseId" | "tableId" | "recordId" | "sourceUrl">;

export interface NewIssueValues {
  title: string;
  description: string;
  priority: IssuePriority;
  type: IssueType;
  serviceId: string;
  environmentId: string;
  assigneeSubject: string | null;
  ccSubjects: string[];
}

export interface CreateIssueRecordInput {
  database: Database;
  stateRoot: string;
  /** Reserved by the caller so its Agent slot can be claimed before the record exists. */
  issueId: string;
  values: NewIssueValues;
  reporterSubject: string;
  relatedIssueIds: string[];
  attachments: PendingAttachment[];
  dingtalk?: DingtalkImportClaim;
  now?: Date;
}

const regionalDateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: issuePilotConfig.regional.timeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function regionalDateStamp(now: Date): string {
  const dateParts = new Map(regionalDateFormat.formatToParts(now).map((part) => [part.type, part.value]));
  return `${dateParts.get("year")}${dateParts.get("month")}${dateParts.get("day")}`;
}

/**
 * Persist one Issue: reserve its key, claim its root, publish staged attachments and commit every row.
 * A failure removes only what this attempt wrote; the key is never reused.
 */
export async function createIssueRecord(input: CreateIssueRecordInput): Promise<typeof issues.$inferSelect> {
  const { database, stateRoot, issueId, values } = input;
  const day = regionalDateStamp(input.now ?? new Date());
  // Reserve the number before touching the filesystem. A failed create may leave a gap, never a reusable key.
  const [next] = await database
    .insert(issueKeySequences)
    .values({ day, lastValue: 1 })
    .onConflictDoUpdate({ target: issueKeySequences.day, set: { lastValue: sql`${issueKeySequences.lastValue} + 1` } })
    .returning({ sequence: issueKeySequences.lastValue });
  const issueKey = `ISSUE-${day}-${String(next!.sequence).padStart(3, "0")}`;
  const writtenObjectKeys: string[] = [];
  await claimIssueRoot(stateRoot, issueKey);
  try {
    const publishedAttachments = await publishPendingAttachments(stateRoot, issueKey, input.attachments, writtenObjectKeys);
    return await database.transaction(async (transaction) => {
      const [insertedIssue] = await transaction
        .insert(issues)
        .values({
          id: issueId,
          key: issueKey,
          title: values.title,
          description: values.description,
          priority: values.priority,
          type: values.type,
          serviceId: values.serviceId,
          environmentId: values.environmentId,
          reporterSubject: input.reporterSubject,
          assigneeSubject: values.assigneeSubject,
        })
        .returning();
      if (values.ccSubjects.length) await transaction.insert(issueCcRecipients).values(values.ccSubjects.map((recipient) => ({ issueId: insertedIssue!.id, subject: recipient })));
      if (input.relatedIssueIds.length) await transaction.insert(issueRelations).values(input.relatedIssueIds.map((relatedIssueId) => ({ issueId: insertedIssue!.id, relatedIssueId })));
      await transaction.insert(issueWorkspaces).values({ issueId: insertedIssue!.id });
      if (input.dingtalk) await transaction.insert(dingtalkIssueImports).values({ ...input.dingtalk, issueId: insertedIssue!.id, importedBy: input.reporterSubject });
      await insertPublishedAttachments(transaction, insertedIssue!.id, input.reporterSubject, publishedAttachments);
      return insertedIssue!;
    });
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    await removeWrittenAttachments(writtenObjectKeys).catch((rollbackError) => rollbackErrors.push(rollbackError));
    await removeEmptyIssueRoot(stateRoot, issueKey).catch((rollbackError) => rollbackErrors.push(rollbackError));
    if (rollbackErrors.length) throw new OperationError("issue_state_rollback_failed", "unknown", { cause: new AggregateError([error, ...rollbackErrors], "issue_state_rollback_failed") });
    throw error;
  }
}
