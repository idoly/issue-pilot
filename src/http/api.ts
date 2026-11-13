import { OperationError } from "../operation-error.ts";
import path from "node:path";
import { DrizzleQueryError } from "drizzle-orm";
import { errorChain, errorDiagnostic, hasErrorCode } from "../diagnostics.ts";
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
import { createPiModelRuntime, PiAgentModelCatalog, type AgentModelCatalog } from "../agent/model-runtime.ts";
import { SerialQueue } from "../serial.ts";
import { WorkspaceLifecycleManager, workspaceLifecyclePolicy, type WorkspaceLifecyclePolicy } from "../workspace/lifecycle.ts";
import { IssueScopeTransitionManager } from "../workspace/scope-transition.ts";
import { ApplicationStateLease } from "../workspace/state-lease.ts";
import { SourceBrowser } from "../workspace/source-browser.ts";
import { registerAgentRoutes } from "./agent-routes.ts";
import { registerAttachmentRoutes } from "./attachment-routes.ts";
import { registerConfigurationRoutes } from "./configuration-routes.ts";
import { DomainError } from "../domain/errors.ts";
import { ApiError } from "./input.ts";
import { registerDingtalkRoutes } from "./dingtalk-routes.ts";
import type { McpConnector } from "../mcp/client.ts";
import { registerIssueRoutes } from "./issue-routes.ts";
import { registerIssueSearchRoutes } from "./issue-search-routes.ts";
import { registerSourceBrowserRoutes } from "./source-browser-routes.ts";
import { registerApplicationMcp } from "../mcp/server.ts";
import { registerMcpRoutes } from "./mcp-routes.ts";
import { registerCapabilityRoutes } from "./capability-routes.ts";
import { registerRepositoryRoutes } from "./repository-routes.ts";
import { registerUserRoutes } from "./user-routes.ts";
import { assertWebBuild, registerWebRoutes } from "./web-routes.ts";
import { registerWorkspaceRoutes } from "./workspace-routes.ts";

export type { AgentController } from "../agent/engine.ts";

export interface ApiOptions {
  dingtalkConnector?: McpConnector;
  issueSearchFetch?: typeof fetch;
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
  const scopeQueue = new SerialQueue();
  let closingResources: Promise<void> | undefined;
  const closeResources = () =>
    (closingResources ??= (async () => {
      const failures: unknown[] = [];
      // Startup rollback and normal shutdown share ownership and ordering. Keep the lease until all writers stop.
      for (const close of [() => stopWorkspaceMaintenance?.(), () => engine?.close?.(), () => scopeQueue.idle(), () => modelRuntime?.close(), () => connection?.close(), () => stateLease?.close()]) {
        try {
          await close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "api_close_failed");
    })());

  try {
    if (options.webRoot) await assertWebBuild(options.webRoot);
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
    const runScopeExclusive = <T>(operation: () => Promise<T>): Promise<T> => scopeQueue.run(operation);
    const workspaces = new WorkspaceLifecycleManager(database.db, stateRoot, engine, options.workspacePolicy ?? workspaceLifecyclePolicy(parameters));
    stopWorkspaceMaintenance = () => workspaces.stop();
    app.addHook("onListen", async () => {
      workspaces.start(
        (error) => app.log.error(errorDiagnostic(error)),
        (durationMs) => app.log.info({ durationMs }, "Completed workspace maintenance"),
      );
    });

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
      const operationError = errorChain(error).find((cause): cause is OperationError => cause instanceof OperationError);
      if (operationError) {
        app.log.error(errorDiagnostic(error));
        return reply.code(500).send({ error: operationError.message, outcome: operationError.outcome });
      }
      if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.message });
      if (error instanceof DomainError) return reply.code(error.statusCode).send({ error: error.code });
      // Known failure codes keep their status; match exact codes across the chain instead of substrings.
      // A rollback or cleanup failure dominates the constraint error wrapped in its AggregateError: the state was not
      // cleanly settled, so reporting a retryable conflict (or keeping the failure out of the log) would mislead.
      for (const operationalError of [
        "attachment_staging_cleanup_failed",
        "attachment_read_cleanup_failed",
        "dingtalk_connection_close_failed",
        "workspace_runtime_restore_failed",
        "issue_root_missing",
        "invalid_issue_root",
        "issue_layout_migration_required",
        "issue_workspace_missing",
        "issue_service_not_found",
        "issue_environment_not_found",
        "agent_session_file_incomplete",
        "agent_session_file_missing",
      ]) {
        if (hasErrorCode(error, operationalError)) {
          app.log.error(errorDiagnostic(error));
          return reply.code(500).send({ error: operationalError });
        }
      }
      for (const conflict of ["issue_deployment_required", "deployment_is_used_by_issues", "issue_resolution_state_invalid", "unmanaged_issue_state"]) {
        if (hasErrorCode(error, conflict)) return reply.code(409).send({ error: conflict });
      }
      const errorMessages = errorChain(error)
        .filter((cause) => !(cause instanceof DrizzleQueryError))
        .map((cause) => (cause instanceof Error ? cause.message : String(cause)))
        .join("\n");
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
    const cancelActiveSearches = registerIssueSearchRoutes(routeContext, options.issueSearchFetch);
    registerConfigurationRoutes(routeContext, cancelActiveSearches);
    const { createIssue, resolveCreationScope } = registerIssueRoutes(routeContext);
    registerDingtalkRoutes(routeContext, createIssue, resolveCreationScope, options.dingtalkConnector);
    registerAttachmentRoutes(routeContext);
    registerAgentRoutes(routeContext);
    registerSourceBrowserRoutes(routeContext);
    registerWorkspaceRoutes(routeContext);
    if (options.webRoot) await registerWebRoutes(app, options.webRoot);
    app.addHook("onClose", closeResources);
    return app;
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await closeResources();
    } catch (cleanup) {
      failures.push(cleanup);
    }
    try {
      await app.close();
    } catch (cleanup) {
      if (!failures.includes(cleanup)) failures.push(cleanup);
    }
    if (failures.length > 1) throw new AggregateError(failures, "api_startup_cleanup_failed");
    throw error;
  }
}

export async function startApi(options: ApiOptions = {}): Promise<FastifyInstance> {
  const app = await buildApi(options);
  const removeShutdownHandlers = installShutdownHandlers(app);
  try {
    app.addHook("onClose", async () => removeShutdownHandlers());
    await app.listen({ port: applicationConfig.http.port, host: options.listenHost ?? applicationConfig.http.host });
  } catch (error) {
    removeShutdownHandlers();
    try {
      await app.close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "api_listen_cleanup_failed");
    }
    throw error;
  }
  return app;
}
