import { randomUUID } from "node:crypto";

import { asc, eq, inArray, sql } from "drizzle-orm";

import { configuredCapabilities, CAPABILITY_KEYS, ENVIRONMENT_KINDS } from "../domain/contracts.ts";
import { environments, issues, serviceDeployments, serviceRepositories, services, subjects } from "../db/schema.ts";
import { ApiError, optionalText, record, text } from "./input.ts";
import { ensureCurrentSubject, type ApiRouteContext } from "./route-context.ts";
import { replaceServiceConfiguration } from "./service-configuration.ts";

function uniqueServiceKey(name: string, existingKeys: Set<string>): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 90).replace(/-+$/g, "");
  const base = slug || `service-${randomUUID().slice(0, 8)}`;
  if (!existingKeys.has(base)) return base;
  let suffix = 2;
  while (existingKeys.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function registerConfigurationRoutes(context: ApiRouteContext): void {
  const { app, database, engine, modelCatalog } = context;
  const findServiceByKey = async (key: string) => (await database.db.select().from(services).where(eq(services.key, key)).limit(1))[0];
  const serializePerson = (person: typeof subjects.$inferSelect) => ({
    subject: person.subject, name: person.displayName ?? person.username ?? person.subject, email: person.email ?? "",
  });

  app.get("/api/me", async () => {
    const subject = await ensureCurrentSubject(database);
    const [person] = await database.db.select().from(subjects).where(eq(subjects.subject, subject)).limit(1);
    if (!person) throw new Error("current_subject_not_found");
    return serializePerson(person);
  });

  app.get("/api/people", async () => {
    await ensureCurrentSubject(database);
    return (await database.db.select().from(subjects).orderBy(asc(subjects.displayName))).map(serializePerson);
  });

  app.get("/api/config", async (_request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    reply.header("Pragma", "no-cache");
    const [environmentRows, serviceRows, deploymentRows, repositoryRows, agentModels] = await Promise.all([
      database.db.select().from(environments).where(inArray(environments.key, ENVIRONMENT_KINDS)).orderBy(asc(environments.name)),
      database.db.select().from(services).orderBy(asc(services.createdAt), sql`${services}.rowid`),
      database.db.select().from(serviceDeployments), database.db.select().from(serviceRepositories), modelCatalog.list(),
    ]);
    return {
      agentModels,
      environments: environmentRows.map((environment) => ({ id: environment.id, key: environment.key, name: environment.name, kind: environment.kind })),
      capabilityCatalog: CAPABILITY_KEYS.map((key) => ({ key })),
      services: serviceRows.map((service) => {
        const deployments = deploymentRows.filter((deployment) => deployment.serviceId === service.id);
        return {
          id: service.id, key: service.key, name: service.name, description: service.description, createdAt: service.createdAt.toISOString(),
          environmentIds: deployments.map((deployment) => deployment.environmentId),
          deployments: deployments.map((deployment) => {
            const deploymentConfig = record(deployment.config);
            return { id: deployment.id, environmentId: deployment.environmentId, baseBranch: deployment.baseBranch, ...structuredClone(deploymentConfig), capabilities: configuredCapabilities(deploymentConfig), agent: deploymentConfig.agent ?? null };
          }),
          repositories: repositoryRows.filter((repository) => repository.serviceId === service.id).map((repository) => ({ id: repository.id, url: repository.url })),
        };
      }),
    };
  });

  app.post("/api/services", async (request, reply) => {
    const input = record(request.body);
    const name = text(input.name, "name", 200);
    const description = optionalText(input.description) ?? "";
    const existingKeys = new Set((await database.db.select({ key: services.key }).from(services)).map(({ key }) => key));
    const key = uniqueServiceKey(name, existingKeys);
    const created = await database.db.transaction(async (transaction) => {
      const [service] = await transaction.insert(services).values({ key, name, description }).returning();
      await replaceServiceConfiguration({ executor: transaction, modelCatalog, serviceId: service!.id, input });
      return service!;
    });
    return reply.code(201).send(created);
  });

  app.patch<{ Params: { key: string } }>("/api/services/:key", async (request) => {
    const service = await findServiceByKey(request.params.key);
    if (!service) throw new ApiError(404, "service_not_found");
    const affectedIssues = await database.db.select({ id: issues.id }).from(issues).where(eq(issues.serviceId, service.id));
    if (affectedIssues.some((issue) => engine.isRunning(issue.id))) throw new ApiError(409, "service_has_running_issues");
    const input = record(request.body);
    const serviceUpdate = { name: text(input.name, "name", 200), description: optionalText(input.description) ?? "" };
    await database.db.transaction((transaction) => replaceServiceConfiguration({ executor: transaction, modelCatalog, serviceId: service.id, input, serviceUpdate }));
    if (affectedIssues.length) {
      await Promise.all(affectedIssues.map((issue) => engine.closeSession(issue.id)));
    }
    return { ok: true };
  });

  app.delete<{ Params: { key: string } }>("/api/services/:key", async (request, reply) => {
    const service = await findServiceByKey(request.params.key);
    if (!service) throw new ApiError(404, "service_not_found");
    if ((await database.db.select({ id: issues.id }).from(issues).where(eq(issues.serviceId, service.id)).limit(1))[0]) throw new ApiError(409, "service_is_used_by_issues");
    await database.db.delete(services).where(eq(services.id, service.id));
    return reply.code(204).send();
  });

}
