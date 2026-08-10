import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { agentSessions, environments, issueAttachments, issueCcRecipients, issueComments, issueRepositories, issues, issueWorkspaces, serviceDeployments, services, subjects } from "../db/schema.ts";
import { ENVIRONMENT_KINDS, ISSUE_PRIORITIES, ISSUE_TYPES, ISSUE_TYPES_BY_ENVIRONMENT, type EnvironmentKind, type IssueType } from "../domain/contracts.ts";
import { issueCodeServerUrl } from "../workspace/code-server.ts";
import { WorkspaceRestoreRefusal } from "../workspace/lifecycle.ts";
import { classifyRepositoryState, issueRuntimeRoot, pathExists } from "../workspace/state.ts";
import { type PendingAttachment, readMultipartAttachment, removeWrittenAttachments, serializeAttachment, writePendingAttachments } from "./attachments.ts";
import { ApiError, choice, optionalText, record, strings, text } from "./input.ts";
import { assertIssueIdle, ensureCurrentSubject, requireIssue, serializePerson, touchIssue, type ApiRouteContext } from "./route-context.ts";

const MANUAL_ISSUE_STATUSES = ["open", "resolved"] as const;

function assertIssueTypeForEnvironment(issueType: IssueType, environmentKind: string): void {
  const allowed = ISSUE_TYPES_BY_ENVIRONMENT[environmentKind as EnvironmentKind];
  if (!allowed?.includes(issueType)) throw new ApiError(400, "invalid_issue_type_for_environment");
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

export function registerIssueRoutes(context: ApiRouteContext): void {
  const { app, database, engine, stateRoot, workspaces } = context;
  let issueCreationTail = Promise.resolve();
  const serializeIssueCreation = async <T>(operation: () => Promise<T>): Promise<T> => {
    const precedingCreation = issueCreationTail;
    let completeCreation!: () => void;
    issueCreationTail = new Promise<void>((resolve) => { completeCreation = resolve; });
    await precedingCreation;
    try { return await operation(); } finally { completeCreation(); }
  };
  const findEnvironmentByKey = async (key: string) => ENVIRONMENT_KINDS.includes(key as EnvironmentKind)
    ? (await database.db.select().from(environments).where(eq(environments.key, key)).limit(1))[0]
    : undefined;
  const findServiceDeployment = async (key: string, environmentId: string) => (await database.db.select({ service: services, deployment: serviceDeployments })
    .from(services)
    .innerJoin(serviceDeployments, and(eq(serviceDeployments.serviceId, services.id), eq(serviceDeployments.environmentId, environmentId)))
    .where(eq(services.key, key))
    .limit(1))[0];
  const validateSubjects = async (subjectValues: Array<string | null>): Promise<void> => {
    const requestedSubjects = [...new Set(subjectValues.filter((value): value is string => Boolean(value)))];
    if (!requestedSubjects.length) return;
    const matchingSubjects = await database.db.select({ subject: subjects.subject }).from(subjects).where(inArray(subjects.subject, requestedSubjects));
    if (matchingSubjects.length !== requestedSubjects.length) throw new ApiError(400, "invalid_subject");
  };
  const parseIssueInput = async (input: Record<string, unknown>, environment: { id: string; kind: string }) => {
    const serviceDeployment = await findServiceDeployment(text(input.serviceKey, "service_key", 100), environment.id);
    if (!serviceDeployment) throw new ApiError(400, "invalid_service_for_environment");
    const assigneeSubject = optionalText(input.assigneeSubject, 255);
    const ccSubjects = [...new Set(strings(input.ccSubjects ?? [], "cc_subjects"))];
    await validateSubjects([assigneeSubject, ...ccSubjects]);
    const issueType = choice(input.type, "type", ISSUE_TYPES);
    assertIssueTypeForEnvironment(issueType, environment.kind);
    return {
      title: text(input.title, "title", 300),
      description: optionalText(input.description) ?? "",
      priority: choice(input.priority, "priority", ISSUE_PRIORITIES),
      type: issueType,
      serviceId: serviceDeployment.service.id,
      assigneeSubject,
      ccSubjects,
    };
  };
  const serializeIssueSummaries = async (selectedIssues: Array<typeof issues.$inferSelect>) => {
    const assigneeSubjects = [...new Set(selectedIssues.flatMap((issue) => issue.assigneeSubject ? [issue.assigneeSubject] : []))];
    const serviceIds = [...new Set(selectedIssues.map((issue) => issue.serviceId))];
    const [assigneeRows, serviceRows] = await Promise.all([
      assigneeSubjects.length ? database.db.select().from(subjects).where(inArray(subjects.subject, assigneeSubjects)) : [],
      serviceIds.length ? database.db.select({ id: services.id, key: services.key, name: services.name }).from(services).where(inArray(services.id, serviceIds)) : [],
    ]);
    const assignees = new Map(assigneeRows.map((assignee) => [assignee.subject, assignee]));
    const serviceById = new Map(serviceRows.map((service) => [service.id, service]));
    return selectedIssues.map((issue) => {
      const assignee = issue.assigneeSubject ? assignees.get(issue.assigneeSubject) : undefined;
      const service = serviceById.get(issue.serviceId);
      if (!service) throw new Error("issue_service_not_found");
      return {
        id: issue.key, title: issue.title, priority: issue.priority, type: issue.type, status: issue.status,
        assignee: assignee?.displayName ?? assignee?.username ?? null, assigneeSubject: issue.assigneeSubject,
        service: { key: service.key, name: service.name },
        createdAt: isoDate(issue.createdAt), updatedAt: issue.updatedAt.toISOString(),
      };
    });
  };
  const serializeIssueSummary = async (issue: typeof issues.$inferSelect) => (await serializeIssueSummaries([issue]))[0]!;
  app.get("/api/issues", async () => serializeIssueSummaries(await database.db.select().from(issues).orderBy(desc(issues.updatedAt))));

  app.post("/api/issues", async (request, reply) => {
    const initialAttachments: PendingAttachment[] = [];
    let attachmentBytes = 0;
    let input: Record<string, unknown>;
    if (request.isMultipart()) {
      let issueField: unknown;
      for await (const part of request.parts()) {
        if (part.type === "file") {
          const attachment = await readMultipartAttachment(part, attachmentBytes);
          attachmentBytes += attachment.content.length;
          initialAttachments.push(attachment);
        } else if (part.fieldname === "issue") {
          issueField = part.value;
        }
      }
      try {
        input = record(JSON.parse(text(issueField, "issue", 100_000)));
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(400, "invalid_issue");
      }
    } else {
      input = record(request.body);
    }
    const selectedEnvironment = await findEnvironmentByKey(text(input.environmentKey, "environment_key", 100));
    if (!selectedEnvironment) throw new ApiError(400, "invalid_environment");
    const reporterSubject = await ensureCurrentSubject(database);
    const issueValues = await parseIssueInput(input, selectedEnvironment);
    const createdIssue = await serializeIssueCreation(async () => {
      const prefix = `ISSUE-${regionalDateStamp()}-`;
      const existingIssueKeys = await database.db.select({ key: issues.key }).from(issues);
      const sequence = Math.max(0, ...existingIssueKeys.flatMap(({ key }) => key.startsWith(prefix) ? [Number(key.slice(prefix.length)) || 0] : [])) + 1;
      const issueKey = `${prefix}${String(sequence).padStart(3, "0")}`;
      const writtenObjectKeys: string[] = [];
      try {
        return await database.db.transaction(async (transaction) => {
          const [insertedIssue] = await transaction.insert(issues).values({ key: issueKey, title: issueValues.title, description: issueValues.description, priority: issueValues.priority, type: issueValues.type, serviceId: issueValues.serviceId, environmentId: selectedEnvironment.id, reporterSubject, assigneeSubject: issueValues.assigneeSubject }).returning();
          if (issueValues.ccSubjects.length) await transaction.insert(issueCcRecipients).values(issueValues.ccSubjects.map((recipient) => ({ issueId: insertedIssue!.id, subject: recipient })));
          await transaction.insert(issueWorkspaces).values({ issueId: insertedIssue!.id });
          await writePendingAttachments(transaction, stateRoot, { id: insertedIssue!.id, key: issueKey }, reporterSubject, initialAttachments, writtenObjectKeys);
          return insertedIssue!;
        });
      } catch (error) {
        await removeWrittenAttachments(writtenObjectKeys);
        throw error;
      }
    });
    engine.enqueue(createdIssue.id);
    return reply.code(201).send(await serializeIssueSummary(createdIssue));
  });

  app.patch<{ Params: { key: string } }>("/api/issues/:key", async (request) => {
    const issue = await requireIssue(database, request.params.key);
    assertIssueIdle(engine, issue.id);
    const input = record(request.body);
    const [issueEnvironment] = await database.db.select({ id: environments.id, kind: environments.kind }).from(environments).where(eq(environments.id, issue.environmentId)).limit(1);
    if (!issueEnvironment) throw new ApiError(409, "issue_scope_not_found");
    const issueValues = await parseIssueInput(input, issueEnvironment);
    await engine.closeSession(issue.id);
    await database.db.transaction(async (transaction) => {
      await transaction.update(issues).set({ title: issueValues.title, description: issueValues.description, priority: issueValues.priority, type: issueValues.type, serviceId: issueValues.serviceId, assigneeSubject: issueValues.assigneeSubject, updatedAt: new Date() }).where(eq(issues.id, issue.id));
      await transaction.delete(issueCcRecipients).where(eq(issueCcRecipients.issueId, issue.id));
      if (issueValues.ccSubjects.length) await transaction.insert(issueCcRecipients).values(issueValues.ccSubjects.map((recipient) => ({ issueId: issue.id, subject: recipient })));
    });
    return serializeIssueSummary(await requireIssue(database, issue.key));
  });

  app.patch<{ Params: { key: string } }>("/api/issues/:key/status", async (request) => {
    const issue = await requireIssue(database, request.params.key);
    const targetStatus = choice(record(request.body).status, "status", MANUAL_ISSUE_STATUSES);
    const validTransition = (targetStatus === "resolved" && issue.status === "pending") || (targetStatus === "open" && issue.status === "resolved");
    if (!validTransition) throw new ApiError(409, "invalid_issue_status_transition");
    if (targetStatus === "open") {
      try { return serializeIssueSummary(await workspaces.reopenIssue(issue.id)); }
      catch (error) {
        if (error instanceof WorkspaceRestoreRefusal) throw new ApiError(409, error.reason);
        throw error;
      }
    }
    const [updatedIssue] = await database.db.update(issues).set({ status: "resolved", resolvedAt: new Date(), updatedAt: new Date() }).where(and(eq(issues.id, issue.id), eq(issues.status, "pending"))).returning();
    if (!updatedIssue) throw new ApiError(409, "invalid_issue_status_transition");
    return serializeIssueSummary(updatedIssue);
  });

  app.get<{ Params: { key: string } }>("/api/issues/:key", async (request) => {
    const issue = await requireIssue(database, request.params.key);
    const [summary, repositoryRows, attachmentRows, workspaceRows, ccRows, sessionRows, reporterRows, commentRows, inspection] = await Promise.all([
      serializeIssueSummary(issue), database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id)), database.db.select().from(issueAttachments).where(eq(issueAttachments.issueId, issue.id)),
      database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, issue.id)),
      database.db.select({ person: subjects }).from(issueCcRecipients).innerJoin(subjects, eq(issueCcRecipients.subject, subjects.subject)).where(eq(issueCcRecipients.issueId, issue.id)), database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id)),
      database.db.select().from(subjects).where(eq(subjects.subject, issue.reporterSubject)), database.db.select({ comment: issueComments, person: subjects }).from(issueComments).innerJoin(subjects, eq(issueComments.authorSubject, subjects.subject)).where(eq(issueComments.issueId, issue.id)).orderBy(asc(issueComments.createdAt)),
      workspaces.inspectIssue(issue.id),
    ]);
    const workspace = workspaceRows[0]; const sessionBinding = sessionRows[0]; const reporter = reporterRows[0];
    const workspaceStatus = workspace?.status ?? "not_created";
    const sessionReady = sessionBinding ? await pathExists(sessionBinding.sessionFile) : false;
    const repositoryState = classifyRepositoryState(repositoryRows);
    const codeServerRoot = repositoryState === "invalid" ? null : issueRuntimeRoot(stateRoot, issue.key);
    return {
      ...summary, description: issue.description,
      repositories: repositoryRows.map((repository) => ({ url: repository.url, baseBranch: repository.baseBranch, workingBranch: repository.workingBranch })),
      attachments: attachmentRows.map(serializeAttachment),
      workspace: {
        status: workspaceStatus,
        url: workspace?.codeServerReady && codeServerRoot ? issueCodeServerUrl(stateRoot, issue.key, codeServerRoot) : null,
        lastError: workspace?.lastError ?? null,
        bytes: inspection.bytes,
        releasable: inspection.releasable,
        releaseBlockedReason: inspection.blockedReason,
        retryable: issue.status !== "resolved" && !engine.isRunning(issue.id) && (
          workspaceStatus !== "ready"
          || (!sessionReady && ["open", "in_progress"].includes(issue.status))
        ),
      },
      reporter: reporter ? serializePerson(reporter) : undefined,
      ccRecipients: ccRows.map(({ person }) => serializePerson(person)),
      environmentKey: (await database.db.select().from(environments).where(eq(environments.id, issue.environmentId)).limit(1))[0]?.key,
      comments: commentRows.map(({ comment, person }) => ({ id: comment.id, author: person.displayName ?? person.username ?? person.subject, body: comment.body, createdAt: comment.createdAt.toISOString() })),
    };
  });

  app.post<{ Params: { key: string } }>("/api/issues/:key/comments", async (request, reply) => {
    const issue = await requireIssue(database, request.params.key);
    const input = record(request.body);
    const authorSubject = await ensureCurrentSubject(database);
    const comment = await database.db.transaction(async (transaction) => {
      const [createdComment] = await transaction.insert(issueComments).values({ issueId: issue.id, authorSubject, body: text(input.body, "comment", 50_000) }).returning();
      await touchIssue(transaction, issue.id);
      return createdComment!;
    });
    return reply.code(201).send({ id: comment.id, author: authorSubject, body: comment.body, createdAt: comment.createdAt.toISOString() });
  });

}
