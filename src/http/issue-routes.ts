import { randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";
import path from "node:path";

import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { readInBatches } from "../db/client.ts";
import { issueMetadataUpdatePrompt } from "../agent/prompts.ts";
import { agentSessions, dingtalkIssueImports, environments, issueAttachments, issueCcRecipients, issueComments, issuePins, issueRelations, issueRepositories, issues, issueWorkspaces, serviceDeployments, services, subjects } from "../db/schema.ts";
import { ISSUE_PRIORITIES, ISSUE_WORK_MODES, issueScopeForWorkMode, parseIssueKey, type EnvironmentKind } from "../domain/contracts.ts";
import { listIssueOutputs, openLegacyIssueOutput } from "../outputs/store.ts";
import { issueRepositoryWorkspaceNames } from "../workspace/git.ts";
import { WorkspaceRestoreRefusal } from "../workspace/lifecycle.ts";
import { claimIssueRoot, classifyRepositoryState, issueAttachmentRoot, issueWorkDirectory, issueRuntimeRoot, pathExists, removeEmptyIssueRoot } from "../workspace/state.ts";
import { finalizeQuarantinedAttachments, type PendingAttachment, type QuarantinedAttachment, readMultipartAttachment, removePendingAttachments, removeWrittenAttachments, resolveSecureAttachmentFile, restoreQuarantinedAttachments, serializeAttachment, writePendingAttachments } from "./attachment-store.ts";
import { participatingServices } from "../workspace/issue-services.ts";
import { ApiError, choice, optionalText, record, strings, text } from "./input.ts";
import { ensureCurrentSubject, authorizeWorkMode, requireIssue, runIssueExclusive, serializePerson, type ApiRouteContext } from "./route-context.ts";

const MANUAL_ISSUE_STATUSES = ["open", "resolved"] as const;
const ISSUE_SCOPE_INPUT_FIELDS = ["serviceKey", "environmentKey", "type", "workMode", "relatedIssueKeys"] as const;

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

async function readIssueInput(request: FastifyRequest): Promise<{ input: Record<string, unknown>; attachments: PendingAttachment[] }> {
  if (!request.isMultipart()) return { input: record(request.body), attachments: [] };
  const attachments: PendingAttachment[] = [];
  let issueField: unknown;
  try {
    for await (const part of request.parts()) {
      if (part.type === "file") attachments.push(await readMultipartAttachment(part));
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

export function registerIssueRoutes(context: ApiRouteContext) {
  const { app, database, engine, stateRoot, workspaces, scopeTransitions, runScopeExclusive } = context;
  const findEnvironmentByKind = async (kind: EnvironmentKind) => (await database.db.select().from(environments).where(eq(environments.kind, kind)).limit(1))[0];
  const findServiceDeployment = async (key: string, environmentId: string) => (await database.db.select({ service: services, deployment: serviceDeployments })
    .from(services)
    .innerJoin(serviceDeployments, and(eq(serviceDeployments.serviceId, services.id), eq(serviceDeployments.environmentId, environmentId)))
    .where(eq(services.key, key))
    .limit(1))[0];
  const validateSubjects = async (subjectValues: Array<string | null>): Promise<void> => {
    const requestedSubjects = [...new Set(subjectValues.filter((value): value is string => Boolean(value)))];
    if (!requestedSubjects.length) return;
    const matchingSubjects = await database.db.select({ subject: subjects.subject }).from(subjects).where(and(inArray(subjects.subject, requestedSubjects), eq(subjects.active, true)));
    if (matchingSubjects.length !== requestedSubjects.length) throw new ApiError(400, "invalid_subject");
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
  const parseCreateIssueInput = async (input: Record<string, unknown>) => {
    if (Object.hasOwn(input, "environmentKey") || Object.hasOwn(input, "type")) throw new ApiError(400, "issue_create_scope_contract_invalid");
    const workMode = choice(input.workMode, "work_mode", ISSUE_WORK_MODES);
    const scope = issueScopeForWorkMode(workMode);
    const environment = await findEnvironmentByKind(scope.environmentKind);
    if (!environment) throw new ApiError(400, "invalid_work_mode");
    const serviceDeployment = await findServiceDeployment(text(input.serviceKey, "service_key", 100), environment.id);
    if (!serviceDeployment) throw new ApiError(400, "invalid_service_for_work_mode");
    return {
      ...await parseIssueMetadataInput(input),
      workMode,
      type: scope.issueType,
      environment,
      serviceId: serviceDeployment.service.id,
      service: { key: serviceDeployment.service.key, name: serviceDeployment.service.name },
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
  const serializeIssueSummaries = async (selectedIssues: Array<typeof issues.$inferSelect>) => {
    const assigneeSubjects = [...new Set(selectedIssues.flatMap((issue) => issue.assigneeSubject ? [issue.assigneeSubject] : []))];
    const serviceIds = [...new Set(selectedIssues.map((issue) => issue.serviceId))];
    const environmentIds = [...new Set(selectedIssues.map((issue) => issue.environmentId))];
    const issueIds = selectedIssues.map((issue) => issue.id);
    const [assigneeRows, serviceRows, environmentRows, workspaceRows] = await Promise.all([
      readInBatches(assigneeSubjects, batch => database.db.select().from(subjects).where(inArray(subjects.subject, batch))),
      readInBatches(serviceIds, batch => database.db.select({ id: services.id, key: services.key, name: services.name }).from(services).where(inArray(services.id, batch))),
      readInBatches(environmentIds, batch => database.db.select({ id: environments.id, key: environments.key }).from(environments).where(inArray(environments.id, batch))),
      readInBatches(issueIds, batch => database.db.select({ issueId: issueWorkspaces.issueId, status: issueWorkspaces.status }).from(issueWorkspaces).where(inArray(issueWorkspaces.issueId, batch))),
    ]);
    const assignees = new Map(assigneeRows.map((assignee) => [assignee.subject, assignee]));
    const serviceById = new Map(serviceRows.map((service) => [service.id, service]));
    const environmentById = new Map(environmentRows.map((environment) => [environment.id, environment]));
    const workspaceByIssueId = new Map(workspaceRows.map((workspace) => [workspace.issueId, workspace]));
    return selectedIssues.map((issue) => {
      const assignee = issue.assigneeSubject ? assignees.get(issue.assigneeSubject) : undefined;
      const service = serviceById.get(issue.serviceId);
      const environment = environmentById.get(issue.environmentId);
      const workspace = workspaceByIssueId.get(issue.id);
      if (!service) throw new Error("issue_service_not_found");
      if (!environment) throw new Error("issue_environment_not_found");
      if (!workspace) throw new Error("issue_workspace_not_found");
      return {
        id: issue.key, title: issue.title, priority: issue.priority, type: issue.type, status: issue.status,
        assignee: assignee?.displayName ?? null, assigneeSubject: issue.assigneeSubject,
        service: { key: service.key, name: service.name }, environmentKey: environment.key,
        workspaceStatus: workspace.status, agentRunning: engine.isRunning(issue.id), resolvedAt: isoDate(issue.resolvedAt) ?? null,
        createdAt: isoDate(issue.createdAt), updatedAt: issue.updatedAt.toISOString(),
      };
    });
  };
  const serializeIssueSummary = async (issue: typeof issues.$inferSelect) => (await serializeIssueSummaries([issue]))[0]!;
  app.get("/api/issues", async (_request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    return serializeIssueSummaries(await database.db.select().from(issues).orderBy(desc(issues.createdAt), desc(issues.key)));
  });

  app.get("/api/issue-pins", async (request, reply) => {
    const subject = await ensureCurrentSubject(database, request);
    reply.header("Cache-Control", "private, no-store");
    const pinned = await database.db.select({ key: issues.key }).from(issuePins)
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

  const createIssue = async (input: Record<string, unknown>, request: FastifyRequest, initialAttachments: PendingAttachment[] = [], options: { dingtalk?: DingtalkImportClaim; startAgent?: boolean; signal?: AbortSignal } = {}) => {
    const failures: unknown[] = [];
    try {
      const reporterSubject = await authorizeWorkMode(database, request, choice(input.workMode, "work_mode", ISSUE_WORK_MODES));
      let created = true;
    const createdIssue = await runScopeExclusive(async () => {
      await authorizeWorkMode(database, request, choice(input.workMode, "work_mode", ISSUE_WORK_MODES));
      options.signal?.throwIfAborted();
      if (options.dingtalk) {
        const source = options.dingtalk;
        const [existing] = await database.db.select({ issue: issues }).from(dingtalkIssueImports).innerJoin(issues, eq(issues.id, dingtalkIssueImports.issueId)).where(and(eq(dingtalkIssueImports.baseId, source.baseId), eq(dingtalkIssueImports.tableId, source.tableId), eq(dingtalkIssueImports.recordId, source.recordId))).limit(1);
        if (existing) { created = false; return existing.issue; }
      }
      const issueValues = await parseCreateIssueInput(input);
      if (issueValues.environment.kind === "dev") {
        const [owner] = await database.db.select().from(subjects).where(eq(subjects.subject, issueValues.assigneeSubject ?? reporterSubject)).limit(1);
        if (owner?.role !== "developer") throw new ApiError(400, "issue_developer_owner_required");
      }
      const relatedIssues = await parseRelatedIssues(input);
      const issueId = randomUUID();
      return runIssueExclusive(engine, [issueId, ...relatedIssues.map(({ id }) => id)], async (reservation) => {
        options.signal?.throwIfAborted();
        const prefix = `ISSUE-${regionalDateStamp()}-`;
        const [next] = await database.db.select({ sequence: sql<number>`coalesce(max(cast(substr(${issues.key}, ${prefix.length + 1}) as integer)), 0) + 1` })
          .from(issues).where(and(gte(issues.key, prefix), lt(issues.key, `${prefix}\uffff`)));
        const issueKey = `${prefix}${String(next!.sequence).padStart(3, "0")}`;
        const writtenObjectKeys: string[] = [];
        await claimIssueRoot(stateRoot, issueKey);
        let issue: typeof issues.$inferSelect;
        try {
          issue = await database.db.transaction(async (transaction) => {
            const [insertedIssue] = await transaction.insert(issues).values({ id: issueId, key: issueKey, title: issueValues.title, description: issueValues.description, priority: issueValues.priority, type: issueValues.type, serviceId: issueValues.serviceId, environmentId: issueValues.environment.id, reporterSubject, assigneeSubject: issueValues.assigneeSubject }).returning();
            if (issueValues.ccSubjects.length) await transaction.insert(issueCcRecipients).values(issueValues.ccSubjects.map((recipient) => ({ issueId: insertedIssue!.id, subject: recipient })));
            if (relatedIssues.length) await transaction.insert(issueRelations).values(relatedIssues.map((relatedIssue) => ({ issueId: insertedIssue!.id, relatedIssueId: relatedIssue.id })));
            await transaction.insert(issueWorkspaces).values({ issueId: insertedIssue!.id });
            if (options.dingtalk) await transaction.insert(dingtalkIssueImports).values({ ...options.dingtalk, issueId: insertedIssue!.id, importedBy: reporterSubject });
            await writePendingAttachments(transaction, stateRoot, { id: insertedIssue!.id, key: issueKey }, reporterSubject, initialAttachments, writtenObjectKeys);
            return insertedIssue!;
          });
        } catch (error) {
          const rollbackErrors: unknown[] = [];
          await removeWrittenAttachments(writtenObjectKeys).catch((rollbackError) => rollbackErrors.push(rollbackError));
          await removeEmptyIssueRoot(stateRoot, issueKey).catch((rollbackError) => rollbackErrors.push(rollbackError));
          if (rollbackErrors.length) throw new Error("issue_state_rollback_failed", { cause: new AggregateError([error, ...rollbackErrors], "issue_state_rollback_failed") });
          throw error;
        }
        if (options.startAgent !== false) reservation.enqueue(issue.id);
        return issue;
      });
    });
      return { issue: await serializeIssueSummary(createdIssue), created };
    } catch (error) {
      failures.push(error);
      throw error;
    } finally {
      await removePendingAttachments(initialAttachments, failures);
    }
  };
  app.post("/api/issues", async (request, reply) => {
    const { input, attachments } = await readIssueInput(request);
    const result = await createIssue(input, request, attachments);
    return reply.code(201).send(result.issue);
  });

  app.patch<{ Params: { key: string } }>("/api/issues/:key", async (request) => {
    const issue = await requireIssue(database, request.params.key);
    const { input, attachments: pendingAttachments } = await readIssueInput(request);
    const failures: unknown[] = [];
    try {
      const removedAttachmentIds = [...new Set(strings(input.removedAttachmentIds ?? [], "attachment_ids"))];
      if (ISSUE_SCOPE_INPUT_FIELDS.some((field) => Object.hasOwn(input, field))) throw new ApiError(400, "issue_scope_update_not_allowed");
      return await runScopeExclusive(() => runIssueExclusive(engine, [issue.id], async (reservation) => {
      const editorSubject = await ensureCurrentSubject(database, request);
      const currentIssue = await requireIssue(database, issue.key);
      const [[issueEnvironment], [issueService], issueValues] = await Promise.all([
        database.db.select({ key: environments.key, kind: environments.kind }).from(environments).where(eq(environments.id, currentIssue.environmentId)).limit(1),
        database.db.select({ key: services.key, name: services.name }).from(services).where(eq(services.id, currentIssue.serviceId)).limit(1),
        parseIssueMetadataInput(input),
      ]);
      if (!issueEnvironment || !issueService) throw new ApiError(409, "issue_scope_not_found");
      const currentAttachments = await database.db.select().from(issueAttachments).where(eq(issueAttachments.issueId, issue.id));
      const removedAttachmentIdSet = new Set(removedAttachmentIds);
      const removedAttachments = currentAttachments.filter((attachment) => removedAttachmentIdSet.has(attachment.id));
      if (removedAttachments.length !== removedAttachmentIds.length) throw new ApiError(404, "attachment_not_found");
      if (issueEnvironment?.kind === "dev") {
        const [owner] = await database.db.select().from(subjects).where(eq(subjects.subject, issueValues.assigneeSubject ?? currentIssue.reporterSubject)).limit(1);
        if (owner?.role !== "developer") throw new ApiError(400, "issue_developer_owner_required");
      }
      const attachmentRoot = issueAttachmentRoot(stateRoot, issue.key);
      const removableFiles = await Promise.all(removedAttachments.map(async (attachment) => ({
        attachment,
        sourcePath: await resolveSecureAttachmentFile(attachmentRoot, attachment.objectKey, attachment.size),
      })));
      await reservation.closeSession(issue.id);
      const quarantined: QuarantinedAttachment[] = [];
      const writtenObjectKeys: string[] = [];
      let attachmentDtos: Array<ReturnType<typeof serializeAttachment>> = [];
      try {
        for (const { attachment, sourcePath } of removableFiles) {
          const temporaryPath = path.join(attachmentRoot, `.attachment-${attachment.id}-${randomUUID()}.deleting`);
          await rename(sourcePath, temporaryPath);
          quarantined.push({ sourcePath, temporaryPath });
        }
        const createdAttachments = await database.db.transaction(async (transaction) => {
          await transaction.update(issues).set({ title: issueValues.title, description: issueValues.description, priority: issueValues.priority, assigneeSubject: issueValues.assigneeSubject, updatedAt: new Date() }).where(eq(issues.id, issue.id));
          await transaction.delete(issueCcRecipients).where(eq(issueCcRecipients.issueId, issue.id));
          if (issueValues.ccSubjects.length) await transaction.insert(issueCcRecipients).values(issueValues.ccSubjects.map((recipient) => ({ issueId: issue.id, subject: recipient })));
          if (removedAttachmentIds.length) await transaction.delete(issueAttachments).where(and(eq(issueAttachments.issueId, issue.id), inArray(issueAttachments.id, removedAttachmentIds)));
          return writePendingAttachments(transaction, stateRoot, issue, editorSubject, pendingAttachments, writtenObjectKeys);
        });
        attachmentDtos = [
          ...currentAttachments.filter((attachment) => !removedAttachmentIdSet.has(attachment.id)).map(serializeAttachment),
          ...createdAttachments,
        ];
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        try { await restoreQuarantinedAttachments(quarantined); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
        await removeWrittenAttachments(writtenObjectKeys).catch((rollbackError) => rollbackErrors.push(rollbackError));
        if (rollbackErrors.length) throw new Error("issue_update_rollback_failed", { cause: new AggregateError([error, ...rollbackErrors], "issue_update_rollback_failed") });
        throw error;
      }
      await finalizeQuarantinedAttachments(quarantined);
      if (currentIssue.status !== "resolved") {
        reservation.enqueue(issue.id, issueMetadataUpdatePrompt({ issue: { ...currentIssue, ...issueValues }, service: issueService, environmentKey: issueEnvironment.key, attachments: attachmentDtos, attachmentPath: attachmentRoot }), false);
      }
        return serializeIssueSummary(await requireIssue(database, issue.key));
      }));
    } catch (error) {
      failures.push(error);
      throw error;
    } finally {
      await removePendingAttachments(pendingAttachments, failures);
    }
  });

  app.put<{ Params: { key: string } }>("/api/issues/:key/related-issues", async (request, reply) => {
    const requestedKeys = parseRelatedIssueKeys(record(request.body));
    await runScopeExclusive(async () => {
      const issue = await requireIssue(database, request.params.key);
      const [existingRelations, requestedRows] = await Promise.all([
        database.db.select().from(issueRelations).where(eq(issueRelations.issueId, issue.id)),
        requestedKeys.length ? database.db.select({ id: issues.id, key: issues.key }).from(issues).where(inArray(issues.key, requestedKeys)) : [],
      ]);
      const reservationIds = [issue.id, ...existingRelations.map(({ relatedIssueId }) => relatedIssueId), ...requestedRows.map(({ id }) => id)];
      await runIssueExclusive(engine, reservationIds, async (reservation) => {
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
    const issue = await requireIssue(database, request.params.key);
    const targetStatus = choice(record(request.body).status, "status", MANUAL_ISSUE_STATUSES);
    if (targetStatus === "open") {
      try { return serializeIssueSummary(await workspaces.reopenIssue(issue.id)); }
      catch (error) {
        if (error instanceof WorkspaceRestoreRefusal) throw new ApiError(409, error.reason);
        throw error;
      }
    }
    return runIssueExclusive(engine, [issue.id], async (reservation) => {
      const currentIssue = await requireIssue(database, issue.key);
      if (currentIssue.status !== "pending") throw new ApiError(409, "invalid_issue_status_transition");
      await reservation.closeSession(issue.id);
      const [updatedIssue] = await database.db.update(issues).set({ status: "resolved", resolvedAt: new Date(), updatedAt: new Date() }).where(and(eq(issues.id, issue.id), eq(issues.status, "pending"))).returning();
      if (!updatedIssue) throw new ApiError(409, "invalid_issue_status_transition");
      return serializeIssueSummary(updatedIssue);
    });
  });

  app.get<{ Params: { key: string } }>("/api/issues/:key", async (request) => {
    const issue = await requireIssue(database, request.params.key);
    const [summary, repositoryRows, attachmentRows, outputRows, workspaceRows, ccRows, sessionRows, reporterRows, commentRows, relationRows, scopeHistory] = await Promise.all([
      serializeIssueSummary(issue), database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id)), database.db.select().from(issueAttachments).where(eq(issueAttachments.issueId, issue.id)), listIssueOutputs(stateRoot, issue.key),
      database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, issue.id)),
      database.db.select({ person: subjects }).from(issueCcRecipients).innerJoin(subjects, eq(issueCcRecipients.subject, subjects.subject)).where(eq(issueCcRecipients.issueId, issue.id)), database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id)),
      database.db.select().from(subjects).where(eq(subjects.subject, issue.reporterSubject)), database.db.select({ comment: issueComments, person: subjects }).from(issueComments).innerJoin(subjects, eq(issueComments.authorSubject, subjects.subject)).where(eq(issueComments.issueId, issue.id)).orderBy(asc(issueComments.createdAt)),
      database.db.select().from(issueRelations).where(eq(issueRelations.issueId, issue.id)).orderBy(asc(issueRelations.createdAt), asc(issueRelations.relatedIssueId)),
      scopeTransitions.history(issue.id),
    ]);
    const relatedIssueRows = relationRows.length ? await database.db.select().from(issues).where(inArray(issues.id, relationRows.map(({ relatedIssueId }) => relatedIssueId))) : [];
    const relatedIssueById = new Map(relatedIssueRows.map((relatedIssue) => [relatedIssue.id, relatedIssue]));
    const relatedIssues = await serializeIssueSummaries(relationRows.map(({ relatedIssueId }) => relatedIssueById.get(relatedIssueId)).filter((relatedIssue): relatedIssue is typeof issues.$inferSelect => Boolean(relatedIssue)));
    const workspace = workspaceRows[0]; const sessionBinding = sessionRows[0]; const reporter = reporterRows[0];
    const workspaceStatus = workspace?.status ?? "not_created";
    const sessionReady = sessionBinding ? await pathExists(sessionBinding.sessionFile) : false;
    const repositoryState = classifyRepositoryState(repositoryRows);
    let repositoryNames = new Map<string, string>();
    if (repositoryState !== "invalid") repositoryNames = issueRepositoryWorkspaceNames(repositoryRows);
    const sourceAvailable = Boolean(workspace?.runtimeReady && repositoryState !== "invalid" && await pathExists(issueRuntimeRoot(stateRoot, issue.key)));
    return {
      ...summary, description: issue.description,
      repositories: repositoryRows.map((repository) => ({ name: repositoryNames.get(repository.url) ?? "", url: repository.url, baseBranch: repository.baseBranch, workingBranch: repository.workingBranch })),
      workingDirectory: issueWorkDirectory(stateRoot, issue.key),
      attachments: attachmentRows.map(serializeAttachment),
      collaboratingServices: await participatingServices(database.db, issue),
      outputs: outputRows,
      relatedIssues,
      scopeTransitions: scopeHistory,
      workspace: {
        status: workspaceStatus,
        sourceAvailable,
        lastError: workspace?.lastError ?? null,
        retryable: issue.status !== "resolved" && !engine.isRunning(issue.id) && (
          workspaceStatus !== "ready"
          || (!sessionReady && ["open", "in_progress"].includes(issue.status))
        ),
      },
      reporter: reporter ? serializePerson(reporter) : undefined,
      ccRecipients: ccRows.map(({ person }) => serializePerson(person)),
      comments: commentRows.map(({ comment, person }) => ({ id: comment.id, author: person.displayName ?? person.subject, body: comment.body, createdAt: comment.createdAt.toISOString() })),
    };
  });

  app.get<{ Params: { key: string; fileName: string } }>("/api/issues/:key/outputs/:fileName", { logLevel: "silent" }, async (request, reply) => {
    const issue = await requireIssue(database, request.params.key);
    let output: Awaited<ReturnType<typeof openLegacyIssueOutput>>;
    try { output = await openLegacyIssueOutput(stateRoot, issue.key, request.params.fileName); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") throw new ApiError(404, "issue_output_not_found");
      if (error instanceof Error && error.message === "invalid_work_file_name") throw new ApiError(400, error.message);
      throw error;
    }
    const extension = path.extname(request.params.fileName).toLowerCase();
    const mediaType = new Map([[".csv", "text/csv; charset=utf-8"], [".json", "application/json; charset=utf-8"], [".jsonl", "application/x-ndjson; charset=utf-8"], [".sql", "text/plain; charset=utf-8"], [".txt", "text/plain; charset=utf-8"], [".md", "text/markdown; charset=utf-8"]]).get(extension) ?? "application/octet-stream";
    reply.header("Cache-Control", "private, no-store");
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(request.params.fileName)}`);
    return reply.type(mediaType).header("Content-Length", output.size).send(output.handle.createReadStream({ autoClose: true }));
  });

  app.post<{ Params: { key: string } }>("/api/issues/:key/comments", async (request, reply) => {
    const issue = await requireIssue(database, request.params.key);
    const input = record(request.body);
    const authorSubject = await ensureCurrentSubject(database, request);
    const comment = await database.db.transaction(async (transaction) => {
      const [createdComment] = await transaction.insert(issueComments).values({ issueId: issue.id, authorSubject, body: text(input.body, "comment", 50_000) }).returning();
      await transaction.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, issue.id));
      return createdComment!;
    });
    return reply.code(201).send({ id: comment.id, author: authorSubject, body: comment.body, createdAt: comment.createdAt.toISOString() });
  });

  return { createIssue };
}
