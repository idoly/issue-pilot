import { asc, eq } from "drizzle-orm";
import { mcpServices, serviceDeployments, issues, subjects } from "../db/schema.ts";
import { inspectMcp, type McpConfiguration } from "../mcp/client.ts";
import { ApiError, choice, record, text } from "./input.ts";
import { ensureCurrentSubject, runIssueExclusive, type ApiRouteContext } from "./route-context.ts";

type McpRow = typeof mcpServices.$inferSelect;
const project = (row: McpRow) => ({ id: row.id, name: row.name, url: row.url, transport: row.transport, enabled: row.enabled, credentialConfigured: Boolean(row.authorization) });
function parse(body: unknown, existing?: McpRow) {
  const input = record(body);
  const name = text(input.name, "mcp_name", 100);
  const url = text(input.url, "mcp_url", 2048);
  let endpoint: URL;
  try { endpoint = new URL(url); } catch { throw new ApiError(400, "invalid_mcp_url"); }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new ApiError(400, "invalid_mcp_url");
  const transport = choice(input.transport, "mcp_transport", ["streamable_http", "sse"] as const);
  if (typeof input.enabled !== "boolean" || "authorization" in input) throw new ApiError(400, "invalid_mcp_configuration");
  const update = record(input.credentialUpdate);
  let authorization = "";
  if (update.mode === "preserve") {
    if (!existing || existing.url !== url || existing.transport !== transport) throw new ApiError(400, "mcp_credentials_target_changed");
    authorization = existing.authorization;
  } else if (update.mode === "replace") {
    const values = record(update.values);
    authorization = text(values.authorization, "mcp_authorization", 10000);
    if (/[\r\n\0]/.test(authorization)) throw new ApiError(400, "invalid_mcp_authorization");
  } else if (update.mode !== "clear") throw new ApiError(400, "invalid_credential_update");
  return { name, url, transport, enabled: input.enabled, authorization };
}

export function registerMcpRoutes(context: ApiRouteContext) {
  const { app, database, engine, runScopeExclusive } = context;
  const authorize = async (request: Parameters<typeof ensureCurrentSubject>[1]) => {
    const subject = await ensureCurrentSubject(database, request);
    const [row] = await database.db.select().from(subjects).where(eq(subjects.subject, subject)).limit(1);
    if (row?.role !== "developer") throw new ApiError(403, "developer_role_required");
  };
  const requireService = async (id: string) => {
    const [row] = await database.db.select().from(mcpServices).where(eq(mcpServices.id, id)).limit(1);
    if (!row) throw new ApiError(404, "mcp_service_not_found");
    return row;
  };
  const mutate = async <T>(operation: () => Promise<T>) => {
    const affected = await database.db.select({ id: issues.id }).from(issues);
    try {
      return await runIssueExclusive(engine, affected.map((row) => row.id), async (reservation) => {
        for (const row of affected) await reservation.closeSession(row.id);
        return operation();
      });
    } catch (error) {
      if (error instanceof ApiError && error.message === "issue_already_running") throw new ApiError(409, "mcp_has_running_issues");
      if (error instanceof ApiError) throw error;
      // Drizzle errors can include credential parameters; expose only stable codes.
      const chain = error instanceof Error ? error.cause : undefined;
      if (chain instanceof Error && /UNIQUE constraint/.test(chain.message)) throw new ApiError(409, "mcp_name_conflict");
      throw new ApiError(500, "mcp_configuration_save_failed");
    }
  };
  app.get("/api/mcp-services", async (_request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    return runScopeExclusive(async () => (await database.db.select().from(mcpServices).orderBy(asc(mcpServices.createdAt), asc(mcpServices.id))).map(project));
  });
  app.post("/api/mcp-services", { logLevel: "silent" }, async (request, reply) => {
    await authorize(request);
    const result = await runScopeExclusive(async () => {
      await authorize(request);
      const input = parse(request.body);
      return mutate(async () => {
        const [row] = await database.db.insert(mcpServices).values(input).returning();
        return project(row!);
      });
    });
    return reply.code(201).send(result);
  });
  app.patch<{ Params: { id: string } }>("/api/mcp-services/:id", { logLevel: "silent" }, async (request) => {
    await authorize(request);
    return runScopeExclusive(async () => {
      await authorize(request);
      const current = await requireService(request.params.id);
      const input = parse(request.body, current);
      if (Object.entries(input).every(([key, value]) => current[key as keyof typeof input] === value)) return project(current);
      return mutate(async () => {
        const [row] = await database.db.update(mcpServices).set({ ...input, updatedAt: new Date() }).where(eq(mcpServices.id, current.id)).returning();
        return project(row!);
      });
    });
  });
  app.delete<{ Params: { id: string } }>("/api/mcp-services/:id", async (request, reply) => {
    await authorize(request);
    await runScopeExclusive(async () => {
      await authorize(request); const current = await requireService(request.params.id);
      if ((await database.db.select().from(serviceDeployments)).some(row => row.config.mcpServices?.includes(current.id))) throw new ApiError(409, "mcp_service_in_use");
      await mutate(() => database.db.delete(mcpServices).where(eq(mcpServices.id, current.id)));
    });
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/api/mcp-services/:id/test", { logLevel: "silent" }, async (request, reply) => {
    await authorize(request);
    const configuration: McpConfiguration = await runScopeExclusive(() => requireService(request.params.id));
    reply.header("Cache-Control", "private, no-store");
    try { return { tools: await inspectMcp(configuration) }; }
    catch (error) { throw new ApiError(502, error instanceof Error && /^mcp_[a-z_]+$/.test(error.message) ? error.message : "mcp_connection_failed"); }
  });
}
