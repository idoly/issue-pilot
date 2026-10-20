import { asc, eq } from "drizzle-orm";
import { mcpServices, issues } from "../db/schema.ts";
import { inspectMcp, type McpConfiguration } from "../mcp/client.ts";
import { ApiError, choice, record, text } from "./input.ts";
import { MCP_TRANSPORTS, type McpStdioConfiguration } from "../domain/contracts.ts";
import { requireAdmin, requireDeveloper, runIssueExclusive, type ApiRouteContext } from "./route-context.ts";

type McpRow = typeof mcpServices.$inferSelect;
const project = (row: McpRow) => ({ id: row.id, name: row.name, url: row.url, transport: row.transport, enabled: row.enabled, credentialConfigured: row.transport === "stdio" ? Boolean(row.stdio) : Boolean(row.authorization) });
function parseStdio(value: unknown): McpStdioConfiguration {
  const input = record(value), command = text(input.command, "mcp_command", 4096);
  if (command.includes("\0") || input.args !== undefined && !Array.isArray(input.args)) throw new ApiError(400, "invalid_mcp_stdio");
  const args = ((input.args ?? []) as unknown[]).map(arg => { if (typeof arg !== "string" || arg.includes("\0")) throw new ApiError(400, "invalid_mcp_stdio"); return arg; });
  const env = Object.fromEntries(Object.entries(record(input.env === undefined ? {} : input.env)).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0")) throw new ApiError(400, "invalid_mcp_stdio");
    return [key, value] as const;
  }));
  if (input.cwd === undefined) return { command, args, env };
  const cwd = text(input.cwd, "mcp_cwd", 4096); if (cwd.includes("\0")) throw new ApiError(400, "invalid_mcp_stdio");
  return { command, args, env, cwd };
}
function parse(body: unknown, existing?: McpRow) {
  const input = record(body);
  const name = text(input.name, "mcp_name", 100);
  const transport = choice(input.transport, "mcp_transport", MCP_TRANSPORTS);
  const url = transport === "stdio" ? "" : text(input.url, "mcp_url", 2048);
  if (transport === "stdio") { if (input.url !== undefined && input.url !== "") throw new ApiError(400, "invalid_mcp_url"); }
  else {
    let endpoint: URL;
    try { endpoint = new URL(url); } catch { throw new ApiError(400, "invalid_mcp_url"); }
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new ApiError(400, "invalid_mcp_url");
  }
  if (typeof input.enabled !== "boolean" || "authorization" in input || "stdio" in input) throw new ApiError(400, "invalid_mcp_configuration");
  const update = record(input.credentialUpdate);
  let authorization = "", stdio: McpStdioConfiguration | null = null;
  if (update.mode === "preserve") {
    if (!existing || existing.url !== url || existing.transport !== transport) throw new ApiError(400, "mcp_credentials_target_changed");
    authorization = existing.authorization; stdio = existing.stdio;
  } else if (update.mode === "replace") {
    const values = record(update.values);
    if (transport === "stdio") stdio = parseStdio(values.stdio);
    else {
      authorization = text(values.authorization, "mcp_authorization", 10000);
      if (/[\r\n\0]/.test(authorization)) throw new ApiError(400, "invalid_mcp_authorization");
    }
  } else if (update.mode !== "clear") throw new ApiError(400, "invalid_credential_update");
  if (transport === "stdio" && input.enabled && !stdio) throw new ApiError(400, "mcp_stdio_configuration_required");
  return { name, url, transport, enabled: input.enabled, authorization, stdio };
}
function parseImport(body: unknown, existing?: McpRow) {
  const entries = Object.entries(record(record(body).mcpServers));
  if (!entries.length || existing && entries.length !== 1) throw new ApiError(400, "invalid_mcp_servers");
  return entries.map(([name, value]) => {
    const entry = record(value), enabled = entry.enabled ?? (entry.disabled === undefined ? existing?.enabled ?? true : !entry.disabled);
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") throw new ApiError(400, "invalid_mcp_configuration");
    if (entry.disabled !== undefined && typeof entry.disabled !== "boolean") throw new ApiError(400, "invalid_mcp_configuration");
    if ("command" in entry || entry.type === "stdio") {
      if (entry.url !== undefined || entry.type !== undefined && entry.type !== "stdio") throw new ApiError(400, "invalid_mcp_configuration");
      if (!("command" in entry) && (entry.args !== undefined || entry.env !== undefined || entry.cwd !== undefined || !existing)) throw new ApiError(400, "invalid_mcp_stdio");
      return parse({ name, transport: "stdio", enabled, credentialUpdate: "command" in entry ? { mode: "replace", values: { stdio: entry } } : { mode: "preserve" } }, existing);
    }
    const type = entry.type === undefined ? "http" : entry.type;
    if (!["http", "streamable_http", "streamable-http", "sse"].includes(String(type))) throw new ApiError(400, "invalid_mcp_transport");
    const headers = Object.entries(record(entry.headers ?? {}));
    if (headers.some(([key]) => key.toLowerCase() !== "authorization") || headers.length > 1) throw new ApiError(400, "mcp_headers_not_supported");
    return parse({ name, url: entry.url, transport: type === "sse" ? "sse" : "streamable_http", enabled, credentialUpdate: headers.length ? { mode: "replace", values: { authorization: headers[0]![1] } } : { mode: existing && entry.headers === undefined ? "preserve" : "clear" } }, existing);
  });
}

export function registerMcpRoutes(context: Pick<ApiRouteContext, "app" | "database" | "engine" | "runScopeExclusive">) {
  const { app, database, engine, runScopeExclusive } = context;

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
  app.get<{ Params: { id: string } }>("/api/mcp-services/:id/configuration", { logLevel: "silent" }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store"); reply.header("Pragma", "no-cache");
    return runScopeExclusive(async () => {
      await requireDeveloper(database, request);
      const row = await requireService(request.params.id);
      const configuration = row.transport === "stdio"
        ? { ...(row.stdio ?? { type: "stdio" }) }
        : { url: row.url, ...(row.transport === "sse" ? { type: "sse" } : {}), ...(row.authorization ? { headers: { Authorization: row.authorization } } : {}) };
      return { mcpServers: { [row.name]: { ...configuration, ...(!row.enabled ? { enabled: false } : {}) } } };
    });
  });
  app.post("/api/mcp-services", { logLevel: "silent" }, async (request, reply) => {
    await requireAdmin(database, request);
    const result = await runScopeExclusive(async () => {
      await requireAdmin(database, request);
      const input = parse(request.body);
      return mutate(async () => {
        const [row] = await database.db.insert(mcpServices).values(input).returning();
        return project(row!);
      });
    });
    return reply.code(201).send(result);
  });
  app.post("/api/mcp-services/import", { logLevel: "silent" }, async (request, reply) => {
    await requireAdmin(database, request);
    const result = await runScopeExclusive(async () => {
      await requireAdmin(database, request);
      const inputs = parseImport(request.body);
      return mutate(() => database.db.transaction(async transaction => (await transaction.insert(mcpServices).values(inputs).returning()).map(project)));
    });
    return reply.code(201).send(result);
  });
  app.patch<{ Params: { id: string } }>("/api/mcp-services/:id", { logLevel: "silent" }, async (request) => {
    await requireDeveloper(database, request);
    return runScopeExclusive(async () => {
      await requireDeveloper(database, request);
      const current = await requireService(request.params.id);
      const input = "mcpServers" in record(request.body) ? parseImport(request.body, current)[0]! : parse(request.body, current);
      if (Object.entries(input).every(([key, value]) => key === "stdio" ? JSON.stringify(current.stdio) === JSON.stringify(value) : current[key as keyof typeof input] === value)) return project(current);
      return mutate(async () => {
        const [row] = await database.db.update(mcpServices).set({ ...input, updatedAt: new Date() }).where(eq(mcpServices.id, current.id)).returning();
        return project(row!);
      });
    });
  });
  app.delete<{ Params: { id: string } }>("/api/mcp-services/:id", async (request, reply) => {
    await requireDeveloper(database, request);
    await runScopeExclusive(async () => {
      await requireDeveloper(database, request); const current = await requireService(request.params.id);
      await mutate(() => database.db.delete(mcpServices).where(eq(mcpServices.id, current.id)));
    });
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
