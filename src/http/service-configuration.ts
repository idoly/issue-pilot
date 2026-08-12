import { and, eq, inArray } from "drizzle-orm";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { isNacosTarget, isSlsLogstore } from "../capabilities/contracts.ts";
import type { Database } from "../db/client.ts";
import { environments, issues, serviceDeploymentRepositories, serviceDeployments, serviceRepositories, services } from "../db/schema.ts";
import { AGENT_THINKING_LEVELS, CAPABILITY_KEYS, ENVIRONMENT_KINDS, type AgentConfiguration, type CapabilityName } from "../domain/contracts.ts";
import type { AgentModelCatalog } from "../pi/models.ts";
import { ApiError, choice, optionalText, record, strings, text } from "./input.ts";

const defaults = issuePilotConfig.defaults;
const SLS_REGION = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SLS_PROJECT = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
type DatabaseExecutor = Pick<Database, "select" | "insert" | "update" | "delete">;

const configurationInput = (value: unknown, required: boolean) => required ? record(value) : undefined;
const optionalString = (value: unknown, maximum = 10_000) => optionalText(value, maximum) ?? "";

function optionalCredentials(input: Record<string, unknown>, name: string) {
  const username = optionalString(input.username, 500);
  const password = optionalString(input.password);
  if (Boolean(username) !== Boolean(password)) throw new ApiError(400, `invalid_${name}_credentials`);
  return { username, ...(password ? { password } : {}) };
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new ApiError(400, `invalid_${name}`);
  return parsed;
}

function parseConnectionUrl(value: unknown, name: string, protocols: string[], options: { rootOnly?: boolean } = {}): string {
  const configuredUrl = text(value, name, 4096);
  let url: URL;
  try { url = new URL(configuredUrl); } catch { throw new ApiError(400, `invalid_${name}`); }
  if (!protocols.includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || (options.rootOnly && url.pathname !== "/")) throw new ApiError(400, `invalid_${name}`);
  return configuredUrl;
}

export function parseCapabilities(value: unknown): CapabilityName[] {
  const capabilities = strings(value, "capabilities");
  if (new Set(capabilities).size !== capabilities.length || capabilities.some((capability) => !CAPABILITY_KEYS.includes(capability as CapabilityName))) throw new ApiError(400, "invalid_capabilities");
  return CAPABILITY_KEYS.filter((key) => capabilities.includes(key));
}

export function parseNacosConfiguration(value: unknown, required: boolean) {
  const input = configurationInput(value, required);
  if (!input) return undefined;
  const credentials = optionalCredentials(input, "nacos");
  const dataIds = [...new Set(strings(input.dataIds, "nacos_data_ids").map((value) => text(value, "nacos_data_id", 255)))];
  if (!dataIds.length || dataIds.length > issuePilotConfig.limits.capability.nacos.dataIds || dataIds.some((dataId) => !isNacosTarget(dataId))) throw new ApiError(400, "invalid_nacos_data_ids");
  const group = text(input.group, "nacos_group", 255);
  if (!isNacosTarget(group)) throw new ApiError(400, "invalid_nacos_group");
  return {
    serverUrl: parseConnectionUrl(input.serverUrl, "nacos_server_url", ["http:", "https:"], { rootOnly: true }),
    namespace: optionalString(input.namespace, 255), group, dataIds, ...credentials,
  };
}

export function parseDatabaseConfiguration(value: unknown, required: boolean) {
  const input = configurationInput(value, required);
  if (!input) return undefined;
  const url = parseConnectionUrl(input.url, "db_url", ["mysql:"]);
  const parsed = new URL(url);
  let database = "";
  try { database = decodeURIComponent(parsed.pathname.slice(1)); } catch { throw new ApiError(400, "invalid_db_url"); }
  if (!parsed.port || Number(parsed.port) < 1 || !/^\/[^/]+$/.test(parsed.pathname) || !database || database.includes("/")) throw new ApiError(400, "invalid_db_url");
  return { url, username: text(input.username, "db_username", 500), password: text(input.password, "db_password") };
}

export function parseSlsConfiguration(value: unknown, required: boolean) {
  const input = configurationInput(value, required);
  if (!input) return undefined;
  const region = text(input.region, "sls_region", 63);
  const project = text(input.project, "sls_project", 63);
  const logstores = [...new Set(strings(input.logstores, "sls_logstores").map((value) => text(value, "sls_logstore", 63)))];
  if (!SLS_REGION.test(region) || !SLS_PROJECT.test(project) || !logstores.length || logstores.some((logstore) => !isSlsLogstore(logstore))) throw new ApiError(400, "invalid_sls_scope");
  return { accessKeyId: text(input.accessKeyId, "sls_access_key_id", 500), accessKeySecret: text(input.accessKeySecret, "sls_access_key_secret"), region, project, logstores };
}

export function parseRedisConfiguration(value: unknown, required: boolean) {
  const input = configurationInput(value, required);
  if (!input) return undefined;
  const password = optionalString(input.password);
  return { host: text(input.host, "redis_host", 255), port: boundedInteger(input.port ?? defaults.redis.port, "redis_port", 1, 65_535), username: optionalString(input.username, 500), ...(password ? { password } : {}), database: boundedInteger(input.database ?? defaults.redis.database, "redis_database", 0, 1_000_000) };
}

export function parseElasticsearchConfiguration(value: unknown, required: boolean) {
  const input = configurationInput(value, required);
  if (!input) return undefined;
  return { url: parseConnectionUrl(input.url, "es_url", ["http:", "https:"]), ...optionalCredentials(input, "es") };
}

export function parseRabbitMqConfiguration(value: unknown, required: boolean) {
  const input = configurationInput(value, required);
  if (!input) return undefined;
  return { host: text(input.host, "mq_host", 255), port: boundedInteger(input.port ?? defaults.rabbitmq.port, "mq_port", 1, 65_535), managementPort: boundedInteger(input.managementPort ?? defaults.rabbitmq.managementPort, "mq_management_port", 1, 65_535), username: text(input.username, "mq_username", 500), password: text(input.password, "mq_password"), virtualHost: text(input.virtualHost ?? defaults.rabbitmq.virtualHost, "mq_virtual_host", 255) };
}

export function parsePlaywrightConfiguration(value: unknown, required: boolean) {
  const input = configurationInput(value, required);
  if (!input) return undefined;
  return { baseUrl: parseConnectionUrl(input.baseUrl, "browser_base_url", ["http:", "https:"]), ...optionalCredentials(input, "browser") };
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
    return {
      environmentKey: text(deployment.environmentKey, "environment_key", 100),
      repositoryBranches,
      capabilities,
      agent: parseAgentConfiguration(deployment.agent),
      nacos: parseNacosConfiguration(deployment.nacos, capabilities.includes("nacos")),
      db: parseDatabaseConfiguration(deployment.db, capabilities.includes("db")),
      sls: parseSlsConfiguration(deployment.sls, capabilities.includes("sls")),
      playwright: parsePlaywrightConfiguration(deployment.playwright, capabilities.includes("playwright")),
      redis: parseRedisConfiguration(deployment.redis, capabilities.includes("redis")),
      es: parseElasticsearchConfiguration(deployment.es, capabilities.includes("es")),
      mq: parseRabbitMqConfiguration(deployment.mq, capabilities.includes("mq")),
    };
  }) : [];
  if (new Set(deployments.map((deployment) => deployment.environmentKey)).size !== deployments.length) throw new ApiError(400, "duplicate_deployment_environment");
  return { repositories, deployments };
}

function storedDeploymentConfiguration(deployment: ReturnType<typeof parseServiceConfigurationInput>["deployments"][number]) {
  return {
    agent: deployment.agent,
    ...(deployment.playwright ? { playwright: deployment.playwright } : {}),
    ...(deployment.nacos ? { nacos: deployment.nacos } : {}),
    ...(deployment.db ? { db: deployment.db } : {}),
    ...(deployment.redis ? { redis: deployment.redis } : {}),
    ...(deployment.mq ? { mq: deployment.mq } : {}),
    ...(deployment.es ? { es: deployment.es } : {}),
    ...(deployment.sls ? { sls: deployment.sls } : {}),
  };
}

export async function replaceServiceConfiguration(options: {
  executor: DatabaseExecutor;
  modelCatalog: AgentModelCatalog;
  serviceId: string;
  input: Record<string, unknown>;
  serviceUpdate?: { name: string; description: string };
}): Promise<void> {
  const { executor, modelCatalog, serviceId, input, serviceUpdate } = options;
  const { repositories: repositoriesInput, deployments: deploymentsInput } = parseServiceConfigurationInput(input);

  const [existingRepositories, existingDeployments, environmentRows, availableModels] = await Promise.all([
    executor.select().from(serviceRepositories).where(eq(serviceRepositories.serviceId, serviceId)),
    executor.select().from(serviceDeployments).where(eq(serviceDeployments.serviceId, serviceId)),
    executor.select().from(environments).where(inArray(environments.key, ENVIRONMENT_KINDS)),
    modelCatalog.list(),
  ]);
  const environmentsByKey = new Map(environmentRows.map((environment) => [environment.key, environment]));
  if (deploymentsInput.some((deployment) => !environmentsByKey.has(deployment.environmentKey))) throw new ApiError(400, "invalid_environment");
  for (const deployment of deploymentsInput) {
    const model = availableModels.find((candidate) => candidate.provider === deployment.agent.provider && candidate.id === deployment.agent.model);
    if (!model) throw new ApiError(400, "agent_model_not_available");
    if (!model.thinkingLevels.includes(deployment.agent.thinkingLevel)) throw new ApiError(400, "agent_thinking_level_not_supported");
  }

  const existingById = new Map(existingRepositories.map((repository) => [repository.id, repository]));
  const configuredIds = repositoriesInput.flatMap((repository) => repository.id ? [repository.id] : []);
  if (new Set(configuredIds).size !== configuredIds.length || (serviceUpdate && configuredIds.some((id) => !existingById.has(id)))) throw new ApiError(400, "invalid_repository");
  const retainedEnvironmentIds = new Set(deploymentsInput.map((deployment) => environmentsByKey.get(deployment.environmentKey)!.id));
  for (const deployment of existingDeployments) {
    const used = !retainedEnvironmentIds.has(deployment.environmentId) && (await executor.select({ id: issues.id }).from(issues).where(and(eq(issues.serviceId, serviceId), eq(issues.environmentId, deployment.environmentId))).limit(1))[0];
    if (used) throw new ApiError(409, "deployment_is_used_by_issues");
  }

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
