import { and, eq, inArray } from "drizzle-orm";

import { CapabilityConfigurationError, storedCapabilitySections } from "../capabilities/registry.ts";
import { resolveConfiguredCapabilitySections } from "../configuration/credentials.ts";
import { serviceConfigurationRevision } from "../configuration/revision.ts";
import type { Database } from "../db/client.ts";
import { environments, issues, serviceDeploymentRepositories, serviceDeployments, serviceRepositories, services } from "../db/schema.ts";
import { AGENT_THINKING_LEVELS, CAPABILITY_KEYS, ENVIRONMENT_KINDS, type AgentConfiguration, type AgentModelDefinition, type CapabilityName, type DeploymentConfig } from "../domain/contracts.ts";
import type { AgentModelCatalog } from "../pi/models.ts";
import { ApiError, choice, optionalText, record, strings, text } from "./input.ts";

type DatabaseExecutor = Pick<Database, "select" | "insert" | "update" | "delete">;

export function parseCapabilities(value: unknown): CapabilityName[] {
  const capabilities = strings(value, "capabilities");
  if (new Set(capabilities).size !== capabilities.length || capabilities.some((capability) => !CAPABILITY_KEYS.includes(capability as CapabilityName))) throw new ApiError(400, "invalid_capabilities");
  return CAPABILITY_KEYS.filter((key) => capabilities.includes(key));
}

function parseAgentConfiguration(value: unknown): AgentConfiguration {
  if (value === undefined || value === null) throw new ApiError(400, "agent_configuration_required");
  const input = record(value);
  return {
    provider: text(input.provider, "agent_provider", 200),
    model: text(input.model, "agent_model", 500),
    thinkingLevel: choice(input.thinkingLevel, "agent_thinking_level", AGENT_THINKING_LEVELS),
  };
}

function storedConfiguration(value: unknown): DeploymentConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("deployment_configuration_invalid");
  return value as DeploymentConfig;
}

function parseServiceConfigurationInput(input: Record<string, unknown>, existingConfigurationByEnvironmentKey: Map<string, DeploymentConfig>) {
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
    const environmentKey = text(deployment.environmentKey, "environment_key", 100);
    const capabilities = parseCapabilities(deployment.capabilities ?? []);
    const repositoryBranches = Array.isArray(deployment.repositoryBranches) ? deployment.repositoryBranches.map(record).map((branch) => ({
      repositoryAlias: text(branch.repositoryAlias, "repository_alias", 100),
      baseBranch: text(branch.baseBranch, "base_branch", 255),
    })) : [];
    if (repositoryBranches.length !== repositories.length || new Set(repositoryBranches.map((branch) => branch.repositoryAlias)).size !== repositoryBranches.length || repositoryBranches.some((branch) => !repositoryAliases.has(branch.repositoryAlias))) throw new ApiError(400, "invalid_deployment_repository_branches");
    let capabilityConfiguration;
    try { capabilityConfiguration = resolveConfiguredCapabilitySections(deployment, capabilities, existingConfigurationByEnvironmentKey.get(environmentKey)); }
    catch (error) {
      if (error instanceof CapabilityConfigurationError) throw new ApiError(400, error.message);
      throw error;
    }
    return {
      environmentKey,
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

function validateConfiguredModels(availableModels: AgentModelDefinition[], deployments: ParsedServiceConfiguration["deployments"]): void {
  for (const deployment of deployments) {
    const model = availableModels.find((candidate) => candidate.provider === deployment.agent.provider && candidate.id === deployment.agent.model);
    if (!model) throw new ApiError(400, "agent_model_not_available");
    if (!model.thinkingLevels.includes(deployment.agent.thinkingLevel)) throw new ApiError(400, "agent_thinking_level_not_supported");
  }
}

export interface PreparedServiceConfiguration {
  parsed: ParsedServiceConfiguration;
  existingRepositories: Array<typeof serviceRepositories.$inferSelect>;
  existingDeployments: Array<typeof serviceDeployments.$inferSelect>;
  environmentsByKey: Map<string, typeof environments.$inferSelect>;
  existingById: Map<string, typeof serviceRepositories.$inferSelect>;
}

export async function prepareServiceConfiguration(options: { executor: DatabaseExecutor; modelCatalog: AgentModelCatalog; serviceId: string; input: Record<string, unknown>; existingService?: typeof services.$inferSelect; expectedRevision?: string }): Promise<PreparedServiceConfiguration> {
  const { executor, modelCatalog, serviceId } = options;
  const [existingRepositories, existingDeployments, referencedIssues, environmentRows, availableModels] = await Promise.all([
    executor.select().from(serviceRepositories).where(eq(serviceRepositories.serviceId, serviceId)),
    executor.select().from(serviceDeployments).where(eq(serviceDeployments.serviceId, serviceId)),
    executor.select({ environmentId: issues.environmentId }).from(issues).where(eq(issues.serviceId, serviceId)),
    executor.select().from(environments).where(inArray(environments.key, ENVIRONMENT_KINDS)),
    modelCatalog.list(),
  ]);
  const existingDeploymentRepositories = existingDeployments.length
    ? await executor.select().from(serviceDeploymentRepositories).where(inArray(serviceDeploymentRepositories.deploymentId, existingDeployments.map((deployment) => deployment.id)))
    : [];
  if (options.existingService) {
    const revision = serviceConfigurationRevision(options.existingService, existingRepositories, existingDeployments, existingDeploymentRepositories);
    if (revision !== options.expectedRevision) throw new ApiError(409, "service_configuration_changed");
  }
  const environmentsByKey = new Map(environmentRows.map((environment) => [environment.key, environment]));
  const environmentKeyById = new Map(environmentRows.map((environment) => [environment.id, environment.key]));
  const existingConfigurationByEnvironmentKey = new Map(existingDeployments.map((deployment) => {
    const environmentKey = environmentKeyById.get(deployment.environmentId);
    if (!environmentKey) throw new Error("deployment_environment_not_found");
    return [environmentKey, storedConfiguration(deployment.config)] as const;
  }));
  const parsed = parseServiceConfigurationInput(options.input, existingConfigurationByEnvironmentKey);
  const { repositories: repositoriesInput, deployments: deploymentsInput } = parsed;
  validateConfiguredModels(availableModels, deploymentsInput);
  if (deploymentsInput.some((deployment) => !environmentsByKey.has(deployment.environmentKey))) throw new ApiError(400, "invalid_environment");
  const existingById = new Map(existingRepositories.map((repository) => [repository.id, repository]));
  const configuredIds = repositoriesInput.flatMap((repository) => repository.id ? [repository.id] : []);
  if (new Set(configuredIds).size !== configuredIds.length || configuredIds.some((id) => !existingById.has(id))) throw new ApiError(400, "invalid_repository");
  const retainedEnvironmentIds = new Set(deploymentsInput.map((deployment) => environmentsByKey.get(deployment.environmentKey)!.id));
  const referencedEnvironmentIds = new Set(referencedIssues.map((issue) => issue.environmentId));
  if (existingDeployments.some((deployment) => !retainedEnvironmentIds.has(deployment.environmentId) && referencedEnvironmentIds.has(deployment.environmentId))) throw new ApiError(409, "deployment_is_used_by_issues");
  return { parsed, existingRepositories, existingDeployments, environmentsByKey, existingById };
}

export async function applyServiceConfiguration(options: { executor: DatabaseExecutor; serviceId: string; prepared: PreparedServiceConfiguration; serviceUpdate?: { name: string; description: string } }): Promise<void> {
  const { executor, serviceId, prepared, serviceUpdate } = options;
  const { repositories: repositoriesInput, deployments: deploymentsInput } = prepared.parsed;
  const { existingRepositories, existingDeployments, environmentsByKey, existingById } = prepared;
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
