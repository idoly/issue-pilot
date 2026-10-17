import { and, asc, eq, inArray } from "drizzle-orm";
import { repositories, serviceRepositories, services, issues, subjects } from "../db/schema.ts";
import { ApiError, record, text } from "./input.ts";
import { ensureCurrentSubject, runIssueExclusive, type ApiRouteContext } from "./route-context.ts";

function repositoryInput(body: unknown) {
  const input = record(body);
  const name = text(input.name, "repository_name", 200);
  const url = text(input.url, "repository_url", 2048);
  if (/\s|\0/.test(url)) throw new ApiError(400, "invalid_repository_url");
  if (url.startsWith("https://") || url.startsWith("ssh://")) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new ApiError(400, "invalid_repository_url"); }
    if (!parsed.hostname || parsed.password || parsed.search || parsed.hash || parsed.pathname === "/" || url.startsWith("https://") && parsed.username) throw new ApiError(400, "invalid_repository_url");
  } else if (!/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:[^\s\0]+$/.test(url)) throw new ApiError(400, "invalid_repository_url");
  return { name, url };
}

export function registerRepositoryRoutes(context: ApiRouteContext) {
  const { app, database, engine, runScopeExclusive } = context;
  const authorize = async (request: Parameters<typeof ensureCurrentSubject>[1]) => {
    const subject = await ensureCurrentSubject(database, request);
    const [user] = await database.db.select().from(subjects).where(eq(subjects.subject, subject)).limit(1);
    if (user?.role !== "developer") throw new ApiError(403, "developer_role_required");
  };
  app.get("/api/repositories", async (_request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    return runScopeExclusive(async () => {
      const rows = await database.db.select().from(repositories).orderBy(asc(repositories.name), asc(repositories.url));
      const uses = await database.db.select({ url: serviceRepositories.url, serviceKey: services.key, serviceName: services.name }).from(serviceRepositories).innerJoin(services, eq(services.id, serviceRepositories.serviceId));
      return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), services: uses.filter((use) => use.url === row.url).map(({ serviceKey, serviceName }) => ({ key: serviceKey, name: serviceName })) }));
    });
  });
  app.post("/api/repositories", async (request, reply) => {
    await authorize(request);
    const input = repositoryInput(request.body);
    const result = await runScopeExclusive(async () => {
      await authorize(request);
      const [saved] = await database.db.insert(repositories).values(input).returning();
      return { id: saved!.id };
    });
    return reply.code(201).send(result);
  });
  app.patch<{ Params: { id: string } }>("/api/repositories/:id", async (request) => {
    await authorize(request);
    const input = repositoryInput(request.body);
    return runScopeExclusive(async () => {
      await authorize(request);
      const [existing] = await database.db.select().from(repositories).where(eq(repositories.id, request.params.id)).limit(1);
      if (!existing) throw new ApiError(404, "repository_not_found");
      if (existing.name === input.name && existing.url === input.url) return { ok: true };
      const bindings = await database.db.select().from(serviceRepositories).where(eq(serviceRepositories.url, existing.url));
      const serviceIds = [...new Set(bindings.map((row) => row.serviceId))];
      const affected = serviceIds.length ? await database.db.select({ id: issues.id }).from(issues) : [];
      return runIssueExclusive(engine, affected.map(({ id }) => id), async (reservation) => {
        if (existing.url !== input.url) for (const { id } of affected) await reservation.closeSession(id);
        await database.db.transaction(async (tx) => {
          const now = new Date();
          await tx.update(repositories).set({ ...input, updatedAt: now }).where(eq(repositories.id, existing.id));
          if (existing.url !== input.url && serviceIds.length) {
            await tx.update(services).set({ updatedAt: now }).where(inArray(services.id, serviceIds));
            await tx.update(serviceRepositories).set({ updatedAt: now }).where(and(inArray(serviceRepositories.serviceId, serviceIds), eq(serviceRepositories.url, input.url)));
          }
        });
        return { ok: true };
      });
    });
  });
  app.delete<{ Params: { id: string } }>("/api/repositories/:id", async (request, reply) => {
    await authorize(request);
    await runScopeExclusive(async () => {
      await authorize(request);
      const [row] = await database.db.select().from(repositories).where(eq(repositories.id, request.params.id)).limit(1);
      if (!row) throw new ApiError(404, "repository_not_found");
      const [binding] = await database.db.select({ id: serviceRepositories.id }).from(serviceRepositories).where(eq(serviceRepositories.url, row.url)).limit(1);
      if (binding) throw new ApiError(409, "repository_is_used_by_services");
      await database.db.delete(repositories).where(eq(repositories.id, row.id));
    });
    return reply.code(204).send();
  });
}
