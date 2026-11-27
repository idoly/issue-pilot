import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AgentReservation } from "../agent/contracts.ts";
import type { AgentEventBus } from "../agent/events.ts";
import { issueMetadataUpdatePrompt } from "../agent/prompts.ts";
import { issueSessionHistory, resetIssueSession } from "../agent/session-reset.ts";
import type { Database } from "../db/client.ts";
import { environments, issueAttachments, issueCcRecipients, type issues, services, type subjects } from "../db/schema.ts";
import { canWriteIssueCode, credentialOwnerSubject, requiresDeveloperOwner } from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import { strings } from "../domain/input.ts";
import { OperationError } from "../operation-error.ts";
import { type PendingAttachment, resolveSecureAttachmentFile, serializeAttachment } from "../workspace/attachments.ts";
import { issueRoot } from "../workspace/state.ts";
import { updateIssueRecord } from "./edit.ts";
import { parseIssueMetadataInput, requireDevelopmentOwner } from "./form-input.ts";

type Issue = typeof issues.$inferSelect;

/** Version only the edited state; Agent progress must not invalidate a draft. */
export function issueEditVersion(issue: Issue, attachments: readonly { id: string }[], ccSubjects: readonly string[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        issue.id,
        issue.title,
        issue.description,
        issue.priority,
        issue.assigneeSubject,
        issue.serviceId,
        issue.environmentId,
        issue.type,
        attachments.map(({ id }) => id).sort(),
        [...ccSubjects].sort(),
      ]),
    )
    .digest("hex");
}

/** Reset replaces the bound file. Appending a message changes neither this token nor the metadata version. */
export function sessionBindingVersion(issueId: string, file: string): string {
  return createHash("sha256")
    .update(JSON.stringify([issueId, file]))
    .digest("hex");
}

function version(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new DomainError(code, "bad_request");
  return value;
}

export function parseIssueEdit(input: Record<string, unknown>) {
  const expectedEditVersion = version(input.expectedEditVersion, "invalid_issue_edit_version");
  if (input.resetSession !== undefined && typeof input.resetSession !== "boolean") throw new DomainError("invalid_reset_session", "bad_request");
  const expectedResetVersion = input.resetSession === true ? version(input.expectedResetVersion, "invalid_reset_version") : undefined;
  const removedIds = new Set(strings(input.removedAttachmentIds ?? [], "attachment_ids"));
  if (["serviceKey", "environmentKey", "type", "workMode", "relatedIssueKeys"].some((field) => Object.hasOwn(input, field))) throw new DomainError("issue_scope_update_not_allowed", "bad_request");
  return { input, expectedEditVersion, expectedResetVersion, removedIds };
}

/** The caller holds the scope and Issue reservation and has reauthorized the editor (developer for reset). */
export async function applyIssueEdit({
  database,
  stateRoot,
  reservation,
  events,
  issue,
  editor,
  edit,
  uploads,
  onFinalizeError,
}: {
  database: Database;
  stateRoot: string;
  reservation: AgentReservation;
  events: AgentEventBus;
  issue: Issue;
  editor: typeof subjects.$inferSelect;
  edit: ReturnType<typeof parseIssueEdit>;
  uploads: PendingAttachment[];
  onFinalizeError: (error: unknown) => void;
}): Promise<void> {
  const attachments = await database.select().from(issueAttachments).where(eq(issueAttachments.issueId, issue.id));
  const recipients = await database.select({ subject: issueCcRecipients.subject }).from(issueCcRecipients).where(eq(issueCcRecipients.issueId, issue.id));
  if (
    edit.expectedEditVersion !==
    issueEditVersion(
      issue,
      attachments,
      recipients.map(({ subject }) => subject),
    )
  )
    throw new DomainError("issue_edit_conflict", "conflict");
  if (edit.expectedResetVersion && issue.status === "resolved") throw new DomainError("resolved_issue_cannot_reset_session", "conflict");
  const currentSession = edit.expectedResetVersion ? (await issueSessionHistory(database, stateRoot, issue))[0] : undefined;
  if (edit.expectedResetVersion) {
    if (!currentSession) throw new DomainError("agent_session_not_found", "conflict");
    if (sessionBindingVersion(issue.id, currentSession.file) !== edit.expectedResetVersion) throw new DomainError("agent_session_changed", "conflict");
  }
  const [[environment], [service], values] = await Promise.all([
    database.select({ key: environments.key, kind: environments.kind }).from(environments).where(eq(environments.id, issue.environmentId)).limit(1),
    database.select({ key: services.key, name: services.name }).from(services).where(eq(services.id, issue.serviceId)).limit(1),
    parseIssueMetadataInput(database, edit.input),
  ]);
  if (!environment || !service) throw new DomainError("issue_scope_not_found", "conflict");
  if (requiresDeveloperOwner(environment.kind)) await requireDevelopmentOwner(database, credentialOwnerSubject({ assigneeSubject: values.assigneeSubject, reporterSubject: issue.reporterSubject }));
  const removed = attachments.filter(({ id }) => edit.removedIds.has(id));
  if (removed.length !== edit.removedIds.size) throw new DomainError("attachment_not_found", "not_found");
  const root = issueRoot(stateRoot, issue.key);
  await Promise.all(removed.map(({ objectKey, size }) => resolveSecureAttachmentFile(root, objectKey, size)));
  await reservation.closeSession(issue.id);
  const created = await updateIssueRecord({
    database,
    stateRoot,
    issue,
    values,
    editorSubject: editor.subject,
    removedAttachments: removed,
    addedAttachments: uploads,
    persist: (save) => (currentSession ? resetIssueSession(database, stateRoot, issue, editor.subject, currentSession.sessionId, save).then(() => undefined) : database.transaction(save)),
    onFinalizeError,
  });
  // Metadata, attachment rows and the optional session binding have committed. Never re-run the edit to notify observers or schedule work.
  if (currentSession) {
    try {
      events.publish({ id: randomUUID(), issueId: issue.id, createdAt: new Date().toISOString(), event: { type: "session_reset" } });
    } catch (cause) {
      throw new OperationError("issue_edit_reset_notification_failed", "committed", { cause });
    }
  } else if (issue.status !== "resolved" && canWriteIssueCode(editor, environment.kind)) {
    try {
      reservation.enqueue(
        issue.id,
        issueMetadataUpdatePrompt({
          issue: { ...issue, ...values },
          service,
          environmentKey: environment.key,
          attachments: [...attachments.filter(({ id }) => !edit.removedIds.has(id)).map(serializeAttachment), ...created],
          attachmentPath: root,
        }),
      );
    } catch (cause) {
      throw new OperationError("issue_edit_enqueue_unconfirmed", "committed", { cause });
    }
  }
}
