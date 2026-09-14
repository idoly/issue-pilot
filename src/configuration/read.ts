import { asc, inArray, sql } from "drizzle-orm";

import { loadGlobalAgentConfiguration } from "./agent.ts";
import type { Database } from "../db/client.ts";
import { environments, serviceDeploymentRepositories, serviceDeployments, serviceRepositories, services } from "../db/schema.ts";
import { configuredCapabilities, ENVIRONMENT_KINDS, type AgentModelDefinition } from "../domain/contracts.ts";
import type { AgentModelCatalog } from "../pi/models.ts";
import type { Configuration, ConfigurationCatalog } from "./contracts.ts";
import { projectCapabilityConfiguration } from "./credentials.ts";

type ConfigurationReader = Pick<Database, "select">;

async function projectConfigurationCatalog(database: ConfigurationReader): Promise<ConfigurationCatalog> {
  const [environmentRows, serviceRows, deploymentRows] = await Promise.all([
    database.select().from(environments).where(inArray(environments.key, ENVIRONMENT_KINDS)).orderBy(asc(environments.name)),
    database.select({ id: services.id, key: services.key, name: services.name }).from(services).orderBy(asc(services.createdAt), sql`${services}.rowid`),
    database.select({ serviceId: serviceDeployments.serviceId, environmentId: serviceDeployments.environmentId }).from(serviceDeployments).orderBy(asc(serviceDeployments.createdAt), sql`${serviceDeployments}.rowid`),
  ]);
  const environmentKeyById = new Map(environmentRows.map((environment) => [environment.id, environment.key]));
  const deploymentsByServiceId = new Map<string, Array<{ environmentKey: string }>>();
  for (const deployment of deploymentRows) {
    const environmentKey = environmentKeyById.get(deployment.environmentId);
    if (!environmentKey) throw new Error("deployment_environment_not_found");
    const grouped = deploymentsByServiceId.get(deployment.serviceId) ?? [];
    grouped.push({ environmentKey });
    deploymentsByServiceId.set(deployment.serviceId, grouped);
  }
  return {
    environments: environmentRows.map(({ key, name }) => ({ key, name })),
    services: serviceRows.map((service) => ({ key: service.key, name: service.name, deployments: deploymentsByServiceId.get(service.id) ?? [] })),
  };
}

export function loadConfigurationCatalog(database: Database): Promise<ConfigurationCatalog> {
  return database.transaction((transaction) => projectConfigurationCatalog(transaction));
}

async function projectConfiguration(database: ConfigurationReader, agentModels: AgentModelDefinition[]): Promise<Configuration> {
  const [agent, environmentRows, serviceRows, deploymentRows, repositoryRows, deploymentRepositoryRows] = await Promise.all([
    loadGlobalAgentConfiguration(database),
    database.select().from(environments).where(inArray(environments.key, ENVIRONMENT_KINDS)).orderBy(asc(environments.name)),
    database.select().from(services).orderBy(asc(services.createdAt), sql`${services}.rowid`),
    database.select().from(serviceDeployments).orderBy(asc(serviceDeployments.createdAt), sql`${serviceDeployments}.rowid`),
    database.select().from(serviceRepositories).orderBy(asc(serviceRepositories.createdAt), sql`${serviceRepositories}.rowid`),
    database.select().from(serviceDeploymentRepositories),
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
    agent,
    agentModels: agentModels.map(({ provider, id, thinkingLevels }) => ({ provider, id, thinkingLevels })),
    environments: environmentRows.map(({ key, name }) => ({ key, name })),
    services: serviceRows.map((service) => {
      const deployments = deploymentsByServiceId.get(service.id) ?? [];
      const repositories = repositoriesByServiceId.get(service.id) ?? [];
      return {
        key: service.key,
        name: service.name,
        description: service.description,
        deployments: deployments.map((deployment) => {
          const deploymentConfig = deployment.config;
          const environmentKey = environmentKeyById.get(deployment.environmentId);
          if (!environmentKey) throw new Error("deployment_environment_not_found");
          const branchByRepositoryId = branchesByDeploymentId.get(deployment.id) ?? new Map<string, string>();
          if (repositories.some((repository) => !branchByRepositoryId.has(repository.id)) || branchByRepositoryId.size !== repositories.length) throw new Error("deployment_repository_branches_invalid");
          return {
            ...projectCapabilityConfiguration(deploymentConfig),
            environmentKey,
            repositoryBranches: repositories.map((repository) => ({ repositoryId: repository.id, repositoryAlias: repository.alias, baseBranch: branchByRepositoryId.get(repository.id)! })),
            capabilities: configuredCapabilities(deploymentConfig),
          };
        }),
        repositories: repositories.map(({ id, alias, url }) => ({ id, alias, url })),
      };
    }),
  };
}

export async function loadConfiguration(database: Database, modelCatalog: AgentModelCatalog): Promise<Configuration> {
  const agentModels = await modelCatalog.list();
  return database.transaction((transaction) => projectConfiguration(transaction, agentModels));
}
