import Fastify, { type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";

import { AgentEventBroker } from "./agent-event-broker.ts";
import { createDatabase } from "./db/client.ts";
import { DatabaseIssueAgentRunner } from "./issue-agent-runner.ts";
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
  issueServices,
  issueTestRuns,
  issueWorkspaces,
  issues,
  serviceEnvironments,
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
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!organizationId) throw new Error("KEYCLOAK_ORGANIZATION_ID is required");
const { db, close } = createDatabase(databaseUrl);
const agentEventBroker = new AgentEventBroker();
const issueAgentRunner = new DatabaseIssueAgentRunner(db, process.env.ISSUE_AGENT_STATE_ROOT ?? ".issue-agent", (event) => agentEventBroker.publish(event));
const jwks = createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`));
const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });
const attachmentStorageDirectory = path.resolve(process.env.ATTACHMENT_STORAGE_DIR ?? ".issue-agent/attachments");
await app.register(multipart, { limits: { files: 10, fileSize: 20 * 1024 * 1024, fields: 0 } });

app.addHook("preHandler", async (request, reply) => {
  if (request.url === "/health") return;
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
    request.log.warn({ error }, "JWT validation failed");
    return reply.code(401).send({ error: "invalid_token" });
  }
});

const visibleConfig = and(eq(environments.scope, "global"), isNull(environments.ownerSubject));
const visibleService = and(eq(services.scope, "global"), isNull(services.ownerSubject));

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
  const [environmentLinks, repositories, relations] = serviceIds.length ? await Promise.all([
    db.select({ serviceId: serviceEnvironments.serviceId, environmentId: serviceEnvironments.environmentId }).from(serviceEnvironments).where(inArray(serviceEnvironments.serviceId, serviceIds)),
    db.select().from(serviceRepositories).where(inArray(serviceRepositories.serviceId, serviceIds)),
    db.select().from(serviceRelations).where(inArray(serviceRelations.sourceServiceId, serviceIds)),
  ]) : [[], [], []];
  return {
    environments: environmentRows,
    services: serviceRows.map((service) => ({
      ...service,
      environmentIds: environmentLinks.filter((link) => link.serviceId === service.id).map((link) => link.environmentId),
      repositories: repositories.filter((repository) => repository.serviceId === service.id),
      relatedServiceIds: relations.filter((relation) => relation.sourceServiceId === service.id).map((relation) => relation.targetServiceId),
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

app.post("/api/services", async (request, reply) => {
  const input = z.object({
    key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,98}$/),
    name: z.string().min(1).max(200),
    description: z.string().max(5000),
    environmentKey: z.string().min(1),
    repositories: z.array(z.object({
      url: z.string().min(1).max(2000).refine((url) => !url.startsWith("-"), "invalid repository URL"),
      defaultBranch: z.string().min(1).max(255),
      role: z.string().min(1).max(100).optional(),
    })).min(1),
    relatedServiceKeys: z.array(z.string()).optional(),
  }).parse(request.body);
  const [environment] = await db.select().from(environments).where(and(
    eq(environments.organizationId, organizationId),
    visibleConfig,
    eq(environments.key, input.environmentKey),
  )).limit(1);
  if (!environment) return reply.code(400).send({ error: "invalid_environment" });
  const targets = input.relatedServiceKeys?.length ? await db.select({ id: services.id }).from(services).where(and(
    eq(services.organizationId, organizationId),
    visibleService,
    inArray(services.key, input.relatedServiceKeys),
  )) : [];
  if (targets.length !== new Set(input.relatedServiceKeys ?? []).size) return reply.code(400).send({ error: "invalid_related_service" });
  const created = await db.transaction(async (transaction) => {
    const [service] = await transaction.insert(services).values({
      organizationId,
      ownerSubject: null,
      scope: "global",
      key: input.key,
      name: input.name,
      description: input.description,
      metadata: {},
    }).returning();
    await transaction.insert(serviceEnvironments).values({
      serviceId: service!.id,
      environmentId: environment.id,
      logProvider: environment.kind === "production" || environment.kind === "test" ? "aliyun-sls" : "local",
      databaseProvider: environment.kind === "production" ? "aliyun-dms" : "local-mysql",
    });
    await transaction.insert(serviceRepositories).values(input.repositories.map((repository) => ({
      serviceId: service!.id,
      url: repository.url,
      defaultBranch: repository.defaultBranch,
      role: repository.role ?? "application",
    })));
    if (targets.length) await transaction.insert(serviceRelations).values(targets.map((target) => ({ sourceServiceId: service!.id, targetServiceId: target.id }))).onConflictDoNothing();
    return service!;
  });
  return reply.code(201).send(created);
});

app.patch("/api/services/:key", async (request, reply) => {
  const { key } = z.object({ key: z.string() }).parse(request.params);
  const input = z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(5000),
    environmentKey: z.string().min(1),
    repositories: z.array(z.object({
      url: z.string().min(1).max(2000).refine((url) => !url.startsWith("-"), "invalid repository URL"),
      defaultBranch: z.string().min(1).max(255),
      role: z.string().min(1).max(100).optional(),
    })).min(1),
    relatedServiceKeys: z.array(z.string()).optional(),
  }).parse(request.body);
  const [service] = await db.select().from(services).where(and(eq(services.organizationId, organizationId), visibleService, eq(services.key, key))).limit(1);
  if (!service) return reply.code(404).send({ error: "service_not_found" });
  if (input.relatedServiceKeys?.includes(key)) return reply.code(400).send({ error: "service_cannot_relate_to_itself" });
  const [environment] = await db.select().from(environments).where(and(
    eq(environments.organizationId, organizationId), visibleConfig, eq(environments.key, input.environmentKey),
  )).limit(1);
  if (!environment) return reply.code(400).send({ error: "invalid_environment" });
  const targets = input.relatedServiceKeys?.length ? await db.select({ id: services.id }).from(services).where(and(
    eq(services.organizationId, organizationId), visibleService, inArray(services.key, input.relatedServiceKeys),
  )) : [];
  if (targets.length !== new Set(input.relatedServiceKeys ?? []).size) return reply.code(400).send({ error: "invalid_related_service" });
  const updated = await db.transaction(async (transaction) => {
    const [row] = await transaction.update(services).set({
      name: input.name,
      description: input.description,
      metadata: {},
      updatedAt: new Date(),
    }).where(eq(services.id, service.id)).returning();
    await transaction.delete(serviceEnvironments).where(eq(serviceEnvironments.serviceId, service.id));
    await transaction.delete(serviceRepositories).where(eq(serviceRepositories.serviceId, service.id));
    await transaction.delete(serviceRelations).where(eq(serviceRelations.sourceServiceId, service.id));
    await transaction.insert(serviceEnvironments).values({
      serviceId: service.id,
      environmentId: environment.id,
      logProvider: environment.kind === "production" || environment.kind === "test" ? "aliyun-sls" : "local",
      databaseProvider: environment.kind === "production" ? "aliyun-dms" : "local-mysql",
    });
    await transaction.insert(serviceRepositories).values(input.repositories.map((repository) => ({
      serviceId: service.id,
      url: repository.url,
      defaultBranch: repository.defaultBranch,
      role: repository.role ?? "application",
    })));
    if (targets.length) await transaction.insert(serviceRelations).values(targets.map((target) => ({ sourceServiceId: service.id, targetServiceId: target.id })));
    return row!;
  });
  return updated;
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
  const [repositories, attachments, evidence, tests, diagnosis, workspace, affectedServices, ccRecipients, agentSession, reporter, comments, piConversation] = await Promise.all([
    db.select().from(issueRepositories).where(eq(issueRepositories.issueId, found.issue.id)),
    db.select().from(issueAttachments).where(eq(issueAttachments.issueId, found.issue.id)).orderBy(asc(issueAttachments.createdAt)),
    db.select().from(issueEvidence).where(eq(issueEvidence.issueId, found.issue.id)),
    db.select().from(issueTestRuns).where(eq(issueTestRuns.issueId, found.issue.id)),
    db.select().from(issueDiagnoses).where(eq(issueDiagnoses.issueId, found.issue.id)).limit(1),
    db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, found.issue.id)).limit(1),
    db.select({ key: services.key, name: services.name, primary: issueServices.primary }).from(issueServices).innerJoin(services, eq(issueServices.serviceId, services.id)).where(eq(issueServices.issueId, found.issue.id)),
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
    environmentKey: found.environmentKey,
    ccRecipients: ccRecipients.map((person) => ({ subject: person.subject, name: person.name ?? person.email ?? person.subject, email: person.email ?? "" })),
  };
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
  const steered = await issueAgentRunner.steerDirect(issue.id, message, behavior);
  if (!steered) issueAgentRunner.enqueueDirect(issue.id, message);
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
    assigneeSubject: z.string().min(1).nullable(),
    ccSubjects: z.array(z.string().min(1)).max(50),
  }).parse(request.body);
  const found = (await db.select({ issue: issues, serviceName: services.name, environmentName: environments.name, environmentKey: environments.key })
    .from(issues)
    .leftJoin(services, eq(issues.serviceId, services.id))
    .leftJoin(environments, eq(issues.environmentId, environments.id))
    .where(eq(issues.key, key)).limit(1))[0];
  if (!found) return reply.code(404).send({ error: "issue_not_found" });
  if (!found.issue.environmentId) return reply.code(400).send({ error: "issue_has_no_environment" });
  let people: Map<string, { name: string | null; email: string | null }>;
  try {
    people = await resolvePeople([...(input.assigneeSubject ? [input.assigneeSubject] : []), ...input.ccSubjects]);
  } catch {
    return reply.code(400).send({ error: "invalid_people" });
  }
  const [candidateServices, currentServices, currentCcRows] = await Promise.all([
    db.select({ service: services }).from(services).innerJoin(serviceEnvironments, eq(serviceEnvironments.serviceId, services.id)).where(and(
      eq(services.organizationId, organizationId), visibleService, eq(serviceEnvironments.environmentId, found.issue.environmentId), inArray(services.key, input.serviceKeys),
    )),
    db.select({ key: services.key, primary: issueServices.primary }).from(issueServices).innerJoin(services, eq(issueServices.serviceId, services.id)).where(eq(issueServices.issueId, found.issue.id)),
    db.select({ subject: issueCcRecipients.subject }).from(issueCcRecipients).where(eq(issueCcRecipients.issueId, found.issue.id)),
  ]);
  if (candidateServices.length !== new Set(input.serviceKeys).size) return reply.code(400).send({ error: "invalid_service_for_environment" });
  const serviceByKey = new Map(candidateServices.map(({ service }) => [service.key, service]));
  const selectedServices = input.serviceKeys.map((serviceKey) => serviceByKey.get(serviceKey)!);
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
    || !sameSet(currentCcRows.map((row) => row.subject), ccSubjects);
  if (!changed) {
    const assignee = input.assigneeSubject ? people.get(input.assigneeSubject) : undefined;
    return mapIssue(found.issue, found.serviceName, found.environmentName, assignee?.name ?? assignee?.email ?? null);
  }
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
    await transaction.delete(issueServices).where(eq(issueServices.issueId, found.issue.id));
    await transaction.insert(issueServices).values(selectedServices.map((service, index) => ({ issueId: found.issue.id, serviceId: service.id, environmentId: found.issue.environmentId, primary: index === 0 })));
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
  const environment = (await db.select().from(environments).where(and(
    eq(environments.organizationId, organizationId), visibleConfig, eq(environments.key, input.environmentKey),
  )).limit(1))[0];
  if (!environment) return reply.code(400).send({ error: "invalid_environment" });
  const primary = serviceRows[0]!;
  const ccSubjects = [...new Set(input.ccSubjects ?? [])].filter((subject) => subject !== assigneeSubject);
  const created = await db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext('issue-agent-key'))`);
    const nextRows = await transaction.execute<{ next: number }>(sql`select coalesce(max(substring(key from 7)::int), 0) + 1 as next from issues`);
    const next = Number(nextRows[0]?.next ?? 1);
    const [issue] = await transaction.insert(issues).values({
      key: `ISSUE-${String(next).padStart(4, "0")}`,
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
    if (ccSubjects.length) await transaction.insert(issueCcRecipients).values(ccSubjects.map((subject) => ({ issueId: issue!.id, subject })));
    await transaction.insert(issueDiagnoses).values({ issueId: issue!.id });
    await transaction.insert(issueWorkspaces).values({ issueId: issue!.id, ownerSubject: assigneeSubject ?? identity.subject });
    return issue!;
  });
  if (process.env.ISSUE_AGENT_AUTO_RUN !== "false") issueAgentRunner.enqueue(created.id);
  const assignee = assigneeSubject ? people.get(assigneeSubject) : undefined;
  return reply.code(201).send(mapIssue(created, primary.name, environment.name, assignee?.name ?? assignee?.email ?? null));
});

const port = Number(process.env.PORT ?? 3000);
await app.listen({ host: "127.0.0.1", port });

async function shutdown() {
  await app.close();
  await close();
}
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
