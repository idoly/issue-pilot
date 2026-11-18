import { eq } from "drizzle-orm";

import { OperationError } from "../operation-error.ts";
import type { Database } from "../db/client.ts";
import { issueCcRecipients, issues } from "../db/schema.ts";
import { issueRoot } from "../workspace/state.ts";
import {
  finalizeRetiredAttachments,
  insertPublishedAttachments,
  publishPendingAttachments,
  removeWrittenAttachments,
  retireAttachments,
  type PendingAttachment,
  type serializeAttachment,
} from "../workspace/attachments.ts";

type IssueRow = Pick<typeof issues.$inferSelect, "id" | "key">;
type AttachmentRow = Parameters<typeof retireAttachments>[2][number];
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type IssueAttachmentDto = ReturnType<typeof serializeAttachment>;

export interface UpdateIssueRecordInput {
  database: Database;
  stateRoot: string;
  issue: IssueRow;
  values: { title: string; description: string; priority: typeof issues.$inferSelect.priority; assigneeSubject: string | null; ccSubjects: string[] };
  editorSubject: string;
  removedAttachments: AttachmentRow[];
  addedAttachments: PendingAttachment[];
  /** Runs the metadata/attachment transaction, optionally wrapped by a session reset. */
  persist: (save: (transaction: Transaction) => Promise<void>) => Promise<void>;
  /** Cleanup after commit is best-effort; the record stays committed either way. */
  onFinalizeError?: (error: unknown) => void;
}

/**
 * Apply one Issue edit: publish staged attachments, write metadata, recipients and attachment records in the
 * caller's transaction, and remove only the originals written by this attempt when it fails.
 * Returns the attachments created by this edit; retained ones stay the caller's projection.
 */
export async function updateIssueRecord(input: UpdateIssueRecordInput): Promise<IssueAttachmentDto[]> {
  const { database, issue, values } = input;
  const attachmentRoot = issueRoot(input.stateRoot, issue.key);
  const writtenObjectKeys: string[] = [];
  let created: IssueAttachmentDto[] = [];
  try {
    const published = await publishPendingAttachments(input.stateRoot, issue.key, input.addedAttachments, writtenObjectKeys);
    await input.persist(async (transaction) => {
      await transaction
        .update(issues)
        .set({ title: values.title, description: values.description, priority: values.priority, assigneeSubject: values.assigneeSubject, updatedAt: new Date() })
        .where(eq(issues.id, issue.id));
      await transaction.delete(issueCcRecipients).where(eq(issueCcRecipients.issueId, issue.id));
      if (values.ccSubjects.length) await transaction.insert(issueCcRecipients).values(values.ccSubjects.map((subject) => ({ issueId: issue.id, subject })));
      await retireAttachments(transaction, issue.id, input.removedAttachments);
      created = await insertPublishedAttachments(transaction, issue.id, input.editorSubject, published);
    });
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    await removeWrittenAttachments(writtenObjectKeys).catch((rollbackError) => rollbackErrors.push(rollbackError));
    if (rollbackErrors.length) throw new OperationError("issue_update_rollback_failed", "unknown", { cause: new AggregateError([error, ...rollbackErrors], "issue_update_rollback_failed") });
    throw error;
  }
  // A committed retirement is never rolled back. The next successful edit retries any recorded cleanup failures.
  await finalizeRetiredAttachments(database, attachmentRoot, issue.id).catch((error: unknown) => input.onFinalizeError?.(error));
  return created;
}
