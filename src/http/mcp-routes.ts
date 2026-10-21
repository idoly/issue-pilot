import { asc, eq } from "drizzle-orm";
import { mcpServices, issues } from "../db/schema.ts";
import { inspectMcp, type McpConfiguration } from "../mcp/client.ts";
import { parseMcpConfiguration, parseMcpImport, publicMcpUrl } from "../configuration/mcp.ts";
import { ApiError, record } from "./input.ts";
import { requireAdmin, requireDeveloper, runIssueExclusive, type ApiRouteContext } from "./route-context.ts";
type McpRow = typeof mcpServices.$inferSelect;
const project = (row: McpRow) => ({ id: row.id, name: row.name, url: publicMcpUrl(row.url), transport: row.transport, enabled: row.enabled, credentialConfigured: row.transport === "stdio" ? Boolean(row.stdio) : Boolean(row.authorization || new URL(row.url).search) });
export function registerMcpRoutes(context: Pick<ApiRouteContext, "app" | "database" | "engine" | "runScopeExclusive" | "fileConfiguration">) {
  const { app, database, engine, runScopeExclusive } = context;
  const current = (row: McpRow) => !context.fileConfiguration?.mcp || context.fileConfiguration.mcpServiceNames?.includes(row.name) === true;
  const requireService = async (id: string) => {
    const [row] = await database.db.select().from(mcpServices).where(eq(mcpServices.id, id)).limit(1);
    if (!row || !current(row)) throw new ApiError(404, "mcp_service_not_found");
    return row;
  };
  const mutate = async <T>(operation: () => Promise<T>) => {
    const affected = await database.db.select({ id: issues.id }).from(issues);
    try {
      return await runIssueExclusive(engine, affected.map(row => row.id), async reservation => {
        for (const row of affected) await reservation.closeSession(row.id);
        return operation();
      });
    } catch (error) {
      if (error instanceof ApiError && error.message === "issue_already_running") throw new ApiError(409, "mcp_has_running_issues");
      if (error instanceof ApiError) throw error;
      const chain = error instanceof Error ? error.cause : undefined;
      if (chain instanceof Error && /UNIQUE constraint/.test(chain.message)) throw new ApiError(409, "mcp_name_conflict");
      throw new ApiError(500, "mcp_configuration_save_failed");
    }
  };
  app.get("/api/mcp-services", async (_request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    return runScopeExclusive(async () => (await database.db.select().from(mcpServices).orderBy(asc(mcpServices.createdAt), asc(mcpServices.id))).filter(current).map(project));
  });
  app.get<{ Params: { id: string } }>("/api/mcp-services/:id/configuration", { logLevel: "silent" }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store"); reply.header("Pragma", "no-cache");
    return runScopeExclusive(async () => {
      await requireDeveloper(database, request);
      const row = await requireService(request.params.id);
      const configuration = row.transport === "stdio" ? { ...(row.stdio ?? { type: "stdio" }) } : { url: row.url, ...(row.transport === "sse" ? { type: "sse" } : {}), ...(row.authorization ? { headers: { Authorization: row.authorization } } : {}) };
      return { mcpServers: { [row.name]: { ...configuration, ...(!row.enabled ? { enabled: false } : {}) } } };
    });
  });
  app.post("/api/mcp-services", { logLevel: "silent" }, async (request, reply) => {
    await requireAdmin(database, request);
    const result = await runScopeExclusive(async () => {
      await requireAdmin(database, request);
      const input = parseMcpConfiguration(request.body);
      return mutate(async () => { const [row] = await database.db.insert(mcpServices).values(input).returning(); return project(row!); });
    });
    return reply.code(201).send(result);
  });
  app.post("/api/mcp-services/import", { logLevel: "silent" }, async (request, reply) => {
    await requireAdmin(database, request);
    const result = await runScopeExclusive(async () => {
      await requireAdmin(database, request);
      const inputs = parseMcpImport(request.body);
      return mutate(() => database.db.transaction(async transaction => (await transaction.insert(mcpServices).values(inputs).returning()).map(project)));
    });
    return reply.code(201).send(result);
  });
  app.patch<{ Params: { id: string } }>("/api/mcp-services/:id", { logLevel: "silent" }, async request => {
    await requireDeveloper(database, request);
    return runScopeExclusive(async () => {
      await requireDeveloper(database, request);
      const current = await requireService(request.params.id);
      const input = "mcpServers" in record(request.body) ? parseMcpImport(request.body, current)[0]! : parseMcpConfiguration(request.body, current);
      if (Object.entries(input).every(([key, value]) => key === "stdio" ? JSON.stringify(current.stdio) === JSON.stringify(value) : current[key as keyof typeof input] === value)) return project(current);
      return mutate(async () => { const [row] = await database.db.update(mcpServices).set({ ...input, updatedAt: new Date() }).where(eq(mcpServices.id, current.id)).returning(); return project(row!); });
    });
  });
  app.delete<{ Params: { id: string } }>("/api/mcp-services/:id", async (request, reply) => {
    await requireDeveloper(database, request);
    await runScopeExclusive(async () => { await requireDeveloper(database, request); const current = await requireService(request.params.id); await mutate(() => database.db.delete(mcpServices).where(eq(mcpServices.id, current.id))); });
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/api/mcp-services/:id/test", { logLevel: "silent" }, async (request, reply) => {
    await requireDeveloper(database, request);
    const configuration: McpConfiguration = await runScopeExclusive(async () => { await requireDeveloper(database, request); return requireService(request.params.id); });
    reply.header("Cache-Control", "private, no-store");
    try { return { tools: await inspectMcp(configuration) }; }
    catch (error) { throw new ApiError(502, error instanceof Error && /^mcp_[a-z_]+$/.test(error.message) ? error.message : "mcp_connection_failed"); }
  });
}
