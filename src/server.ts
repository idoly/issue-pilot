import Fastify, { type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, chmod, mkdir, readFile, unlink } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";

import { AgentEventBroker } from "./agent-event-broker.ts";
import { PiPtySessionManager, type PiPtyAttachment } from "./pi-pty-sessions.ts";
import { createDatabase } from "./db/client.ts";
import { DatabaseIssueAgentRunner } from "./issue-agent-runner.ts";
import { formatIssueDate, isIssueKey } from "./issue-keys.ts";
import {
  environments,
  issueDiagnoses,
  issueAttachments,
  issueAgentEvents,
  issueAgentSessions,
  issueCcRecipients,
  issueComments,
  issueEvidence,
  issueRepositories,
  issueServiceModules,
  issueServices,
  issueTestRuns,
  issueWorkspaces,
  issues,
  serviceEnvironments,
  serviceModules,
  serviceRelationModules,
  serviceRelations,
  serviceRepositories,
  services,
  subjects,
} from "./db/schema.ts";

interface AuthenticatedRequest extends FastifyRequest {
  identity: { subject: string; name: string; email: string; claims: JWTPayload };
}

const databaseUrl = process.env.DATABASE_URL;
const organizationId = process.env.KEYCLOAK_ORGANIZATION_ID;
const issuer = process.env.KEYCLOAK_ISSUER ?? "http://127.0.0.1:8081/realms/issue-agent";
const issueKeyTimeZone = process.env.ISSUE_AGENT_TIME_ZONE ?? "Asia/Shanghai";
formatIssueDate(new Date(), issueKeyTimeZone);
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!organizationId) throw new Error("KEYCLOAK_ORGANIZATION_ID is required");
const { db, close } = createDatabase(databaseUrl);
const agentEventBroker = new AgentEventBroker();
const issueAgentStateRoot = path.resolve(process.env.ISSUE_AGENT_STATE_ROOT ?? ".issue-agent");
const issueAgentRunner = new DatabaseIssueAgentRunner(db, issueAgentStateRoot, (event) => agentEventBroker.publish(event));
const jwks = createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`));
const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });
const attachmentStorageDirectory = path.resolve(process.env.ATTACHMENT_STORAGE_DIR ?? ".issue-agent/attachments");
const terminalTickets = new Map<string, { issueId: string; issueKey: string; subject: string; sessionFile: string; workspacePath: string; mode: "live" | "pty"; expiresAt: number }>();
const activeTerminalConnections = new Set<string>();
const terminalSocketDirectory = path.join(issueAgentStateRoot, "run");
const codeTerminalSocketPath = path.join(terminalSocketDirectory, "code-terminal.sock");
const piPtySocketPath = path.join(terminalSocketDirectory, "pi-pty.sock");
await app.register(multipart, { limits: { files: 10, fileSize: 20 * 1024 * 1024, fields: 0 } });
await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

app.setErrorHandler((error, request, reply) => {
  if (error instanceof z.ZodError) {
    const invalidModulePath = error.issues.some((issue) => issue.path.at(-1) === "path" && issue.path.includes("modules"));
    return reply.code(400).send({ error: invalidModulePath ? "invalid_module_path" : "invalid_request" });
  }
  request.log.error({
    errorName: error instanceof Error ? error.name : "UnknownError",
    errorCode: error && typeof error === "object" && "code" in error ? error.code : undefined,
  }, "request failed");
  return reply.send(error);
});

app.addHook("preHandler", async (request, reply) => {
  const requestPath = request.url.split("?", 1)[0];
  if (requestPath === "/health" || requestPath?.endsWith("/terminal")) return;
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return reply.code(401).send({ error: "unauthorized" });
  try {
    const { payload } = await jwtVerify(authorization.slice(7), jwks, { issuer });
    if (!payload.sub) throw new Error("token has no subject");
    const identity = {
      subject: payload.sub,
      name: String(payload.name ?? payload.preferred_username ?? payload.email ?? payload.sub),
      email: String(payload.email ?? ""),
      claims: payload,
    };
    (request as AuthenticatedRequest).identity = identity;
    await db.insert(subjects).values({
      subject: identity.subject,
      username: String(payload.preferred_username ?? identity.email),
      displayName: identity.name,
      email: identity.email,
    }).onConflictDoUpdate({
      target: subjects.subject,
      set: { username: String(payload.preferred_username ?? identity.email), displayName: identity.name, email: identity.email, updatedAt: new Date() },
    });
  } catch (error) {
    request.log.warn({
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorCode: error && typeof error === "object" && "code" in error ? error.code : undefined,
    }, "JWT validation failed");
    return reply.code(401).send({ error: "invalid_token" });
  }
});

function isManagedAgentPath(candidate: string): boolean {
  const relative = path.relative(issueAgentStateRoot, path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function terminalEnvironment(): Record<string, string> {
  const allowed = ["HOME", "PATH", "SHELL", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "COLORTERM", "PI_CODING_AGENT_DIR"];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []));
}

const piPtySessions = new PiPtySessionManager(process.env.PI_EXECUTABLE ?? "pi", null, terminalEnvironment());

function terminalIsActive(issueId: string): boolean {
  return activeTerminalConnections.has(issueId) || piPtySessions.isAttached(issueId);
}

const visibleConfig = and(eq(environments.scope, "global"), isNull(environments.ownerSubject));
const visibleService = and(eq(services.scope, "global"), isNull(services.ownerSubject));
const modulePathSchema = z.string().trim().min(1).max(1000).refine((value) => (
  !path.posix.isAbsolute(value)
  && !value.includes("\\")
  && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
), "module path must be a normalized repository-relative path");
const serviceModuleInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200),
  path: modulePathSchema,
});
const serviceRepositoryInputSchema = z.object({
  url: z.string().min(1).max(2000).refine((url) => !url.startsWith("-"), "invalid repository URL"),
  defaultBranch: z.string().min(1).max(255),
  role: z.string().min(1).max(100).optional(),
});

app.get("/health", async () => ({ status: "ok" }));

app.get("/api/people", async () => {
  const rows = await db.select({ subject: subjects.subject, name: subjects.displayName, email: subjects.email }).from(subjects).orderBy(asc(subjects.displayName));
  return rows.map((person) => ({ subject: person.subject, name: person.name ?? person.email ?? person.subject, email: person.email ?? "" }));
});

app.get("/api/config", async () => {
  const environmentRows = await db.select().from(environments).where(and(
    eq(environments.organizationId, organizationId),
    visibleConfig,
  )).orderBy(asc(environments.createdAt));
  const serviceRows = await db.select().from(services).where(and(
    eq(services.organizationId, organizationId),
    visibleService,
  )).orderBy(asc(services.createdAt));
  const serviceIds = serviceRows.map((service) => service.id);
  const [environmentLinks, repositories, modules, relations, relationModules] = serviceIds.length ? await Promise.all([
    db.select({ serviceId: serviceEnvironments.serviceId, environmentId: serviceEnvironments.environmentId }).from(serviceEnvironments).where(inArray(serviceEnvironments.serviceId, serviceIds)),
    db.select().from(serviceRepositories).where(inArray(serviceRepositories.serviceId, serviceIds)),
    db.select().from(serviceModules).where(inArray(serviceModules.serviceId, serviceIds)).orderBy(asc(serviceModules.createdAt)),
    db.select().from(serviceRelations).where(inArray(serviceRelations.sourceServiceId, serviceIds)),
    db.select().from(serviceRelationModules).where(inArray(serviceRelationModules.sourceServiceId, serviceIds)),
  ]) : [[], [], [], [], []];
  return {
    environments: environmentRows,
    services: serviceRows.map((service) => ({
      ...service,
      environmentIds: environmentLinks.filter((link) => link.serviceId === service.id).map((link) => link.environmentId),
      repositories: repositories.filter((repository) => repository.serviceId === service.id),
      modules: modules.filter((module) => module.serviceId === service.id),
      relatedServiceIds: relations.filter((relation) => relation.sourceServiceId === service.id).map((relation) => relation.targetServiceId),
      relatedModuleIds: relationModules.filter((relation) => relation.sourceServiceId === service.id).map((relation) => relation.moduleId),
    })),
  };
});

app.post("/api/environments", async (request, reply) => {
  const input = z.object({
    key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,98}$/),
    name: z.string().min(1).max(200),
    config: z.record(z.string(), z.unknown()).optional(),
  }).parse(request.body);
  const [created] = await db.insert(environments).values({
    organizationId,
    ownerSubject: null,
    scope: "global",
    key: input.key,
    name: input.name,
    kind: "test",
    config: input.config ?? {},
  }).returning();
  return reply.code(201).send(created);
});

app.patch("/api/environments/:key", async (request, reply) => {
  const { key } = z.object({ key: z.string() }).parse(request.params);
  if (key === "production" || key === "test") return reply.code(409).send({ error: "protected_environment" });
  const input = z.object({
    name: z.string().min(1).max(200),
    config: z.record(z.string(), z.unknown()).optional(),
  }).parse(request.body);
  const [updated] = await db.update(environments).set({
    name: input.name,
    ...(input.config ? { config: input.config } : {}),
    updatedAt: new Date(),
  }).where(and(eq(environments.organizationId, organizationId), visibleConfig, eq(environments.key, key))).returning();
  if (!updated) return reply.code(404).send({ error: "environment_not_found" });
  return updated;
});

app.delete("/api/environments/:key", async (request, reply) => {
  const { key } = z.object({ key: z.string() }).parse(request.params);
  const [environment] = await db.select().from(environments).where(and(eq(environments.organizationId, organizationId), visibleConfig, eq(environments.key, key))).limit(1);
  if (!environment) return reply.code(404).send({ error: "environment_not_found" });
  if (environment.key === "production" || environment.key === "test") return reply.code(409).send({ error: "protected_environment" });
  const [primaryReference, issueServiceReference, configuredService] = await Promise.all([
    db.select({ id: issues.id }).from(issues).where(eq(issues.environmentId, environment.id)).limit(1),
    db.select({ id: issueServices.issueId }).from(issueServices).where(eq(issueServices.environmentId, environment.id)).limit(1),
    db.select({ id: serviceEnvironments.serviceId }).from(serviceEnvironments).where(eq(serviceEnvironments.environmentId, environment.id)).limit(1),
  ]);
  if (primaryReference.length || issueServiceReference.length) return reply.code(409).send({ error: "environment_is_used_by_issues" });
  if (configuredService.length) return reply.code(409).send({ error: "environment_is_used_by_services" });
  await db.delete(environments).where(eq(environments.id, environment.id));
  return reply.code(204).send();
});

const serviceMutationSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5000),
  environmentKey: z.string().min(1),
  repositories: z.array(serviceRepositoryInputSchema).min(1),
  modules: z.array(serviceModuleInputSchema).max(100).default([]),
  relatedServiceKeys: z.array(z.string()).default([]),
  relatedModuleIds: z.array(z.string().uuid()).max(500).default([]),
});

function hasDuplicateModules(modules: Array<{ name: string; path: string }>): boolean {
  return new Set(modules.map((module) => module.name)).size !== modules.length
    || new Set(modules.map((module) => module.path)).size !== modules.length;
}

app.post("/api/services", async (request, reply) => {
  const input = serviceMutationSchema.extend({ key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,98}$/) }).parse(request.body);
  if (hasDuplicateModules(input.modules)) return reply.code(400).send({ error: "duplicate_service_module" });
  const [environment] = await db.select().from(environments).where(and(
    eq(environments.organizationId, organizationId), visibleConfig, eq(environments.key, input.environmentKey),
  )).limit(1);
  if (!environment) return reply.code(400).send({ error: "invalid_environment" });
  const targets = input.relatedServiceKeys.length ? await db.select({ id: services.id, key: services.key }).from(services).where(and(
    eq(services.organizationId, organizationId), visibleService, inArray(services.key, input.relatedServiceKeys),
  )) : [];
  if (targets.length !== new Set(input.relatedServiceKeys).size) return reply.code(400).send({ error: "invalid_related_service" });
  const relatedModules = input.relatedModuleIds.length ? await db.select().from(serviceModules).where(inArray(serviceModules.id, input.relatedModuleIds)) : [];
  const targetIds = new Set(targets.map((target) => target.id));
  if (relatedModules.length !== new Set(input.relatedModuleIds).size || relatedModules.some((module) => !targetIds.has(module.serviceId))) return reply.code(400).send({ error: "invalid_related_module" });
  const created = await db.transaction(async (transaction) => {
    const [service] = await transaction.insert(services).values({ organizationId, ownerSubject: null, scope: "global", key: input.key, name: input.name, description: input.description, metadata: {} }).returning();
    await transaction.insert(serviceEnvironments).values({
      serviceId: service!.id, environmentId: environment.id,
      logProvider: environment.kind === "production" || environment.kind === "test" ? "aliyun-sls" : "local",
      databaseProvider: environment.kind === "production" ? "aliyun-dms" : "local-mysql",
    });
    await transaction.insert(serviceRepositories).values(input.repositories.map((repository) => ({ serviceId: service!.id, url: repository.url, defaultBranch: repository.defaultBranch, role: repository.role ?? "application" })));
    if (input.modules.length) await transaction.insert(serviceModules).values(input.modules.map((module) => ({ serviceId: service!.id, name: module.name, path: module.path })));
    if (targets.length) await transaction.insert(serviceRelations).values(targets.map((target) => ({ sourceServiceId: service!.id, targetServiceId: target.id })));
    if (relatedModules.length) await transaction.insert(serviceRelationModules).values(relatedModules.map((module) => ({ sourceServiceId: service!.id, targetServiceId: module.serviceId, moduleId: module.id })));
    return service!;
  });
  return reply.code(201).send(created);
});

app.patch("/api/services/:key", async (request, reply) => {
  const { key } = z.object({ key: z.string() }).parse(request.params);
  const input = serviceMutationSchema.parse(request.body);
  if (hasDuplicateModules(input.modules)) return reply.code(400).send({ error: "duplicate_service_module" });
  const [service] = await db.select().from(services).where(and(eq(services.organizationId, organizationId), visibleService, eq(services.key, key))).limit(1);
  if (!service) return reply.code(404).send({ error: "service_not_found" });
  if (input.relatedServiceKeys.includes(key)) return reply.code(400).send({ error: "service_cannot_relate_to_itself" });
  const [environment] = await db.select().from(environments).where(and(eq(environments.organizationId, organizationId), visibleConfig, eq(environments.key, input.environmentKey))).limit(1);
  if (!environment) return reply.code(400).send({ error: "invalid_environment" });
  const targets = input.relatedServiceKeys.length ? await db.select({ id: services.id, key: services.key }).from(services).where(and(eq(services.organizationId, organizationId), visibleService, inArray(services.key, input.relatedServiceKeys))) : [];
  if (targets.length !== new Set(input.relatedServiceKeys).size) return reply.code(400).send({ error: "invalid_related_service" });
  const relatedModules = input.relatedModuleIds.length ? await db.select().from(serviceModules).where(inArray(serviceModules.id, input.relatedModuleIds)) : [];
  const targetIds = new Set(targets.map((target) => target.id));
  if (relatedModules.length !== new Set(input.relatedModuleIds).size || relatedModules.some((module) => !targetIds.has(module.serviceId))) return reply.code(400).send({ error: "invalid_related_module" });
  const existingModules = await db.select().from(serviceModules).where(eq(serviceModules.serviceId, service.id));
  const existingIds = new Set(existingModules.map((module) => module.id));
  if (input.modules.some((module) => module.id && !existingIds.has(module.id))) return reply.code(400).send({ error: "invalid_service_module" });
  const retainedIds = new Set(input.modules.flatMap((module) => module.id ? [module.id] : []));
  const removedIds = existingModules.filter((module) => !retainedIds.has(module.id)).map((module) => module.id);
  if (removedIds.length) {
    const [issueUse, relationUse] = await Promise.all([
      db.select({ id: issueServiceModules.moduleId }).from(issueServiceModules).where(inArray(issueServiceModules.moduleId, removedIds)).limit(1),
      db.select({ id: serviceRelationModules.moduleId }).from(serviceRelationModules).where(inArray(serviceRelationModules.moduleId, removedIds)).limit(1),
    ]);
    if (issueUse.length || relationUse.length) return reply.code(409).send({ error: "service_module_is_used" });
  }
  const updated = await db.transaction(async (transaction) => {
    const [row] = await transaction.update(services).set({ name: input.name, description: input.description, metadata: {}, updatedAt: new Date() }).where(eq(services.id, service.id)).returning();
    await transaction.delete(serviceEnvironments).where(eq(serviceEnvironments.serviceId, service.id));
    await transaction.delete(serviceRepositories).where(eq(serviceRepositories.serviceId, service.id));
    await transaction.delete(serviceRelationModules).where(eq(serviceRelationModules.sourceServiceId, service.id));
    await transaction.delete(serviceRelations).where(eq(serviceRelations.sourceServiceId, service.id));
    if (removedIds.length) await transaction.delete(serviceModules).where(inArray(serviceModules.id, removedIds));
    for (const module of input.modules) {
      if (module.id) await transaction.update(serviceModules).set({ name: module.name, path: module.path, updatedAt: new Date() }).where(eq(serviceModules.id, module.id));
      else await transaction.insert(serviceModules).values({ serviceId: service.id, name: module.name, path: module.path });
    }
    await transaction.insert(serviceEnvironments).values({ serviceId: service.id, environmentId: environment.id, logProvider: environment.kind === "production" || environment.kind === "test" ? "aliyun-sls" : "local", databaseProvider: environment.kind === "production" ? "aliyun-dms" : "local-mysql" });
    await transaction.insert(serviceRepositories).values(input.repositories.map((repository) => ({ serviceId: service.id, url: repository.url, defaultBranch: repository.defaultBranch, role: repository.role ?? "application" })));
    if (targets.length) await transaction.insert(serviceRelations).values(targets.map((target) => ({ sourceServiceId: service.id, targetServiceId: target.id })));
    if (relatedModules.length) await transaction.insert(serviceRelationModules).values(relatedModules.map((module) => ({ sourceServiceId: service.id, targetServiceId: module.serviceId, moduleId: module.id })));
    return row!;
  });
  return updated;
});

app.post("/api/services/:key/copy", async (request, reply) => {
  const { key } = z.object({ key: z.string() }).parse(request.params);
  const input = z.object({
    key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,98}$/),
    name: z.string().trim().min(1).max(200),
    targetEnvironmentKey: z.string().min(1),
  }).parse(request.body);
  const [source] = await db.select().from(services).where(and(eq(services.organizationId, organizationId), visibleService, eq(services.key, key))).limit(1);
  if (!source) return reply.code(404).send({ error: "service_not_found" });
  const [targetEnvironment] = await db.select().from(environments).where(and(eq(environments.organizationId, organizationId), visibleConfig, eq(environments.key, input.targetEnvironmentKey))).limit(1);
  if (!targetEnvironment) return reply.code(400).send({ error: "invalid_environment" });
  const [sourceEnvironment] = await db.select({ environmentId: serviceEnvironments.environmentId }).from(serviceEnvironments).where(eq(serviceEnvironments.serviceId, source.id)).limit(1);
  if (sourceEnvironment?.environmentId === targetEnvironment.id) return reply.code(400).send({ error: "copy_target_must_differ" });
  const [keyConflict] = await db.select({ id: services.id }).from(services).where(and(eq(services.organizationId, organizationId), visibleService, eq(services.key, input.key))).limit(1);
  if (keyConflict) return reply.code(409).send({ error: "service_key_exists" });
  const [repositories, modules, relations, relationModules] = await Promise.all([
    db.select().from(serviceRepositories).where(eq(serviceRepositories.serviceId, source.id)).orderBy(asc(serviceRepositories.createdAt)),
    db.select().from(serviceModules).where(eq(serviceModules.serviceId, source.id)).orderBy(asc(serviceModules.createdAt)),
    db.select().from(serviceRelations).where(eq(serviceRelations.sourceServiceId, source.id)),
    db.select().from(serviceRelationModules).where(eq(serviceRelationModules.sourceServiceId, source.id)),
  ]);
  const relationTargetIds = [...new Set(relations.map((relation) => relation.targetServiceId))];
  const targetEnvironmentServices = relationTargetIds.length ? await db.select({ serviceId: serviceEnvironments.serviceId }).from(serviceEnvironments).where(and(
    eq(serviceEnvironments.environmentId, targetEnvironment.id),
    inArray(serviceEnvironments.serviceId, relationTargetIds),
  )) : [];
  const allowedTargets = new Set(targetEnvironmentServices.map((row) => row.serviceId));
  const copied = await db.transaction(async (transaction) => {
    const [service] = await transaction.insert(services).values({
      organizationId,
      ownerSubject: null,
      scope: "global",
      key: input.key,
      name: input.name,
      description: source.description,
      metadata: source.metadata,
    }).returning();
    await transaction.insert(serviceEnvironments).values({
      serviceId: service!.id,
      environmentId: targetEnvironment.id,
      logProvider: targetEnvironment.kind === "production" || targetEnvironment.kind === "test" ? "aliyun-sls" : "local",
      databaseProvider: targetEnvironment.kind === "production" ? "aliyun-dms" : "local-mysql",
    });
    if (repositories.length) await transaction.insert(serviceRepositories).values(repositories.map((repository) => ({ serviceId: service!.id, url: repository.url, defaultBranch: repository.defaultBranch, role: repository.role })));
    if (modules.length) await transaction.insert(serviceModules).values(modules.map((module) => ({ serviceId: service!.id, name: module.name, path: module.path })));
    const copiedRelations = relations.filter((relation) => allowedTargets.has(relation.targetServiceId));
    if (copiedRelations.length) await transaction.insert(serviceRelations).values(copiedRelations.map((relation) => ({ sourceServiceId: service!.id, targetServiceId: relation.targetServiceId, relationType: relation.relationType, metadata: relation.metadata })));
    const copiedRelationModules = relationModules.filter((relation) => allowedTargets.has(relation.targetServiceId));
    if (copiedRelationModules.length) await transaction.insert(serviceRelationModules).values(copiedRelationModules.map((relation) => ({ sourceServiceId: service!.id, targetServiceId: relation.targetServiceId, moduleId: relation.moduleId })));
    return service!;
  });
  return reply.code(201).send({ key: copied.key, name: copied.name });
});

app.delete("/api/services/:key", async (request, reply) => {
  const { key } = z.object({ key: z.string() }).parse(request.params);
  const [service] = await db.select().from(services).where(and(eq(services.organizationId, organizationId), visibleService, eq(services.key, key))).limit(1);
  if (!service) return reply.code(404).send({ error: "service_not_found" });
  const [primaryReference, issueReference] = await Promise.all([
    db.select({ id: issues.id }).from(issues).where(eq(issues.serviceId, service.id)).limit(1),
    db.select({ id: issueServices.issueId }).from(issueServices).where(eq(issueServices.serviceId, service.id)).limit(1),
  ]);
  if (primaryReference.length || issueReference.length) return reply.code(409).send({ error: "service_is_used_by_issues" });
  await db.delete(services).where(eq(services.id, service.id));
  return reply.code(204).send();
});

function mapIssue(row: typeof issues.$inferSelect, serviceName?: string | null, environmentName?: string | null, assigneeName?: string | null) {
  return {
    id: row.key,
    title: row.title,
    description: row.description,
    priority: row.priority,
    type: row.type,
    status: row.status,
    assignee: assigneeName ?? row.assigneeSubject,
    updatedAt: row.updatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    version: row.version,
    assigneeSubject: row.assigneeSubject,
    labels: row.labels,
    service: serviceName ?? null,
    environment: environmentName ?? null,
  };
}

app.get("/api/issues", async () => {
  const rows = await db.select({ issue: issues, serviceName: services.name, environmentName: environments.name, assigneeName: subjects.displayName })
    .from(issues)
    .leftJoin(services, eq(issues.serviceId, services.id))
    .leftJoin(environments, eq(issues.environmentId, environments.id))
    .leftJoin(subjects, eq(issues.assigneeSubject, subjects.subject))
    .orderBy(desc(issues.updatedAt))
    .limit(100);
  return rows.map((row) => mapIssue(row.issue, row.serviceName, row.environmentName, row.assigneeName));
});

app.get<{ Params: { key: string } }>("/api/issues/:key", async (request, reply) => {
  const found = (await db.select({ issue: issues, serviceName: services.name, environmentName: environments.name, environmentKey: environments.key, assigneeName: subjects.displayName })
    .from(issues)
    .leftJoin(services, eq(issues.serviceId, services.id))
    .leftJoin(environments, eq(issues.environmentId, environments.id))
    .leftJoin(subjects, eq(issues.assigneeSubject, subjects.subject))
    .where(eq(issues.key, request.params.key)).limit(1))[0];
  if (!found) return reply.code(404).send({ error: "not_found" });
  const [repositories, attachments, evidence, tests, diagnosis, workspace, affectedServices, affectedModules, ccRecipients, agentSession, reporter, comments, piConversation] = await Promise.all([
    db.select().from(issueRepositories).where(eq(issueRepositories.issueId, found.issue.id)),
    db.select().from(issueAttachments).where(eq(issueAttachments.issueId, found.issue.id)).orderBy(asc(issueAttachments.createdAt)),
    db.select().from(issueEvidence).where(eq(issueEvidence.issueId, found.issue.id)),
    db.select().from(issueTestRuns).where(eq(issueTestRuns.issueId, found.issue.id)),
    db.select().from(issueDiagnoses).where(eq(issueDiagnoses.issueId, found.issue.id)).limit(1),
    db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, found.issue.id)).limit(1),
    db.select({ key: services.key, name: services.name, primary: issueServices.primary }).from(issueServices).innerJoin(services, eq(issueServices.serviceId, services.id)).where(eq(issueServices.issueId, found.issue.id)),
    db.select({ id: serviceModules.id, serviceKey: services.key, name: serviceModules.name, path: serviceModules.path }).from(issueServiceModules).innerJoin(serviceModules, eq(issueServiceModules.moduleId, serviceModules.id)).innerJoin(services, eq(serviceModules.serviceId, services.id)).where(eq(issueServiceModules.issueId, found.issue.id)),
    db.select({ subject: subjects.subject, name: subjects.displayName, email: subjects.email }).from(issueCcRecipients).innerJoin(subjects, eq(issueCcRecipients.subject, subjects.subject)).where(eq(issueCcRecipients.issueId, found.issue.id)),
    db.select({ sessionId: issueAgentSessions.piSessionId }).from(issueAgentSessions).where(eq(issueAgentSessions.issueId, found.issue.id)).limit(1),
    db.select({ subject: subjects.subject, name: subjects.displayName, email: subjects.email }).from(subjects).where(eq(subjects.subject, found.issue.reporterSubject)).limit(1),
    db.select().from(issueComments).where(eq(issueComments.issueId, found.issue.id)).orderBy(asc(issueComments.createdAt)),
    issueAgentRunner.getConversation(found.issue.id),
  ]);
  return {
    ...mapIssue(found.issue, found.serviceName, found.environmentName, found.assigneeName),
    repositories: repositories.map((repository) => ({ id: repository.id, url: repository.url, baseBranch: repository.baseBranch, workingBranch: repository.workingBranch })),
    attachments: attachments.map((attachment) => ({ id: attachment.id, fileName: attachment.fileName, mediaType: attachment.mediaType, size: attachment.size, sha256: attachment.sha256, scanStatus: attachment.scanStatus, createdAt: attachment.createdAt.toISOString() })),
    evidence: evidence.map((item) => ({ id: item.id, source: item.source, summary: item.summary, createdAt: item.createdAt.toISOString() })),
    testRuns: tests.map((test) => ({ id: test.id, scope: test.scope, status: test.status, summary: test.summary, command: test.command })),
    diagnosis: diagnosis[0] ? { classification: diagnosis[0].classification, rootCause: diagnosis[0].rootCause, confidence: diagnosis[0].confidencePermille === null ? null : diagnosis[0].confidencePermille / 1000 } : { classification: "pending", rootCause: null, confidence: null },
    workspace: workspace[0] ? { status: workspace[0].status, url: workspace[0].codeServerUrl, lastError: workspace[0].lastError } : { status: "not_created", url: null, lastError: null },
    agentSession: agentSession[0] ?? null,
    reporter: reporter[0] ? { subject: reporter[0].subject, name: reporter[0].name ?? reporter[0].email ?? reporter[0].subject, email: reporter[0].email ?? "" } : { subject: found.issue.reporterSubject, name: found.issue.reporterSubject, email: "" },
    comments: comments.map((comment) => ({ id: comment.id, author: comment.authorSubject, body: comment.body, createdAt: comment.createdAt.toISOString() })),
    piConversation,
    affectedServices,
    affectedModules,
    environmentKey: found.environmentKey,
    ccRecipients: ccRecipients.map((person) => ({ subject: person.subject, name: person.name ?? person.email ?? person.subject, email: person.email ?? "" })),
  };
});

app.post("/api/issues/:key/terminal-ticket", async (request, reply) => {
  const identity = (request as AuthenticatedRequest).identity;
  const { key } = z.object({ key: z.string() }).parse(request.params);
  const [terminal] = await db.select({
    issueId: issues.id,
    issueKey: issues.key,
    workspaceStatus: issueWorkspaces.status,
    sessionFile: issueAgentSessions.sessionFile,
    workspacePath: issueAgentSessions.workspacePath,
  }).from(issues)
    .leftJoin(issueWorkspaces, eq(issueWorkspaces.issueId, issues.id))
    .leftJoin(issueAgentSessions, eq(issueAgentSessions.issueId, issues.id))
    .where(eq(issues.key, key))
    .limit(1);
  if (!terminal) return reply.code(404).send({ error: "issue_not_found" });
  const runnerActive = issueAgentRunner.isRunning(terminal.issueId);
  if ((terminal.workspaceStatus === "preparing" || terminal.workspaceStatus === "running") && !runnerActive) return reply.code(409).send({ error: "pi_session_running" });
  if (terminalIsActive(terminal.issueId)) return reply.code(409).send({ error: "pi_terminal_already_open" });
  if (!terminal.sessionFile || !terminal.workspacePath) return reply.code(409).send({ error: "pi_session_not_ready" });
  if (!isManagedAgentPath(terminal.sessionFile) || !isManagedAgentPath(terminal.workspacePath)) return reply.code(409).send({ error: "pi_session_path_invalid" });
  try {
    await Promise.all([access(terminal.sessionFile), access(terminal.workspacePath)]);
  } catch {
    return reply.code(409).send({ error: "pi_session_not_ready" });
  }
  const now = Date.now();
  for (const [ticket, value] of terminalTickets) if (value.expiresAt <= now) terminalTickets.delete(ticket);
  const ticket = randomUUID();
  const expiresAt = now + 30_000;
  terminalTickets.set(ticket, {
    issueId: terminal.issueId,
    issueKey: terminal.issueKey,
    subject: identity.subject,
    sessionFile: terminal.sessionFile,
    workspacePath: terminal.workspacePath,
    mode: runnerActive ? "live" : "pty",
    expiresAt,
  });
  return reply.send({ ticket, mode: runnerActive ? "live" : "pty", expiresAt: new Date(expiresAt).toISOString() });
});

app.get("/api/issues/:key/terminal", { websocket: true }, (socket, request) => {
  const reject = (error: string) => {
    if (socket.readyState === 1) socket.send(JSON.stringify({ type: "error", error }));
    socket.close(1008, error.slice(0, 120));
  };
  const parsed = z.object({ key: z.string(), ticket: z.string().uuid() }).safeParse({
    ...(request.params as Record<string, unknown>),
    ...(request.query as Record<string, unknown>),
  });
  if (!parsed.success) {
    reject("terminal_ticket_invalid");
    return;
  }
  const { key, ticket: ticketId } = parsed.data;
  const ticket = terminalTickets.get(ticketId);
  terminalTickets.delete(ticketId);
  if (!ticket || ticket.expiresAt <= Date.now() || ticket.issueKey !== key) {
    reject("terminal_ticket_invalid");
    return;
  }
  if (terminalIsActive(ticket.issueId)) {
    reject("pi_terminal_already_open");
    return;
  }
  activeTerminalConnections.add(ticket.issueId);

  if (ticket.mode === "live") {
    let cleaned = false;
    let lineBuffer = "";
    let lastClientHeartbeat = Date.now();
    const sendOutput = (data: string) => {
      if (socket.readyState === 1) socket.send(JSON.stringify({ type: "output", data }));
    };
    const formatEvent = (event: { kind: string; message: string }): string => {
      if (event.kind === "assistant_delta") return event.message;
      if (event.kind === "response_start") return "\r\n\x1b[38;5;78mpi\x1b[0m ";
      return `\r\n\x1b[38;5;244m[${event.kind}] ${event.message}\x1b[0m\r\n`;
    };
    const unsubscribe = agentEventBroker.subscribe(ticket.issueId, (event) => {
      sendOutput(formatEvent(event));
      if (event.kind === "complete" || event.kind === "error") setTimeout(() => socket.close(1000, "pi run completed"), 250);
    });
    const idleTimer = setInterval(() => {
      if (Date.now() - lastClientHeartbeat <= 15_000) return;
      socket.close(1001, "terminal client disconnected");
      cleanup();
    }, 5_000);
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(idleTimer);
      unsubscribe();
      activeTerminalConnections.delete(ticket.issueId);
      request.log.info({ issueKey: ticket.issueKey, subject: ticket.subject }, "pi live terminal closed");
    };
    const submitLine = () => {
      const prompt = lineBuffer.trim();
      lineBuffer = "";
      sendOutput("\r\n");
      if (!prompt) {
        sendOutput("\x1b[38;5;78m>\x1b[0m ");
        return;
      }
      void issueAgentRunner.steerDirect(ticket.issueId, prompt, "followUp").then((accepted) => {
        sendOutput(accepted
          ? "\x1b[38;5;244m[queued for current pi session]\x1b[0m\r\n"
          : "\x1b[38;5;196m[pi session is no longer running]\x1b[0m\r\n");
      });
    };
    socket.on("message", (raw: unknown) => {
      try {
        const message = z.discriminatedUnion("type", [
          z.object({ type: z.literal("input"), data: z.string().max(64 * 1024) }),
          z.object({ type: z.literal("resize"), cols: z.number().int().min(20).max(400), rows: z.number().int().min(5).max(200) }),
          z.object({ type: z.literal("heartbeat") }),
        ]).parse(JSON.parse(String(raw)));
        lastClientHeartbeat = Date.now();
        if (message.type !== "input") return;
        if (message.data.includes("\u001b")) return;
        for (const character of message.data) {
          if (character === "\u0003") {
            lineBuffer = "";
            sendOutput("^C\r\n");
            void issueAgentRunner.abortDirect(ticket.issueId);
          } else if (character === "\r" || character === "\n") submitLine();
          else if (character === "\u007f") {
            if (lineBuffer) { lineBuffer = lineBuffer.slice(0, -1); sendOutput("\b \b"); }
          } else {
            lineBuffer += character;
            sendOutput(character);
          }
        }
      } catch {
        reject("terminal_message_invalid");
      }
    });
    socket.once("close", cleanup);
    socket.once("error", cleanup);
    sendOutput("\x1b[38;5;78mpi live session\x1b[0m\r\n");
    void db.select().from(issueAgentEvents).where(eq(issueAgentEvents.issueId, ticket.issueId)).orderBy(asc(issueAgentEvents.createdAt)).then((events) => {
      for (const event of events) sendOutput(formatEvent(event));
      sendOutput("\r\n\x1b[38;5;78m>\x1b[0m ");
    });
    request.log.info({ issueKey: ticket.issueKey, subject: ticket.subject }, "pi live terminal opened");
    return;
  }

  let attachment: PiPtyAttachment | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let cleaned = false;
  let lastClientHeartbeat = Date.now();
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (idleTimer) clearInterval(idleTimer);
    attachment?.detach();
    activeTerminalConnections.delete(ticket.issueId);
    request.log.info({ issueKey: ticket.issueKey, subject: ticket.subject }, "pi terminal detached");
  };
  try {
    attachment = piPtySessions.attach({
      issueId: ticket.issueId,
      issueKey: ticket.issueKey,
      sessionFile: ticket.sessionFile,
      workspacePath: ticket.workspacePath,
    }, {
      output: (data) => { if (socket.readyState === 1) socket.send(JSON.stringify({ type: "output", data })); },
      exit: (exitCode) => {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ type: "exit", exitCode }));
          socket.close(1000, "pi exited");
        }
        cleanup();
      },
    }, 100, 30);
  } catch {
    activeTerminalConnections.delete(ticket.issueId);
    reject("pi_terminal_start_failed");
    return;
  }
  request.log.info({ issueKey: ticket.issueKey, subject: ticket.subject }, "pi terminal attached");
  idleTimer = setInterval(() => {
    if (Date.now() - lastClientHeartbeat <= 15_000) return;
    socket.close(1001, "terminal client disconnected");
    cleanup();
  }, 5_000);
  socket.on("message", (raw: unknown) => {
    try {
      const message = z.discriminatedUnion("type", [
        z.object({ type: z.literal("input"), data: z.string().max(64 * 1024) }),
        z.object({ type: z.literal("resize"), cols: z.number().int().min(20).max(400), rows: z.number().int().min(5).max(200) }),
        z.object({ type: z.literal("heartbeat") }),
      ]).parse(JSON.parse(String(raw)));
      lastClientHeartbeat = Date.now();
      if (message.type === "input") attachment?.input(message.data);
      else if (message.type === "resize") attachment?.resize(message.cols, message.rows);
    } catch {
      reject("terminal_message_invalid");
    }
  });
  socket.once("close", cleanup);
  socket.once("error", cleanup);
});

app.get<{ Params: { key: string } }>("/api/issues/:key/agent-stream", async (request, reply) => {
  const [issue] = await db.select({ id: issues.id }).from(issues).where(eq(issues.key, request.params.key)).limit(1);
  if (!issue) return reply.code(404).send({ error: "issue_not_found" });

  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  });
  const write = (event: { id: string; issueId: string; kind: string; message: string; createdAt: string }) => {
    if (!reply.raw.destroyed) reply.raw.write(`${JSON.stringify(event)}\n`);
  };
  const unsubscribe = agentEventBroker.subscribe(issue.id, write);
  const heartbeat = setInterval(() => {
    if (!reply.raw.destroyed) reply.raw.write(`${JSON.stringify({ type: "heartbeat", at: new Date().toISOString() })}\n`);
  }, 15_000);
  const cleanup = () => { clearInterval(heartbeat); unsubscribe(); };
  reply.raw.once("close", cleanup);

  const backlog = await db.select().from(issueAgentEvents).where(eq(issueAgentEvents.issueId, issue.id)).orderBy(asc(issueAgentEvents.createdAt));
  for (const event of backlog) write({ id: event.id, issueId: event.issueId, kind: event.kind, message: event.message, createdAt: event.createdAt.toISOString() });
});

app.post("/api/issues/:key/pi-prompt", async (request, reply) => {
  const { key } = z.object({ key: z.string() }).parse(request.params);
  const { message, behavior } = z.object({
    message: z.string().trim().min(1).max(20_000),
    behavior: z.enum(["steer", "followUp"]).default("followUp"),
  }).parse(request.body);
  const [issue] = await db.select({ id: issues.id }).from(issues).where(eq(issues.key, key)).limit(1);
  if (!issue) return reply.code(404).send({ error: "issue_not_found" });
  if (terminalIsActive(issue.id)) return reply.code(409).send({ error: "pi_terminal_is_open" });
  const steered = await issueAgentRunner.steerDirect(issue.id, message, behavior);
  if (!steered) {
    if (!await piPtySessions.releaseDetached(issue.id)) return reply.code(409).send({ error: "pi_terminal_is_open" });
    issueAgentRunner.enqueueDirect(issue.id, message);
  }
  return reply.code(202).send({ accepted: true, delivery: steered ? behavior : "prompt" });
});

app.post("/api/issues/:key/pi-abort", async (request, reply) => {
  const { key } = z.object({ key: z.string() }).parse(request.params);
  const [issue] = await db.select({ id: issues.id }).from(issues).where(eq(issues.key, key)).limit(1);
  if (!issue) return reply.code(404).send({ error: "issue_not_found" });
  const aborted = await issueAgentRunner.abortDirect(issue.id);
  return reply.code(aborted ? 202 : 409).send(aborted ? { accepted: true } : { error: "pi_session_not_running" });
});

app.post("/api/issues/:key/comments", async (request, reply) => {
  const identity = (request as AuthenticatedRequest).identity;
  const { key } = z.object({ key: z.string() }).parse(request.params);
  const { body } = z.object({ body: z.string().trim().min(1).max(20_000) }).parse(request.body);
  const [issue] = await db.select({ id: issues.id }).from(issues).where(eq(issues.key, key)).limit(1);
  if (!issue) return reply.code(404).send({ error: "issue_not_found" });
  if (process.env.ISSUE_AGENT_AUTO_RUN !== "false" && terminalIsActive(issue.id)) return reply.code(409).send({ error: "pi_terminal_is_open" });
  if (process.env.ISSUE_AGENT_AUTO_RUN !== "false" && !await piPtySessions.releaseDetached(issue.id)) return reply.code(409).send({ error: "pi_terminal_is_open" });
  const [comment] = await db.transaction(async (transaction) => {
    const inserted = await transaction.insert(issueComments).values({
      issueId: issue.id,
      authorSubject: identity.subject,
      body,
    }).returning();
    await transaction.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, issue.id));
    return inserted;
  });
  if (process.env.ISSUE_AGENT_AUTO_RUN !== "false") issueAgentRunner.enqueue(issue.id, comment!.id);
  return reply.code(201).send({ id: comment!.id, author: comment!.authorSubject, body: comment!.body, createdAt: comment!.createdAt.toISOString() });
});

app.post("/api/issues/:key/attachments", async (request, reply) => {
  const identity = (request as AuthenticatedRequest).identity;
  const { key } = z.object({ key: z.string() }).parse(request.params);
  const [issue] = await db.select({ id: issues.id, key: issues.key }).from(issues).where(eq(issues.key, key)).limit(1);
  if (!issue) return reply.code(404).send({ error: "issue_not_found" });
  const issueDirectory = path.join(attachmentStorageDirectory, issue.key);
  await mkdir(issueDirectory, { recursive: true, mode: 0o700 });
  const pending: Array<{ fileName: string; mediaType: string; size: number; objectKey: string; sha256: string; path: string }> = [];
  try {
    for await (const part of request.files()) {
      const id = randomUUID();
      const storedPath = path.join(issueDirectory, id);
      const hash = createHash("sha256");
      let size = 0;
      const hashingStream = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      pending.push({ fileName: "", mediaType: "", size: 0, objectKey: "", sha256: "", path: storedPath });
      await pipeline(part.file, hashingStream, createWriteStream(storedPath, { mode: 0o600 }));
      if (part.file.truncated) throw new Error("attachment_too_large");
      const fileName = path.basename(part.filename || "attachment").replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 500) || "attachment";
      pending[pending.length - 1] = {
        fileName,
        mediaType: (part.mimetype || "application/octet-stream").slice(0, 255),
        size,
        objectKey: `${issue.key}/${id}`,
        sha256: hash.digest("hex"),
        path: storedPath,
      };
    }
    if (!pending.length) return reply.code(400).send({ error: "attachments_required" });
    const created = await db.insert(issueAttachments).values(pending.map((attachment) => ({
      issueId: issue.id,
      fileName: attachment.fileName,
      mediaType: attachment.mediaType,
      size: attachment.size,
      objectKey: attachment.objectKey,
      sha256: attachment.sha256,
      scanStatus: "pending",
      uploadedBy: identity.subject,
    }))).returning();
    return reply.code(201).send(created.map((attachment) => ({ id: attachment.id, fileName: attachment.fileName, mediaType: attachment.mediaType, size: attachment.size, sha256: attachment.sha256, scanStatus: attachment.scanStatus })));
  } catch (error) {
    await Promise.all(pending.map((attachment) => unlink(attachment.path).catch(() => undefined)));
    request.log.warn({ error, issue: issue.key }, "Attachment upload failed");
    const tooLarge = error instanceof Error && (error.message.includes("too_large") || error.name === "RequestFileTooLargeError");
    return reply.code(tooLarge ? 413 : 400).send({ error: tooLarge ? "attachment_too_large" : "attachment_upload_failed" });
  }
});

async function resolvePeople(subjectIds: string[]): Promise<Map<string, { name: string | null; email: string | null }>> {
  const unique = [...new Set(subjectIds.filter(Boolean))];
  if (!unique.length) return new Map();
  const rows = await db.select({ subject: subjects.subject, name: subjects.displayName, email: subjects.email }).from(subjects).where(inArray(subjects.subject, unique));
  if (rows.length !== unique.length) throw new Error("invalid_people");
  return new Map(rows.map((person) => [person.subject, { name: person.name, email: person.email }]));
}

app.patch("/api/issues/:key", async (request, reply) => {
  const { key } = z.object({ key: z.string() }).parse(request.params);
  const input = z.object({
    title: z.string().min(1).max(300),
    description: z.string().max(20_000),
    priority: z.enum(["p0", "p1", "p2", "p3"]),
    type: z.enum(["incident", "request", "task", "problem", "question", "smart_analysis"]),
    serviceKeys: z.array(z.string()).min(1),
    moduleIds: z.array(z.string().uuid()).max(500).default([]),
    assigneeSubject: z.string().min(1).nullable(),
    ccSubjects: z.array(z.string().min(1)).max(50),
  }).parse(request.body);
  const found = (await db.select({ issue: issues, serviceName: services.name, environmentName: environments.name, environmentKey: environments.key })
    .from(issues)
    .leftJoin(services, eq(issues.serviceId, services.id))
    .leftJoin(environments, eq(issues.environmentId, environments.id))
    .where(eq(issues.key, key)).limit(1))[0];
  if (!found) return reply.code(404).send({ error: "issue_not_found" });
  if (process.env.ISSUE_AGENT_AUTO_RUN !== "false" && terminalIsActive(found.issue.id)) return reply.code(409).send({ error: "pi_terminal_is_open" });
  if (!found.issue.environmentId) return reply.code(400).send({ error: "issue_has_no_environment" });
  let people: Map<string, { name: string | null; email: string | null }>;
  try {
    people = await resolvePeople([...(input.assigneeSubject ? [input.assigneeSubject] : []), ...input.ccSubjects]);
  } catch {
    return reply.code(400).send({ error: "invalid_people" });
  }
  const [candidateServices, currentServices, currentModules, currentCcRows] = await Promise.all([
    db.select({ service: services }).from(services).innerJoin(serviceEnvironments, eq(serviceEnvironments.serviceId, services.id)).where(and(
      eq(services.organizationId, organizationId), visibleService, eq(serviceEnvironments.environmentId, found.issue.environmentId), inArray(services.key, input.serviceKeys),
    )),
    db.select({ key: services.key, primary: issueServices.primary }).from(issueServices).innerJoin(services, eq(issueServices.serviceId, services.id)).where(eq(issueServices.issueId, found.issue.id)),
    db.select({ id: issueServiceModules.moduleId }).from(issueServiceModules).where(eq(issueServiceModules.issueId, found.issue.id)),
    db.select({ subject: issueCcRecipients.subject }).from(issueCcRecipients).where(eq(issueCcRecipients.issueId, found.issue.id)),
  ]);
  if (candidateServices.length !== new Set(input.serviceKeys).size) return reply.code(400).send({ error: "invalid_service_for_environment" });
  const serviceByKey = new Map(candidateServices.map(({ service }) => [service.key, service]));
  const selectedServices = input.serviceKeys.map((serviceKey) => serviceByKey.get(serviceKey)!);
  const selectedServiceIds = new Set(selectedServices.map((service) => service.id));
  const selectedModules = input.moduleIds.length ? await db.select().from(serviceModules).where(inArray(serviceModules.id, input.moduleIds)) : [];
  if (selectedModules.length !== new Set(input.moduleIds).size || selectedModules.some((module) => !selectedServiceIds.has(module.serviceId))) return reply.code(400).send({ error: "invalid_issue_module" });
  const primary = selectedServices[0]!;
  const ccSubjects = [...new Set(input.ccSubjects)].filter((subject) => subject !== input.assigneeSubject);
  const sameSet = (left: string[], right: string[]) => left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
  const changed = found.issue.title !== input.title
    || found.issue.description !== input.description
    || found.issue.priority !== input.priority
    || found.issue.type !== input.type
    || found.issue.assigneeSubject !== input.assigneeSubject
    || currentServices.find((service) => service.primary)?.key !== input.serviceKeys[0]
    || !sameSet(currentServices.map((service) => service.key), input.serviceKeys)
    || !sameSet(currentModules.map((module) => module.id), input.moduleIds)
    || !sameSet(currentCcRows.map((row) => row.subject), ccSubjects);
  if (!changed) {
    const assignee = input.assigneeSubject ? people.get(input.assigneeSubject) : undefined;
    return mapIssue(found.issue, found.serviceName, found.environmentName, assignee?.name ?? assignee?.email ?? null);
  }
  if (process.env.ISSUE_AGENT_AUTO_RUN !== "false" && !await piPtySessions.releaseDetached(found.issue.id)) return reply.code(409).send({ error: "pi_terminal_is_open" });
  const [updated] = await db.transaction(async (transaction) => {
    const rows = await transaction.update(issues).set({
      title: input.title,
      description: input.description,
      priority: input.priority,
      type: input.type,
      assigneeSubject: input.assigneeSubject,
      serviceId: primary.id,
      labels: [...input.serviceKeys, found.environmentKey ?? ""].filter(Boolean),
      version: found.issue.version + 1,
      updatedAt: new Date(),
    }).where(and(eq(issues.id, found.issue.id), eq(issues.version, found.issue.version))).returning();
    if (!rows[0]) return [];
    await transaction.delete(issueServiceModules).where(eq(issueServiceModules.issueId, found.issue.id));
    await transaction.delete(issueServices).where(eq(issueServices.issueId, found.issue.id));
    await transaction.insert(issueServices).values(selectedServices.map((service, index) => ({ issueId: found.issue.id, serviceId: service.id, environmentId: found.issue.environmentId, primary: index === 0 })));
    if (selectedModules.length) await transaction.insert(issueServiceModules).values(selectedModules.map((module) => ({ issueId: found.issue.id, moduleId: module.id })));
    await transaction.delete(issueCcRecipients).where(eq(issueCcRecipients.issueId, found.issue.id));
    if (ccSubjects.length) await transaction.insert(issueCcRecipients).values(ccSubjects.map((subject) => ({ issueId: found.issue.id, subject })));
    return rows;
  });
  if (!updated) return reply.code(409).send({ error: "issue_version_conflict" });
  if (process.env.ISSUE_AGENT_AUTO_RUN !== "false") issueAgentRunner.enqueue(found.issue.id);
  const assignee = input.assigneeSubject ? people.get(input.assigneeSubject) : undefined;
  return mapIssue(updated, primary.name, found.environmentName, assignee?.name ?? assignee?.email ?? null);
});

app.post("/api/issues", async (request, reply) => {
  const identity = (request as AuthenticatedRequest).identity;
  const input = z.object({
    title: z.string().min(1).max(300),
    description: z.string().max(20_000).optional(),
    priority: z.enum(["p0", "p1", "p2", "p3"]),
    type: z.enum(["incident", "request", "task", "problem", "question", "smart_analysis"]),
    serviceKeys: z.array(z.string()).min(1),
    moduleIds: z.array(z.string().uuid()).max(500).default([]),
    environmentKey: z.string().min(1),
    assigneeSubject: z.string().min(1).nullable().optional(),
    ccSubjects: z.array(z.string().min(1)).max(50).optional(),
  }).parse(request.body);
  const assigneeSubject = input.assigneeSubject === undefined ? identity.subject : input.assigneeSubject;
  let people: Map<string, { name: string | null; email: string | null }>;
  try {
    people = await resolvePeople([...(assigneeSubject ? [assigneeSubject] : []), ...(input.ccSubjects ?? [])]);
  } catch {
    return reply.code(400).send({ error: "invalid_people" });
  }
  const serviceRows = await db.select().from(services).where(and(
    eq(services.organizationId, organizationId), visibleService, inArray(services.key, input.serviceKeys),
  ));
  if (serviceRows.length !== new Set(input.serviceKeys).size) return reply.code(400).send({ error: "invalid_service" });
  const selectedServiceIds = new Set(serviceRows.map((service) => service.id));
  const selectedModules = input.moduleIds.length ? await db.select().from(serviceModules).where(inArray(serviceModules.id, input.moduleIds)) : [];
  if (selectedModules.length !== new Set(input.moduleIds).size || selectedModules.some((module) => !selectedServiceIds.has(module.serviceId))) return reply.code(400).send({ error: "invalid_issue_module" });
  const environment = (await db.select().from(environments).where(and(
    eq(environments.organizationId, organizationId), visibleConfig, eq(environments.key, input.environmentKey),
  )).limit(1))[0];
  if (!environment) return reply.code(400).send({ error: "invalid_environment" });
  const primary = serviceRows[0]!;
  const ccSubjects = [...new Set(input.ccSubjects ?? [])].filter((subject) => subject !== assigneeSubject);
  const created = await db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext('issue-agent-key'))`);
    const issueDate = formatIssueDate(new Date(), issueKeyTimeZone);
    const keyPrefix = `ISSUE-${issueDate}-`;
    const keyPattern = `^ISSUE-${issueDate}-[0-9]{4}$`;
    const nextRows = await transaction.execute<{ next: number }>(sql`
      select coalesce(max(substring(key from 16)::int), 0) + 1 as next
      from issues
      where key ~ ${keyPattern}
    `);
    const next = Number(nextRows[0]?.next ?? 1);
    if (!Number.isInteger(next) || next < 1 || next > 9_999) throw new Error("daily_issue_key_sequence_exhausted");
    const [issue] = await transaction.insert(issues).values({
      key: `${keyPrefix}${String(next).padStart(4, "0")}`,
      title: input.title,
      description: input.description ?? "",
      priority: input.priority,
      type: input.type,
      reporterSubject: identity.subject,
      assigneeSubject,
      serviceId: primary.id,
      environmentId: environment.id,
      labels: [primary.key, environment.key],
    }).returning();
    await transaction.insert(issueServices).values(serviceRows.map((service, index) => ({ issueId: issue!.id, serviceId: service.id, environmentId: environment.id, primary: index === 0 })));
    if (selectedModules.length) await transaction.insert(issueServiceModules).values(selectedModules.map((module) => ({ issueId: issue!.id, moduleId: module.id })));
    if (ccSubjects.length) await transaction.insert(issueCcRecipients).values(ccSubjects.map((subject) => ({ issueId: issue!.id, subject })));
    await transaction.insert(issueDiagnoses).values({ issueId: issue!.id });
    await transaction.insert(issueWorkspaces).values({ issueId: issue!.id, ownerSubject: assigneeSubject ?? identity.subject });
    return issue!;
  });
  if (process.env.ISSUE_AGENT_AUTO_RUN !== "false") issueAgentRunner.enqueue(created.id);
  const assignee = assigneeSubject ? people.get(assigneeSubject) : undefined;
  return reply.code(201).send(mapIssue(created, primary.name, environment.name, assignee?.name ?? assignee?.email ?? null));
});

async function authenticatePiPty(issueKey: string, suppliedToken: string) {
  const [binding] = await db.select({
    issueId: issues.id,
    issueKey: issues.key,
    sessionFile: issueAgentSessions.sessionFile,
    workspacePath: issueAgentSessions.workspacePath,
  })
    .from(issues)
    .innerJoin(issueAgentSessions, eq(issueAgentSessions.issueId, issues.id))
    .where(eq(issues.key, issueKey))
    .limit(1);
  if (!binding || !isManagedAgentPath(binding.workspacePath) || !isManagedAgentPath(binding.sessionFile)) return null;
  let expectedToken: string;
  try {
    expectedToken = (await readFile(path.join(binding.workspacePath, ".issue-pilot", "pi-terminal-token"), "utf8")).trim();
  } catch {
    return null;
  }
  const supplied = Buffer.from(suppliedToken);
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected) ? binding : null;
}

const piPtyServer = createNetServer((socket: Socket) => {
  socket.setNoDelay(true);
  let buffer = "";
  let authenticatedIssueId: string | null = null;
  let attachment: PiPtyAttachment | null = null;
  let unsubscribe: (() => void) | null = null;
  let lineBuffer = "";
  let cols = 100;
  let rows = 30;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    attachment?.detach();
    unsubscribe?.();
    if (authenticatedIssueId) activeTerminalConnections.delete(authenticatedIssueId);
  };
  const attachNative = (binding: { issueId: string; issueKey: string; sessionFile: string; workspacePath: string }) => {
    if (attachment || issueAgentRunner.isRunning(binding.issueId) || socket.destroyed) return;
    unsubscribe?.();
    unsubscribe = null;
    try {
      attachment = piPtySessions.attach(binding, {
        output: (data) => { if (!socket.destroyed) socket.write(data); },
        exit: (exitCode) => { if (!socket.destroyed) socket.end(`\r\n[pi exited: ${exitCode}]\r\n`); },
      }, cols, rows);
    } catch {
      socket.end("\r\nUnable to attach the issue pi PTY.\r\n");
    }
  };
  const attachLive = async (binding: { issueId: string; issueKey: string; sessionFile: string; workspacePath: string }) => {
    const format = (event: { kind: string; message: string }) => {
      if (event.kind === "assistant_delta") return event.message;
      if (event.kind === "response_start") return "\r\npi ";
      return `\r\n[${event.kind}] ${event.message}\r\n`;
    };
    unsubscribe = agentEventBroker.subscribe(binding.issueId, (event) => {
      if (!socket.destroyed) socket.write(format(event));
      if (event.kind === "complete" || event.kind === "error") setTimeout(() => attachNative(binding), 250);
    });
    socket.write("\x1b[38;5;78mpi live session; native TUI will attach when the run settles\x1b[0m\r\n> ");
    const recentEvents = await db.select().from(issueAgentEvents).where(eq(issueAgentEvents.issueId, binding.issueId)).orderBy(desc(issueAgentEvents.createdAt)).limit(100);
    for (const event of recentEvents.reverse()) if (!socket.destroyed) socket.write(format(event));
    if (!issueAgentRunner.isRunning(binding.issueId)) attachNative(binding);
  };
  const handleInput = (binding: { issueId: string }, data: string) => {
    if (attachment) {
      attachment.input(data);
      return;
    }
    for (const character of data) {
      if (character === "\u0003") {
        lineBuffer = "";
        socket.write("^C\r\n");
        void issueAgentRunner.abortDirect(binding.issueId);
      } else if (character === "\r" || character === "\n") {
        const prompt = lineBuffer.trim();
        lineBuffer = "";
        socket.write("\r\n");
        if (prompt) void issueAgentRunner.steerDirect(binding.issueId, prompt, "followUp");
      } else if (character === "\u007f") {
        if (lineBuffer) { lineBuffer = lineBuffer.slice(0, -1); socket.write("\b \b"); }
      } else if (character !== "\u001b") {
        lineBuffer += character;
        socket.write(character);
      }
    }
  };
  let binding: Awaited<ReturnType<typeof authenticatePiPty>> = null;
  const handleMessage = async (line: string) => {
    if (!binding) {
      const auth = z.object({
        type: z.literal("auth"),
        issueKey: z.string().refine(isIssueKey),
        token: z.string().min(20).max(200),
        cols: z.number().int().min(20).max(400),
        rows: z.number().int().min(5).max(200),
      }).parse(JSON.parse(line));
      binding = await authenticatePiPty(auth.issueKey, auth.token);
      if (!binding || terminalIsActive(binding.issueId)) {
        socket.end("Issue pi terminal is already attached or access was denied.\r\n");
        return;
      }
      authenticatedIssueId = binding.issueId;
      activeTerminalConnections.add(binding.issueId);
      cols = auth.cols;
      rows = auth.rows;
      if (issueAgentRunner.isRunning(binding.issueId)) void attachLive(binding);
      else attachNative(binding);
      return;
    }
    const message = z.discriminatedUnion("type", [
      z.object({ type: z.literal("input"), data: z.string().max(96 * 1024) }),
      z.object({ type: z.literal("resize"), cols: z.number().int().min(20).max(400), rows: z.number().int().min(5).max(200) }),
      z.object({ type: z.literal("detach") }),
    ]).parse(JSON.parse(line));
    if (message.type === "input") handleInput(binding, Buffer.from(message.data, "base64").toString("utf8"));
    else if (message.type === "resize") {
      cols = message.cols;
      rows = message.rows;
      attachment?.resize(cols, rows);
    } else socket.end();
  };
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (buffer.length > 256 * 1024) {
      socket.destroy();
      return;
    }
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line) void handleMessage(line).catch(() => socket.destroy());
      newline = buffer.indexOf("\n");
    }
  });
  socket.once("close", cleanup);
  socket.once("error", cleanup);
});

const codeTerminalServer = createHttpServer((request, response) => {
  void (async () => {
  const match = /^\/issues\/(ISSUE-[0-9]{4,})\/(stream|prompt)$/i.exec(new URL(request.url ?? "/", "http://localhost").pathname);
  const suppliedToken = Array.isArray(request.headers["x-issue-terminal-token"]) ? undefined : request.headers["x-issue-terminal-token"];
  if (!match || !suppliedToken) {
    response.writeHead(404).end();
    return;
  }
  const [, issueKey, action] = match;
  const [binding] = await db.select({ issueId: issues.id, workspacePath: issueAgentSessions.workspacePath })
    .from(issues)
    .innerJoin(issueAgentSessions, eq(issueAgentSessions.issueId, issues.id))
    .where(eq(issues.key, issueKey!))
    .limit(1);
  if (!binding || !isManagedAgentPath(binding.workspacePath)) {
    response.writeHead(404).end();
    return;
  }
  let expectedToken: string;
  try {
    expectedToken = (await readFile(path.join(binding.workspacePath, ".issue-pilot", "pi-terminal-token"), "utf8")).trim();
  } catch {
    response.writeHead(403).end();
    return;
  }
  const supplied = Buffer.from(suppliedToken);
  const expected = Buffer.from(expectedToken);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    response.writeHead(403).end();
    return;
  }
  if (action === "stream" && request.method === "GET") {
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    const writeEvent = (event: { kind: string; message: string }) => {
      if (response.destroyed) return;
      if (event.kind === "assistant_delta") response.write(event.message);
      else if (event.kind === "response_start") response.write("\npi ");
      else response.write(`\n[${event.kind}] ${event.message}\n`);
    };
    const unsubscribe = agentEventBroker.subscribe(binding.issueId, writeEvent);
    const heartbeat = setInterval(() => { if (!response.destroyed) response.write("\n"); }, 15_000);
    request.once("close", () => { clearInterval(heartbeat); unsubscribe(); });
    response.write(`Connected to ${issueKey} pi session\n`);
    const recentEvents = await db.select().from(issueAgentEvents).where(eq(issueAgentEvents.issueId, binding.issueId)).orderBy(desc(issueAgentEvents.createdAt)).limit(100);
    for (const event of recentEvents.reverse()) writeEvent(event);
    return;
  }
  if (action === "prompt" && request.method === "POST") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 20_000) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(buffer);
    }
    const message = Buffer.concat(chunks).toString("utf8").trim();
    if (!message) {
      response.writeHead(400).end();
      return;
    }
    const steered = await issueAgentRunner.steerDirect(binding.issueId, message, "followUp");
    if (!steered) {
      if (!await piPtySessions.releaseDetached(binding.issueId)) {
        response.writeHead(409).end();
        return;
      }
      issueAgentRunner.enqueueDirect(binding.issueId, message);
    }
    response.writeHead(202, { "Content-Type": "text/plain; charset=utf-8" }).end("accepted\n");
    return;
  }
  response.writeHead(405).end();
  })().catch(() => {
    if (!response.headersSent) response.writeHead(500).end();
    else response.destroy();
  });
});
await mkdir(terminalSocketDirectory, { recursive: true, mode: 0o700 });
await chmod(terminalSocketDirectory, 0o700);
await Promise.all([codeTerminalSocketPath, piPtySocketPath].map((socketPath) => unlink(socketPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; })));
await Promise.all([
  new Promise<void>((resolve, reject) => {
    codeTerminalServer.once("error", reject);
    codeTerminalServer.listen(codeTerminalSocketPath, () => { codeTerminalServer.off("error", reject); resolve(); });
  }),
  new Promise<void>((resolve, reject) => {
    piPtyServer.once("error", reject);
    piPtyServer.listen(piPtySocketPath, () => { piPtyServer.off("error", reject); resolve(); });
  }),
]);
await Promise.all([chmod(codeTerminalSocketPath, 0o600), chmod(piPtySocketPath, 0o600)]);

const port = Number(process.env.PORT ?? 3000);
await app.listen({ host: "127.0.0.1", port });

async function shutdown() {
  piPtySessions.close();
  activeTerminalConnections.clear();
  terminalTickets.clear();
  await app.close();
  await Promise.all([
    new Promise<void>((resolve) => codeTerminalServer.close(() => resolve())),
    new Promise<void>((resolve) => piPtyServer.close(() => resolve())),
  ]);
  await Promise.all([codeTerminalSocketPath, piPtySocketPath].map((socketPath) => unlink(socketPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; })));
  await close();
}
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
