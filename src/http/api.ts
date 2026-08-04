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
  issueComments, issueDiagnoses, issueEvidence, issueHistory, issueRepositories, issueServiceModules,
  issueServices, issueTestRuns, issueWorkspaces, issues, serviceDeployments, serviceModules,
  serviceRelationModules, serviceRelations, serviceRepositories, services, subjects,
} from "../db/schema.ts";
import { isIssueKey, normalizeIssueKey } from "../shared/issue-key.ts";
import { PtySessions } from "../workspace/pty.ts";

const CAPABILITIES = ["configuration_read", "database_read", "cache_read", "log_read"] as const;
const ISSUE_PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
const ISSUE_TYPES = ["incident", "request", "task", "problem", "question", "smart_analysis"] as const;
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
  return [...new Set(value as string[])];
}

function capabilities(value: unknown): Capability[] {
  const values = strings(value, "capabilities");
  if (values.some((entry) => !CAPABILITIES.includes(entry as Capability))) throw new ApiError(400, "invalid_capability");
  return values as Capability[];
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
  const ptys = new PtySessions(options.piExecutable ?? process.env.PI_EXECUTABLE ?? "pi", path.resolve("src/evidence/extension.ts"), process.env, path.join(stateRoot, "run-signals"));
  const runner = options.runner ?? new Runner(database.db, ptys, stateRoot, publish);
  const tickets = new Map<string, { issueId: string; issueKey: string; sessionFile: string; workspacePath: string; expiresAt: number }>();
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
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE constraint failed/i.test(message)) return reply.code(409).send({ error: "conflict" });
    if (/FOREIGN KEY constraint failed/i.test(message)) return reply.code(409).send({ error: "resource_in_use" });
    app.log.error(error);
    return reply.code(500).send({ error: "internal_error" });
  });

  app.addHook("onClose", async () => {
    ptys.close();
    database.close();
  });

  const subject = async () => {
    const value = process.env.ISSUE_PILOT_SUBJECT ?? "demo-owner";
    await database.db.insert(subjects).values({ subject: value, username: value, displayName: value, email: "" }).onConflictDoNothing();
    return value;
  };

  const environmentByKey = async (key: string) => key === "production" || key === "test"
    ? (await database.db.select().from(environments).where(and(eq(environments.organizationId, "demo"), eq(environments.key, key))).limit(1))[0]
    : undefined;
  const serviceByKey = async (key: string) => (await database.db.select().from(services).where(and(eq(services.organizationId, "demo"), eq(services.key, key))).limit(1))[0];
  const issueByKey = async (key: string) => isIssueKey(key) ? (await database.db.select().from(issues).where(eq(issues.key, normalizeIssueKey(key))).limit(1))[0] : undefined;
  const validateSubjects = async (values: Array<string | null>): Promise<void> => {
    const requested = [...new Set(values.filter((value): value is string => Boolean(value)))];
    if (!requested.length) return;
    const found = await database.db.select({ subject: subjects.subject }).from(subjects).where(inArray(subjects.subject, requested));
    if (found.length !== requested.length) throw new ApiError(400, "invalid_subject");
  };

  const listItem = async (issue: typeof issues.$inferSelect) => {
    const assignee = issue.assigneeSubject ? (await database.db.select().from(subjects).where(eq(subjects.subject, issue.assigneeSubject)).limit(1))[0] : undefined;
    return {
      id: issue.key, title: issue.title, priority: issue.priority, type: issue.type, status: issue.status,
      assignee: assignee?.displayName ?? assignee?.username ?? null, assigneeSubject: issue.assigneeSubject,
      version: issue.version, createdAt: date(issue.createdAt), updatedAt: issue.updatedAt.toISOString(), labels: issue.labels,
    };
  };
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
    const [environmentRows, serviceRows, deploymentRows, capabilityRows, repositoryRows, moduleRows, relationRows, relationModuleRows] = await Promise.all([
      database.db.select().from(environments).where(and(eq(environments.organizationId, "demo"), eq(environments.scope, "global"), inArray(environments.key, ["production", "test"]))).orderBy(asc(environments.name)),
      database.db.select().from(services).where(and(eq(services.organizationId, "demo"), eq(services.scope, "global"))).orderBy(asc(services.sortOrder), asc(services.name)),
      database.db.select().from(serviceDeployments), database.db.select().from(deploymentCapabilities), database.db.select().from(serviceRepositories),
      database.db.select().from(serviceModules), database.db.select().from(serviceRelations), database.db.select().from(serviceRelationModules),
    ]);
    return {
      environments: environmentRows.map((item) => ({ id: item.id, key: item.key, name: item.name, kind: item.kind, scope: item.scope })),
      capabilityCatalog: [
        { key: "configuration_read", label: "配置读取" }, { key: "database_read", label: "数据库读取" },
        { key: "cache_read", label: "缓存读取" }, { key: "log_read", label: "日志读取" },
      ],
      services: serviceRows.map((service) => {
        const deployments = deploymentRows.filter((item) => item.serviceId === service.id);
        return {
          id: service.id, key: service.key, name: service.name, description: service.description, scope: service.scope,
          environmentIds: deployments.map((item) => item.environmentId),
          deployments: deployments.map((item) => ({ id: item.id, environmentId: item.environmentId, baseBranch: item.baseBranch, capabilities: capabilityRows.filter((capability) => capability.deploymentId === item.id).map((capability) => capability.capability) })),
          repositories: repositoryRows.filter((item) => item.serviceId === service.id).map((item) => ({ id: item.id, url: item.url, role: item.role })),
          modules: moduleRows.filter((item) => item.serviceId === service.id).map((item) => ({ id: item.id, name: item.name, path: item.path, description: item.description })),
          relatedServiceIds: relationRows.filter((item) => item.sourceServiceId === service.id).map((item) => item.targetServiceId),
          relatedModuleIds: relationModuleRows.filter((item) => item.sourceServiceId === service.id).map((item) => item.moduleId),
        };
      }),
    };
  });

  app.post("/api/environments", async (_request, reply) => reply.code(405).send({ error: "environment_configuration_fixed" }));
  app.patch<{ Params: { key: string } }>("/api/environments/:key", async (_request, reply) => reply.code(405).send({ error: "environment_configuration_fixed" }));
  app.delete<{ Params: { key: string } }>("/api/environments/:key", async (_request, reply) => reply.code(405).send({ error: "environment_configuration_fixed" }));

  async function replaceServiceConfiguration(serviceId: string, input: Record<string, unknown>, serviceUpdate?: { name: string; description: string }): Promise<void> {
    const repositoriesInput = Array.isArray(input.repositories) ? input.repositories.map(record) : [];
    const modulesInput = Array.isArray(input.modules) ? input.modules.map(record) : [];
    const relatedServiceKeys = strings(input.relatedServiceKeys ?? [], "related_service_keys");
    const relatedModuleIds = strings(input.relatedModuleIds ?? [], "related_module_ids");
    const related = relatedServiceKeys.length ? await database.db.select().from(services).where(inArray(services.key, relatedServiceKeys)) : [];
    if (related.length !== relatedServiceKeys.length || related.some((item) => item.id === serviceId)) throw new ApiError(400, "invalid_related_service");
    const validModules = relatedModuleIds.length ? await database.db.select().from(serviceModules).where(inArray(serviceModules.id, relatedModuleIds)) : [];
    if (validModules.length !== relatedModuleIds.length || validModules.some((module) => !related.some((item) => item.id === module.serviceId))) throw new ApiError(400, "invalid_related_module");
    await database.db.transaction(async (transaction) => {
      if (serviceUpdate) await transaction.update(services).set({ ...serviceUpdate, updatedAt: new Date() }).where(eq(services.id, serviceId));
      await transaction.delete(serviceRelationModules).where(eq(serviceRelationModules.sourceServiceId, serviceId));
      await transaction.delete(serviceRelations).where(eq(serviceRelations.sourceServiceId, serviceId));
      await transaction.delete(serviceRepositories).where(eq(serviceRepositories.serviceId, serviceId));
      await transaction.delete(serviceModules).where(eq(serviceModules.serviceId, serviceId));
      if (repositoriesInput.length > 1) throw new ApiError(400, "one_repository_per_service");
      if (repositoriesInput[0]) await transaction.insert(serviceRepositories).values({ serviceId, url: text(repositoriesInput[0].url, "repository_url"), role: optionalText(repositoriesInput[0].role, 100) ?? "application" });
      if (modulesInput.length) await transaction.insert(serviceModules).values(modulesInput.map((module) => ({ serviceId, id: typeof module.id === "string" ? module.id : randomUUID(), name: text(module.name, "module_name", 200), path: text(module.path, "module_path", 1000), description: optionalText(module.description) ?? "" })));
      if (related.length) await transaction.insert(serviceRelations).values(related.map((target) => ({ sourceServiceId: serviceId, targetServiceId: target.id })));
      if (validModules.length) await transaction.insert(serviceRelationModules).values(validModules.map((module) => ({ sourceServiceId: serviceId, targetServiceId: module.serviceId, moduleId: module.id })));
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
    if ((await database.db.select().from(issueServices).where(eq(issueServices.serviceId, service.id)).limit(1))[0]) throw new ApiError(409, "service_is_used_by_issues");
    await database.db.delete(services).where(eq(services.id, service.id));
    return reply.code(204).send();
  });

  app.post<{ Params: { key: string } }>("/api/services/:key/deployments", async (request, reply) => {
    const service = await serviceByKey(request.params.key);
    if (!service) throw new ApiError(404, "service_not_found");
    const input = record(request.body);
    const environment = await environmentByKey(text(input.environmentKey, "environment_key", 100));
    if (!environment) throw new ApiError(400, "invalid_environment");
    const [deployment] = await database.db.insert(serviceDeployments).values({ serviceId: service.id, environmentId: environment.id, baseBranch: text(input.baseBranch, "base_branch", 255), config: {} }).returning();
    const granted = capabilities(input.capabilities ?? []);
    if (granted.length) await database.db.insert(deploymentCapabilities).values(granted.map((capability) => ({ deploymentId: deployment!.id, capability })));
    return reply.code(201).send(deployment);
  });

  app.patch<{ Params: { key: string; environmentKey: string } }>("/api/services/:key/deployments/:environmentKey", async (request) => {
    const [service, environment] = await Promise.all([serviceByKey(request.params.key), environmentByKey(request.params.environmentKey)]);
    if (!service || !environment) throw new ApiError(404, "deployment_not_found");
    const deployment = (await database.db.select().from(serviceDeployments).where(and(eq(serviceDeployments.serviceId, service.id), eq(serviceDeployments.environmentId, environment.id))).limit(1))[0];
    if (!deployment) throw new ApiError(404, "deployment_not_found");
    const input = record(request.body);
    await database.db.transaction(async (transaction) => {
      await transaction.update(serviceDeployments).set({ baseBranch: text(input.baseBranch, "base_branch", 255), updatedAt: new Date() }).where(eq(serviceDeployments.id, deployment.id));
      await transaction.delete(deploymentCapabilities).where(eq(deploymentCapabilities.deploymentId, deployment.id));
      const granted = capabilities(input.capabilities ?? []);
      if (granted.length) await transaction.insert(deploymentCapabilities).values(granted.map((capability) => ({ deploymentId: deployment.id, capability })));
    });
    return { ok: true };
  });

  app.delete<{ Params: { key: string; environmentKey: string } }>("/api/services/:key/deployments/:environmentKey", async (request, reply) => {
    const [service, environment] = await Promise.all([serviceByKey(request.params.key), environmentByKey(request.params.environmentKey)]);
    if (!service || !environment) throw new ApiError(404, "deployment_not_found");
    const deployment = (await database.db.select().from(serviceDeployments).where(and(eq(serviceDeployments.serviceId, service.id), eq(serviceDeployments.environmentId, environment.id))).limit(1))[0];
    if (!deployment) throw new ApiError(404, "deployment_not_found");
    if ((await database.db.select().from(issueServices).where(eq(issueServices.deploymentId, deployment.id)).limit(1))[0]) throw new ApiError(409, "deployment_is_used_by_issues");
    await database.db.delete(serviceDeployments).where(eq(serviceDeployments.id, deployment.id));
    return reply.code(204).send();
  });

  app.get("/api/issues", async () => Promise.all((await database.db.select().from(issues).orderBy(desc(issues.updatedAt))).map(listItem)));

  app.post("/api/issues", async (request, reply) => {
    const input = record(request.body);
    const environment = await environmentByKey(text(input.environmentKey, "environment_key", 100));
    if (!environment) throw new ApiError(400, "invalid_environment");
    const serviceKeys = strings(input.serviceKeys, "service_keys");
    if (!serviceKeys.length) throw new ApiError(400, "service_required");
    const selectedServices = await database.db.select().from(services).where(inArray(services.key, serviceKeys));
    if (selectedServices.length !== serviceKeys.length) throw new ApiError(400, "invalid_service");
    const deployments = await database.db.select().from(serviceDeployments).where(and(inArray(serviceDeployments.serviceId, selectedServices.map((service) => service.id)), eq(serviceDeployments.environmentId, environment.id)));
    if (deployments.length !== selectedServices.length) throw new ApiError(400, "invalid_service_for_environment");
    const moduleIds = strings(input.moduleIds ?? [], "module_ids");
    const modules = moduleIds.length ? await database.db.select().from(serviceModules).where(inArray(serviceModules.id, moduleIds)) : [];
    if (modules.length !== moduleIds.length || modules.some((module) => !selectedServices.some((service) => service.id === module.serviceId))) throw new ApiError(400, "invalid_module");
    const reporter = await subject();
    const assignee = optionalText(input.assigneeSubject, 255);
    const cc = strings(input.ccSubjects ?? [], "cc_subjects");
    await validateSubjects([assignee, ...cc]);
    const priority = choice(input.priority, "priority", ISSUE_PRIORITIES);
    const issueType = choice(input.type, "type", ISSUE_TYPES);
    const created = await serializeIssueCreation(async () => {
      const prefix = `ISSUE-${datedKey()}-`;
      const existing = await database.db.select({ key: issues.key }).from(issues);
      const sequence = Math.max(0, ...existing.flatMap(({ key }) => key.startsWith(prefix) ? [Number(key.slice(prefix.length)) || 0] : [])) + 1;
      const key = `${prefix}${String(sequence).padStart(3, "0")}`;
      return database.db.transaction(async (transaction) => {
        const [row] = await transaction.insert(issues).values({ key, title: text(input.title, "title", 300), description: optionalText(input.description) ?? "", priority, type: issueType, serviceId: selectedServices[0]!.id, environmentId: environment.id, reporterSubject: reporter, assigneeSubject: assignee, labels: [...serviceKeys, environment.key] }).returning();
        await transaction.insert(issueServices).values(selectedServices.map((service, index) => ({ issueId: row!.id, serviceId: service.id, environmentId: environment.id, deploymentId: deployments.find((deployment) => deployment.serviceId === service.id)!.id, primary: index === 0 })));
        if (modules.length) await transaction.insert(issueServiceModules).values(modules.map((module) => ({ issueId: row!.id, moduleId: module.id })));
        if (cc.length) await transaction.insert(issueCcRecipients).values(cc.map((recipient) => ({ issueId: row!.id, subject: recipient })));
        await transaction.insert(issueDiagnoses).values({ issueId: row!.id });
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
    const serviceKeys = strings(input.serviceKeys, "service_keys");
    if (!serviceKeys.length) throw new ApiError(400, "service_required");
    const selectedServices = await database.db.select().from(services).where(inArray(services.key, serviceKeys));
    const deployments = issue.environmentId && selectedServices.length ? await database.db.select().from(serviceDeployments).where(and(inArray(serviceDeployments.serviceId, selectedServices.map((service) => service.id)), eq(serviceDeployments.environmentId, issue.environmentId))) : [];
    if (!issue.environmentId || selectedServices.length !== serviceKeys.length || deployments.length !== selectedServices.length) throw new ApiError(400, "invalid_service_for_environment");
    const moduleIds = strings(input.moduleIds ?? [], "module_ids");
    const modules = moduleIds.length ? await database.db.select().from(serviceModules).where(inArray(serviceModules.id, moduleIds)) : [];
    if (modules.length !== moduleIds.length || modules.some((module) => !selectedServices.some((service) => service.id === module.serviceId))) throw new ApiError(400, "invalid_module");
    const cc = strings(input.ccSubjects ?? [], "cc_subjects");
    const assignee = optionalText(input.assigneeSubject, 255);
    await validateSubjects([assignee, ...cc]);
    const priority = choice(input.priority, "priority", ISSUE_PRIORITIES);
    const issueType = choice(input.type, "type", ISSUE_TYPES);
    const issueEnvironment = (await database.db.select({ key: environments.key }).from(environments).where(eq(environments.id, issue.environmentId!)).limit(1))[0];
    if (!issueEnvironment) throw new ApiError(400, "invalid_environment");
    await database.db.transaction(async (transaction) => {
      await transaction.update(issues).set({ title: text(input.title, "title", 300), description: optionalText(input.description) ?? "", priority, type: issueType, serviceId: selectedServices[0]!.id, assigneeSubject: assignee, labels: [...serviceKeys, issueEnvironment.key], version: issue.version + 1, updatedAt: new Date() }).where(eq(issues.id, issue.id));
      await transaction.delete(issueServices).where(eq(issueServices.issueId, issue.id));
      if (selectedServices.length) await transaction.insert(issueServices).values(selectedServices.map((service, index) => ({ issueId: issue.id, serviceId: service.id, environmentId: issue.environmentId!, deploymentId: deployments.find((deployment) => deployment.serviceId === service.id)!.id, primary: index === 0 })));
      await transaction.delete(issueServiceModules).where(eq(issueServiceModules.issueId, issue.id));
      if (modules.length) await transaction.insert(issueServiceModules).values(modules.map((module) => ({ issueId: issue.id, moduleId: module.id })));
      await transaction.delete(issueCcRecipients).where(eq(issueCcRecipients.issueId, issue.id));
      if (cc.length) await transaction.insert(issueCcRecipients).values(cc.map((recipient) => ({ issueId: issue.id, subject: recipient })));
    });
    return listItem((await issueByKey(issue.key))!);
  });

  app.get<{ Params: { key: string } }>("/api/issues/:key", async (request) => {
    const issue = await issueByKey(request.params.key);
    if (!issue) throw new ApiError(404, "issue_not_found");
    const [base, repositoryRows, attachmentRows, evidenceRows, testRows, diagnosisRows, workspaceRows, serviceRows, moduleRows, ccRows, sessionRows, reporterRows, commentRows] = await Promise.all([
      listItem(issue), database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue.id)), database.db.select().from(issueAttachments).where(eq(issueAttachments.issueId, issue.id)),
      database.db.select().from(issueEvidence).where(eq(issueEvidence.issueId, issue.id)), database.db.select().from(issueTestRuns).where(eq(issueTestRuns.issueId, issue.id)), database.db.select().from(issueDiagnoses).where(eq(issueDiagnoses.issueId, issue.id)),
      database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, issue.id)), database.db.select({ service: services, link: issueServices }).from(issueServices).innerJoin(services, eq(issueServices.serviceId, services.id)).where(eq(issueServices.issueId, issue.id)),
      database.db.select({ module: serviceModules, serviceKey: services.key }).from(issueServiceModules).innerJoin(serviceModules, eq(issueServiceModules.moduleId, serviceModules.id)).innerJoin(services, eq(serviceModules.serviceId, services.id)).where(eq(issueServiceModules.issueId, issue.id)),
      database.db.select({ person: subjects }).from(issueCcRecipients).innerJoin(subjects, eq(issueCcRecipients.subject, subjects.subject)).where(eq(issueCcRecipients.issueId, issue.id)), database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id)),
      database.db.select().from(subjects).where(eq(subjects.subject, issue.reporterSubject)), database.db.select().from(issueComments).where(eq(issueComments.issueId, issue.id)).orderBy(asc(issueComments.createdAt)),
    ]);
    const workspace = workspaceRows[0]; const diagnosis = diagnosisRows[0]; const session = sessionRows[0]; const reporter = reporterRows[0];
    const sessionReady = session ? await readFile(session.sessionFile).then(() => true, () => false) : false;
    return {
      ...base, description: issue.description,
      repositories: repositoryRows.map((item) => ({ id: item.id, url: item.url, baseBranch: item.baseBranch, workingBranch: item.workingBranch, codeServerPath: codeServerFolder(item.localPath) })),
      attachments: attachmentRows.map(attachmentItem), evidence: evidenceRows.map((item) => ({ id: item.id, source: item.source, summary: item.summary, createdAt: item.createdAt.toISOString() })),
      testRuns: testRows.map((item) => ({ id: item.id, scope: item.scope, status: item.status, summary: item.summary, command: item.command })),
      diagnosis: { classification: diagnosis?.classification ?? "pending", rootCause: diagnosis?.rootCause ?? null, confidence: diagnosis?.confidencePermille === null || diagnosis?.confidencePermille === undefined ? null : diagnosis.confidencePermille / 1000 },
      workspace: {
        status: workspace?.status ?? "not_created",
        url: workspace?.codeServerUrl ?? null,
        lastError: workspace?.lastError ?? null,
        retryable: !runner.isRunning(issue.id) && (
          ["not_created", "preparing", "running", "stopped", "failed"].includes(workspace?.status ?? "not_created")
          || (workspace?.status === "ready" && !sessionReady)
        ),
      },
      agentSession: sessionReady ? { sessionId: session!.piSessionId } : null,
      reporter: reporter ? { subject: reporter.subject, name: reporter.displayName ?? reporter.username ?? reporter.subject, email: reporter.email ?? "" } : undefined,
      ccRecipients: ccRows.map(({ person }) => ({ subject: person.subject, name: person.displayName ?? person.username ?? person.subject, email: person.email ?? "" })),
      environmentKey: issue.environmentId ? (await database.db.select().from(environments).where(eq(environments.id, issue.environmentId)).limit(1))[0]?.key ?? null : null,
      affectedServices: serviceRows.map(({ service, link }) => ({ key: service.key, name: service.name, primary: link.primary })), affectedModules: moduleRows.map(({ module, serviceKey }) => ({ id: module.id, serviceKey, name: module.name, path: module.path })),
      scopeCandidates: await runner.getScopeCandidates(issue.id), comments: commentRows.map((item) => ({ id: item.id, author: item.authorSubject, body: item.body, createdAt: item.createdAt.toISOString() })), piConversation: await runner.getConversation(issue.id),
    };
  });

  app.post<{ Params: { key: string } }>("/api/issues/:key/retry", async (request, reply) => {
    const issue = await issueByKey(request.params.key);
    if (!issue) throw new ApiError(404, "issue_not_found");
    if (runner.isRunning(issue.id)) throw new ApiError(409, "issue_already_running");
    await database.db.update(issueWorkspaces).set({ status: "preparing", lastError: null, updatedAt: new Date() }).where(eq(issueWorkspaces.issueId, issue.id));
    runner.enqueue(issue.id);
    return reply.code(202).send({ ok: true });
  });

  app.post<{ Params: { key: string } }>("/api/issues/:key/comments", async (request, reply) => {
    const issue = await issueByKey(request.params.key); if (!issue) throw new ApiError(404, "issue_not_found");
    const input = record(request.body); const author = await subject();
    const [comment] = await database.db.insert(issueComments).values({ issueId: issue.id, authorSubject: author, body: text(input.body, "comment", 50_000) }).returning();
    runner.enqueue(issue.id, comment!.id);
    return reply.code(201).send({ id: comment!.id, author, body: comment!.body, createdAt: comment!.createdAt.toISOString() });
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

  app.post<{ Params: { key: string } }>("/api/issues/:key/pi-prompt", async (request, reply) => {
    const issue = await issueByKey(request.params.key); if (!issue) throw new ApiError(404, "issue_not_found"); const input = record(request.body); const message = text(input.message, "message", 50_000); const behavior = input.behavior === "steer" ? "steer" : "followUp";
    if (!await runner.steerDirect(issue.id, message, behavior)) runner.enqueueDirect(issue.id, message); return reply.code(202).send({ ok: true });
  });
  app.post<{ Params: { key: string } }>("/api/issues/:key/pi-abort", async (request, reply) => { const issue = await issueByKey(request.params.key); if (!issue) throw new ApiError(404, "issue_not_found"); return await runner.abortDirect(issue.id) ? { ok: true } : reply.code(409).send({ error: "pi_not_running" }); });

  app.post<{ Params: { key: string } }>("/api/issues/:key/terminal-ticket", async (request) => {
    const issue = await issueByKey(request.params.key); if (!issue) throw new ApiError(404, "issue_not_found");
    const session = (await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue.id)).limit(1))[0]; if (!session) throw new ApiError(409, "pi_session_not_ready");
    try { await Promise.all([readFile(session.sessionFile), readFile(path.join(session.workspacePath, ".issue-pilot", "pi-terminal-token"))]); }
    catch { throw new ApiError(409, "pi_session_not_ready"); }
    const ticket = randomUUID(); const expiresAt = Date.now() + 30_000; tickets.set(ticket, { issueId: issue.id, issueKey: issue.key, sessionFile: session.sessionFile, workspacePath: session.workspacePath, expiresAt });
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

export const createApi = buildApi;

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") throw new Error("issue_pilot_api_must_bind_to_loopback");
  const app = await buildApi();
  await app.listen({ port, host });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
