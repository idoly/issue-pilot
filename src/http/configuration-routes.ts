import { randomUUID } from "node:crypto";

import { asc, eq, inArray, sql } from "drizzle-orm";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { configuredCapabilities, CAPABILITY_KEYS, ENVIRONMENT_KINDS } from "../domain/contracts.ts";
import { environments, issues, serviceDeploymentRepositories, serviceDeployments, serviceRepositories, services, subjects } from "../db/schema.ts";
import { ApiError, optionalText, record, text } from "./input.ts";
import { ensureConfiguredSubjects, ensureCurrentSubject, runIssueExclusive, serializePerson, type ApiRouteContext } from "./route-context.ts";
import { replaceServiceConfiguration, validateServiceConfiguration } from "./service-configuration.ts";

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
    const deploymentsByServiceId = new Map<string, typeof deploymentRows>();
    const repositoriesByServiceId = new Map<string, typeof repositoryRows>();
    const branchesByDeploymentId = new Map<string, Map<string, string>>();
    for (const deployment of deploymentRows) {
      const grouped = deploymentsByServiceId.get(deployment.serviceId) ?? [];
      grouped.push(deployment);
      deploymentsByServiceId.set(deployment.serviceId, grouped);
    }
    for (const repository of repositoryRows) {
      const grouped = repositoriesByServiceId.get(repository.serviceId) ?? [];
      grouped.push(repository);
      repositoriesByServiceId.set(repository.serviceId, grouped);
    }
    for (const branch of deploymentRepositoryRows) {
      const grouped = branchesByDeploymentId.get(branch.deploymentId) ?? new Map<string, string>();
      grouped.set(branch.repositoryId, branch.baseBranch);
      branchesByDeploymentId.set(branch.deploymentId, grouped);
    }
    return {
      agentModels: agentModels.map((model) => ({ provider: model.provider, id: model.id, thinkingLevels: model.thinkingLevels })),
      environments: environmentRows.map((environment) => ({ key: environment.key, name: environment.name })),
      capabilityCatalog: CAPABILITY_KEYS.map((key) => ({ key })),
      services: serviceRows.map((service) => {
        const deployments = deploymentsByServiceId.get(service.id) ?? [];
        const repositories = repositoriesByServiceId.get(service.id) ?? [];
        return {
          key: service.key, name: service.name, description: service.description,
          deployments: deployments.map((deployment) => {
            const deploymentConfig = record(deployment.config);
            const environmentKey = environmentKeyById.get(deployment.environmentId);
            if (!environmentKey) throw new Error("deployment_environment_not_found");
            const branchByRepositoryId = branchesByDeploymentId.get(deployment.id) ?? new Map<string, string>();
            if (repositories.some((repository) => !branchByRepositoryId.has(repository.id)) || branchByRepositoryId.size !== repositories.length) throw new Error("deployment_repository_branches_invalid");
            return {
              ...structuredClone(deploymentConfig),
              environmentKey,
              repositoryBranches: repositories.map((repository) => ({ repositoryId: repository.id, repositoryAlias: repository.alias, baseBranch: branchByRepositoryId.get(repository.id)! })),
              capabilities: configuredCapabilities(deploymentConfig),
              agent: deploymentConfig.agent ?? null,
            };
          }),
          repositories: repositories.map((repository) => ({ id: repository.id, alias: repository.alias, url: repository.url })),
        };
      }),
    };
  });

  app.post("/api/services", async (request, reply) => {
    const input = record(request.body);
    const name = text(input.name, "name", 200);
    const description = optionalText(input.description) ?? "";
    const createdService = await runScopeExclusive(async () => {
      const existingKeys = new Set((await database.db.select({ key: services.key }).from(services)).map(({ key }) => key));
      const serviceKey = uniqueServiceKey(name, existingKeys);
      return database.db.transaction(async (transaction) => {
        const [service] = await transaction.insert(services).values({ key: serviceKey, name, description }).returning();
        await replaceServiceConfiguration({ executor: transaction, modelCatalog, serviceId: service!.id, input });
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
          await validateServiceConfiguration({ executor: database.db, modelCatalog, serviceId: service.id, input });
          for (const issue of affectedIssues) await reservation.closeSession(issue.id);
          await database.db.transaction((transaction) => replaceServiceConfiguration({ executor: transaction, modelCatalog, serviceId: service.id, input, serviceUpdate }));
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
