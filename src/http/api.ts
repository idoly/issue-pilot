import path from "node:path";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";

import { applicationConfig } from "../config.ts";
import { ensureGlobalAgentConfiguration } from "../configuration/agent.ts";
import { AgentEngine, type AgentController } from "../agent/engine.ts";
import type { ToolRuntime } from "../tool-runtime.ts";
import { AgentEventBus } from "../agent/events.ts";
import { openApplicationDatabase } from "../db/bootstrap.ts";
import { issues } from "../db/schema.ts";
import { createPiModelRuntime, PiAgentModelCatalog, type AgentModelCatalog } from "../pi/models.ts";
import { SerialQueue } from "../serial.ts";
import { WorkspaceLifecycleManager, type WorkspaceLifecyclePolicy } from "../workspace/lifecycle.ts";
import { prepareDevelopmentIssueRuntimes, prepareReadOnlyIssueRuntimes } from "../workspace/project.ts";
import { ProjectToolBroker } from "../workspace/project-tools.ts";
import { SourceBrowser } from "../workspace/source-browser.ts";
import { pruneState } from "../workspace/state.ts";
import { registerAgentRoutes } from "./agent-routes.ts";
import { registerAttachmentRoutes } from "./attachment-routes.ts";
import { registerConfigurationRoutes } from "./configuration-routes.ts";
import { ApiError } from "./input.ts";
import { registerIssueRoutes } from "./issue-routes.ts";
import { registerSourceBrowserRoutes } from "./source-browser-routes.ts";
import { registerUserRoutes } from "./user-routes.ts";
import { registerWebRoutes } from "./web-routes.ts";
import { registerWorkspaceRoutes } from "./workspace-routes.ts";

export type { AgentController } from "../agent/engine.ts";

export interface ApiOptions {
  databaseFile?: string;
  stateRoot?: string;
  engine?: AgentController;
  events?: AgentEventBus;
  toolRuntime?: ToolRuntime;
  logger?: boolean;
  listenHost?: string;
  modelCatalog?: AgentModelCatalog;
  workspacePolicy?: WorkspaceLifecyclePolicy;
  projectTools?: Pick<ProjectToolBroker, "start" | "close">;
  webRoot?: string;
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
    void app.close().catch((error) => {
      try { app.log.error(error); } catch {
        // A logger failure cannot turn graceful shutdown into an unhandled rejection.
      }
    });
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
  const databaseStartedAt = performance.now();
  const database = await openApplicationDatabase(databaseFile);
  const app = Fastify({ logger: options.logger ?? applicationConfig.http.logger, forceCloseConnections: true });
  app.log.info({ durationMs: Math.round(performance.now() - databaseStartedAt) }, "Opened application database");
  let engine: AgentController | undefined;
  let modelRuntime: ReturnType<typeof createPiModelRuntime> | undefined;
  let projectTools: Pick<ProjectToolBroker, "start" | "close"> | undefined;
  let stopWorkspaceMaintenance: (() => Promise<void>) | undefined;

  try {
    const pruneStartedAt = performance.now();
    const issueKeys = (await database.db.select({ key: issues.key }).from(issues)).map(({ key }) => key);
    await pruneState(stateRoot, issueKeys);
    app.log.info({ durationMs: Math.round(performance.now() - pruneStartedAt) }, "Pruned application state");
    projectTools = options.projectTools ?? new ProjectToolBroker(database.db, stateRoot, options.toolRuntime, undefined, (error) => app.log.error(error));
    await projectTools.start();

    const developmentStartedAt = performance.now();
    const developmentRuntimes = await prepareDevelopmentIssueRuntimes(database.db, stateRoot);
    for (const blocked of developmentRuntimes.blocked) app.log.warn(blocked, "Development issue runtime could not be prepared");
    app.log.info({ issueKeys: developmentRuntimes.prepared, durationMs: Math.round(performance.now() - developmentStartedAt) }, "Prepared development issue runtimes");

    const readOnlyStartedAt = performance.now();
    const readOnlyRuntimes = await prepareReadOnlyIssueRuntimes(database.db, stateRoot);
    for (const blocked of readOnlyRuntimes.blocked) app.log.warn(blocked, "Read-only issue runtime could not be prepared");
    app.log.info({ issueKeys: readOnlyRuntimes.prepared, durationMs: Math.round(performance.now() - readOnlyStartedAt) }, "Prepared read-only issue runtimes");

    const sharedModelRuntime = () => modelRuntime ??= createPiModelRuntime();
    const modelCatalog = options.modelCatalog ?? new PiAgentModelCatalog(sharedModelRuntime());
    await ensureGlobalAgentConfiguration(database.db, modelCatalog);
    const attachmentLimits = applicationConfig.limits.attachment;
    await app.register(multipart, { limits: { fileSize: attachmentLimits.fileBytes, files: attachmentLimits.files, parts: attachmentLimits.files + 1, fieldSize: attachmentLimits.formFieldBytes } });
    const events = options.events ?? new AgentEventBus((error) => app.log.error(error));
    engine = options.engine ?? new AgentEngine(database.db, stateRoot, (event) => events.publish(event), (error) => app.log.error(error), options.toolRuntime, sharedModelRuntime());
    const scopeQueue = new SerialQueue();
    const runScopeExclusive = <T>(operation: () => Promise<T>): Promise<T> => scopeQueue.run(operation);
    const workspaces = new WorkspaceLifecycleManager(database.db, stateRoot, engine, options.workspacePolicy);
    const maintenanceStartedAt = performance.now();
    await workspaces.maintain();
    app.log.info({ durationMs: Math.round(performance.now() - maintenanceStartedAt) }, "Completed workspace maintenance");
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
      for (const conflict of ["issue_deployment_required", "deployment_is_used_by_issues", "issue_resolution_state_invalid", "unmanaged_issue_state"]) {
        if (errorChain.includes(conflict)) return reply.code(409).send({ error: conflict });
      }
      for (const operationalError of ["attachment_finalize_failed", "attachment_rollback_failed", "issue_state_rollback_failed", "issue_update_rollback_failed", "issue_workspace_missing"]) {
        if (errorChain.includes(operationalError)) {
          app.log.error(error);
          return reply.code(500).send({ error: operationalError });
        }
      }
      if (/UNIQUE constraint failed/i.test(errorChain)) return reply.code(409).send({ error: "conflict" });
      if (/FOREIGN KEY constraint failed/i.test(errorChain)) return reply.code(409).send({ error: "resource_in_use" });
      app.log.error(error);
      return reply.code(500).send({ error: "internal_error" });
    });

    const sourceBrowser = new SourceBrowser(database.db, stateRoot);
    const routeContext = { app, database, engine, stateRoot, modelCatalog, events, workspaces, sourceBrowser, runScopeExclusive };
    app.get("/health", async () => ({ ok: true }));
    registerUserRoutes(routeContext);
    registerConfigurationRoutes(routeContext);
    registerIssueRoutes(routeContext);
    registerAttachmentRoutes(routeContext);
    registerAgentRoutes(routeContext);
    registerSourceBrowserRoutes(routeContext);
    registerWorkspaceRoutes(routeContext);
    if (options.webRoot) await registerWebRoutes(app, options.webRoot);
    app.addHook("onClose", async () => {
      const failures: unknown[] = [];
      try { await stopWorkspaceMaintenance?.(); } catch (error) { failures.push(error); }
      try { await engine?.close?.(); } catch (error) { failures.push(error); }
      try { await modelRuntime?.close(); } catch (error) { failures.push(error); }
      try { await projectTools?.close(); } catch (error) { failures.push(error); }
      try { await database.close(); } catch (error) { failures.push(error); }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "api_close_failed");
    });
    return app;
  } catch (error) {
    if (stopWorkspaceMaintenance) await stopWorkspaceMaintenance().catch(() => undefined);
    if (engine?.close) await engine.close().catch(() => undefined);
    await modelRuntime?.close().catch(() => undefined);
    await projectTools?.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    try { await database.close(); } catch {
      // Preserve the startup error that triggered cleanup.
    }
    throw error;
  }
}

export async function startApi(options: ApiOptions = {}): Promise<FastifyInstance> {
  const app = await buildApi(options);
  const removeShutdownHandlers = installShutdownHandlers(app);
  try {
    await app.listen({ port: applicationConfig.http.port, host: options.listenHost ?? applicationConfig.http.host });
  } catch (error) {
    removeShutdownHandlers();
    await app.close().catch(() => undefined);
    throw error;
  }
  return app;
}
