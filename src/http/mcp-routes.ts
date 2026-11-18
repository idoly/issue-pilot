import { loadMcpConnections } from "../configuration/service-mcp.ts";
import { eq } from "drizzle-orm";
import { issuesAffectedByGlobalChange } from "../configuration/impact.ts";
import { mcpServices } from "../db/schema.ts";
import { inspectMcp, type McpConfiguration } from "../mcp/client.ts";
import { parseMcpConfiguration, parseMcpImport, publicMcpUrl } from "../configuration/mcp.ts";
import { errorDiagnostic } from "../diagnostics.ts";
import { constraintFailure } from "../db/constraints.ts";
import { DomainError } from "../domain/errors.ts";
import { isClassifiedFailure, record } from "./input.ts";
import { requireAdmin, runIssueExclusive, type ApiRouteContext } from "./route-context.ts";
type McpRow = typeof mcpServices.$inferSelect;
const project = (row: McpRow) => ({
  id: row.id,
  name: row.name,
  url: publicMcpUrl(row.url),
  transport: row.transport,
  enabled: row.enabled,
  credentialConfigured: row.transport === "stdio" ? Boolean(row.stdio) : Boolean(row.authorization || new URL(row.url).search),
});
export function registerMcpRoutes(context: Pick<ApiRouteContext, "app" | "database" | "engine" | "runScopeExclusive">) {
  const { app, database, engine, runScopeExclusive } = context;
  const requireService = async (id: string) => {
    const row = (await loadMcpConnections(database.db)).find((connection) => connection.id === id);
    if (!row) throw new DomainError("mcp_service_not_found", "not_found");
    return row;
  };
  const mutate = async <T>(operation: () => Promise<T>) => {
    const affected = await issuesAffectedByGlobalChange(database.db);
    try {
      return await runIssueExclusive(
        engine,
        affected.map((row) => row.id),
        async (reservation) => {
          for (const row of affected) await reservation.closeSession(row.id);
          return operation();
        },
        "mcp_has_running_issues",
      );
    } catch (error) {
      if (isClassifiedFailure(error)) throw error;
      // Connection names are unique; the database boundary reports which constraint failed.
      if (constraintFailure(error)?.code === "conflict") throw new DomainError("mcp_name_conflict", "conflict", { cause: error });
      app.log.error(errorDiagnostic(error));
      throw new DomainError("mcp_configuration_save_failed", "internal");
    }
  };
  app.get("/api/mcp-services", async (_request, _reply) => {
    return runScopeExclusive(async () =>
      (await loadMcpConnections(database.db)).sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id)).map(project),
    );
  });
  // Global connections (including the DingTalk import gateway) carry shared credentials and launch host
  // processes, so reading their configuration, changing, deleting or testing them is admin-only like creation.
  app.get<{ Params: { id: string } }>("/api/mcp-services/:id/configuration", { logLevel: "silent" }, async (request, _reply) => {
    return runScopeExclusive(async () => {
      await requireAdmin(database, request);
      const row = await requireService(request.params.id);
      const configuration =
        row.transport === "stdio"
          ? { ...(row.stdio ?? { type: "stdio" }) }
          : { url: row.url, ...(row.transport === "sse" ? { type: "sse" } : {}), ...(row.authorization ? { headers: { Authorization: row.authorization } } : {}) };
      return { mcpServers: { [row.name]: { ...configuration, ...(!row.enabled ? { enabled: false } : {}) } } };
    });
  });
  app.post("/api/mcp-services", { logLevel: "silent" }, async (request, reply) => {
    await requireAdmin(database, request);
    const result = await runScopeExclusive(async () => {
      await requireAdmin(database, request);
      const input = parseMcpConfiguration(request.body);
      return mutate(() =>
        database.db.transaction(async (transaction) => {
          const [row] = await transaction.insert(mcpServices).values(input).returning();
          await loadMcpConnections(transaction);
          return project(row!);
        }),
      );
    });
    return reply.code(201).send(result);
  });
  app.post("/api/mcp-services/import", { logLevel: "silent" }, async (request, reply) => {
    await requireAdmin(database, request);
    const result = await runScopeExclusive(async () => {
      await requireAdmin(database, request);
      const inputs = parseMcpImport(request.body);
      return mutate(() =>
        database.db.transaction(async (transaction) => {
          const rows = await transaction.insert(mcpServices).values(inputs).returning();
          await loadMcpConnections(transaction);
          return rows.map(project);
        }),
      );
    });
    return reply.code(201).send(result);
  });
  app.patch<{ Params: { id: string } }>("/api/mcp-services/:id", { logLevel: "silent" }, async (request) => {
    await requireAdmin(database, request);
    return runScopeExclusive(async () => {
      await requireAdmin(database, request);
      const current = await requireService(request.params.id);
      if (current.deploymentId) throw new DomainError("mcp_managed_by_service", "conflict");
      const input = "mcpServers" in record(request.body) ? parseMcpImport(request.body, current)[0]! : parseMcpConfiguration(request.body, current);
      if (Object.entries(input).every(([key, value]) => (key === "stdio" ? JSON.stringify(current.stdio) === JSON.stringify(value) : current[key as keyof typeof input] === value)))
        return project(current);
      return mutate(() =>
        database.db.transaction(async (transaction) => {
          const [row] = await transaction
            .update(mcpServices)
            .set({ ...input, updatedAt: new Date() })
            .where(eq(mcpServices.id, current.id))
            .returning();
          await loadMcpConnections(transaction);
          return project(row!);
        }),
      );
    });
  });
  app.delete<{ Params: { id: string } }>("/api/mcp-services/:id", async (request, reply) => {
    await requireAdmin(database, request);
    await runScopeExclusive(async () => {
      await requireAdmin(database, request);
      const current = await requireService(request.params.id);
      if (current.deploymentId) throw new DomainError("mcp_managed_by_service", "conflict");
      await mutate(() => database.db.delete(mcpServices).where(eq(mcpServices.id, current.id)));
    });
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/api/mcp-services/:id/test", { logLevel: "silent" }, async (request, _reply) => {
    await requireAdmin(database, request);
    const configuration: McpConfiguration = await runScopeExclusive(async () => {
      await requireAdmin(database, request);
      return requireService(request.params.id);
    });
    try {
      return { tools: await inspectMcp(configuration) };
    } catch (error) {
      // The MCP owner classifies its stable mcp_* failures as upstream; those are logged once by the global handler.
      if (error instanceof DomainError && error.category === "upstream") throw error;
      app.log.error({ code: "mcp_connection_failed" }, "mcp_connection_test_failed");
      throw new DomainError("mcp_connection_failed", "upstream");
    }
  });
}
