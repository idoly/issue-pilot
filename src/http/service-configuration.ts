import { and, eq, inArray } from "drizzle-orm";

import { isNacosTarget, isSlsLogstore, MAX_NACOS_DATA_IDS } from "../capabilities/contracts.ts";
import type { Database } from "../db/client.ts";
import { environments, issues, serviceDeployments, serviceRepositories, services } from "../db/schema.ts";
import { AGENT_THINKING_LEVELS, CAPABILITY_KEYS, ENVIRONMENT_KINDS, type AgentConfiguration, type CapabilityName } from "../domain/contracts.ts";
import type { AgentModelCatalog } from "../pi/models.ts";
import { ApiError, choice, optionalText, record, strings, text } from "./input.ts";

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
  const configured = text(value, name, 4096);
  let parsed: URL;
  try { parsed = new URL(configured); } catch { throw new ApiError(400, `invalid_${name}`); }
  if (!protocols.includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || (options.rootOnly && parsed.pathname !== "/")) throw new ApiError(400, `invalid_${name}`);
  return configured;
}

export function parseCapabilities(value: unknown): CapabilityName[] {
  const entries = strings(value, "capabilities");
  if (new Set(entries).size !== entries.length || entries.some((entry) => !CAPABILITY_KEYS.includes(entry as CapabilityName))) throw new ApiError(400, "invalid_capabilities");
  return CAPABILITY_KEYS.filter((key) => entries.includes(key));
}

export function parseNacosConfiguration(value: unknown, required: boolean) {
  const input = configurationInput(value, required);
  if (!input) return undefined;
  const credentials = optionalCredentials(input, "nacos");
  const dataIds = [...new Set(strings(input.dataIds, "nacos_data_ids").map((value) => text(value, "nacos_data_id", 255)))];
  if (!dataIds.length || dataIds.length > MAX_NACOS_DATA_IDS || dataIds.some((dataId) => !isNacosTarget(dataId))) throw new ApiError(400, "invalid_nacos_data_ids");
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
  return { host: text(input.host, "redis_host", 255), port: boundedInteger(input.port ?? 6379, "redis_port", 1, 65_535), username: optionalString(input.username, 500), ...(password ? { password } : {}), database: boundedInteger(input.database ?? 0, "redis_database", 0, 1_000_000) };
}

export function parseElasticsearchConfiguration(value: unknown, required: boolean) {
  const input = configurationInput(value, required);
  if (!input) return undefined;
  return { url: parseConnectionUrl(input.url, "es_url", ["http:", "https:"]), ...optionalCredentials(input, "es") };
}

export function parseRabbitMqConfiguration(value: unknown, required: boolean) {
  const input = configurationInput(value, required);
  if (!input) return undefined;
  return { host: text(input.host, "mq_host", 255), port: boundedInteger(input.port ?? 5672, "mq_port", 1, 65_535), managementPort: boundedInteger(input.managementPort ?? 15672, "mq_management_port", 1, 65_535), username: text(input.username, "mq_username", 500), password: text(input.password, "mq_password"), virtualHost: text(input.virtualHost, "mq_virtual_host", 255) };
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
    url: text(repository.url, "repository_url"),
  })) : [];
  if (!repositories.length) throw new ApiError(400, "repository_required");
  if (new Set(repositories.map((repository) => repository.url)).size !== repositories.length) throw new ApiError(400, "duplicate_repository");

  const deployments = Array.isArray(input.deployments) ? input.deployments.map(record).map((deployment) => {
    const capabilities = parseCapabilities(deployment.capabilities ?? []);
    return {
      environmentKey: text(deployment.environmentKey, "environment_key", 100),
      baseBranch: text(deployment.baseBranch, "base_branch", 255),
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
  for (const repository of repositoriesInput) {
    if (repository.id && existingById.has(repository.id)) {
      retainedRepositoryIds.add(repository.id);
      await executor.update(serviceRepositories).set({ url: repository.url, updatedAt: new Date() }).where(and(eq(serviceRepositories.id, repository.id), eq(serviceRepositories.serviceId, serviceId)));
    } else {
      const [created] = await executor.insert(serviceRepositories).values({ serviceId, url: repository.url }).returning();
      retainedRepositoryIds.add(created!.id);
    }
  }
  for (const repository of existingRepositories) if (!retainedRepositoryIds.has(repository.id)) await executor.delete(serviceRepositories).where(eq(serviceRepositories.id, repository.id));

  const existingByEnvironmentId = new Map(existingDeployments.map((deployment) => [deployment.environmentId, deployment]));
  const retainedDeploymentIds = new Set<string>();
  for (const deploymentInput of deploymentsInput) {
    const environment = environmentsByKey.get(deploymentInput.environmentKey)!;
    const existing = existingByEnvironmentId.get(environment.id);
    const config = storedDeploymentConfiguration(deploymentInput);
    const deployment = existing
      ? (await executor.update(serviceDeployments).set({ baseBranch: deploymentInput.baseBranch, config, updatedAt: new Date() }).where(eq(serviceDeployments.id, existing.id)).returning())[0]!
      : (await executor.insert(serviceDeployments).values({ serviceId, environmentId: environment.id, baseBranch: deploymentInput.baseBranch, config }).returning())[0]!;
    retainedDeploymentIds.add(deployment.id);
  }
  for (const deployment of existingDeployments) if (!retainedDeploymentIds.has(deployment.id)) await executor.delete(serviceDeployments).where(eq(serviceDeployments.id, deployment.id));
}
