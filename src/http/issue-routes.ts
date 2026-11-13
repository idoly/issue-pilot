import { OperationError } from "../operation-error.ts";
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { errorCode } from "../diagnostics.ts";
import { readSnapshot, type DatabaseReader } from "../db/client.ts";
import { issueMetadataUpdatePrompt } from "../agent/prompts.ts";
import { issueSessionHistory, resetIssueSession } from "../agent/session-reset.ts";
import {
  agentSessions,
  dingtalkIssueImports,
  environments,
  issueAttachments,
  issueCcRecipients,
  issueComments,
  issueKeySequences,
  issuePins,
  issueRelations,
  issueRepositories,
  issues,
  issueWorkspaces,
  serviceDeployments,
  services,
  subjects,
} from "../db/schema.ts";
import { credentialOwnerSubject, ISSUE_PRIORITIES, ISSUE_WORK_MODES, issueScopeForWorkMode, parseIssueKey, type EnvironmentKind, type IssueWorkMode } from "../domain/contracts.ts";
import { issueRepositoryWorkspaceNames } from "../workspace/git.ts";
import { IssueDeletionRefusal, WorkspaceRestoreRefusal } from "../workspace/lifecycle.ts";
import { claimIssueRoot, classifyRepositoryState, hasRepositoryView, issueRoot, pathExists, removeEmptyIssueRoot } from "../workspace/state.ts";
import {
  finalizeRetiredAttachments,
  type PendingAttachment,
  readMultipartAttachment,
  removePendingAttachments,
  removeWrittenAttachments,
  resolveSecureAttachmentFile,
  retireAttachments,
  serializeAttachment,
  publishPendingAttachments,
  insertPublishedAttachments,
} from "./attachment-store.ts";
import { participatingServices } from "../workspace/issue-services.ts";
import { ApiError, choice, optionalText, record, strings, text } from "./input.ts";
import { issueRevision } from "./issue-revision.ts";
import { ensureCurrentSubject, authorizeWorkMode, requireAdmin, requireDeveloper, requireIssue, runIssueExclusive, serializePerson, throwRefusal, type ApiRouteContext } from "./route-context.ts";

const MANUAL_ISSUE_STATUSES = ["open", "resolved"] as const;
const ISSUE_SCOPE_INPUT_FIELDS = ["serviceKey", "environmentKey", "type", "workMode", "relatedIssueKeys"] as const;

/** Version only the edited state; Agent progress and new comments must not invalidate a draft. */
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

function isoDate(value: Date | null | undefined): string | undefined {
  return value?.toISOString();
}

const regionalDateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: issuePilotConfig.regional.timeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function regionalDateStamp(now = new Date()): string {
  const dateParts = new Map(regionalDateFormat.formatToParts(now).map((part) => [part.type, part.value]));
  return `${dateParts.get("year")}${dateParts.get("month")}${dateParts.get("day")}`;
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
    const failure = error instanceof SyntaxError ? new ApiError(400, "invalid_issue") : error;
    await removePendingAttachments(attachments, [failure]);
    throw failure;
  }
}

export type DingtalkImportClaim = Pick<typeof dingtalkIssueImports.$inferInsert, "baseId" | "tableId" | "recordId" | "sourceUrl">;
export type IssueCreator = ReturnType<typeof registerIssueRoutes>["createIssue"];
export type IssueCreationScopeResolver = ReturnType<typeof registerIssueRoutes>["resolveCreationScope"];

export function registerIssueRoutes(context: ApiRouteContext) {
  const { app, database, engine, stateRoot, workspaces, scopeTransitions, runScopeExclusive, events } = context;

  app.delete<{ Params: { key: string } }>("/api/issues/:key", async (request, reply) => {
    await requireAdmin(database, request);
    const issue = await requireIssue(database, request.params.key);
    await runScopeExclusive(async () => {
      try {
        await workspaces.deleteIssue(issue.id, async () => {
          await requireAdmin(database, request);
          await requireIssue(database, issue.key);
        });
      } catch (error) {
        if (error instanceof IssueDeletionRefusal) throwRefusal(error);
        throw error;
      }
    });
    return reply.code(204).send();
  });
  const findEnvironmentByKind = async (kind: EnvironmentKind) => (await database.db.select().from(environments).where(eq(environments.kind, kind)).limit(1))[0];
  const findServiceDeployment = async (key: string, environmentId: string) =>
    (
      await database.db
        .select({ service: services, deployment: serviceDeployments })
        .from(services)
        .innerJoin(serviceDeployments, and(eq(serviceDeployments.serviceId, services.id), eq(serviceDeployments.environmentId, environmentId)))
        .where(eq(services.key, key))
        .limit(1)
    )[0];
  const validateSubjects = async (subjectValues: Array<string | null>): Promise<void> => {
    const requestedSubjects = [...new Set(subjectValues.filter((value): value is string => Boolean(value)))];
    if (!requestedSubjects.length) return;
    const matchingSubjects = await database.db
      .select({ subject: subjects.subject })
      .from(subjects)
      .where(and(inArray(subjects.subject, requestedSubjects), eq(subjects.active, true)));
    if (matchingSubjects.length !== requestedSubjects.length) throw new ApiError(400, "invalid_subject");
  };
  // Development credentials belong to the owner (assignee, else reporter), who must be an active developer.
  const requireDevelopmentOwner = async (subject: string): Promise<void> => {
    const [owner] = await database.db.select({ role: subjects.role, active: subjects.active }).from(subjects).where(eq(subjects.subject, subject)).limit(1);
    if (owner?.role !== "developer" || !owner.active) throw new ApiError(400, "issue_developer_owner_required");
  };
  const parseIssueMetadataInput = async (input: Record<string, unknown>) => {
    const assigneeSubject = optionalText(input.assigneeSubject, 255);
    const ccSubjects = [...new Set(strings(input.ccSubjects ?? [], "cc_subjects"))];
    await validateSubjects([assigneeSubject, ...ccSubjects]);
    return {
      title: text(input.title, "title", 300),
      description: optionalText(input.description) ?? "",
      priority: choice(input.priority, "priority", ISSUE_PRIORITIES),
      assigneeSubject,
      ccSubjects,
    };
  };
  const resolveCreationScope = async (workMode: IssueWorkMode, serviceKey: string) => {
    const scope = issueScopeForWorkMode(workMode);
    const environment = await findEnvironmentByKind(scope.environmentKind);
    if (!environment) throw new ApiError(400, "invalid_work_mode");
    const serviceDeployment = await findServiceDeployment(serviceKey, environment.id);
    if (!serviceDeployment) throw new ApiError(400, "invalid_service_for_work_mode");
    return { type: scope.issueType, environment, serviceId: serviceDeployment.service.id, service: { key: serviceDeployment.service.key, name: serviceDeployment.service.name } };
  };
  const parseCreateIssueInput = async (input: Record<string, unknown>) => {
    if (Object.hasOwn(input, "environmentKey") || Object.hasOwn(input, "type")) throw new ApiError(400, "issue_create_scope_contract_invalid");
    const workMode = choice(input.workMode, "work_mode", ISSUE_WORK_MODES);
    return {
      ...(await parseIssueMetadataInput(input)),
      workMode,
      ...(await resolveCreationScope(workMode, text(input.serviceKey, "service_key", 100))),
    };
  };
  const parseRelatedIssueKeys = (input: Record<string, unknown>) => {
    const rawKeys = strings(input.relatedIssueKeys ?? [], "related_issue_keys");
    if (rawKeys.length > issuePilotConfig.limits.relatedIssues) throw new ApiError(400, "related_issue_limit_exceeded");
    const keys = [...new Set(rawKeys.map((key) => parseIssueKey(key.trim())).filter((key): key is string => Boolean(key)))];
    if (keys.length !== rawKeys.length) throw new ApiError(400, "invalid_related_issues");
    return keys;
  };
  const validateRelatedIssues = async (keys: string[]) => {
    if (!keys.length) return [];
    const relatedRows = await database.db.select().from(issues).where(inArray(issues.key, keys));
    const byKey = new Map(relatedRows.map((issue) => [issue.key, issue]));
    if (byKey.size !== keys.length) throw new ApiError(400, "invalid_related_issues");
    return keys.map((key) => byKey.get(key)!);
  };
  const parseRelatedIssues = (input: Record<string, unknown>) => validateRelatedIssues(parseRelatedIssueKeys(input));
  const serviceSummary = { key: services.key, name: services.name };
  const issueSummaryQuery = (reader: DatabaseReader = database.db) =>
    reader
      .select({
        issue: {
          id: issues.id,
          key: issues.key,
          title: issues.title,
          priority: issues.priority,
          type: issues.type,
          status: issues.status,
          assigneeSubject: issues.assigneeSubject,
          resolvedAt: issues.resolvedAt,
          createdAt: issues.createdAt,
          updatedAt: issues.updatedAt,
        },
        assignee: subjects.displayName,
        service: serviceSummary,
        environmentKey: environments.key,
        workspaceStatus: issueWorkspaces.status,
        workspaceUpdatedAt: issueWorkspaces.updatedAt,
        workspaceRuntimeReady: issueWorkspaces.runtimeReady,
        workspaceReleasedAt: issueWorkspaces.releasedAt,
        workspaceLastError: issueWorkspaces.lastError,
      })
      .from(issues)
      .leftJoin(subjects, eq(subjects.subject, issues.assigneeSubject))
      .leftJoin(services, eq(services.id, issues.serviceId))
      .leftJoin(environments, eq(environments.id, issues.environmentId))
      .leftJoin(issueWorkspaces, eq(issueWorkspaces.issueId, issues.id));
  type IssueSummaryRow = Awaited<ReturnType<typeof issueSummaryQuery>>[number];
  const serializeIssueSummaryRow = ({
    issue,
    assignee,
    service,
    environmentKey,
    workspaceStatus,
    workspaceUpdatedAt,
    workspaceRuntimeReady,
    workspaceReleasedAt,
    workspaceLastError,
  }: IssueSummaryRow) => {
    if (!service) throw new Error("issue_service_not_found");
    if (environmentKey === null) throw new Error("issue_environment_not_found");
    const runState = engine.getRunState(issue.id);
    return {
      id: issue.key,
      title: issue.title,
      priority: issue.priority,
      type: issue.type,
      status: issue.status,
      assignee,
      assigneeSubject: issue.assigneeSubject,
      service,
      environmentKey,
      // The detail projection already treats an absent Workspace row as not created; summaries agree.
      workspaceStatus: workspaceStatus ?? "not_created",
      agentRunning: runState !== "idle",
      revision: issueRevision({
        issue,
        service,
        environmentKey,
        assignee,
        workspace: {
          status: workspaceStatus,
          updatedAt: workspaceUpdatedAt,
          runtimeReady: workspaceRuntimeReady,
          releasedAt: workspaceReleasedAt,
          lastError: workspaceLastError,
        },
        runState,
      }),
      resolvedAt: isoDate(issue.resolvedAt) ?? null,
      createdAt: isoDate(issue.createdAt),
      updatedAt: issue.updatedAt.toISOString(),
    };
  };
  const readIssueSummary = async (issueId: string, reader?: DatabaseReader) => {
    const row = (await issueSummaryQuery(reader).where(eq(issues.id, issueId)))[0];
    if (!row) throw new ApiError(404, "issue_not_found");
    return serializeIssueSummaryRow(row);
  };
  app.get("/api/issues", async () => {
    // A single SQLite snapshot for the polled list, without large description columns.
    const rows = await issueSummaryQuery().orderBy(desc(issues.createdAt), desc(issues.key));
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
    if (issue.assigneeSubject !== subject) throw new ApiError(409, "issue_not_assigned_to_current_user");
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
  const createIssue = async (
    input: Record<string, unknown>,
    request: FastifyRequest,
    initialAttachments: PendingAttachment[] = [],
    options: { dingtalk?: DingtalkImportClaim; startAgent?: boolean; signal?: AbortSignal } = {},
  ) => {
    const failures: unknown[] = [];
    try {
      const reporterSubject = await authorizeWorkMode(database, request, choice(input.workMode, "work_mode", ISSUE_WORK_MODES));
      let created = true;
      const createdIssue = await runScopeExclusive(async () => {
        await authorizeWorkMode(database, request, choice(input.workMode, "work_mode", ISSUE_WORK_MODES));
        options.signal?.throwIfAborted();
        if (options.dingtalk) {
          const source = options.dingtalk;
          const [existing] = await database.db
            .select({ issue: issues })
            .from(dingtalkIssueImports)
            .innerJoin(issues, eq(issues.id, dingtalkIssueImports.issueId))
            .where(and(eq(dingtalkIssueImports.baseId, source.baseId), eq(dingtalkIssueImports.tableId, source.tableId), eq(dingtalkIssueImports.recordId, source.recordId)))
            .limit(1);
          if (existing) {
            created = false;
            return existing.issue;
          }
        }
        const issueValues = await parseCreateIssueInput(input);
        if (issueValues.environment.kind === "dev") await requireDevelopmentOwner(credentialOwnerSubject({ assigneeSubject: issueValues.assigneeSubject, reporterSubject }));
        const relatedIssues = await parseRelatedIssues(input);
        const issueId = randomUUID();
        return runIssueExclusive(engine, [issueId, ...relatedIssues.map(({ id }) => id)], async (reservation) => {
          options.signal?.throwIfAborted();
          const day = regionalDateStamp();
          // Reserve the number before touching the filesystem. A failed create may leave a gap, never a reusable key.
          const [next] = await database.db
            .insert(issueKeySequences)
            .values({ day, lastValue: 1 })
            .onConflictDoUpdate({ target: issueKeySequences.day, set: { lastValue: sql`${issueKeySequences.lastValue} + 1` } })
            .returning({ sequence: issueKeySequences.lastValue });
          const issueKey = `ISSUE-${day}-${String(next!.sequence).padStart(3, "0")}`;
          const writtenObjectKeys: string[] = [];
          await claimIssueRoot(stateRoot, issueKey);
          let issue: typeof issues.$inferSelect;
          try {
            const publishedAttachments = await publishPendingAttachments(stateRoot, issueKey, initialAttachments, writtenObjectKeys);
            issue = await database.db.transaction(async (transaction) => {
              const [insertedIssue] = await transaction
                .insert(issues)
                .values({
                  id: issueId,
                  key: issueKey,
                  title: issueValues.title,
                  description: issueValues.description,
                  priority: issueValues.priority,
                  type: issueValues.type,
                  serviceId: issueValues.serviceId,
                  environmentId: issueValues.environment.id,
                  reporterSubject,
                  assigneeSubject: issueValues.assigneeSubject,
                })
                .returning();
              if (issueValues.ccSubjects.length) await transaction.insert(issueCcRecipients).values(issueValues.ccSubjects.map((recipient) => ({ issueId: insertedIssue!.id, subject: recipient })));
              if (relatedIssues.length) await transaction.insert(issueRelations).values(relatedIssues.map((relatedIssue) => ({ issueId: insertedIssue!.id, relatedIssueId: relatedIssue.id })));
              await transaction.insert(issueWorkspaces).values({ issueId: insertedIssue!.id });
              if (options.dingtalk) await transaction.insert(dingtalkIssueImports).values({ ...options.dingtalk, issueId: insertedIssue!.id, importedBy: reporterSubject });
              await insertPublishedAttachments(transaction, insertedIssue!.id, reporterSubject, publishedAttachments);
              return insertedIssue!;
            });
          } catch (error) {
            const rollbackErrors: unknown[] = [];
            await removeWrittenAttachments(writtenObjectKeys).catch((rollbackError) => rollbackErrors.push(rollbackError));
            await removeEmptyIssueRoot(stateRoot, issueKey).catch((rollbackError) => rollbackErrors.push(rollbackError));
            if (rollbackErrors.length) throw new OperationError("issue_state_rollback_failed", "unknown", { cause: new AggregateError([error, ...rollbackErrors], "issue_state_rollback_failed") });
            throw error;
          }
          if (options.startAgent !== false) reservation.enqueue(issue.id);
          return issue;
        });
      });
      return { issue: await readIssueSummary(createdIssue.id), created };
    } catch (error) {
      failures.push(error);
      throw error;
    } finally {
      await removeStagedAttachments(request, initialAttachments, failures);
    }
  };
  app.post("/api/issues", async (request, reply) => {
    await ensureCurrentSubject(database, request);
    const { input, attachments } = await readIssueInput(stateRoot, request);
    const result = await createIssue(input, request, attachments);
    return reply.code(201).send(result.issue);
  });

  app.patch<{ Params: { key: string } }>("/api/issues/:key", async (request) => {
    await ensureCurrentSubject(database, request);
    const issue = await requireIssue(database, request.params.key);
    const { input, attachments: pendingAttachments } = await readIssueInput(stateRoot, request);
    const failures: unknown[] = [];
    try {
      const expectedEditVersion = input.expectedEditVersion;
      if (typeof expectedEditVersion !== "string" || !/^[0-9a-f]{64}$/.test(expectedEditVersion)) throw new ApiError(400, "invalid_issue_edit_version");
      if (input.resetSession !== undefined && typeof input.resetSession !== "boolean") throw new ApiError(400, "invalid_reset_session");
      // Saving and resetting in one reservation: the reset must not find a metadata round already queued.
      const resetSession = input.resetSession === true;
      if (resetSession) await requireDeveloper(database, request);
      const removedAttachmentIds = [...new Set(strings(input.removedAttachmentIds ?? [], "attachment_ids"))];
      if (ISSUE_SCOPE_INPUT_FIELDS.some((field) => Object.hasOwn(input, field))) throw new ApiError(400, "issue_scope_update_not_allowed");
      return await runScopeExclusive(() =>
        runIssueExclusive(engine, [issue.id], async (reservation) => {
          const editorSubject = await ensureCurrentSubject(database, request);
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
            throw new ApiError(409, "issue_edit_conflict");
          if (resetSession) {
            await requireDeveloper(database, request);
            if (currentIssue.status === "resolved") throw new ApiError(409, "resolved_issue_cannot_reset_session");
          }
          const currentSession = resetSession ? (await issueSessionHistory(database.db, stateRoot, currentIssue))[0] : undefined;
          if (resetSession && !currentSession) throw new ApiError(409, "agent_session_not_found");
          const [[issueEnvironment], [issueService], issueValues] = await Promise.all([
            database.db.select({ key: environments.key, kind: environments.kind }).from(environments).where(eq(environments.id, currentIssue.environmentId)).limit(1),
            database.db.select({ key: services.key, name: services.name }).from(services).where(eq(services.id, currentIssue.serviceId)).limit(1),
            parseIssueMetadataInput(input),
          ]);
          if (!issueEnvironment || !issueService) throw new ApiError(409, "issue_scope_not_found");
          const removedAttachmentIdSet = new Set(removedAttachmentIds);
          const removedAttachments = currentAttachments.filter((attachment) => removedAttachmentIdSet.has(attachment.id));
          if (removedAttachments.length !== removedAttachmentIds.length) throw new ApiError(404, "attachment_not_found");
          if (issueEnvironment.kind === "dev") await requireDevelopmentOwner(credentialOwnerSubject({ assigneeSubject: issueValues.assigneeSubject, reporterSubject: currentIssue.reporterSubject }));
          const attachmentRoot = issueRoot(stateRoot, issue.key);
          await Promise.all(removedAttachments.map(({ objectKey, size }) => resolveSecureAttachmentFile(attachmentRoot, objectKey, size)));
          await reservation.closeSession(issue.id);
          const writtenObjectKeys: string[] = [];
          let attachmentDtos: Array<ReturnType<typeof serializeAttachment>> = [];
          try {
            const publishedAttachments = await publishPendingAttachments(stateRoot, issue.key, pendingAttachments, writtenObjectKeys);
            let createdAttachments: Awaited<ReturnType<typeof insertPublishedAttachments>> = [];
            const save = async (transaction: Parameters<Parameters<typeof database.db.transaction>[0]>[0]) => {
              await transaction
                .update(issues)
                .set({ title: issueValues.title, description: issueValues.description, priority: issueValues.priority, assigneeSubject: issueValues.assigneeSubject, updatedAt: new Date() })
                .where(eq(issues.id, issue.id));
              await transaction.delete(issueCcRecipients).where(eq(issueCcRecipients.issueId, issue.id));
              if (issueValues.ccSubjects.length) await transaction.insert(issueCcRecipients).values(issueValues.ccSubjects.map((recipient) => ({ issueId: issue.id, subject: recipient })));
              await retireAttachments(transaction, issue.id, removedAttachments);
              createdAttachments = await insertPublishedAttachments(transaction, issue.id, editorSubject, publishedAttachments);
            };
            if (resetSession) await resetIssueSession(database.db, stateRoot, currentIssue, editorSubject, currentSession!.sessionId, save);
            else await database.db.transaction(save);
            attachmentDtos = [...currentAttachments.filter((attachment) => !removedAttachmentIdSet.has(attachment.id)).map(serializeAttachment), ...createdAttachments];
          } catch (error) {
            const rollbackErrors: unknown[] = [];
            await removeWrittenAttachments(writtenObjectKeys).catch((rollbackError) => rollbackErrors.push(rollbackError));
            if (rollbackErrors.length) throw new OperationError("issue_update_rollback_failed", "unknown", { cause: new AggregateError([error, ...rollbackErrors], "issue_update_rollback_failed") });
            throw error;
          }
          // A committed retirement is never rolled back. The next successful edit retries any recorded cleanup failures.
          await finalizeRetiredAttachments(database.db, attachmentRoot, issue.id).catch((error: unknown) =>
            request.log.error({ issueKey: issue.key, code: errorCode(error) }, "attachment_finalize_failed"),
          );
          if (resetSession) {
            events.publish({ id: randomUUID(), issueId: issue.id, createdAt: new Date().toISOString(), event: { type: "session_reset" } });
          } else if (currentIssue.status !== "resolved") {
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
        await ensureCurrentSubject(database, request);
        const currentIssue = await requireIssue(database, issue.key);
        const [[workspace], currentRelations] = await Promise.all([
          database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, currentIssue.id)).limit(1),
          database.db.select().from(issueRelations).where(eq(issueRelations.issueId, currentIssue.id)),
        ]);
        if (currentIssue.status === "resolved") throw new ApiError(409, "related_issue_update_not_allowed");
        if (!workspace || !["ready", "stopped"].includes(workspace.status) || !workspace.runtimeReady) throw new ApiError(409, "related_issue_context_unavailable");
        if (requestedKeys.includes(currentIssue.key)) throw new ApiError(400, "invalid_related_issues");
        const relatedIssues = await validateRelatedIssues(requestedKeys);
        const currentIds = currentRelations.map(({ relatedIssueId }) => relatedIssueId).sort();
        const requestedIds = relatedIssues.map(({ id }) => id).sort();
        if (currentIds.length === requestedIds.length && currentIds.every((id, index) => id === requestedIds[index])) return;
        await reservation.closeSession(currentIssue.id);
        await database.db.transaction(async (transaction) => {
          const currentIdSet = new Set(currentIds);
          const requestedIdSet = new Set(requestedIds);
          const removedIds = currentIds.filter((id) => !requestedIdSet.has(id));
          const addedIssues = relatedIssues.filter(({ id }) => !currentIdSet.has(id));
          if (removedIds.length) await transaction.delete(issueRelations).where(and(eq(issueRelations.issueId, currentIssue.id), inArray(issueRelations.relatedIssueId, removedIds)));
          if (addedIssues.length) await transaction.insert(issueRelations).values(addedIssues.map((relatedIssue) => ({ issueId: currentIssue.id, relatedIssueId: relatedIssue.id })));
          const now = new Date();
          await transaction.update(issueWorkspaces).set({ runtimeReady: false, updatedAt: now }).where(eq(issueWorkspaces.issueId, currentIssue.id));
          await transaction.update(issues).set({ updatedAt: now }).where(eq(issues.id, currentIssue.id));
        });
        reservation.enqueue(currentIssue.id);
      });
    });
    return reply.code(204).send();
  });

  app.patch<{ Params: { key: string } }>("/api/issues/:key/status", async (request) => {
    await ensureCurrentSubject(database, request);
    const issue = await requireIssue(database, request.params.key);
    const targetStatus = choice(record(request.body).status, "status", MANUAL_ISSUE_STATUSES);
    if (targetStatus === "open") {
      try {
        const reopened = await workspaces.reopenIssue(issue.id, () => ensureCurrentSubject(database, request));
        return readIssueSummary(reopened.id);
      } catch (error) {
        if (error instanceof WorkspaceRestoreRefusal) throwRefusal(error);
        throw error;
      }
    }
    return runIssueExclusive(engine, [issue.id], async (reservation) => {
      await ensureCurrentSubject(database, request);
      const currentIssue = await requireIssue(database, issue.key);
      if (currentIssue.status !== "pending") throw new ApiError(409, "invalid_issue_status_transition");
      await reservation.closeSession(issue.id);
      const [updatedIssue] = await database.db
        .update(issues)
        .set({ status: "resolved", resolvedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(issues.id, issue.id), eq(issues.status, "pending")))
        .returning();
      if (!updatedIssue) throw new ApiError(409, "invalid_issue_status_transition");
      return readIssueSummary(updatedIssue.id);
    });
  });

  app.get<{ Params: { key: string } }>("/api/issues/:key", async (request, _reply) => {
    const { issue, summary, repositoryRows, attachmentRows, workspaceRows, ccRows, sessionRows, reporterRows, commentRows, relatedIssueRows, scopeHistory, collaboratingServices } = await readSnapshot(
      database.db,
      async (reader) => {
        const issue = await requireIssue({ db: reader }, request.params.key);
        const [summary, repositoryRows, attachmentRows, workspaceRows, ccRows, sessionRows, reporterRows, commentRows, relatedIssueRows, scopeHistory, collaboratingServices] = await Promise.all([
          readIssueSummary(issue.id, reader),
          reader.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id)),
          reader.select().from(issueAttachments).where(eq(issueAttachments.issueId, issue.id)),
          reader.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, issue.id)),
          reader.select({ person: subjects }).from(issueCcRecipients).innerJoin(subjects, eq(issueCcRecipients.subject, subjects.subject)).where(eq(issueCcRecipients.issueId, issue.id)),
          reader.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id)),
          reader.select().from(subjects).where(eq(subjects.subject, issue.reporterSubject)),
          reader
            .select({ comment: issueComments, person: subjects })
            .from(issueComments)
            .innerJoin(subjects, eq(issueComments.authorSubject, subjects.subject))
            .where(eq(issueComments.issueId, issue.id))
            .orderBy(asc(issueComments.createdAt)),
          issueSummaryQuery(reader)
            .innerJoin(issueRelations, eq(issueRelations.relatedIssueId, issues.id))
            .where(eq(issueRelations.issueId, issue.id))
            .orderBy(asc(issueRelations.createdAt), asc(issueRelations.relatedIssueId)),
          scopeTransitions.history(issue.id, reader),
          participatingServices(reader, issue),
        ]);
        return { issue, summary, repositoryRows, attachmentRows, workspaceRows, ccRows, sessionRows, reporterRows, commentRows, relatedIssueRows, scopeHistory, collaboratingServices };
      },
    );
    const workspace = workspaceRows[0];
    const sessionBinding = sessionRows[0];
    const reporter = reporterRows[0];
    const workspaceStatus = workspace?.status ?? "not_created";
    const sessionReady = sessionBinding ? await pathExists(sessionBinding.sessionFile) : false;
    const repositoryState = classifyRepositoryState(repositoryRows);
    let repositoryNames = new Map<string, string>();
    if (repositoryState !== "invalid") repositoryNames = issueRepositoryWorkspaceNames(repositoryRows);
    const sourceAvailable = Boolean(repositoryState !== "invalid" && hasRepositoryView(repositoryState, workspace) && (await pathExists(issueRoot(stateRoot, issue.key))));
    return {
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
        lastError: workspace?.lastError ?? null,
        retryable:
          issue.status !== "resolved" && !summary.agentRunning && (workspaceStatus !== "ready" || !workspace?.runtimeReady || (!sessionReady && ["open", "in_progress"].includes(issue.status))),
      },
      reporter: reporter ? serializePerson(reporter) : undefined,
      ccRecipients: ccRows.map(({ person }) => serializePerson(person)),
      comments: commentRows.map(({ comment, person }) => ({ id: comment.id, author: person.displayName ?? person.subject, body: comment.body, createdAt: comment.createdAt.toISOString() })),
    };
  });

  app.post<{ Params: { key: string } }>("/api/issues/:key/comments", async (request, reply) => {
    const issue = await requireIssue(database, request.params.key);
    const input = record(request.body);
    const authorSubject = await ensureCurrentSubject(database, request);
    const comment = await database.db.transaction(async (transaction) => {
      const [createdComment] = await transaction
        .insert(issueComments)
        .values({ issueId: issue.id, authorSubject, body: text(input.body, "comment", 50_000) })
        .returning();
      await transaction.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, issue.id));
      return createdComment!;
    });
    return reply.code(201).send({ id: comment.id, author: authorSubject, body: comment.body, createdAt: comment.createdAt.toISOString() });
  });

  return { createIssue, resolveCreationScope };
}
