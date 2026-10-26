import { drizzle } from "drizzle-orm/libsql";
import { asc, eq, inArray, sql } from "drizzle-orm";

import { loadGlobalAgentConfiguration } from "./agent.ts";
import type { Database } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { environments, serviceDeploymentRepositories, serviceDeployments, serviceRepositories, services } from "../db/schema.ts";
import { configuredCapabilities, ENVIRONMENT_KINDS, type AgentModelDefinition } from "../domain/contracts.ts";
import type { AgentModelCatalog } from "../agent/model-runtime.ts";
import type { Configuration, ConfigurationCatalog } from "./contracts.ts";
import { deploymentContext } from "./service-context.ts";
import { dingtalkMcpNames, serviceMcpConnections } from "./service-mcp.ts";
import { projectCapabilityConfiguration } from "./credentials.ts";

const descriptionEnvironmentOrder = ["dev", "test", "prod"];

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

async function readSnapshot<T>(database: Database, project: (reader: ConfigurationReader) => Promise<T>): Promise<T> {
  // Drizzle's libSQL adapter ignores transaction options. Use native read mode
  // so a configuration snapshot does not reserve the SQLite writer.
  const client = new Proxy(database.$client, {
    get(target, property) {
      if (property === "transaction") return () => target.transaction("read");
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return drizzle(client, { schema }).transaction((transaction) => project(transaction));
}

export function loadConfigurationCatalog(database: Database): Promise<ConfigurationCatalog> {
  return readSnapshot(database, projectConfigurationCatalog);
}

async function projectConfiguration(database: ConfigurationReader, agentModels: AgentModelDefinition[]): Promise<Configuration> {
  const [agent, environmentRows, serviceRows, deploymentRows, repositoryRows, deploymentRepositoryRows, mcp] = await Promise.all([
    loadGlobalAgentConfiguration(database),
    database.select().from(environments).where(inArray(environments.key, ENVIRONMENT_KINDS)).orderBy(asc(environments.name)),
    database.select().from(services).orderBy(asc(services.createdAt), sql`${services}.rowid`),
    database.select().from(serviceDeployments).orderBy(asc(serviceDeployments.createdAt), sql`${serviceDeployments}.rowid`),
    database.select().from(serviceRepositories).orderBy(asc(serviceRepositories.createdAt), sql`${serviceRepositories}.rowid`),
    database.select().from(serviceDeploymentRepositories),
    database.select({ id: schema.mcpServices.id, name: schema.mcpServices.name, url: schema.mcpServices.url, transport: schema.mcpServices.transport, enabled: schema.mcpServices.enabled, deploymentId: schema.mcpServices.deploymentId }).from(schema.mcpServices),
  ]);
  const importNames = await dingtalkMcpNames(database);
  const environmentKeyById = new Map(environmentRows.map((environment) => [environment.id, environment.key]));
  const environmentById = new Map(environmentRows.map(environment => [environment.id, environment]));
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
        revision: service.revision,
        key: service.key,
        name: service.name,
        description: service.description,
        context: [service.description, ...deployments.toSorted((left, right) => descriptionEnvironmentOrder.indexOf(environmentKeyById.get(left.environmentId)!) - descriptionEnvironmentOrder.indexOf(environmentKeyById.get(right.environmentId)!)).map(deployment => deploymentContext(environmentById.get(deployment.environmentId)!, deployment.config, serviceMcpConnections(mcp, [deployment.id], importNames)))].filter(Boolean).join("\n\n"),
        deployments: deployments.map((deployment) => {
          const deploymentConfig = deployment.config;
          const environmentKey = environmentKeyById.get(deployment.environmentId);
          if (!environmentKey) throw new Error("deployment_environment_not_found");
          const branchDeployment = environmentKey === "dev" ? deployments.find(row => environmentKeyById.get(row.environmentId) === "prod") : deployment;
          if (!branchDeployment) throw new Error("development_production_deployment_required");
          const branchByRepositoryId = branchesByDeploymentId.get(branchDeployment.id) ?? new Map<string, string>();
          if (repositories.some((repository) => !branchByRepositoryId.has(repository.id)) || branchByRepositoryId.size !== repositories.length) throw new Error("deployment_repository_branches_invalid");
          return {
            ...projectCapabilityConfiguration(deploymentConfig),
            ...(deploymentConfig.mysql ? { mysql: deploymentConfig.mysql.map(({ password, ...target }) => ({ ...target, passwordConfigured: Boolean(password) })) } : {}),
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

export function loadServiceConfigurationDescription(database: Database, key: string): Promise<{ context: string } | undefined> {
  return readSnapshot(database, async reader => {
    const [service] = await reader.select().from(services).where(eq(services.key, key)).limit(1);
    if (!service) return undefined;
    const [deployments, environmentRows, mcp] = await Promise.all([
      reader.select().from(serviceDeployments).where(eq(serviceDeployments.serviceId, service.id)),
      reader.select().from(environments), reader.select().from(schema.mcpServices),
    ]);
    const importNames = await dingtalkMcpNames(reader);
    return { context: [service.description, ...deployments.toSorted((left, right) => descriptionEnvironmentOrder.indexOf(environmentRows.find(row => row.id === left.environmentId)?.key ?? "") - descriptionEnvironmentOrder.indexOf(environmentRows.find(row => row.id === right.environmentId)?.key ?? "")).map(deployment => {
      const environment = environmentRows.find(row => row.id === deployment.environmentId);
      if (!environment) throw new Error("deployment_environment_not_found");
      const connections = serviceMcpConnections(mcp, [deployment.id], importNames);
      return deploymentContext(environment, deployment.config, connections, connections, true);
    })].filter(Boolean).join("\n\n") };
  });
}

export async function loadConfiguration(database: Database, modelCatalog: AgentModelCatalog): Promise<Configuration> {
  const agentModels = await modelCatalog.list();
  return readSnapshot(database, (reader) => projectConfiguration(reader, agentModels));
}
