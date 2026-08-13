import { and, eq, inArray } from "drizzle-orm";

import { CapabilityConfigurationError, configuredCapabilitySections, parseCapabilityConfiguration, storedCapabilitySections } from "../capabilities/registry.ts";
import type { Database } from "../db/client.ts";
import { environments, issues, serviceDeploymentRepositories, serviceDeployments, serviceRepositories, services } from "../db/schema.ts";
import { AGENT_THINKING_LEVELS, CAPABILITY_KEYS, ENVIRONMENT_KINDS, type AgentConfiguration, type CapabilityName } from "../domain/contracts.ts";
import type { AgentModelCatalog } from "../pi/models.ts";
import { ApiError, choice, optionalText, record, strings, text } from "./input.ts";

type DatabaseExecutor = Pick<Database, "select" | "insert" | "update" | "delete">;

function capabilityConfiguration<Key extends CapabilityName>(key: Key, value: unknown, required: boolean) {
  if (!required) return undefined;
  try { return parseCapabilityConfiguration(key, value); }
  catch (error) {
    if (error instanceof CapabilityConfigurationError) throw new ApiError(400, error.message);
    throw error;
  }
}

export function parseCapabilities(value: unknown): CapabilityName[] {
  const capabilities = strings(value, "capabilities");
  if (new Set(capabilities).size !== capabilities.length || capabilities.some((capability) => !CAPABILITY_KEYS.includes(capability as CapabilityName))) throw new ApiError(400, "invalid_capabilities");
  return CAPABILITY_KEYS.filter((key) => capabilities.includes(key));
}

export const parseNacosConfiguration = (value: unknown, required: boolean) => capabilityConfiguration("nacos", value, required);
export const parseDatabaseConfiguration = (value: unknown, required: boolean) => capabilityConfiguration("db", value, required);
export const parseDmsConfiguration = (value: unknown, required: boolean) => capabilityConfiguration("dms", value, required);
export const parseSlsConfiguration = (value: unknown, required: boolean) => capabilityConfiguration("sls", value, required);
export const parseRedisConfiguration = (value: unknown, required: boolean) => capabilityConfiguration("redis", value, required);
export const parseElasticsearchConfiguration = (value: unknown, required: boolean) => capabilityConfiguration("es", value, required);
export const parseRabbitMqConfiguration = (value: unknown, required: boolean) => capabilityConfiguration("mq", value, required);
export const parsePlaywrightConfiguration = (value: unknown, required: boolean) => capabilityConfiguration("playwright", value, required);

function parseAgentConfiguration(value: unknown): AgentConfiguration {
  if (value === undefined || value === null) throw new ApiError(400, "agent_configuration_required");
  const input = record(value);
  return {
    provider: text(input.provider, "agent_provider", 200),
    model: text(input.model, "agent_model", 500),
    thinkingLevel: choice(input.thinkingLevel, "agent_thinking_level", AGENT_THINKING_LEVELS),
  };
}

function parseServiceConfigurationInput(input: Record<string, unknown>) {
  const repositories = Array.isArray(input.repositories) ? input.repositories.map(record).map((repository) => ({
    id: optionalText(repository.id, 255),
    alias: text(repository.alias, "repository_alias", 100),
    url: text(repository.url, "repository_url"),
  })) : [];
  if (!repositories.length) throw new ApiError(400, "repository_required");
  if (new Set(repositories.map((repository) => repository.alias)).size !== repositories.length) throw new ApiError(400, "duplicate_repository_alias");
  if (new Set(repositories.map((repository) => repository.url)).size !== repositories.length) throw new ApiError(400, "duplicate_repository");
  const repositoryAliases = new Set(repositories.map((repository) => repository.alias));

  const deployments = Array.isArray(input.deployments) ? input.deployments.map(record).map((deployment) => {
    const capabilities = parseCapabilities(deployment.capabilities ?? []);
    const repositoryBranches = Array.isArray(deployment.repositoryBranches) ? deployment.repositoryBranches.map(record).map((branch) => ({
      repositoryAlias: text(branch.repositoryAlias, "repository_alias", 100),
      baseBranch: text(branch.baseBranch, "base_branch", 255),
    })) : [];
    if (repositoryBranches.length !== repositories.length || new Set(repositoryBranches.map((branch) => branch.repositoryAlias)).size !== repositoryBranches.length || repositoryBranches.some((branch) => !repositoryAliases.has(branch.repositoryAlias))) throw new ApiError(400, "invalid_deployment_repository_branches");
    let capabilityConfiguration;
    try { capabilityConfiguration = configuredCapabilitySections(deployment, capabilities); }
    catch (error) {
      if (error instanceof CapabilityConfigurationError) throw new ApiError(400, error.message);
      throw error;
    }
    return {
      environmentKey: text(deployment.environmentKey, "environment_key", 100),
      repositoryBranches,
      capabilities,
      agent: parseAgentConfiguration(deployment.agent),
      ...capabilityConfiguration,
    };
  }) : [];
  if (new Set(deployments.map((deployment) => deployment.environmentKey)).size !== deployments.length) throw new ApiError(400, "duplicate_deployment_environment");
  return { repositories, deployments };
}

function storedDeploymentConfiguration(deployment: ReturnType<typeof parseServiceConfigurationInput>["deployments"][number]) {
  return { agent: deployment.agent, ...storedCapabilitySections(deployment) };
}

type ParsedServiceConfiguration = ReturnType<typeof parseServiceConfigurationInput>;

async function validateConfiguredModels(modelCatalog: AgentModelCatalog, deployments: ParsedServiceConfiguration["deployments"]): Promise<void> {
  const availableModels = await modelCatalog.list();
  for (const deployment of deployments) {
    const model = availableModels.find((candidate) => candidate.provider === deployment.agent.provider && candidate.id === deployment.agent.model);
    if (!model) throw new ApiError(400, "agent_model_not_available");
    if (!model.thinkingLevels.includes(deployment.agent.thinkingLevel)) throw new ApiError(400, "agent_thinking_level_not_supported");
  }
}

async function validatedDatabaseConfiguration(executor: DatabaseExecutor, serviceId: string, parsed: ParsedServiceConfiguration) {
  const { repositories: repositoriesInput, deployments: deploymentsInput } = parsed;
  const [existingRepositories, existingDeployments, referencedIssues, environmentRows] = await Promise.all([
    executor.select().from(serviceRepositories).where(eq(serviceRepositories.serviceId, serviceId)),
    executor.select().from(serviceDeployments).where(eq(serviceDeployments.serviceId, serviceId)),
    executor.select({ environmentId: issues.environmentId }).from(issues).where(eq(issues.serviceId, serviceId)),
    executor.select().from(environments).where(inArray(environments.key, ENVIRONMENT_KINDS)),
  ]);
  const environmentsByKey = new Map(environmentRows.map((environment) => [environment.key, environment]));
  if (deploymentsInput.some((deployment) => !environmentsByKey.has(deployment.environmentKey))) throw new ApiError(400, "invalid_environment");
  const existingById = new Map(existingRepositories.map((repository) => [repository.id, repository]));
  const configuredIds = repositoriesInput.flatMap((repository) => repository.id ? [repository.id] : []);
  if (new Set(configuredIds).size !== configuredIds.length || configuredIds.some((id) => !existingById.has(id))) throw new ApiError(400, "invalid_repository");
  const retainedEnvironmentIds = new Set(deploymentsInput.map((deployment) => environmentsByKey.get(deployment.environmentKey)!.id));
  const referencedEnvironmentIds = new Set(referencedIssues.map((issue) => issue.environmentId));
  if (existingDeployments.some((deployment) => !retainedEnvironmentIds.has(deployment.environmentId) && referencedEnvironmentIds.has(deployment.environmentId))) throw new ApiError(409, "deployment_is_used_by_issues");
  return { repositoriesInput, deploymentsInput, existingRepositories, existingDeployments, environmentsByKey, existingById };
}

export async function validateServiceConfigurationInput(modelCatalog: AgentModelCatalog, input: Record<string, unknown>): Promise<void> {
  const parsed = parseServiceConfigurationInput(input);
  await validateConfiguredModels(modelCatalog, parsed.deployments);
}

export async function validateServiceConfiguration(options: { executor: DatabaseExecutor; modelCatalog: AgentModelCatalog; serviceId: string; input: Record<string, unknown> }): Promise<void> {
  const parsed = parseServiceConfigurationInput(options.input);
  await Promise.all([
    validateConfiguredModels(options.modelCatalog, parsed.deployments),
    validatedDatabaseConfiguration(options.executor, options.serviceId, parsed),
  ]);
}

export async function replaceServiceConfiguration(options: { executor: DatabaseExecutor; serviceId: string; input: Record<string, unknown>; serviceUpdate?: { name: string; description: string } }): Promise<void> {
  const { executor, serviceId, input, serviceUpdate } = options;
  const parsed = parseServiceConfigurationInput(input);
  const { repositoriesInput, deploymentsInput, existingRepositories, existingDeployments, environmentsByKey, existingById } = await validatedDatabaseConfiguration(executor, serviceId, parsed);

  if (serviceUpdate) await executor.update(services).set({ ...serviceUpdate, updatedAt: new Date() }).where(eq(services.id, serviceId));
  const retainedRepositoryIds = new Set<string>();
  const savedRepositoryByAlias = new Map<string, typeof serviceRepositories.$inferSelect>();
  for (const repository of repositoriesInput) {
    const savedRows = repository.id && existingById.has(repository.id)
      ? await executor.update(serviceRepositories).set({ alias: repository.alias, url: repository.url, updatedAt: new Date() }).where(and(eq(serviceRepositories.id, repository.id), eq(serviceRepositories.serviceId, serviceId))).returning()
      : await executor.insert(serviceRepositories).values({ serviceId, alias: repository.alias, url: repository.url }).returning();
    const savedRepository = savedRows[0];
    if (!savedRepository) throw new Error("repository_save_failed");
    retainedRepositoryIds.add(savedRepository.id);
    savedRepositoryByAlias.set(repository.alias, savedRepository);
  }
  for (const repository of existingRepositories) if (!retainedRepositoryIds.has(repository.id)) await executor.delete(serviceRepositories).where(eq(serviceRepositories.id, repository.id));

  const existingByEnvironmentId = new Map(existingDeployments.map((deployment) => [deployment.environmentId, deployment]));
  const retainedDeploymentIds = new Set<string>();
  for (const deploymentInput of deploymentsInput) {
    const environment = environmentsByKey.get(deploymentInput.environmentKey)!;
    const existingDeployment = existingByEnvironmentId.get(environment.id);
    const deploymentConfig = storedDeploymentConfiguration(deploymentInput);
    const savedDeployment = existingDeployment
      ? (await executor.update(serviceDeployments).set({ config: deploymentConfig, updatedAt: new Date() }).where(eq(serviceDeployments.id, existingDeployment.id)).returning())[0]!
      : (await executor.insert(serviceDeployments).values({ serviceId, environmentId: environment.id, config: deploymentConfig }).returning())[0]!;
    retainedDeploymentIds.add(savedDeployment.id);
    await executor.delete(serviceDeploymentRepositories).where(eq(serviceDeploymentRepositories.deploymentId, savedDeployment.id));
    await executor.insert(serviceDeploymentRepositories).values(deploymentInput.repositoryBranches.map((branch) => ({
      deploymentId: savedDeployment.id,
      repositoryId: savedRepositoryByAlias.get(branch.repositoryAlias)!.id,
      baseBranch: branch.baseBranch,
    })));
  }
  for (const deployment of existingDeployments) if (!retainedDeploymentIds.has(deployment.id)) await executor.delete(serviceDeployments).where(eq(serviceDeployments.id, deployment.id));
}
