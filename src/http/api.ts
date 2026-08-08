import path from "node:path";
import { pathToFileURL } from "node:url";

import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";

import { AgentEngine, type AgentController } from "../agent/engine.ts";
import { AgentEventBus } from "../agent/events.ts";
import { openApplicationDatabase } from "../db/bootstrap.ts";
import { issues } from "../db/schema.ts";
import { PiAgentModelCatalog, type AgentModelCatalog } from "../pi/models.ts";
import { pruneState } from "../workspace/state.ts";
import { registerAgentRoutes } from "./agent-routes.ts";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_FILES, registerAttachmentRoutes } from "./attachments.ts";
import { registerConfigurationRoutes } from "./configuration-routes.ts";
import { ApiError } from "./input.ts";
import { registerIssueRoutes } from "./issue-routes.ts";
import { installShutdownHandlers } from "./lifecycle.ts";

export type { AgentController } from "../agent/engine.ts";

export interface ApiOptions {
  databaseFile?: string;
  stateRoot?: string;
  engine?: AgentController;
  logger?: boolean;
  modelCatalog?: AgentModelCatalog;
}

export async function buildApi(options: ApiOptions = {}): Promise<FastifyInstance> {
  const stateRoot = path.resolve(options.stateRoot ?? process.env.ISSUE_PILOT_STATE_ROOT ?? ".issue-pilot");
  const database = await openApplicationDatabase(options.databaseFile ?? process.env.ISSUE_PILOT_DATABASE ?? path.join(stateRoot, "issues.db"));
  await pruneState(stateRoot, (await database.db.select({ key: issues.key }).from(issues)).map(({ key }) => key));

  const app = Fastify({ logger: options.logger ?? process.env.NODE_ENV !== "test", forceCloseConnections: true });
  const modelCatalog = options.modelCatalog ?? new PiAgentModelCatalog();
  await app.register(multipart, { limits: { fileSize: MAX_ATTACHMENT_BYTES, files: MAX_ATTACHMENT_FILES, parts: MAX_ATTACHMENT_FILES + 1, fieldSize: 100_000 } });

  const events = new AgentEventBus();
  const engine: AgentController = options.engine ?? new AgentEngine(database.db, stateRoot, (event) => events.publish(event));

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ error: error.message });
    const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "";
    if (["FST_REQ_FILE_TOO_LARGE", "FST_FILES_LIMIT", "FST_PARTS_LIMIT", "FST_FIELDS_LIMIT"].includes(errorCode)) return reply.code(413).send({ error: "attachment_limit_exceeded" });
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

  const routeContext = { app, database, engine, stateRoot, modelCatalog, events };
  app.get("/health", async () => ({ ok: true }));
  registerConfigurationRoutes(routeContext);
  registerIssueRoutes(routeContext);
  registerAttachmentRoutes(routeContext);
  registerAgentRoutes(routeContext);
  app.addHook("onClose", async () => {
    await engine.close?.();
    await database.close();
  });
  return app;
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  const app = await buildApi();
  const removeShutdownHandlers = installShutdownHandlers(app);
  try {
    await app.listen({ port, host });
  } catch (error) {
    removeShutdownHandlers();
    await app.close().catch(() => undefined);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
