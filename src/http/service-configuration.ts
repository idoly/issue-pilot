import { and, eq, inArray } from "drizzle-orm";

import { browserConfiguration, dbConfiguration, esConfiguration, mqConfiguration, nacosConfiguration, parseCapabilities, redisConfiguration, slsConfiguration } from "../capabilities/http-config.ts";
import type { Database } from "../db/client.ts";
import { environments, issues, serviceDeployments, serviceRepositories, services } from "../db/schema.ts";
import { ENVIRONMENT_KINDS } from "../domain/contracts.ts";
import { AGENT_THINKING_LEVELS, type AgentModelCatalog, type AgentThinkingLevel } from "../pi/models.ts";
import { ApiError, choice, optionalText, record, text } from "./input.ts";

const REPOSITORY_KINDS = ["frontend", "backend"] as const;
type DatabaseExecutor = Pick<Database, "select" | "insert" | "update" | "delete">;

function agentConfiguration(value: unknown): { provider: string; model: string; thinkingLevel: AgentThinkingLevel } {
  if (value === undefined || value === null) throw new ApiError(400, "agent_configuration_required");
  const input = record(value);
  return {
    provider: text(input.provider, "agent_provider", 200),
    model: text(input.model, "agent_model", 500),
    thinkingLevel: choice(input.thinkingLevel, "agent_thinking_level", AGENT_THINKING_LEVELS),
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
  const repositoriesInput = Array.isArray(input.repositories) ? input.repositories.map(record).map((repository) => ({
    id: optionalText(repository.id, 255),
    kind: choice(repository.kind, "repository_kind", REPOSITORY_KINDS),
    url: text(repository.url, "repository_url"),
  })) : [];
  if (!repositoriesInput.length) throw new ApiError(400, "repository_required");
  if (new Set(repositoriesInput.map((repository) => repository.url)).size !== repositoriesInput.length) throw new ApiError(400, "duplicate_repository");

  const deploymentsInput = Array.isArray(input.deployments) ? input.deployments.map(record).map((deployment) => {
    const capabilities = parseCapabilities(deployment.capabilities ?? []);
    return {
      environmentKey: text(deployment.environmentKey, "environment_key", 100),
      baseBranch: text(deployment.baseBranch, "base_branch", 255),
      capabilities,
      agent: agentConfiguration(deployment.agent),
      nacos: nacosConfiguration(deployment.nacos, capabilities.includes("nacos")),
      db: dbConfiguration(deployment.db, capabilities.includes("db")),
      sls: slsConfiguration(deployment.sls, capabilities.includes("sls")),
      playwright: browserConfiguration(deployment.playwright, capabilities.includes("playwright")),
      redis: redisConfiguration(deployment.redis, capabilities.includes("redis")),
      es: esConfiguration(deployment.es, capabilities.includes("es")),
      mq: mqConfiguration(deployment.mq, capabilities.includes("mq")),
    };
  }) : [];
  if (new Set(deploymentsInput.map((deployment) => deployment.environmentKey)).size !== deploymentsInput.length) throw new ApiError(400, "duplicate_deployment_environment");

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
      await executor.update(serviceRepositories).set({ kind: repository.kind, url: repository.url, updatedAt: new Date() }).where(and(eq(serviceRepositories.id, repository.id), eq(serviceRepositories.serviceId, serviceId)));
    } else {
      const [created] = await executor.insert(serviceRepositories).values({ serviceId, kind: repository.kind, url: repository.url }).returning();
      retainedRepositoryIds.add(created!.id);
    }
  }
  for (const repository of existingRepositories) if (!retainedRepositoryIds.has(repository.id)) await executor.delete(serviceRepositories).where(eq(serviceRepositories.id, repository.id));

  const existingByEnvironmentId = new Map(existingDeployments.map((deployment) => [deployment.environmentId, deployment]));
  const retainedDeploymentIds = new Set<string>();
  for (const deploymentInput of deploymentsInput) {
    const environment = environmentsByKey.get(deploymentInput.environmentKey)!;
    const existing = existingByEnvironmentId.get(environment.id);
    const config = {
      agent: deploymentInput.agent,
      ...(deploymentInput.playwright ? { playwright: deploymentInput.playwright } : {}),
      ...(deploymentInput.nacos ? { nacos: deploymentInput.nacos } : {}),
      ...(deploymentInput.db ? { db: deploymentInput.db } : {}),
      ...(deploymentInput.redis ? { redis: deploymentInput.redis } : {}),
      ...(deploymentInput.mq ? { mq: deploymentInput.mq } : {}),
      ...(deploymentInput.es ? { es: deploymentInput.es } : {}),
      ...(deploymentInput.sls ? { sls: deploymentInput.sls } : {}),
    };
    const deployment = existing
      ? (await executor.update(serviceDeployments).set({ baseBranch: deploymentInput.baseBranch, config, updatedAt: new Date() }).where(eq(serviceDeployments.id, existing.id)).returning())[0]!
      : (await executor.insert(serviceDeployments).values({ serviceId, environmentId: environment.id, baseBranch: deploymentInput.baseBranch, config }).returning())[0]!;
    retainedDeploymentIds.add(deployment.id);
  }
  for (const deployment of existingDeployments) if (!retainedDeploymentIds.has(deployment.id)) await executor.delete(serviceDeployments).where(eq(serviceDeployments.id, deployment.id));
}
