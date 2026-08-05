import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import Fastify, { type FastifyInstance } from "fastify";

import { Runner } from "../agent/runner.ts";
import type { RunEvent } from "../agent/events.ts";
import { openDatabase } from "../db/client.ts";
import {
  agentEvents, agentSessions, deploymentCapabilities, environments, issueAttachments, issueCcRecipients,
  issueComments, issueHistory, issueRepositories,
  issueWorkspaces, issues, serviceDeployments,
  serviceRepositories, services, subjects,
} from "../db/schema.ts";
import { loadIssuePolicy } from "../pi/policy.ts";
import { isIssueKey, normalizeIssueKey } from "../shared/issue-key.ts";
import { PtySessions } from "../workspace/pty.ts";

const CAPABILITIES = ["configuration_read", "database_read"] as const;
const ISSUE_PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
const ISSUE_TYPES = ["incident", "request", "question", "smart_analysis"] as const;
const MANUAL_ISSUE_STATUSES = ["open", "resolved"] as const;
const REPOSITORY_KINDS = ["frontend", "backend"] as const;
type Capability = typeof CAPABILITIES[number];

class ApiError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError(400, "invalid_request");
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, maximum = 10_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new ApiError(400, `invalid_${name}`);
  return value.trim();
}

function optionalText(value: unknown, maximum = 10_000): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > maximum) throw new ApiError(400, "invalid_text");
  return value.trim();
}

function strings(value: unknown, name: string, maximum = 100): string[] {
  if (!Array.isArray(value) || value.length > maximum || !value.every((entry) => typeof entry === "string" && entry.length > 0)) throw new ApiError(400, `invalid_${name}`);
  return value as string[];
}

function capabilities(value: unknown): Capability[] {
  const values = strings(value, "capabilities");
  if (values.some((entry) => !CAPABILITIES.includes(entry as Capability))) throw new ApiError(400, "invalid_capability");
  return [...new Set(values)] as Capability[];
}

function choice<const Values extends readonly string[]>(value: unknown, name: string, values: Values): Values[number] {
  const selected = text(value, name, 100);
  if (!values.includes(selected)) throw new ApiError(400, `invalid_${name}`);
  return selected as Values[number];
}

function date(value: Date | null | undefined): string | undefined {
  return value?.toISOString();
}

function datedKey(now = new Date()): string {
  const values = new Map(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map((part) => [part.type, part.value]));
  return `${values.get("year")}${values.get("month")}${values.get("day")}`;
}

export interface ApiOptions {
  databaseFile?: string;
  stateRoot?: string;
  runner?: Runner;
  piExecutable?: string;
  logger?: boolean;
}

export async function buildApi(options: ApiOptions = {}): Promise<FastifyInstance> {
  const stateRoot = path.resolve(options.stateRoot ?? process.env.ISSUE_PILOT_STATE_ROOT ?? ".issue-pilot");
  const database = openDatabase(options.databaseFile ?? process.env.ISSUE_PILOT_DATABASE ?? path.join(stateRoot, "issues.db"));
  await migrate(database.db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  await database.client.execute("PRAGMA foreign_keys = ON");
  await database.client.execute({
    sql: "UPDATE issues SET status = 'failed', updated_at = unixepoch() * 1000, version = version + 1 WHERE status NOT IN ('resolved', 'closed', 'failed') AND id IN (SELECT issue_id FROM issue_workspaces WHERE status IN ('preparing', 'running', 'failed'))",
    args: [],
  });
  await database.client.execute({
    sql: "UPDATE issue_workspaces SET status = 'failed', last_error = coalesce(last_error, 'agent_interrupted_by_api_restart'), updated_at = unixepoch() * 1000 WHERE status IN ('preparing', 'running')",
    args: [],
  });
  await database.client.execute({
    sql: "UPDATE issues SET status = 'pending', updated_at = unixepoch() * 1000, version = version + 1 WHERE status = 'in_progress' AND id IN (SELECT issue_id FROM issue_workspaces WHERE status = 'ready')",
    args: [],
  });
  for (const definition of [
    { key: "production", name: "正式", kind: "production" as const },
    { key: "test", name: "测试", kind: "test" as const },
  ]) {
    const [existing] = await database.db.select().from(environments).where(and(
      eq(environments.organizationId, "demo"), eq(environments.scope, "global"), eq(environments.key, definition.key),
    )).limit(1);
    if (existing) await database.db.update(environments).set({ name: definition.name, kind: definition.kind, updatedAt: new Date() }).where(eq(environments.id, existing.id));
    else await database.db.insert(environments).values({ organizationId: "demo", scope: "global", key: definition.key, name: definition.name, kind: definition.kind, config: {} });
  }
  const app = Fastify({ logger: options.logger ?? process.env.NODE_ENV !== "test" });
  await app.register(multipart, { limits: { files: 20, fileSize: 25 * 1024 * 1024 } });
  await app.register(websocket);

  const listeners = new Map<string, Set<(event: RunEvent) => void>>();
  const publish = (event: RunEvent) => { for (const listener of listeners.get(event.issueId) ?? []) listener(event); };
  const ptys = new PtySessions(options.piExecutable ?? process.env.PI_EXECUTABLE ?? "pi", path.resolve("src/pi/extension.ts"), process.env, path.join(stateRoot, "run-signals"));
  const runner = options.runner ?? new Runner(database.db, ptys, stateRoot, publish);
  const tickets = new Map<string, { issueId: string; issueKey: string; sessionFile: string; workspacePath: string; policyHash: string; tools: string[]; expiresAt: number }>();
  let issueCreationTail = Promise.resolve();
  const serializeIssueCreation = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = issueCreationTail;
    let release!: () => void;
    issueCreationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  };

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.message });
    const messages: string[] = [];
    const seen = new Set<unknown>();
    let current: unknown = error;
    while (current && !seen.has(current)) {
      seen.add(current);
      messages.push(current instanceof Error ? current.message : String(current));
      current = typeof current === "object" && "cause" in current ? (current as { cause?: unknown }).cause : undefined;
    }
    const message = messages.join("\n");
    if (/UNIQUE constraint failed/i.test(message)) return reply.code(409).send({ error: "conflict" });
    if (/FOREIGN KEY constraint failed/i.test(message)) return reply.code(409).send({ error: "resource_in_use" });
    app.log.error(error);
    return reply.code(500).send({ error: "internal_error" });
  });

  app.addHook("onClose", async () => {
    await ptys.close();
    await database.close();
  });

  const subject = async () => {
    const value = process.env.ISSUE_PILOT_SUBJECT ?? "demo-owner";
    await database.db.insert(subjects).values({ subject: value, username: value, displayName: value, email: "" }).onConflictDoNothing();
    return value;
  };

  const environmentByKey = async (key: string) => key === "production" || key === "test"
    ? (await database.db.select().from(environments).where(and(eq(environments.organizationId, "demo"), eq(environments.key, key))).limit(1))[0]
    : undefined;
  const serviceByKey = async (key: string) => (await database.db.select().from(services).where(and(eq(services.organizationId, "demo"), eq(services.scope, "global"), eq(services.key, key))).limit(1))[0];
  const serviceForEnvironment = async (key: string, environmentId: string) => (await database.db.select({ service: services, deployment: serviceDeployments })
    .from(services)
    .innerJoin(serviceDeployments, and(eq(serviceDeployments.serviceId, services.id), eq(serviceDeployments.environmentId, environmentId)))
    .where(and(eq(services.organizationId, "demo"), eq(services.scope, "global"), eq(services.key, key)))
    .limit(1))[0];
  const issueByKey = async (key: string) => isIssueKey(key) ? (await database.db.select().from(issues).where(eq(issues.key, normalizeIssueKey(key))).limit(1))[0] : undefined;
  const validateSubjects = async (values: Array<string | null>): Promise<void> => {
    const requested = [...new Set(values.filter((value): value is string => Boolean(value)))];
    if (!requested.length) return;
    const found = await database.db.select({ subject: subjects.subject }).from(subjects).where(inArray(subjects.subject, requested));
    if (found.length !== requested.length) throw new ApiError(400, "invalid_subject");
  };

  const listItems = async (selectedIssues: Array<typeof issues.$inferSelect>) => {
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
        version: issue.version, createdAt: date(issue.createdAt), updatedAt: issue.updatedAt.toISOString(),
      };
    });
  };
  const listItem = async (issue: typeof issues.$inferSelect) => (await listItems([issue]))[0]!;
  const codeServerFolder = (localPath: string | null): string | null => {
    if (!localPath) return null;
    const workspaceRoot = path.join(stateRoot, "workspaces");
    const relativePath = path.relative(workspaceRoot, path.resolve(localPath));
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
    return path.posix.join("/home/coder/project", ...relativePath.split(path.sep));
  };
  const attachmentItem = (attachment: typeof issueAttachments.$inferSelect) => ({
    id: attachment.id,
    fileName: attachment.fileName,
    mediaType: attachment.mediaType,
    size: attachment.size,
    sha256: attachment.sha256,
    scanStatus: attachment.scanStatus,
    createdAt: date(attachment.createdAt),
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/api/people", async () => (await database.db.select().from(subjects).orderBy(asc(subjects.displayName))).map((person) => ({
    subject: person.subject, name: person.displayName ?? person.username ?? person.subject, email: person.email ?? "",
  })));

  app.get("/api/config", async () => {
    const [environmentRows, serviceRows, deploymentRows, capabilityRows, repositoryRows] = await Promise.all([
      database.db.select().from(environments).where(and(eq(environments.organizationId, "demo"), eq(environments.scope, "global"), inArray(environments.key, ["production", "test"]))).orderBy(asc(environments.name)),
      database.db.select().from(services).where(and(eq(services.organizationId, "demo"), eq(services.scope, "global"))).orderBy(asc(services.sortOrder), asc(services.name)),
      database.db.select().from(serviceDeployments), database.db.select().from(deploymentCapabilities), database.db.select().from(serviceRepositories),
    ]);
    return {
      environments: environmentRows.map((item) => ({ id: item.id, key: item.key, name: item.name, kind: item.kind, scope: item.scope })),
      capabilityCatalog: [
        { key: "configuration_read", label: "配置读取", description: "按需合并冻结仓库配置、环境 profile 和批准的 Nacos 配置，并对敏感值脱敏。" },
        { key: "database_read", label: "数据库读取", description: "按需解析服务数据源，通过 MySQL 或 DMS 执行有行数限制的只读 SQL。" },
      ],
      services: serviceRows.map((service) => {
        const deployments = deploymentRows.filter((item) => item.serviceId === service.id);
        return {
          id: service.id, key: service.key, name: service.name, description: service.description, scope: service.scope,
          environmentIds: deployments.map((item) => item.environmentId),
          deployments: deployments.map((item) => ({ id: item.id, environmentId: item.environmentId, baseBranch: item.baseBranch, capabilities: capabilityRows.filter((capability) => capability.deploymentId === item.id).map((capability) => capability.capability) })),
          repositories: repositoryRows.filter((item) => item.serviceId === service.id).map((item) => ({ id: item.id, kind: item.kind, url: item.url })),
        };
      }),
    };
  });

  async function replaceServiceConfiguration(serviceId: string, input: Record<string, unknown>, serviceUpdate?: { name: string; description: string }): Promise<void> {
    const repositoriesInput = Array.isArray(input.repositories) ? input.repositories.map(record).map((repository) => ({
      id: optionalText(repository.id, 255),
      kind: choice(repository.kind, "repository_kind", REPOSITORY_KINDS),
      url: text(repository.url, "repository_url"),
    })) : [];
    if (!repositoriesInput.length) throw new ApiError(400, "repository_required");
    if (new Set(repositoriesInput.map((repository) => repository.url)).size !== repositoriesInput.length) throw new ApiError(400, "duplicate_repository");
    const deploymentsInput = Array.isArray(input.deployments) ? input.deployments.map(record).map((deployment) => ({
      environmentKey: text(deployment.environmentKey, "environment_key", 100),
      baseBranch: text(deployment.baseBranch, "base_branch", 255),
      capabilities: capabilities(deployment.capabilities ?? []),
    })) : [];
    if (new Set(deploymentsInput.map((deployment) => deployment.environmentKey)).size !== deploymentsInput.length) throw new ApiError(400, "duplicate_deployment_environment");
    const [existingRepositories, existingDeployments, environmentRows] = await Promise.all([
      database.db.select().from(serviceRepositories).where(eq(serviceRepositories.serviceId, serviceId)),
      database.db.select().from(serviceDeployments).where(eq(serviceDeployments.serviceId, serviceId)),
      database.db.select().from(environments).where(and(eq(environments.organizationId, "demo"), inArray(environments.key, ["production", "test"]))),
    ]);
    const environmentsByKey = new Map(environmentRows.map((environment) => [environment.key, environment]));
    if (deploymentsInput.some((deployment) => !environmentsByKey.has(deployment.environmentKey))) throw new ApiError(400, "invalid_environment");
    const existingById = new Map(existingRepositories.map((repository) => [repository.id, repository]));
    const configuredIds = repositoriesInput.flatMap((repository) => repository.id ? [repository.id] : []);
    if (new Set(configuredIds).size !== configuredIds.length || (serviceUpdate && configuredIds.some((id) => !existingById.has(id)))) throw new ApiError(400, "invalid_repository");
    const retainedEnvironmentIds = new Set(deploymentsInput.map((deployment) => environmentsByKey.get(deployment.environmentKey)!.id));
    for (const deployment of existingDeployments) {
      if (!retainedEnvironmentIds.has(deployment.environmentId) && (await database.db.select({ id: issues.id }).from(issues).where(and(eq(issues.serviceId, serviceId), eq(issues.environmentId, deployment.environmentId))).limit(1))[0]) throw new ApiError(409, "deployment_is_used_by_issues");
    }
    await database.db.transaction(async (transaction) => {
      if (serviceUpdate) await transaction.update(services).set({ ...serviceUpdate, updatedAt: new Date() }).where(eq(services.id, serviceId));
      const retainedIds = new Set<string>();
      for (const repository of repositoriesInput) {
        if (repository.id && existingById.has(repository.id)) {
          retainedIds.add(repository.id);
          await transaction.update(serviceRepositories).set({ kind: repository.kind, url: repository.url, updatedAt: new Date() }).where(and(eq(serviceRepositories.id, repository.id), eq(serviceRepositories.serviceId, serviceId)));
        } else {
          const [created] = await transaction.insert(serviceRepositories).values({ serviceId, kind: repository.kind, url: repository.url }).returning();
          retainedIds.add(created!.id);
        }
      }
      for (const repository of existingRepositories) if (!retainedIds.has(repository.id)) await transaction.delete(serviceRepositories).where(eq(serviceRepositories.id, repository.id));

      const existingByEnvironmentId = new Map(existingDeployments.map((deployment) => [deployment.environmentId, deployment]));
      const retainedDeploymentIds = new Set<string>();
      for (const deploymentInput of deploymentsInput) {
        const environment = environmentsByKey.get(deploymentInput.environmentKey)!;
        const existing = existingByEnvironmentId.get(environment.id);
        const deployment = existing
          ? (await transaction.update(serviceDeployments).set({ baseBranch: deploymentInput.baseBranch, updatedAt: new Date() }).where(eq(serviceDeployments.id, existing.id)).returning())[0]!
          : (await transaction.insert(serviceDeployments).values({ serviceId, environmentId: environment.id, baseBranch: deploymentInput.baseBranch, config: {} }).returning())[0]!;
        retainedDeploymentIds.add(deployment.id);
        await transaction.delete(deploymentCapabilities).where(eq(deploymentCapabilities.deploymentId, deployment.id));
        if (deploymentInput.capabilities.length) await transaction.insert(deploymentCapabilities).values(deploymentInput.capabilities.map((capability) => ({ deploymentId: deployment.id, capability })));
      }
      for (const deployment of existingDeployments) if (!retainedDeploymentIds.has(deployment.id)) await transaction.delete(serviceDeployments).where(eq(serviceDeployments.id, deployment.id));
    });
  }

  app.post("/api/services", async (request, reply) => {
    const input = record(request.body);
    const maximum = await database.db.select({ maximumSortOrder: sql<number>`coalesce(max(${services.sortOrder}), -1)` }).from(services).where(and(eq(services.organizationId, "demo"), eq(services.scope, "global")));
    const sortOrder = Number(maximum[0]?.maximumSortOrder ?? -1) + 1;
    const [created] = await database.db.insert(services).values({ organizationId: "demo", scope: "global", key: text(input.key, "key", 100), name: text(input.name, "name", 200), description: optionalText(input.description) ?? "", sortOrder }).returning();
    try { await replaceServiceConfiguration(created!.id, input); } catch (error) { await database.db.delete(services).where(eq(services.id, created!.id)); throw error; }
    return reply.code(201).send(created);
  });

  app.put("/api/services/order", async (request) => {
    const serviceKeys = strings(record(request.body).serviceKeys, "service_keys");
    if (new Set(serviceKeys).size !== serviceKeys.length) throw new ApiError(400, "invalid_service_order");
    const existing = await database.db.select({ id: services.id, key: services.key }).from(services).where(and(eq(services.organizationId, "demo"), eq(services.scope, "global")));
    const existingKeys = new Set(existing.map((service) => service.key));
    if (serviceKeys.length !== existing.length || serviceKeys.some((key) => !existingKeys.has(key))) throw new ApiError(400, "invalid_service_order");
    const byKey = new Map(existing.map((service) => [service.key, service]));
    await database.db.transaction(async (transaction) => {
      for (const [sortOrder, key] of serviceKeys.entries()) await transaction.update(services).set({ sortOrder, updatedAt: new Date() }).where(eq(services.id, byKey.get(key)!.id));
    });
    return { ok: true };
  });

  app.patch<{ Params: { key: string } }>("/api/services/:key", async (request) => {
    const service = await serviceByKey(request.params.key);
    if (!service) throw new ApiError(404, "service_not_found");
    const input = record(request.body);
    const serviceUpdate = { name: text(input.name, "name", 200), description: optionalText(input.description) ?? "" };
    await replaceServiceConfiguration(service.id, input, serviceUpdate);
    return { ok: true };
  });

  app.delete<{ Params: { key: string } }>("/api/services/:key", async (request, reply) => {
    const service = await serviceByKey(request.params.key);
    if (!service) throw new ApiError(404, "service_not_found");
    if ((await database.db.select({ id: issues.id }).from(issues).where(eq(issues.serviceId, service.id)).limit(1))[0]) throw new ApiError(409, "service_is_used_by_issues");
    await database.db.delete(services).where(eq(services.id, service.id));
    return reply.code(204).send();
  });

  app.get("/api/issues", async () => listItems(await database.db.select().from(issues).orderBy(desc(issues.updatedAt))));

  app.post("/api/issues", async (request, reply) => {
    const input = record(request.body);
    const environment = await environmentByKey(text(input.environmentKey, "environment_key", 100));
    if (!environment) throw new ApiError(400, "invalid_environment");
    const selected = await serviceForEnvironment(text(input.serviceKey, "service_key", 100), environment.id);
    if (!selected) throw new ApiError(400, "invalid_service_for_environment");
    const reporter = await subject();
    const assignee = optionalText(input.assigneeSubject, 255);
    const cc = [...new Set(strings(input.ccSubjects ?? [], "cc_subjects"))];
    await validateSubjects([assignee, ...cc]);
    const priority = choice(input.priority, "priority", ISSUE_PRIORITIES);
    const issueType = choice(input.type, "type", ISSUE_TYPES);
    const created = await serializeIssueCreation(async () => {
      const prefix = `ISSUE-${datedKey()}-`;
      const existing = await database.db.select({ key: issues.key }).from(issues);
      const sequence = Math.max(0, ...existing.flatMap(({ key }) => key.startsWith(prefix) ? [Number(key.slice(prefix.length)) || 0] : [])) + 1;
      const key = `${prefix}${String(sequence).padStart(3, "0")}`;
      return database.db.transaction(async (transaction) => {
        const [row] = await transaction.insert(issues).values({ key, title: text(input.title, "title", 300), description: optionalText(input.description) ?? "", priority, type: issueType, serviceId: selected.service.id, environmentId: environment.id, reporterSubject: reporter, assigneeSubject: assignee }).returning();
        if (cc.length) await transaction.insert(issueCcRecipients).values(cc.map((recipient) => ({ issueId: row!.id, subject: recipient })));
        await transaction.insert(issueWorkspaces).values({ issueId: row!.id, ownerSubject: reporter });
        await transaction.insert(issueHistory).values({ issueId: row!.id, actorSubject: reporter, action: "created", changes: {} });
        return row!;
      });
    });
    runner.enqueue(created.id);
    return reply.code(201).send(await listItem(created));
  });

  app.patch<{ Params: { key: string } }>("/api/issues/:key", async (request) => {
    const issue = await issueByKey(request.params.key);
    if (!issue) throw new ApiError(404, "issue_not_found");
    const input = record(request.body);
    const selected = await serviceForEnvironment(text(input.serviceKey, "service_key", 100), issue.environmentId);
    if (!selected) throw new ApiError(400, "invalid_service_for_environment");
    const cc = [...new Set(strings(input.ccSubjects ?? [], "cc_subjects"))];
    const assignee = optionalText(input.assigneeSubject, 255);
    await validateSubjects([assignee, ...cc]);
    const priority = choice(input.priority, "priority", ISSUE_PRIORITIES);
    const issueType = choice(input.type, "type", ISSUE_TYPES);
    if (!await runner.invalidatePolicy(issue.id)) throw new ApiError(409, "issue_terminal_active");
    await database.db.transaction(async (transaction) => {
      await transaction.update(issues).set({ title: text(input.title, "title", 300), description: optionalText(input.description) ?? "", priority, type: issueType, serviceId: selected.service.id, assigneeSubject: assignee, version: issue.version + 1, updatedAt: new Date() }).where(eq(issues.id, issue.id));
      await transaction.delete(issueCcRecipients).where(eq(issueCcRecipients.issueId, issue.id));
      if (cc.length) await transaction.insert(issueCcRecipients).values(cc.map((recipient) => ({ issueId: issue.id, subject: recipient })));
    });
    return listItem((await issueByKey(issue.key))!);
  });

  app.patch<{ Params: { key: string } }>("/api/issues/:key/status", async (request) => {
    const issue = await issueByKey(request.params.key);
    if (!issue) throw new ApiError(404, "issue_not_found");
    const target = choice(record(request.body).status, "status", MANUAL_ISSUE_STATUSES);
    const allowed = (target === "resolved" && issue.status === "pending") || (target === "open" && (issue.status === "resolved" || issue.status === "closed"));
    if (!allowed) throw new ApiError(409, "invalid_issue_status_transition");
    const actor = await subject();
    const updated = await database.db.transaction(async (transaction) => {
      const [row] = await transaction.update(issues).set({ status: target, resolvedAt: target === "resolved" ? new Date() : null, version: sql`${issues.version} + 1`, updatedAt: new Date() }).where(and(eq(issues.id, issue.id), eq(issues.status, issue.status))).returning();
      if (!row) throw new ApiError(409, "invalid_issue_status_transition");
      await transaction.insert(issueHistory).values({ issueId: issue.id, actorSubject: actor, action: `status:${target}`, changes: { from: issue.status, to: target } });
      return row;
    });
    return listItem(updated);
  });

  app.get<{ Params: { key: string } }>("/api/issues/:key", async (request) => {
    const issue = await issueByKey(request.params.key);
    if (!issue) throw new ApiError(404, "issue_not_found");
    const [base, repositoryRows, attachmentRows, workspaceRows, ccRows, sessionRows, reporterRows, commentRows] = await Promise.all([
      listItem(issue), database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id)), database.db.select().from(issueAttachments).where(eq(issueAttachments.issueId, issue.id)),
      database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, issue.id)),
      database.db.select({ person: subjects }).from(issueCcRecipients).innerJoin(subjects, eq(issueCcRecipients.subject, subjects.subject)).where(eq(issueCcRecipients.issueId, issue.id)), database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id)),
      database.db.select().from(subjects).where(eq(subjects.subject, issue.reporterSubject)), database.db.select().from(issueComments).where(eq(issueComments.issueId, issue.id)).orderBy(asc(issueComments.createdAt)),
    ]);
    const workspace = workspaceRows[0]; const session = sessionRows[0]; const reporter = reporterRows[0];
    const sessionReady = session ? await readFile(session.sessionFile).then(() => true, () => false) : false;
    const sessionLive = sessionReady && ptys.has(issue.id);
    return {
      ...base, description: issue.description,
      repositories: repositoryRows.map((item) => ({ id: item.id, url: item.url, baseBranch: item.baseBranch, workingBranch: item.workingBranch, codeServerPath: codeServerFolder(item.localPath) })),
      attachments: attachmentRows.map(attachmentItem),
      workspace: {
        status: workspace?.status ?? "not_created",
        url: workspace?.codeServerUrl ?? null,
        lastError: workspace?.lastError ?? null,
        retryable: !runner.isRunning(issue.id) && (
          ["not_created", "preparing", "running", "stopped", "failed"].includes(workspace?.status ?? "not_created")
          || (workspace?.status === "ready" && !sessionLive && ["open", "in_progress", "failed"].includes(issue.status))
        ),
      },
      agentSession: sessionLive ? { sessionId: session!.piSessionId } : null,
      reporter: reporter ? { subject: reporter.subject, name: reporter.displayName ?? reporter.username ?? reporter.subject, email: reporter.email ?? "" } : undefined,
      ccRecipients: ccRows.map(({ person }) => ({ subject: person.subject, name: person.displayName ?? person.username ?? person.subject, email: person.email ?? "" })),
      environmentKey: (await database.db.select().from(environments).where(eq(environments.id, issue.environmentId)).limit(1))[0]?.key,
      comments: commentRows.map((item) => ({ id: item.id, author: item.authorSubject, body: item.body, createdAt: item.createdAt.toISOString() })),
      terminalTranscript: await runner.getTerminalTranscript(issue.id),
    };
  });

  app.post<{ Params: { key: string } }>("/api/issues/:key/retry", async (request, reply) => {
    const issue = await issueByKey(request.params.key);
    if (!issue) throw new ApiError(404, "issue_not_found");
    if (runner.isRunning(issue.id)) throw new ApiError(409, "issue_already_running");
    await database.db.transaction(async (transaction) => {
      await transaction.update(issueWorkspaces).set({ status: "preparing", lastError: null, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id));
      await transaction.update(issues).set({ status: "in_progress", resolvedAt: null, version: issue.version + 1, updatedAt: new Date() }).where(eq(issues.id, issue.id));
    });
    runner.enqueue(issue.id);
    return reply.code(202).send({ ok: true });
  });

  app.post<{ Params: { key: string } }>("/api/issues/:key/comments", async (request, reply) => {
    const issue = await issueByKey(request.params.key); if (!issue) throw new ApiError(404, "issue_not_found");
    const input = record(request.body); const author = await subject();
    const comment = await database.db.transaction(async (transaction) => {
      const [created] = await transaction.insert(issueComments).values({ issueId: issue.id, authorSubject: author, body: text(input.body, "comment", 50_000) }).returning();
      await transaction.update(issues).set({ status: "in_progress", resolvedAt: null, version: sql`${issues.version} + 1`, updatedAt: new Date() }).where(eq(issues.id, issue.id));
      return created!;
    });
    runner.enqueue(issue.id, comment.id);
    return reply.code(201).send({ id: comment.id, author, body: comment.body, createdAt: comment.createdAt.toISOString() });
  });

  app.post<{ Params: { key: string } }>("/api/issues/:key/attachments", async (request, reply) => {
    const issue = await issueByKey(request.params.key); if (!issue) throw new ApiError(404, "issue_not_found");
    const uploader = await subject(); const created: Array<ReturnType<typeof attachmentItem>> = [];
    for await (const part of request.files()) {
      const data = await part.toBuffer(); const sha256 = createHash("sha256").update(data).digest("hex");
      const directory = path.join(stateRoot, "attachments", issue.key.toLowerCase()); await mkdir(directory, { recursive: true, mode: 0o700 });
      const objectKey = path.join(directory, `${randomUUID()}-${path.basename(part.filename)}`); await writeFile(objectKey, data, { mode: 0o600 });
      try {
        const [attachment] = await database.db.insert(issueAttachments).values({ issueId: issue.id, fileName: path.basename(part.filename), mediaType: part.mimetype, size: data.length, objectKey, sha256, uploadedBy: uploader }).returning(); created.push(attachmentItem(attachment!));
      } catch (error) {
        await rm(objectKey, { force: true });
        throw error;
      }
    }
    return reply.code(201).send(created);
  });

  app.get<{ Params: { key: string } }>("/api/issues/:key/agent-stream", async (request, reply) => {
    const issue = await issueByKey(request.params.key); if (!issue) throw new ApiError(404, "issue_not_found");
    reply.hijack(); reply.raw.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache", connection: "keep-alive" });
    for (const event of await database.db.select().from(agentEvents).where(eq(agentEvents.issueId, issue.id)).orderBy(asc(agentEvents.createdAt))) reply.raw.write(`${JSON.stringify({ ...event, createdAt: event.createdAt.toISOString() })}\n`);
    const listener = (event: RunEvent) => reply.raw.write(`${JSON.stringify(event)}\n`); const set = listeners.get(issue.id) ?? new Set(); set.add(listener); listeners.set(issue.id, set);
    const heartbeat = setInterval(() => reply.raw.write(`${JSON.stringify({ type: "heartbeat" })}\n`), 15_000); heartbeat.unref();
    request.raw.once("close", () => { clearInterval(heartbeat); set.delete(listener); if (!set.size) listeners.delete(issue.id); });
  });

  app.post<{ Params: { key: string } }>("/api/issues/:key/terminal-ticket", async (request) => {
    const issue = await issueByKey(request.params.key); if (!issue) throw new ApiError(404, "issue_not_found");
    const session = (await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id)).limit(1))[0]; if (!session) throw new ApiError(409, "pi_session_not_ready");
    try { await Promise.all([readFile(session.sessionFile), readFile(path.join(session.workspacePath, ".issue-pilot", "pi-terminal-token"))]); }
    catch { throw new ApiError(409, "pi_session_not_ready"); }
    if (!ptys.has(issue.id)) throw new ApiError(409, "pi_terminal_not_running");
    const policy = await loadIssuePolicy(session.workspacePath, stateRoot);
    const policyHash = createHash("sha256").update(JSON.stringify(policy)).digest("hex");
    const ticket = randomUUID(); const expiresAt = Date.now() + 30_000; tickets.set(ticket, { issueId: issue.id, issueKey: issue.key, sessionFile: session.sessionFile, workspacePath: session.workspacePath, policyHash, tools: policy.tools, expiresAt });
    return { ticket, mode: "pty", expiresAt: new Date(expiresAt).toISOString() };
  });

  app.get<{ Params: { key: string }; Querystring: { ticket?: string } }>("/api/issues/:key/terminal", { websocket: true }, (socket, request) => {
    const ticket = request.query.ticket ? tickets.get(request.query.ticket) : undefined; if (request.query.ticket) tickets.delete(request.query.ticket);
    if (!ticket || ticket.expiresAt < Date.now() || ticket.issueKey !== request.params.key.toUpperCase()) return socket.close(1008, "invalid_ticket");
    let attachment: ReturnType<PtySessions["attach"]> | undefined;
    try {
      attachment = ptys.attach(ticket, { output: (data) => socket.send(JSON.stringify({ type: "output", data })), exit: (exitCode) => { socket.send(JSON.stringify({ type: "exit", exitCode })); socket.close(); } }, 100, 30);
    } catch { return socket.close(1011, "terminal_unavailable"); }
    socket.on("message", (buffer) => { try { const message = JSON.parse(buffer.toString()) as { type?: string; data?: string; cols?: number; rows?: number }; if (message.type === "input" && typeof message.data === "string") attachment?.input(message.data); else if (message.type === "resize") attachment?.resize(message.cols ?? 100, message.rows ?? 30); } catch { socket.close(1003, "invalid_message"); } });
    socket.once("close", () => attachment?.detach());
  });

  return app;
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") throw new Error("issue_pilot_api_must_bind_to_loopback");
  const app = await buildApi();
  await app.listen({ port, host });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
