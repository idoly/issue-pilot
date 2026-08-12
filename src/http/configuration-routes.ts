import { randomUUID } from "node:crypto";

import { asc, eq, inArray, sql } from "drizzle-orm";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { configuredCapabilities, CAPABILITY_KEYS, ENVIRONMENT_KINDS } from "../domain/contracts.ts";
import { environments, issues, serviceDeploymentRepositories, serviceDeployments, serviceRepositories, services, subjects } from "../db/schema.ts";
import { ApiError, optionalText, record, text } from "./input.ts";
import { ensureConfiguredSubjects, ensureCurrentSubject, serializePerson, type ApiRouteContext } from "./route-context.ts";
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

  app.get("/api/users", async () => {
    await ensureConfiguredSubjects(database);
    return issuePilotConfig.users.map((user) => ({ subject: user.subject, name: user.name, email: user.email }));
  });

  app.get("/api/me", async (request) => {
    const subject = await ensureCurrentSubject(database, request);
    const [person] = await database.db.select().from(subjects).where(eq(subjects.subject, subject)).limit(1);
    if (!person) throw new Error("current_subject_not_found");
    return serializePerson(person);
  });

  app.get("/api/people", async () => {
    await ensureConfiguredSubjects(database);
    return (await database.db.select().from(subjects).orderBy(asc(subjects.displayName))).map(serializePerson);
  });

  app.get("/api/config", async (_request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    reply.header("Pragma", "no-cache");
    const [environmentRows, serviceRows, deploymentRows, repositoryRows, deploymentRepositoryRows, agentModels] = await Promise.all([
      database.db.select().from(environments).where(inArray(environments.key, ENVIRONMENT_KINDS)).orderBy(asc(environments.name)),
      database.db.select().from(services).orderBy(asc(services.createdAt), sql`${services}.rowid`),
      database.db.select().from(serviceDeployments).orderBy(asc(serviceDeployments.createdAt), sql`${serviceDeployments}.rowid`),
      database.db.select().from(serviceRepositories).orderBy(asc(serviceRepositories.createdAt), sql`${serviceRepositories}.rowid`),
      database.db.select().from(serviceDeploymentRepositories), modelCatalog.list(),
    ]);
    const environmentKeyById = new Map(environmentRows.map((environment) => [environment.id, environment.key]));
    return {
      agentModels: agentModels.map((model) => ({ provider: model.provider, id: model.id, thinkingLevels: model.thinkingLevels })),
      environments: environmentRows.map((environment) => ({ key: environment.key, name: environment.name })),
      capabilityCatalog: CAPABILITY_KEYS.map((key) => ({ key })),
      services: serviceRows.map((service) => {
        const deployments = deploymentRows.filter((deployment) => deployment.serviceId === service.id);
        return {
          key: service.key, name: service.name, description: service.description,
          deployments: deployments.map((deployment) => {
            const deploymentConfig = record(deployment.config);
            const environmentKey = environmentKeyById.get(deployment.environmentId);
            if (!environmentKey) throw new Error("deployment_environment_not_found");
            const serviceRepositoryRows = repositoryRows.filter((repository) => repository.serviceId === service.id);
            const branchByRepositoryId = new Map(deploymentRepositoryRows.filter((branch) => branch.deploymentId === deployment.id).map((branch) => [branch.repositoryId, branch.baseBranch]));
            if (serviceRepositoryRows.some((repository) => !branchByRepositoryId.has(repository.id)) || branchByRepositoryId.size !== serviceRepositoryRows.length) throw new Error("deployment_repository_branches_invalid");
            return {
              environmentKey,
              repositoryBranches: serviceRepositoryRows.map((repository) => ({ repositoryId: repository.id, repositoryAlias: repository.alias, baseBranch: branchByRepositoryId.get(repository.id)! })),
              ...structuredClone(deploymentConfig),
              capabilities: configuredCapabilities(deploymentConfig),
              agent: deploymentConfig.agent ?? null,
            };
          }),
          repositories: repositoryRows.filter((repository) => repository.serviceId === service.id).map((repository) => ({ id: repository.id, alias: repository.alias, url: repository.url })),
        };
      }),
    };
  });

  app.post("/api/services", async (request, reply) => {
    const input = record(request.body);
    const name = text(input.name, "name", 200);
    const description = optionalText(input.description) ?? "";
    const existingKeys = new Set((await database.db.select({ key: services.key }).from(services)).map(({ key }) => key));
    const serviceKey = uniqueServiceKey(name, existingKeys);
    const createdService = await database.db.transaction(async (transaction) => {
      const [service] = await transaction.insert(services).values({ key: serviceKey, name, description }).returning();
      await replaceServiceConfiguration({ executor: transaction, modelCatalog, serviceId: service!.id, input });
      return service!;
    });
    return reply.code(201).send({ key: createdService.key, name: createdService.name });
  });

  app.patch<{ Params: { key: string } }>("/api/services/:key", async (request) => {
    const service = await findServiceByKey(request.params.key);
    if (!service) throw new ApiError(404, "service_not_found");
    const affectedIssues = await database.db.select({ id: issues.id }).from(issues).where(eq(issues.serviceId, service.id));
    if (affectedIssues.some((issue) => engine.isRunning(issue.id))) throw new ApiError(409, "service_has_running_issues");
    const input = record(request.body);
    const serviceUpdate = { name: text(input.name, "name", 200), description: optionalText(input.description) ?? "" };
    await database.db.transaction((transaction) => replaceServiceConfiguration({ executor: transaction, modelCatalog, serviceId: service.id, input, serviceUpdate }));
    await Promise.all(affectedIssues.map((issue) => engine.closeSession(issue.id)));
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
