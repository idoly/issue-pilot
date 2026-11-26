import { DomainError } from "../domain/errors.ts";
import { createHash, randomUUID } from "node:crypto";
import { createIssue } from "../issues/create-command.ts";
import { IssueCreatedError } from "../issues/creation-receipt.ts";
import { parseIssueMetadataInput, parseRelatedIssueKeys, requireDevelopmentOwner, validateRelatedIssues } from "../issues/form-input.ts";
import { updateIssueRecord } from "../issues/edit.ts";
import { updateIssueRelations } from "../issues/relations.ts";
import { transitionIssue } from "../issues/status.ts";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { FastifyRequest } from "fastify";

import { errorCode } from "../diagnostics.ts";
import { readSnapshot, type DatabaseReader } from "../db/client.ts";
import { issueMetadataUpdatePrompt } from "../agent/prompts.ts";
import { issueSessionHistory, resetIssueSession } from "../agent/session-reset.ts";
import { agentSessions, environments, issueAttachments, issueCcRecipients, issuePins, issueRelations, issueRepositories, issues, issueWorkspaces, services, subjects } from "../db/schema.ts";
import { canWriteIssueCode, credentialOwnerSubject, relatedIssueUpdateRefusal, requiresDeveloperOwner } from "../domain/contracts.ts";
import { issueRepositoryWorkspaceNames } from "../workspace/git.ts";
import { classifyRepositoryState, hasRepositoryView, issueRoot, pathExists } from "../workspace/state.ts";
import { type PendingAttachment, readMultipartAttachment, removePendingAttachments, resolveSecureAttachmentFile, serializeAttachment } from "../workspace/attachments.ts";
import { participatingServices } from "../workspace/issue-services.ts";
import { choice, record, strings, text } from "../domain/input.ts";
import type { IssueDetail, IssueExecutionItem } from "./contracts.ts";
import { issueSummaryQuery, serializeIssueSummary, type IssueSummaryRow } from "./issue-summary.ts";
import {
  ensureCurrentSubject,
  authorizeWorkMode,
  issueEnvironmentKind,
  requireAdmin,
  requireCurrentUser,
  requireDeveloper,
  requireIssue,
  runIssueExclusive,
  serializePerson,
  type ApiRouteContext,
} from "./route-context.ts";

const MANUAL_ISSUE_STATUSES = ["open", "resolved"] as const;
const ISSUE_SCOPE_INPUT_FIELDS = ["serviceKey", "environmentKey", "type", "workMode", "relatedIssueKeys"] as const;

/** Version only the edited state; Agent progress must not invalidate a draft. */
function issueEditVersion(issue: typeof issues.$inferSelect, attachments: readonly { id: string }[], ccSubjects: readonly string[]): string {
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

async function readIssueInput(stateRoot: string, request: FastifyRequest): Promise<{ input: Record<string, unknown>; attachments: PendingAttachment[] }> {
  if (!request.isMultipart()) return { input: record(request.body), attachments: [] };
  const attachments: PendingAttachment[] = [];
  let issueField: unknown;
  try {
    for await (const part of request.parts()) {
      if (part.type === "file") attachments.push(await readMultipartAttachment(stateRoot, part));
      else if (part.fieldname === "issue") issueField = part.value;
    }
    return { input: record(JSON.parse(text(issueField, "issue", 100_000))), attachments };
  } catch (error) {
    const failure = error instanceof SyntaxError ? new DomainError("invalid_issue", "bad_request") : error;
    await removePendingAttachments(attachments, [failure]);
    throw failure;
  }
}

export function registerIssueRoutes(context: ApiRouteContext, now: () => Date = () => new Date()) {
  const { app, database, engine, stateRoot, workspaces, scopeTransitions, runScopeExclusive, events } = context;

  app.delete<{ Params: { key: string } }>("/api/issues/:key", async (request, reply) => {
    await requireAdmin(database, request);
    const issue = await requireIssue(database, request.params.key);
    await runScopeExclusive(async () => {
      await workspaces.deleteIssue(issue.id, async () => {
        await requireAdmin(database, request);
        await requireIssue(database, issue.key);
      });
    });
    return reply.code(204).send();
  });
  const serializeIssueSummaryRow = (row: IssueSummaryRow): IssueExecutionItem => serializeIssueSummary(row, engine.getRunState(row.issue.id));
  const readIssueSummary = async (issueId: string, reader?: DatabaseReader) => {
    const row = (await issueSummaryQuery(reader ?? database.db).where(eq(issues.id, issueId)))[0];
    if (!row) throw new DomainError("issue_not_found", "not_found");
    return serializeIssueSummaryRow(row);
  };
  app.get("/api/issues", async () => {
    // A single SQLite snapshot for the polled list, without large description columns.
    const rows = await issueSummaryQuery(database.db).orderBy(desc(issues.createdAt), desc(issues.key));
    return rows.map(serializeIssueSummaryRow);
  });

  app.get("/api/issue-pins", async (request, _reply) => {
    const subject = await ensureCurrentSubject(database, request);
    const pinned = await database.db
      .select({ key: issues.key })
      .from(issuePins)
      .innerJoin(issues, eq(issues.id, issuePins.issueId))
      .where(and(eq(issuePins.subject, subject), eq(issues.assigneeSubject, subject)))
      .orderBy(desc(issues.createdAt), desc(issues.key));
    return pinned.map(({ key }) => key);
  });

  app.put<{ Params: { key: string } }>("/api/issues/:key/pin", async (request, reply) => {
    const [issue, subject] = await Promise.all([requireIssue(database, request.params.key), ensureCurrentSubject(database, request)]);
    if (issue.assigneeSubject !== subject) throw new DomainError("issue_not_assigned_to_current_user", "conflict");
    await database.db.insert(issuePins).values({ subject, issueId: issue.id }).onConflictDoNothing();
    return reply.code(204).send();
  });

  app.delete<{ Params: { key: string } }>("/api/issues/:key/pin", async (request, reply) => {
    const [issue, subject] = await Promise.all([requireIssue(database, request.params.key), ensureCurrentSubject(database, request)]);
    await database.db.delete(issuePins).where(and(eq(issuePins.subject, subject), eq(issuePins.issueId, issue.id)));
    return reply.code(204).send();
  });

  // Staging files are temporary. After a committed operation, a failed cleanup is logged so the client
  // does not retry (and duplicate) work that already succeeded; on failure it joins the primary error.
  const removeStagedAttachments = async (request: FastifyRequest, pending: PendingAttachment[], failures: unknown[]): Promise<void> => {
    if (failures.length) return removePendingAttachments(pending, failures);
    await removePendingAttachments(pending).catch((error: unknown) => request.log.error({ code: errorCode(error) }, "attachment_staging_cleanup_failed"));
  };
  app.post("/api/issues", async (request, reply) => {
    await ensureCurrentSubject(database, request);
    const { input, attachments } = await readIssueInput(stateRoot, request);
    const { issue } = await createIssue(context, input, {
      authorize: (mode) => authorizeWorkMode(database, request, mode),
      attachments,
      now,
      onCleanupError: (error) => request.log.error({ code: errorCode(error) }, "attachment_staging_cleanup_failed"),
    });
    let summary: IssueExecutionItem;
    try {
      summary = await readIssueSummary(issue.id);
    } catch (cause) {
      throw new IssueCreatedError("issue_created_summary_unavailable", issue.key, { cause });
    }
    return reply.code(201).send(summary);
  });

  app.patch<{ Params: { key: string } }>("/api/issues/:key", async (request) => {
    await ensureCurrentSubject(database, request);
    const issue = await requireIssue(database, request.params.key);
    const { input, attachments: pendingAttachments } = await readIssueInput(stateRoot, request);
    const failures: unknown[] = [];
    try {
      const expectedEditVersion = input.expectedEditVersion;
      if (typeof expectedEditVersion !== "string" || !/^[0-9a-f]{64}$/.test(expectedEditVersion)) throw new DomainError("invalid_issue_edit_version", "bad_request");
      if (input.resetSession !== undefined && typeof input.resetSession !== "boolean") throw new DomainError("invalid_reset_session", "bad_request");
      // Saving and resetting in one reservation: the reset must not find a metadata round already queued.
      const resetSession = input.resetSession === true;
      if (resetSession) await requireDeveloper(database, request);
      const removedAttachmentIds = [...new Set(strings(input.removedAttachmentIds ?? [], "attachment_ids"))];
      if (ISSUE_SCOPE_INPUT_FIELDS.some((field) => Object.hasOwn(input, field))) throw new DomainError("issue_scope_update_not_allowed", "bad_request");
      return await runScopeExclusive(() =>
        runIssueExclusive(engine, [issue.id], async (reservation) => {
          const editor = await requireCurrentUser(database, request);
          const editorSubject = editor.subject;
          const currentIssue = await requireIssue(database, issue.key);
          const currentAttachments = await database.db.select().from(issueAttachments).where(eq(issueAttachments.issueId, issue.id));
          const recipients = await database.db.select({ subject: issueCcRecipients.subject }).from(issueCcRecipients).where(eq(issueCcRecipients.issueId, issue.id));
          if (
            expectedEditVersion !==
            issueEditVersion(
              currentIssue,
              currentAttachments,
              recipients.map(({ subject }) => subject),
            )
          )
            throw new DomainError("issue_edit_conflict", "conflict");
          if (resetSession) {
            await requireDeveloper(database, request);
            if (currentIssue.status === "resolved") throw new DomainError("resolved_issue_cannot_reset_session", "conflict");
          }
          const currentSession = resetSession ? (await issueSessionHistory(database.db, stateRoot, currentIssue))[0] : undefined;
          if (resetSession && !currentSession) throw new DomainError("agent_session_not_found", "conflict");
          const [[issueEnvironment], [issueService], issueValues] = await Promise.all([
            database.db.select({ key: environments.key, kind: environments.kind }).from(environments).where(eq(environments.id, currentIssue.environmentId)).limit(1),
            database.db.select({ key: services.key, name: services.name }).from(services).where(eq(services.id, currentIssue.serviceId)).limit(1),
            parseIssueMetadataInput(database.db, input),
          ]);
          if (!issueEnvironment || !issueService) throw new DomainError("issue_scope_not_found", "conflict");
          const removedAttachmentIdSet = new Set(removedAttachmentIds);
          const removedAttachments = currentAttachments.filter((attachment) => removedAttachmentIdSet.has(attachment.id));
          if (removedAttachments.length !== removedAttachmentIds.length) throw new DomainError("attachment_not_found", "not_found");
          if (requiresDeveloperOwner(issueEnvironment.kind))
            await requireDevelopmentOwner(database.db, credentialOwnerSubject({ assigneeSubject: issueValues.assigneeSubject, reporterSubject: currentIssue.reporterSubject }));
          const attachmentRoot = issueRoot(stateRoot, issue.key);
          await Promise.all(removedAttachments.map(({ objectKey, size }) => resolveSecureAttachmentFile(attachmentRoot, objectKey, size)));
          await reservation.closeSession(issue.id);
          const createdAttachments = await updateIssueRecord({
            database: database.db,
            stateRoot,
            issue,
            values: issueValues,
            editorSubject,
            removedAttachments,
            addedAttachments: pendingAttachments,
            persist: (save) =>
              resetSession ? resetIssueSession(database.db, stateRoot, currentIssue, editorSubject, currentSession!.sessionId, save).then(() => undefined) : database.db.transaction(save),
            onFinalizeError: (error) => request.log.error({ issueKey: issue.key, code: errorCode(error) }, "attachment_finalize_failed"),
          });
          const attachmentDtos = [...currentAttachments.filter((attachment) => !removedAttachmentIdSet.has(attachment.id)).map(serializeAttachment), ...createdAttachments];
          if (resetSession) {
            events.publish({ id: randomUUID(), issueId: issue.id, createdAt: new Date().toISOString(), event: { type: "session_reset" } });
          } else if (currentIssue.status !== "resolved" && canWriteIssueCode(editor, issueEnvironment.kind)) {
            reservation.enqueue(
              issue.id,
              issueMetadataUpdatePrompt({
                issue: { ...currentIssue, ...issueValues },
                service: issueService,
                environmentKey: issueEnvironment.key,
                attachments: attachmentDtos,
                attachmentPath: attachmentRoot,
              }),
            );
          }
          return readIssueSummary(issue.id);
        }),
      );
    } catch (error) {
      failures.push(error);
      throw error;
    } finally {
      await removeStagedAttachments(request, pendingAttachments, failures);
    }
  });

  app.put<{ Params: { key: string } }>("/api/issues/:key/related-issues", async (request, reply) => {
    await ensureCurrentSubject(database, request);
    const requestedKeys = parseRelatedIssueKeys(record(request.body));
    await runScopeExclusive(async () => {
      const issue = await requireIssue(database, request.params.key);
      const [existingRelations, requestedRows] = await Promise.all([
        database.db.select().from(issueRelations).where(eq(issueRelations.issueId, issue.id)),
        requestedKeys.length ? database.db.select({ id: issues.id, key: issues.key }).from(issues).where(inArray(issues.key, requestedKeys)) : [],
      ]);
      const reservationIds = [issue.id, ...existingRelations.map(({ relatedIssueId }) => relatedIssueId), ...requestedRows.map(({ id }) => id)];
      await runIssueExclusive(engine, reservationIds, async (reservation) => {
        const editor = await requireCurrentUser(database, request);
        const currentIssue = await requireIssue(database, issue.key);
        const [[workspace], currentRelations] = await Promise.all([
          database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, currentIssue.id)).limit(1),
          database.db
            .select({ relatedIssueId: issueRelations.relatedIssueId, key: issues.key })
            .from(issueRelations)
            .innerJoin(issues, eq(issues.id, issueRelations.relatedIssueId))
            .where(eq(issueRelations.issueId, currentIssue.id)),
        ]);
        // Detaching existing relations needs no rebuilt runtime view; additions still require one.
        const currentKeys = new Set(currentRelations.map(({ key }) => key));
        const onlyRemoves = requestedKeys.every((key) => currentKeys.has(key));
        const refusal = relatedIssueUpdateRefusal({ status: currentIssue.status, workspace }, { onlyRemoves });
        if (refusal) throw new DomainError(refusal, "conflict");
        if (requestedKeys.includes(currentIssue.key)) throw new DomainError("invalid_related_issues", "bad_request");
        const relatedIssues = await validateRelatedIssues(database.db, requestedKeys);
        const currentIds = currentRelations.map(({ relatedIssueId }) => relatedIssueId).sort();
        const requestedIds = relatedIssues.map(({ id }) => id).sort();
        if (currentIds.length === requestedIds.length && currentIds.every((id, index) => id === requestedIds[index])) return;
        const mayRunAgent = canWriteIssueCode(editor, await issueEnvironmentKind(database, currentIssue));
        await reservation.closeSession(currentIssue.id);
        await updateIssueRelations(database.db, currentIssue.id, currentIds, requestedIds);
        if (mayRunAgent) reservation.enqueue(currentIssue.id);
      });
    });
    return reply.code(204).send();
  });

  app.patch<{ Params: { key: string } }>("/api/issues/:key/status", async (request) => {
    await ensureCurrentSubject(database, request);
    const issue = await requireIssue(database, request.params.key);
    const targetStatus = choice(record(request.body).status, "status", MANUAL_ISSUE_STATUSES);
    if (targetStatus === "open") {
      const reopened = await workspaces.reopenIssue(issue.id, () => ensureCurrentSubject(database, request));
      return readIssueSummary(reopened.id);
    }
    return runIssueExclusive(engine, [issue.id], async (reservation) => {
      await ensureCurrentSubject(database, request);
      const currentIssue = await requireIssue(database, issue.key);
      if (currentIssue.status !== "pending") throw new DomainError("invalid_issue_status_transition", "conflict");
      await reservation.closeSession(issue.id);
      const updatedIssue = await transitionIssue(database.db, issue.id, { from: ["pending"], to: "resolved", resolvedAt: new Date() });
      if (!updatedIssue) throw new DomainError("invalid_issue_status_transition", "conflict");
      return readIssueSummary(updatedIssue.id);
    });
  });

  app.get<{ Params: { key: string } }>("/api/issues/:key", async (request, _reply) => {
    const { issue, summary, repositoryRows, attachmentRows, workspaceRows, ccRows, sessionRows, reporterRows, relatedIssueRows, scopeHistory, collaboratingServices } = await readSnapshot(
      database.db,
      async (reader) => {
        const issue = await requireIssue({ db: reader }, request.params.key);
        const [summary, repositoryRows, attachmentRows, workspaceRows, ccRows, sessionRows, reporterRows, relatedIssueRows, scopeHistory, collaboratingServices] = await Promise.all([
          readIssueSummary(issue.id, reader),
          reader.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id)),
          reader.select().from(issueAttachments).where(eq(issueAttachments.issueId, issue.id)),
          reader.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, issue.id)),
          reader.select({ person: subjects }).from(issueCcRecipients).innerJoin(subjects, eq(issueCcRecipients.subject, subjects.subject)).where(eq(issueCcRecipients.issueId, issue.id)),
          reader.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id)),
          reader.select().from(subjects).where(eq(subjects.subject, issue.reporterSubject)),
          issueSummaryQuery(reader)
            .innerJoin(issueRelations, eq(issueRelations.relatedIssueId, issues.id))
            .where(eq(issueRelations.issueId, issue.id))
            .orderBy(asc(issueRelations.createdAt), asc(issueRelations.relatedIssueId)),
          scopeTransitions.history(issue.id, reader),
          participatingServices(reader, issue),
        ]);
        return { issue, summary, repositoryRows, attachmentRows, workspaceRows, ccRows, sessionRows, reporterRows, relatedIssueRows, scopeHistory, collaboratingServices };
      },
    );
    const workspace = workspaceRows[0];
    // Every Issue owns exactly one Workspace. A missing row is storage damage, not a fresh workspace:
    // reporting it as not_created would offer a retry that can only fail with the same code.
    if (!workspace) throw new Error(`issue_workspace_missing:${issue.key}`);
    const sessionBinding = sessionRows[0];
    const reporter = reporterRows[0];
    const workspaceStatus = workspace.status;
    const sessionReady = sessionBinding ? await pathExists(sessionBinding.sessionFile) : false;
    const repositoryState = classifyRepositoryState(repositoryRows);
    let repositoryNames = new Map<string, string>();
    if (repositoryState !== "invalid") repositoryNames = issueRepositoryWorkspaceNames(repositoryRows);
    const sourceAvailable = Boolean(repositoryState !== "invalid" && hasRepositoryView(repositoryState, workspace) && (await pathExists(issueRoot(stateRoot, issue.key))));
    const detail: IssueDetail = {
      ...summary,
      editVersion: issueEditVersion(
        issue,
        attachmentRows,
        ccRows.map(({ person }) => person.subject),
      ),
      description: issue.description,
      repositories: repositoryRows.map((repository) => ({
        name: repositoryNames.get(repository.url) ?? "",
        url: repository.url,
        baseBranch: repository.baseBranch,
        workingBranch: repository.workingBranch,
      })),
      workingDirectory: issueRoot(stateRoot, issue.key),
      attachments: attachmentRows.map(serializeAttachment),
      collaboratingServices,
      relatedIssues: relatedIssueRows.map(serializeIssueSummaryRow),
      scopeTransitions: scopeHistory,
      workspace: {
        status: workspaceStatus,
        sourceAvailable,
        runtimeReady: workspace.runtimeReady,
        lastError: workspace.lastError,
        retryable:
          issue.status !== "resolved" && !summary.agentRunning && (workspaceStatus !== "ready" || !workspace.runtimeReady || (!sessionReady && ["open", "in_progress"].includes(issue.status))),
      },
      reporter: reporter ? serializePerson(reporter) : undefined,
      ccRecipients: ccRows.map(({ person }) => serializePerson(person)),
    };
    return detail;
  });
}
