import { OperationError } from "../operation-error.ts";
import { readFileSync } from "node:fs";
import path from "node:path";
import { errorChain, errorDiagnostic, hasErrorCode } from "../diagnostics.ts";
import { constraintFailure } from "../db/constraints.ts";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import { applicationConfig } from "../config.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { ensureGlobalAgentConfiguration } from "../configuration/agent.ts";
import { installApplicationParameters, loadApplicationParameterState } from "../configuration/parameters.ts";
import { AgentEngine } from "../agent/engine.ts";
import type { AgentController } from "../agent/contracts.ts";
import { AgentEventBus } from "../agent/events.ts";
import { openApplicationDatabase } from "../db/bootstrap.ts";
import type { DatabaseConnection } from "../db/client.ts";
import { createPiModelRuntime, PiAgentModelCatalog, type AgentModelCatalog } from "../agent/model-runtime.ts";
import { SerialQueue } from "../serial.ts";
import { WorkspaceLifecycleManager, workspaceLifecyclePolicy, type WorkspaceLifecyclePolicy } from "../workspace/lifecycle.ts";
import { IssueScopeTransitionManager } from "../workspace/scope-transition.ts";
import { ApplicationStateLease } from "../state-lease.ts";
import { SourceBrowser } from "../workspace/source-browser.ts";
import { registerAgentRoutes } from "./agent-routes.ts";
import { registerAttachmentRoutes } from "./attachment-routes.ts";
import { registerConfigurationRoutes } from "./configuration-routes.ts";
import { DomainError, OPERATIONAL_FAILURE_CODES } from "../domain/errors.ts";
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
import { registerUserRoutes, type IdentityMode } from "./user-routes.ts";
import { assertWebBuild, registerWebRoutes } from "./web-routes.ts";
import { assertRuntimeDependencyPatches } from "./dependency-patches.ts";
import { registerWorkspaceRoutes } from "./workspace-routes.ts";

export type { AgentController } from "../agent/contracts.ts";

export interface ApiOptions {
  dingtalkConnector?: McpConnector;
  issueSearchFetch?: typeof fetch;
  /** Test seam for the shared sandbox network sync that follows a committed parameter save. */
  applyIssueSandboxNetwork?: () => Promise<void>;
  /** Clock for Issue key dates only; defaults to the wall clock. */
  now?: () => Date;
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
  /** Overrides the root http.identity mode; tests use it instead of mutating frozen configuration. */
  identity?: IdentityMode;
}

interface ShutdownTarget {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  exitCode?: number | string | null | undefined;
}

/** The host runner supplies the checked-out revision; a manual start falls back to the package version. */
function startupRevision(): string {
  const runnerRevision = process.env.ISSUE_PILOT_REVISION?.trim();
  if (runnerRevision) return runnerRevision;
  try {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? `v${manifest.version}` : "unknown";
  } catch {
    return "unknown";
  }
}

export function installShutdownHandlers(app: FastifyInstance, target: ShutdownTarget = process): () => void {
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    try {
      app.log.info("Shutdown requested");
    } catch {
      // A logging failure cannot block shutdown.
    }
    // Stalled downloads or uploads would otherwise keep a graceful close pending indefinitely.
    const force = setTimeout(() => app.server.closeAllConnections(), issuePilotConfig.http.shutdownGraceMs);
    force.unref();
    void app
      .close()
      .then(() => {
        try {
          app.log.info("Shutdown complete");
        } catch {
          // A logging failure cannot turn a clean close into a failure.
        }
      })
      .finally(() => clearTimeout(force))
      .catch((error) => {
        // The process stops either way; a failed cleanup must not look like a clean stop to the host runner.
        target.exitCode = 1;
        try {
          app.log.error(errorDiagnostic(error));
        } catch {
          // A logger failure cannot turn graceful shutdown into an unhandled rejection.
        }
      });
  };
  // Keep listening while closing: a repeated stop signal must not fall through to Node's default
  // handler and kill the process before the engine, database and lease are released.
  target.on("SIGINT", shutdown);
  target.on("SIGTERM", shutdown);
  return () => {
    target.removeListener("SIGINT", shutdown);
    target.removeListener("SIGTERM", shutdown);
  };
}

/** API and inbound MCP requests by matched route (unmatched: path without query); Web assets and /health are outside. */
function identityScoped(request: FastifyRequest): boolean {
  const path = request.routeOptions.url ?? request.url.split("?", 1)[0]!;
  return path === "/mcp" || path.startsWith("/api/");
}

export async function buildApi(options: ApiOptions = {}): Promise<FastifyInstance> {
  const stateRoot = path.resolve(options.stateRoot ?? applicationConfig.stateRoot);
  const databaseFile = options.databaseFile ?? applicationConfig.databaseFile;
  // Idle keep-alive sockets close at once; in-flight requests finish, and preClose ends long-lived SSE streams.
  const app = Fastify({ logger: options.logger ?? applicationConfig.http.logger, forceCloseConnections: "idle" });
  app.log.info({ revision: startupRevision() }, "Starting application");
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
    // Refuse to run an install whose postinstall dependency patches were skipped.
    await assertRuntimeDependencyPatches();
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
        undefined,
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
      // A rollback or cleanup failure dominates the constraint error wrapped in its AggregateError: the state was not
      // cleanly settled, so reporting a retryable conflict (or keeping the failure out of the log) would mislead.
      if (!(error instanceof DomainError))
        for (const operationalError of OPERATIONAL_FAILURE_CODES) {
          if (hasErrorCode(error, operationalError)) {
            app.log.error(errorDiagnostic(error));
            return reply.code(500).send({ error: operationalError });
          }
        }
      // Owners declare categories; SQLite constraint failures are translated once at the database boundary.
      const failure = error instanceof DomainError ? error : constraintFailure(error);
      if (failure) {
        if (failure.statusCode >= 500) app.log.error(errorDiagnostic(error));
        return reply.code(failure.statusCode).send({ error: failure.code });
      }
      app.log.error(errorDiagnostic(error));
      return reply.code(500).send({ error: "internal_error" });
    });

    const identityMode = options.identity ?? applicationConfig.http.identity;
    // A gateway deployment must bind every API, SSE and MCP request to an identity; implicit
    // selection would silently act as the oldest active user. /health and Web assets stay open.
    if (identityMode === "gateway")
      app.addHook("onRequest", async (request, reply) => {
        if (identityScoped(request) && !request.headers["x-issue-pilot-subject"]) return reply.code(401).send({ error: "current_subject_required" });
      });

    // Every API and MCP response may carry identity-scoped data; one hook guarantees it for new routes.
    // SSE hijacks the socket and writes its own streaming cache headers.
    app.addHook("onSend", async (request, reply, payload) => {
      if (identityScoped(request)) {
        reply.header("Cache-Control", "private, no-store");
        reply.header("Pragma", "no-cache");
      }
      return payload;
    });

    const sourceBrowser = new SourceBrowser(database.db, stateRoot);
    const scopeTransitions = new IssueScopeTransitionManager(database.db, engine, workspaces);
    const routeContext = { app, database, engine, stateRoot, modelCatalog, events, workspaces, scopeTransitions, sourceBrowser, runScopeExclusive };
    // Liveness plus a lock-free probe of the open database connection; it does not check models or external services.
    app.get("/health", async (_request, reply) => {
      try {
        await database.client.execute("SELECT 1");
        return { ok: true };
      } catch (error) {
        app.log.error(errorDiagnostic(error));
        return reply.code(503).send({ ok: false, error: "database_unavailable" });
      }
    });
    registerUserRoutes(routeContext, identityMode);
    registerRepositoryRoutes(routeContext);
    registerCapabilityRoutes(routeContext);
    registerMcpRoutes(routeContext);
    registerApplicationMcp(routeContext);
    const cancelActiveSearches = registerIssueSearchRoutes(routeContext, options.issueSearchFetch);
    registerConfigurationRoutes(routeContext, cancelActiveSearches, options.applyIssueSandboxNetwork);
    const { createIssue, resolveCreationScope } = registerIssueRoutes(routeContext, options.now);
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
