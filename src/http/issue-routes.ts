import { DomainError } from "../domain/errors.ts";
import { OperationError } from "../operation-error.ts";
import { createIssue } from "../issues/create-command.ts";
import { IssueCreatedError } from "../issues/creation-receipt.ts";
import { parseRelatedIssueKeys, validateRelatedIssues } from "../issues/form-input.ts";
import { applyIssueEdit, issueEditVersion, parseIssueEdit, sessionBindingVersion } from "../issues/edit-command.ts";
import { updateIssueRelations } from "../issues/relations.ts";
import { transitionIssue } from "../issues/status.ts";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { FastifyRequest } from "fastify";

import { errorCode } from "../diagnostics.ts";
import { readSnapshot, type DatabaseReader } from "../db/client.ts";
import { agentSessions, issueAttachments, issueCcRecipients, issuePins, issueRelations, issueRepositories, issues, issueWorkspaces, subjects } from "../db/schema.ts";
import { canWriteIssueCode, relatedIssueUpdateRefusal } from "../domain/contracts.ts";
import { issueRepositoryWorkspaceNames } from "../workspace/git.ts";
import { classifyRepositoryState, hasRepositoryView, issueRoot, pathExists } from "../workspace/state.ts";
import { type PendingAttachment, readMultipartAttachment, removePendingAttachments, serializeAttachment } from "../workspace/attachments.ts";
import { participatingServices } from "../workspace/issue-services.ts";
import { choice, record, text } from "../domain/input.ts";
import type { IssueDetail, IssueExecutionItem } from "./contracts.ts";
import { issueSummaryQuery, serializeIssueSummary, type IssueSummaryRow } from "./issue-summary.ts";
import {
  ensureCurrentSubject,
  authorizeWorkMode,
  issueEnvironmentKind,
  requireAdmin,
  requireCurrentUser,
  requireDeveloper,
  requireDeveloperUser,
  requireIssue,
  runIssueExclusive,
  serializePerson,
  type ApiRouteContext,
} from "./route-context.ts";

const MANUAL_ISSUE_STATUSES = ["open", "resolved"] as const;

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
      const edit = parseIssueEdit(input);
      if (edit.expectedResetVersion) await requireDeveloper(database, request);
      return await runScopeExclusive(() =>
        runIssueExclusive(engine, [issue.id], async (reservation) => {
          const editor = edit.expectedResetVersion ? await requireDeveloperUser(database, request) : await requireCurrentUser(database, request);
          const currentIssue = await requireIssue(database, issue.key);
          await applyIssueEdit({
            database: database.db,
            stateRoot,
            reservation,
            events,
            issue: currentIssue,
            editor,
            edit,
            uploads: pendingAttachments,
            onFinalizeError: (error) => request.log.error({ issueKey: issue.key, code: errorCode(error) }, "attachment_finalize_failed"),
          });
          try {
            return await readIssueSummary(issue.id);
          } catch (cause) {
            throw new OperationError("issue_edit_summary_unavailable", "committed", { cause });
          }
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
      ...(sessionBinding ? { resetVersion: sessionBindingVersion(issue.id, sessionBinding.sessionFile) } : {}),
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
