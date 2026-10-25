import path from "node:path";
import { DrizzleQueryError } from "drizzle-orm";
import { errorDiagnostic } from "./error-diagnostic.ts";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";

import { applicationConfig } from "../config.ts";
import { ensureGlobalAgentConfiguration } from "../configuration/agent.ts";
import { AgentEngine, type AgentController } from "../agent/engine.ts";
import { AgentEventBus } from "../agent/events.ts";
import { openApplicationDatabase } from "../db/bootstrap.ts";
import type { DatabaseConnection } from "../db/client.ts";
import { applicationSettings, issues } from "../db/schema.ts";
import { createPiModelRuntime, PiAgentModelCatalog, type AgentModelCatalog } from "../agent/model-runtime.ts";
import { SerialQueue } from "../serial.ts";
import { WorkspaceLifecycleManager, type WorkspaceLifecyclePolicy } from "../workspace/lifecycle.ts";
import { prepareDevelopmentIssueRuntimes, prepareReadOnlyIssueRuntimes } from "../workspace/project.ts";
import { IssueScopeTransitionManager } from "../workspace/scope-transition.ts";
import { ApplicationStateLease } from "../workspace/state-lease.ts";
import { SourceBrowser } from "../workspace/source-browser.ts";
import { pruneState } from "../workspace/state.ts";
import { registerAgentRoutes } from "./agent-routes.ts";
import { registerAttachmentRoutes } from "./attachment-routes.ts";
import { registerConfigurationRoutes } from "./configuration-routes.ts";
import { ApiError } from "./input.ts";
import { registerDingtalkRoutes } from "./dingtalk-routes.ts";
import type { McpConnector } from "../mcp/client.ts";
import { registerIssueRoutes } from "./issue-routes.ts";
import { registerSourceBrowserRoutes } from "./source-browser-routes.ts";
import { registerApplicationMcp } from "../mcp/server.ts";
import { registerMcpRoutes } from "./mcp-routes.ts";
import { registerCapabilityRoutes } from "./capability-routes.ts";
import { registerRepositoryRoutes } from "./repository-routes.ts";
import { registerUserRoutes } from "./user-routes.ts";
import { registerWebRoutes } from "./web-routes.ts";
import { registerWorkspaceRoutes } from "./workspace-routes.ts";

export type { AgentController } from "../agent/engine.ts";

export interface ApiOptions {
  dingtalkConnector?: McpConnector;
  databaseFile?: string;
  stateRoot?: string;
  engine?: AgentController;
  events?: AgentEventBus;
  logger?: boolean;
  listenHost?: string;
  modelCatalog?: AgentModelCatalog;
  workspacePolicy?: WorkspaceLifecyclePolicy;
  stateLease?: Pick<ApplicationStateLease, "start" | "close">;
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
      try { app.log.error(errorDiagnostic(error)); } catch {
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
  const app = Fastify({ logger: options.logger ?? applicationConfig.http.logger, forceCloseConnections: true });
  let connection: DatabaseConnection | undefined;
  let engine: AgentController | undefined;
  let modelRuntime: ReturnType<typeof createPiModelRuntime> | undefined;
  let stateLease: Pick<ApplicationStateLease, "start" | "close"> | undefined;
  let stopWorkspaceMaintenance: (() => Promise<void>) | undefined;

  try {
    // Bootstrap recovers persistent state, so claim the control socket first.
    stateLease = options.stateLease ?? new ApplicationStateLease(stateRoot);
    await stateLease.start();
    const databaseStartedAt = performance.now();
    const database = await openApplicationDatabase(databaseFile);
    connection = database;
    const [settings] = await database.db.select().from(applicationSettings).limit(1);
    app.log.info({ durationMs: Math.round(performance.now() - databaseStartedAt) }, "Opened application database");
    const pruneStartedAt = performance.now();
    const issueKeys = (await database.db.select({ key: issues.key }).from(issues)).map(({ key }) => key);
    await pruneState(stateRoot, issueKeys);
    app.log.info({ durationMs: Math.round(performance.now() - pruneStartedAt) }, "Pruned application state");

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
    await app.register(multipart, { limits: { fileSize: Infinity, files: Infinity, fields: Infinity, parts: Infinity, fieldSize: Infinity } });
    const events = options.events ?? new AgentEventBus((error) => app.log.error(errorDiagnostic(error)));
    engine = options.engine ?? new AgentEngine(database.db, stateRoot, (event) => events.publish(event), (error) => app.log.error(errorDiagnostic(error)), sharedModelRuntime(), settings?.maxConcurrentIssues ?? undefined);
    const scopeQueue = new SerialQueue();
    const runScopeExclusive = <T>(operation: () => Promise<T>): Promise<T> => scopeQueue.run(operation);
    const workspaces = new WorkspaceLifecycleManager(database.db, stateRoot, engine, options.workspacePolicy);
    const maintenanceStartedAt = performance.now();
    const maintenance = await workspaces.maintain();
    for (const failure of maintenance.failures) app.log.error({ issueKey: failure.issueKey, err: errorDiagnostic(failure.error) }, "Workspace automatic release failed");
    app.log.info({ durationMs: Math.round(performance.now() - maintenanceStartedAt) }, "Completed workspace maintenance");
    stopWorkspaceMaintenance = workspaces.start((error) => app.log.error(errorDiagnostic(error)));

    app.setErrorHandler((error, _request, reply) => {
      if (error && typeof error === "object" && "code" in error && error.code === "FST_ERR_CTP_INVALID_JSON_BODY") return reply.code(400).send({ error: "invalid_json" });
      if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.message });
      const errorMessages: string[] = [];
      const seenCauses = new Set<unknown>();
      let cause: unknown = error;
      while (cause && !seenCauses.has(cause)) {
        seenCauses.add(cause);
        if (!(cause instanceof DrizzleQueryError)) errorMessages.push(cause instanceof Error ? cause.message : String(cause));
        cause = typeof cause === "object" && "cause" in cause ? (cause as { cause?: unknown }).cause : undefined;
      }
      const errorChain = errorMessages.join("\n");
      for (const conflict of ["issue_deployment_required", "deployment_is_used_by_issues", "issue_resolution_state_invalid", "unmanaged_issue_state"]) {
        if (errorChain.includes(conflict)) return reply.code(409).send({ error: conflict });
      }
      for (const operationalError of ["attachment_finalize_failed", "attachment_rollback_failed", "issue_state_rollback_failed", "issue_update_rollback_failed", "source_rename_rollback_failed", "source_rename_finalize_failed", "source_save_cleanup_failed", "workspace_runtime_restore_failed", "issue_workspace_missing", "agent_session_file_incomplete", "agent_session_file_missing"]) {
        if (errorChain.includes(operationalError)) {
          app.log.error(errorDiagnostic(error));
          return reply.code(500).send({ error: operationalError });
        }
      }
      if (/UNIQUE constraint failed/i.test(errorChain)) return reply.code(409).send({ error: "conflict" });
      if (/FOREIGN KEY constraint failed/i.test(errorChain)) return reply.code(409).send({ error: "resource_in_use" });
      app.log.error(errorDiagnostic(error));
      return reply.code(500).send({ error: "internal_error" });
    });

    const sourceBrowser = new SourceBrowser(database.db, stateRoot);
    const scopeTransitions = new IssueScopeTransitionManager(database.db, engine, workspaces);
    const routeContext = { app, database, engine, stateRoot, modelCatalog, events, workspaces, scopeTransitions, sourceBrowser, runScopeExclusive };
    app.get("/health", async () => ({ ok: true }));
    registerUserRoutes(routeContext);
    registerRepositoryRoutes(routeContext);
    registerCapabilityRoutes(routeContext);
    registerMcpRoutes(routeContext);
    registerApplicationMcp(routeContext);
    registerConfigurationRoutes(routeContext);
    const { createIssue } = registerIssueRoutes(routeContext);
    registerDingtalkRoutes(routeContext, createIssue, options.dingtalkConnector);
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
      try { await stateLease?.close(); } catch (error) { failures.push(error); }
      try { await database.close(); } catch (error) { failures.push(error); }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "api_close_failed");
    });
    return app;
  } catch (error) {
    if (stopWorkspaceMaintenance) await stopWorkspaceMaintenance().catch(() => undefined);
    if (engine?.close) await engine.close().catch(() => undefined);
    await modelRuntime?.close().catch(() => undefined);
    await stateLease?.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    try { await connection?.close(); } catch {
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
