import path from "node:path";
import { DrizzleQueryError } from "drizzle-orm";
import { errorChain, errorDiagnostic } from "../diagnostics.ts";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";

import { applicationConfig } from "../config.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { ensureGlobalAgentConfiguration } from "../configuration/agent.ts";
import { installApplicationParameters, loadApplicationParameterState } from "../configuration/parameters.ts";
import { AgentEngine, type AgentController } from "../agent/engine.ts";
import { AgentEventBus } from "../agent/events.ts";
import { openApplicationDatabase } from "../db/bootstrap.ts";
import type { DatabaseConnection } from "../db/client.ts";
import { issues } from "../db/schema.ts";
import { createPiModelRuntime, PiAgentModelCatalog, type AgentModelCatalog } from "../agent/model-runtime.ts";
import { SerialQueue } from "../serial.ts";
import { WorkspaceLifecycleManager, workspaceLifecyclePolicy, type WorkspaceLifecyclePolicy } from "../workspace/lifecycle.ts";
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
    // Stalled downloads or uploads would otherwise keep a graceful close pending indefinitely.
    const force = setTimeout(() => app.server.closeAllConnections(), issuePilotConfig.http.shutdownGraceMs);
    force.unref();
    void app
      .close()
      .finally(() => clearTimeout(force))
      .catch((error) => {
        try {
          app.log.error(errorDiagnostic(error));
        } catch {
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
  // Idle keep-alive sockets close at once; in-flight requests finish, and preClose ends long-lived SSE streams.
  const app = Fastify({ logger: options.logger ?? applicationConfig.http.logger, forceCloseConnections: "idle" });
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
    // Install saved parameters before any owner starts so startup work already uses them.
    const parameters = (await loadApplicationParameterState(database.db)).values;
    installApplicationParameters(parameters);
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

    const sharedModelRuntime = () => (modelRuntime ??= createPiModelRuntime());
    const modelCatalog = options.modelCatalog ?? new PiAgentModelCatalog(sharedModelRuntime());
    await ensureGlobalAgentConfiguration(database.db, modelCatalog);
    // File size/count stays deployment-controlled; ordinary form fields already have application maxima.
    await app.register(multipart, { limits: { fileSize: Infinity, files: Infinity, fields: 64, parts: Infinity, fieldSize: 400_000 } });
    const events = options.events ?? new AgentEventBus((error) => app.log.error(errorDiagnostic(error)));
    engine =
      options.engine ??
      new AgentEngine(
        database.db,
        stateRoot,
        (event) => events.publish(event),
        (error) => app.log.error(errorDiagnostic(error)),
        sharedModelRuntime(),
        parameters.maxConcurrentIssues,
      );
    const scopeQueue = new SerialQueue();
    const runScopeExclusive = <T>(operation: () => Promise<T>): Promise<T> => scopeQueue.run(operation);
    const workspaces = new WorkspaceLifecycleManager(database.db, stateRoot, engine, options.workspacePolicy ?? workspaceLifecyclePolicy(parameters));
    const maintenanceStartedAt = performance.now();
    const maintenance = await workspaces.maintain();
    for (const failure of maintenance.failures) app.log.error({ issueKey: failure.issueKey, err: errorDiagnostic(failure.error) }, "Workspace automatic release failed");
    app.log.info({ durationMs: Math.round(performance.now() - maintenanceStartedAt) }, "Completed workspace maintenance");
    stopWorkspaceMaintenance = workspaces.start((error) => app.log.error(errorDiagnostic(error)));

    app.setErrorHandler((error, _request, reply) => {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      // Malformed multipart input is a client error even though busboy only reports a message.
      if (
        ["FST_PROTO_VIOLATION", "FST_INVALID_JSON_FIELD_ERROR", "FST_MP_PREMATURE_CLOSE"].includes(code) ||
        (error instanceof Error && /^(?:Multipart: |Unexpected end of multipart data|Malformed part header|Unexpected end of form)/.test(error.message))
      )
        return reply.code(400).send({ error: "invalid_multipart" });
      if (code === "FST_ERR_CTP_INVALID_JSON_BODY" || code === "FST_ERR_CTP_EMPTY_JSON_BODY") return reply.code(400).send({ error: "invalid_json" });
      if (["FST_ERR_CTP_BODY_TOO_LARGE", "FST_REQ_FILE_TOO_LARGE", "FST_FIELDS_LIMIT", "FST_PARTS_LIMIT", "FST_FILES_LIMIT"].includes(code))
        return reply.code(413).send({ error: "payload_too_large" });
      if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") return reply.code(415).send({ error: "unsupported_media_type" });
      if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.message });
      // Known failure codes keep their status; the joined chain stays internal and never reaches the client.
      const errorMessages = errorChain(error)
        .filter((cause) => !(cause instanceof DrizzleQueryError))
        .map((cause) => (cause instanceof Error ? cause.message : String(cause)))
        .join("\n");
      // A rollback or cleanup failure dominates the constraint error wrapped in its AggregateError: the state was not
      // cleanly settled, so reporting a retryable conflict (or keeping the failure out of the log) would mislead.
      for (const operationalError of [
        // A committed edit takes precedence over the nested reason why its session reset failed.
        "issue_saved_session_reset_failed",
        "attachment_finalize_failed",
        "attachment_rollback_failed",
        "attachment_staging_cleanup_failed",
        "attachment_copy_cleanup_failed",
        "attachment_read_cleanup_failed",
        "issue_state_rollback_failed",
        "issue_update_rollback_failed",
        "source_rename_rollback_failed",
        "source_rename_finalize_failed",
        "source_save_cleanup_failed",
        "source_path_cleanup_failed",
        "workspace_runtime_restore_failed",
        "issue_workspace_missing",
        "issue_workspace_not_found",
        "issue_service_not_found",
        "issue_environment_not_found",
        "agent_session_file_incomplete",
        "agent_session_file_missing",
      ]) {
        if (errorMessages.includes(operationalError)) {
          app.log.error(errorDiagnostic(error));
          return reply.code(500).send({ error: operationalError });
        }
      }
      for (const conflict of ["issue_deployment_required", "deployment_is_used_by_issues", "issue_resolution_state_invalid", "unmanaged_issue_state"]) {
        if (errorMessages.includes(conflict)) return reply.code(409).send({ error: conflict });
      }
      if (/UNIQUE constraint failed/i.test(errorMessages)) return reply.code(409).send({ error: "conflict" });
      if (/FOREIGN KEY constraint failed/i.test(errorMessages)) return reply.code(409).send({ error: "resource_in_use" });
      app.log.error(errorDiagnostic(error));
      return reply.code(500).send({ error: "internal_error" });
    });

    // Every API and MCP response may carry identity-scoped data; one hook guarantees it for new routes.
    // SSE hijacks the socket and writes its own streaming cache headers.
    app.addHook("onSend", async (request, reply, payload) => {
      if (request.url === "/mcp" || request.url.startsWith("/api/")) {
        reply.header("Cache-Control", "private, no-store");
        reply.header("Pragma", "no-cache");
      }
      return payload;
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
      try {
        await stopWorkspaceMaintenance?.();
      } catch (error) {
        failures.push(error);
      }
      try {
        await engine?.close?.();
      } catch (error) {
        failures.push(error);
      }
      // Scope-only writes (repositories, users, configuration) must finish before the database closes.
      await scopeQueue.idle();
      try {
        await modelRuntime?.close();
      } catch (error) {
        failures.push(error);
      }
      // Keep the state lease until the database is closed so a new instance cannot start against live state.
      try {
        await database.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await stateLease?.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "api_close_failed");
    });
    return app;
  } catch (error) {
    if (stopWorkspaceMaintenance) await stopWorkspaceMaintenance().catch(() => undefined);
    if (engine?.close) await engine.close().catch(() => undefined);
    await modelRuntime?.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    try {
      await connection?.close();
    } catch {
      // Preserve the startup error that triggered cleanup.
    }
    await stateLease?.close().catch(() => undefined);
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
