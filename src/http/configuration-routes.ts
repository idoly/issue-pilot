import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { loadConfiguration, loadConfigurationCatalog } from "../configuration/read.ts";
import { issues, services } from "../db/schema.ts";
import { ApiError, optionalText, record, text } from "./input.ts";
import { runIssueExclusive, type ApiRouteContext } from "./route-context.ts";
import { applyServiceConfiguration, prepareServiceConfiguration } from "./service-configuration.ts";

function uniqueServiceKey(name: string, existingKeys: Set<string>): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 90).replace(/-+$/g, "");
  const base = slug || `service-${randomUUID().slice(0, 8)}`;
  if (!existingKeys.has(base)) return base;
  let suffix = 2;
  while (existingKeys.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function registerConfigurationRoutes(context: ApiRouteContext): void {
  const { app, database, engine, modelCatalog, runScopeExclusive } = context;
  const findServiceByKey = async (key: string) => (await database.db.select().from(services).where(eq(services.key, key)).limit(1))[0];

  app.get("/api/catalog", async (_request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    return runScopeExclusive(() => loadConfigurationCatalog(database.db));
  });

  app.get("/api/config", async (_request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    reply.header("Pragma", "no-cache");
    return runScopeExclusive(() => loadConfiguration(database.db, modelCatalog));
  });

  app.post("/api/services", async (request, reply) => {
    const input = record(request.body);
    const name = text(input.name, "name", 200);
    const description = optionalText(input.description) ?? "";
    const createdService = await runScopeExclusive(async () => {
      const serviceId = randomUUID();
      const [existingKeys, prepared] = await Promise.all([
        database.db.select({ key: services.key }).from(services).then((rows) => new Set(rows.map(({ key }) => key))),
        prepareServiceConfiguration({ executor: database.db, modelCatalog, serviceId, input }),
      ]);
      const serviceKey = uniqueServiceKey(name, existingKeys);
      return database.db.transaction(async (transaction) => {
        const [service] = await transaction.insert(services).values({ id: serviceId, key: serviceKey, name, description }).returning();
        await applyServiceConfiguration({ executor: transaction, serviceId, prepared });
        return service!;
      });
    });
    return reply.code(201).send({ key: createdService.key, name: createdService.name });
  });

  app.patch<{ Params: { key: string } }>("/api/services/:key", async (request) => {
    return runScopeExclusive(async () => {
      const service = await findServiceByKey(request.params.key);
      if (!service) throw new ApiError(404, "service_not_found");
      const affectedIssues = await database.db.select({ id: issues.id }).from(issues).where(eq(issues.serviceId, service.id));
      try {
        return await runIssueExclusive(engine, affectedIssues.map((issue) => issue.id), async (reservation) => {
          const input = record(request.body);
          const serviceUpdate = { name: text(input.name, "name", 200), description: optionalText(input.description) ?? "" };
          const prepared = await prepareServiceConfiguration({ executor: database.db, modelCatalog, serviceId: service.id, input });
          for (const issue of affectedIssues) await reservation.closeSession(issue.id);
          await database.db.transaction((transaction) => applyServiceConfiguration({ executor: transaction, serviceId: service.id, prepared, serviceUpdate }));
          return { ok: true };
        });
      } catch (error) {
        if (error instanceof ApiError && error.message === "issue_already_running") throw new ApiError(409, "service_has_running_issues");
        throw error;
      }
    });
  });

  app.delete<{ Params: { key: string } }>("/api/services/:key", async (request, reply) => {
    await runScopeExclusive(async () => {
      const service = await findServiceByKey(request.params.key);
      if (!service) throw new ApiError(404, "service_not_found");
      if ((await database.db.select({ id: issues.id }).from(issues).where(eq(issues.serviceId, service.id)).limit(1))[0]) throw new ApiError(409, "service_is_used_by_issues");
      await database.db.delete(services).where(eq(services.id, service.id));
    });
    return reply.code(204).send();
  });

}
