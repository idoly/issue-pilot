import path from "node:path";
import { pathToFileURL } from "node:url";

import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";

import { applicationConfig } from "../config.ts";
import { AgentEngine, type AgentController } from "../agent/engine.ts";
import { AgentEventBus } from "../agent/events.ts";
import { openApplicationDatabase } from "../db/bootstrap.ts";
import { issues } from "../db/schema.ts";
import { PiAgentModelCatalog, type AgentModelCatalog } from "../pi/models.ts";
import { prepareDevelopmentIssueRuntimes } from "../workspace/development.ts";
import { WorkspaceLifecycleManager, type WorkspaceRetentionPolicy } from "../workspace/lifecycle.ts";
import { prepareReadOnlyIssueRuntimes } from "../workspace/read-only.ts";
import { pruneState } from "../workspace/state.ts";
import { registerAgentRoutes } from "./agent-routes.ts";
import { registerAttachmentRoutes } from "./attachments.ts";
import { registerConfigurationRoutes } from "./configuration-routes.ts";
import { ApiError } from "./input.ts";
import { registerIssueRoutes } from "./issue-routes.ts";
import { registerWorkspaceRoutes } from "./workspace-routes.ts";

export type { AgentController } from "../agent/engine.ts";

export interface ApiOptions {
  databaseFile?: string;
  stateRoot?: string;
  engine?: AgentController;
  logger?: boolean;
  modelCatalog?: AgentModelCatalog;
  workspacePolicy?: WorkspaceRetentionPolicy;
}

interface ShutdownTarget {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export function installShutdownHandlers(app: FastifyInstance, target: ShutdownTarget = process): () => void {
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void app.close().catch((error) => app.log.error(error));
  };
  target.once("SIGINT", shutdown);
  target.once("SIGTERM", shutdown);
  return () => {
    target.removeListener("SIGINT", shutdown);
    target.removeListener("SIGTERM", shutdown);
  };
}

export async function buildApi(options: ApiOptions = {}): Promise<FastifyInstance> {
  const stateRoot = path.resolve(options.stateRoot ?? applicationConfig.stateRoot);
  const databaseFile = options.databaseFile ?? applicationConfig.databaseFile;
  const database = await openApplicationDatabase(databaseFile);
  const app = Fastify({ logger: options.logger ?? applicationConfig.http.logger, forceCloseConnections: true });
  let engine: AgentController | undefined;
  let stopWorkspaceMaintenance: (() => void) | undefined;

  try {
    const issueKeys = (await database.db.select({ key: issues.key }).from(issues)).map(({ key }) => key);
    await pruneState(stateRoot, issueKeys);

    const developmentRuntimes = await prepareDevelopmentIssueRuntimes(database.db, stateRoot);
    for (const blocked of developmentRuntimes.blocked) app.log.warn(blocked, "Development issue runtime could not be prepared");
    if (developmentRuntimes.prepared.length) app.log.info({ issueKeys: developmentRuntimes.prepared }, "Prepared development issue runtimes");
    const readOnlyRuntimes = await prepareReadOnlyIssueRuntimes(database.db, stateRoot);
    for (const blocked of readOnlyRuntimes.blocked) app.log.warn(blocked, "Read-only code-server runtime could not be prepared");
    if (readOnlyRuntimes.prepared.length) app.log.info({ issueKeys: readOnlyRuntimes.prepared }, "Prepared read-only code-server runtimes");

    const modelCatalog = options.modelCatalog ?? new PiAgentModelCatalog();
    const attachmentLimits = applicationConfig.limits.attachment;
    await app.register(multipart, { limits: { fileSize: attachmentLimits.fileBytes, files: attachmentLimits.files, parts: attachmentLimits.files + 1, fieldSize: attachmentLimits.formFieldBytes } });
    const events = new AgentEventBus();
    engine = options.engine ?? new AgentEngine(database.db, stateRoot, (event) => events.publish(event));
    const workspaces = new WorkspaceLifecycleManager(database.db, stateRoot, engine, options.workspacePolicy);
    await workspaces.maintain();
    stopWorkspaceMaintenance = workspaces.start((error) => app.log.error(error));

    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.message });
      const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
      if (["FST_REQ_FILE_TOO_LARGE", "FST_FILES_LIMIT", "FST_PARTS_LIMIT", "FST_FIELDS_LIMIT"].includes(errorCode)) return reply.code(413).send({ error: "attachment_limit_exceeded" });
      const errorMessages: string[] = [];
      const seenCauses = new Set<unknown>();
      let cause: unknown = error;
      while (cause && !seenCauses.has(cause)) {
        seenCauses.add(cause);
        errorMessages.push(cause instanceof Error ? cause.message : String(cause));
        cause = typeof cause === "object" && "cause" in cause ? (cause as { cause?: unknown }).cause : undefined;
      }
      const errorChain = errorMessages.join("\n");
      if (/UNIQUE constraint failed/i.test(errorChain)) return reply.code(409).send({ error: "conflict" });
      if (/FOREIGN KEY constraint failed/i.test(errorChain)) return reply.code(409).send({ error: "resource_in_use" });
      app.log.error(error);
      return reply.code(500).send({ error: "internal_error" });
    });

    const routeContext = { app, database, engine, stateRoot, modelCatalog, events, workspaces };
    app.get("/health", async () => ({ ok: true }));
    registerConfigurationRoutes(routeContext);
    registerIssueRoutes(routeContext);
    registerAttachmentRoutes(routeContext);
    registerAgentRoutes(routeContext);
    registerWorkspaceRoutes(routeContext);
    app.addHook("onClose", async () => {
      stopWorkspaceMaintenance?.();
      await engine?.close?.();
      await database.close();
    });
    return app;
  } catch (error) {
    stopWorkspaceMaintenance?.();
    if (engine?.close) await engine.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    try { await database.close(); } catch {
      // Preserve the startup error that triggered cleanup.
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const app = await buildApi();
  const removeShutdownHandlers = installShutdownHandlers(app);
  try {
    await app.listen({ port: applicationConfig.http.port, host: applicationConfig.http.host });
  } catch (error) {
    removeShutdownHandlers();
    await app.close().catch(() => undefined);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
