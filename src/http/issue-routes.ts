import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { agentSessions, environments, issueAttachments, issueCcRecipients, issueComments, issueRepositories, issues, issueWorkspaces, serviceDeployments, services, subjects } from "../db/schema.ts";
import { ENVIRONMENT_KINDS, ISSUE_PRIORITIES, ISSUE_TYPES, ISSUE_TYPES_BY_ENVIRONMENT, type EnvironmentKind, type IssueType } from "../domain/contracts.ts";
import { issueCodeServerUrl } from "../workspace/code-server.ts";
import { issueAttachmentRoot } from "../workspace/state.ts";
import { type PendingAttachment, readMultipartAttachment, serializeAttachment } from "./attachments.ts";
import { ApiError, choice, optionalText, record, strings, text } from "./input.ts";
import { ensureCurrentSubject, assertIssueIdle, requireIssue, type ApiRouteContext } from "./route-context.ts";

const MANUAL_ISSUE_STATUSES = ["open", "resolved"] as const;

function assertIssueTypeForEnvironment(issueType: IssueType, environmentKind: string): void {
  const allowed = ISSUE_TYPES_BY_ENVIRONMENT[environmentKind as EnvironmentKind];
  if (!allowed?.includes(issueType)) throw new ApiError(400, "invalid_issue_type_for_environment");
}

function isoDate(value: Date | null | undefined): string | undefined {
  return value?.toISOString();
}

function shanghaiDateStamp(now = new Date()): string {
  const values = new Map(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map((part) => [part.type, part.value]));
  return `${values.get("year")}${values.get("month")}${values.get("day")}`;
}

export function registerIssueRoutes(context: ApiRouteContext): void {
  const { app, database, engine, stateRoot, workspaces } = context;
  let issueCreationTail = Promise.resolve();
  const serializeIssueCreation = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = issueCreationTail;
    let release!: () => void;
    issueCreationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  };
  const findEnvironmentByKey = async (key: string) => ENVIRONMENT_KINDS.includes(key as EnvironmentKind)
    ? (await database.db.select().from(environments).where(eq(environments.key, key)).limit(1))[0]
    : undefined;
  const findServiceDeployment = async (key: string, environmentId: string) => (await database.db.select({ service: services, deployment: serviceDeployments })
    .from(services)
    .innerJoin(serviceDeployments, and(eq(serviceDeployments.serviceId, services.id), eq(serviceDeployments.environmentId, environmentId)))
    .where(eq(services.key, key))
    .limit(1))[0];
  const validateSubjects = async (values: Array<string | null>): Promise<void> => {
    const requested = [...new Set(values.filter((value): value is string => Boolean(value)))];
    if (!requested.length) return;
    const found = await database.db.select({ subject: subjects.subject }).from(subjects).where(inArray(subjects.subject, requested));
    if (found.length !== requested.length) throw new ApiError(400, "invalid_subject");
  };
  const parseIssueInput = async (input: Record<string, unknown>, environment: { id: string; kind: string }) => {
    const serviceDeployment = await findServiceDeployment(text(input.serviceKey, "service_key", 100), environment.id);
    if (!serviceDeployment) throw new ApiError(400, "invalid_service_for_environment");
    const assignee = optionalText(input.assigneeSubject, 255);
    const cc = [...new Set(strings(input.ccSubjects ?? [], "cc_subjects"))];
    await validateSubjects([assignee, ...cc]);
    const type = choice(input.type, "type", ISSUE_TYPES);
    assertIssueTypeForEnvironment(type, environment.kind);
    return {
      title: text(input.title, "title", 300),
      description: optionalText(input.description) ?? "",
      priority: choice(input.priority, "priority", ISSUE_PRIORITIES),
      type,
      serviceId: serviceDeployment.service.id,
      assignee,
      cc,
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
      let issuePart: unknown;
      for await (const part of request.parts()) {
        if (part.type === "file") {
          const attachment = await readMultipartAttachment(part, attachmentBytes);
          attachmentBytes += attachment.data.length;
          initialAttachments.push(attachment);
        } else if (part.fieldname === "issue") {
          issuePart = part.value;
        }
      }
      try {
        input = record(JSON.parse(text(issuePart, "issue", 100_000)));
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(400, "invalid_issue");
      }
    } else {
      input = record(request.body);
    }
    const environment = await findEnvironmentByKey(text(input.environmentKey, "environment_key", 100));
    if (!environment) throw new ApiError(400, "invalid_environment");
    const reporter = await ensureCurrentSubject(database);
    const parsed = await parseIssueInput(input, environment);
    const created = await serializeIssueCreation(async () => {
      const prefix = `ISSUE-${shanghaiDateStamp()}-`;
      const existing = await database.db.select({ key: issues.key }).from(issues);
      const sequence = Math.max(0, ...existing.flatMap(({ key }) => key.startsWith(prefix) ? [Number(key.slice(prefix.length)) || 0] : [])) + 1;
      const key = `${prefix}${String(sequence).padStart(3, "0")}`;
      const written: string[] = [];
      try {
        return await database.db.transaction(async (transaction) => {
          const [row] = await transaction.insert(issues).values({ key, title: parsed.title, description: parsed.description, priority: parsed.priority, type: parsed.type, serviceId: parsed.serviceId, environmentId: environment.id, reporterSubject: reporter, assigneeSubject: parsed.assignee }).returning();
          if (parsed.cc.length) await transaction.insert(issueCcRecipients).values(parsed.cc.map((recipient) => ({ issueId: row!.id, subject: recipient })));
          await transaction.insert(issueWorkspaces).values({ issueId: row!.id });
          if (initialAttachments.length) {
            const directory = issueAttachmentRoot(stateRoot, key);
            await mkdir(directory, { recursive: true, mode: 0o700 });
            for (const file of initialAttachments) {
              const objectKey = path.join(directory, `${randomUUID()}-${file.fileName}`);
              await writeFile(objectKey, file.data, { mode: 0o600 });
              written.push(objectKey);
              await transaction.insert(issueAttachments).values({ issueId: row!.id, fileName: file.fileName, mediaType: file.mediaType, size: file.data.length, objectKey, sha256: file.sha256, uploadedBy: reporter });
            }
          }
          return row!;
        });
      } catch (error) {
        await Promise.all(written.map((objectKey) => rm(objectKey, { force: true }).catch(() => undefined)));
        throw error;
      }
    });
    engine.enqueue(created.id);
    return reply.code(201).send(await serializeIssueSummary(created));
  });

  app.patch<{ Params: { key: string } }>("/api/issues/:key", async (request) => {
    const issue = await requireIssue(database, request.params.key);
    assertIssueIdle(engine, issue.id);
    const input = record(request.body);
    const [environment] = await database.db.select({ id: environments.id, kind: environments.kind }).from(environments).where(eq(environments.id, issue.environmentId)).limit(1);
    if (!environment) throw new ApiError(409, "issue_scope_not_found");
    const parsed = await parseIssueInput(input, environment);
    await engine.closeSession(issue.id);
    await database.db.transaction(async (transaction) => {
      await transaction.update(issues).set({ title: parsed.title, description: parsed.description, priority: parsed.priority, type: parsed.type, serviceId: parsed.serviceId, assigneeSubject: parsed.assignee, updatedAt: new Date() }).where(eq(issues.id, issue.id));
      await transaction.delete(issueCcRecipients).where(eq(issueCcRecipients.issueId, issue.id));
      if (parsed.cc.length) await transaction.insert(issueCcRecipients).values(parsed.cc.map((recipient) => ({ issueId: issue.id, subject: recipient })));
    });
    return serializeIssueSummary(await requireIssue(database, issue.key));
  });

  app.patch<{ Params: { key: string } }>("/api/issues/:key/status", async (request) => {
    const issue = await requireIssue(database, request.params.key);
    const target = choice(record(request.body).status, "status", MANUAL_ISSUE_STATUSES);
    const allowed = (target === "resolved" && issue.status === "pending") || (target === "open" && issue.status === "resolved");
    if (!allowed) throw new ApiError(409, "invalid_issue_status_transition");
    const [updated] = await database.db.update(issues).set({ status: target, resolvedAt: target === "resolved" ? new Date() : null, updatedAt: new Date() }).where(and(eq(issues.id, issue.id), eq(issues.status, issue.status))).returning();
    if (!updated) throw new ApiError(409, "invalid_issue_status_transition");
    return serializeIssueSummary(updated);
  });

  app.get<{ Params: { key: string } }>("/api/issues/:key", async (request) => {
    const issue = await requireIssue(database, request.params.key);
    const [base, repositoryRows, attachmentRows, workspaceRows, ccRows, sessionRows, reporterRows, commentRows, workspaceStorage] = await Promise.all([
      serializeIssueSummary(issue), database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id)), database.db.select().from(issueAttachments).where(eq(issueAttachments.issueId, issue.id)),
      database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, issue.id)),
      database.db.select({ person: subjects }).from(issueCcRecipients).innerJoin(subjects, eq(issueCcRecipients.subject, subjects.subject)).where(eq(issueCcRecipients.issueId, issue.id)), database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id)),
      database.db.select().from(subjects).where(eq(subjects.subject, issue.reporterSubject)), database.db.select({ comment: issueComments, person: subjects }).from(issueComments).innerJoin(subjects, eq(issueComments.authorSubject, subjects.subject)).where(eq(issueComments.issueId, issue.id)).orderBy(asc(issueComments.createdAt)),
      workspaces.inspectIssue(issue.id),
    ]);
    const workspace = workspaceRows[0]; const session = sessionRows[0]; const reporter = reporterRows[0];
    const sessionReady = session ? await readFile(session.sessionFile).then(() => true, () => false) : false;
    return {
      ...base, description: issue.description,
      repositories: repositoryRows.map((item) => ({ url: item.url, baseBranch: item.baseBranch, workingBranch: item.workingBranch })),
      attachments: attachmentRows.map(serializeAttachment),
      workspace: {
        status: workspace?.status ?? "not_created",
        url: workspace?.codeServerReady && session ? issueCodeServerUrl(stateRoot, issue.key, session.workspacePath) : null,
        lastError: workspace?.lastError ?? null,
        bytes: workspaceStorage.bytes,
        releasable: workspaceStorage.releasable,
        releaseBlockedReason: workspaceStorage.blockedReason,
        retryable: issue.status !== "resolved" && !engine.isRunning(issue.id) && (
          ["not_created", "preparing", "running", "stopped", "failed"].includes(workspace?.status ?? "not_created")
          || (workspace?.status === "ready" && !sessionReady && ["open", "in_progress"].includes(issue.status))
        ),
      },
      reporter: reporter ? { subject: reporter.subject, name: reporter.displayName ?? reporter.username ?? reporter.subject, email: reporter.email ?? "" } : undefined,
      ccRecipients: ccRows.map(({ person }) => ({ subject: person.subject, name: person.displayName ?? person.username ?? person.subject, email: person.email ?? "" })),
      environmentKey: (await database.db.select().from(environments).where(eq(environments.id, issue.environmentId)).limit(1))[0]?.key,
      comments: commentRows.map(({ comment, person }) => ({ id: comment.id, author: person.displayName ?? person.username ?? person.subject, body: comment.body, createdAt: comment.createdAt.toISOString() })),
    };
  });

  app.post<{ Params: { key: string } }>("/api/issues/:key/comments", async (request, reply) => {
    const issue = await requireIssue(database, request.params.key);
    const input = record(request.body); const author = await ensureCurrentSubject(database);
    const comment = await database.db.transaction(async (transaction) => {
      const [created] = await transaction.insert(issueComments).values({ issueId: issue.id, authorSubject: author, body: text(input.body, "comment", 50_000) }).returning();
      await transaction.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, issue.id));
      return created!;
    });
    return reply.code(201).send({ id: comment.id, author, body: comment.body, createdAt: comment.createdAt.toISOString() });
  });

}
