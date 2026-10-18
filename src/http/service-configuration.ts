import { or, and, eq, inArray } from "drizzle-orm";
import { CapabilityConfigurationError } from "../capabilities/registry.ts";
import { resolveConfiguredCapabilitySections } from "../configuration/credentials.ts";
import type { Database } from "../db/client.ts";
import { environments, issues, issueServiceScopes, serviceDeploymentRepositories, serviceDeployments, serviceRepositories, repositories as repositoryCatalog, services } from "../db/schema.ts";
import { CAPABILITY_KEYS, ENVIRONMENT_KINDS, type CapabilityName, type StoredDeploymentConfig } from "../domain/contracts.ts";
import { ApiError, optionalText, record, strings, text } from "./input.ts";

type DatabaseExecutor = Pick<Database, "select" | "insert" | "update" | "delete">;

function parseServiceDeployment(deployment: Record<string, unknown>, repositoryAliases: Set<string>, existing: StoredDeploymentConfig | undefined) {
  if (deployment.agent !== undefined) throw new ApiError(400, "deployment_agent_not_allowed");
  const selected = strings(deployment.capabilities ?? [], "capabilities");
  if (new Set(selected).size !== selected.length || selected.some(key => !CAPABILITY_KEYS.includes(key as CapabilityName))) throw new ApiError(400, "invalid_capabilities");
  const environmentKey = text(deployment.environmentKey, "environment_key", 100);
  const capabilities = CAPABILITY_KEYS.filter(key => selected.includes(key));
  if (strings(deployment.mcpServices ?? [], "mcp_services").length) throw new ApiError(400, "mcp_services_are_global");
  if (environmentKey === "dev" && capabilities.length) throw new ApiError(400, "development_capabilities_inherited");
  if (environmentKey === "dev" && existing && Object.keys(existing).some(key => key !== "archivedDevelopment")) throw new ApiError(409, "development_configuration_layout_invalid");
  const repositoryBranches = Array.isArray(deployment.repositoryBranches) ? deployment.repositoryBranches.map(record).map(branch => ({ repositoryAlias: text(branch.repositoryAlias, "repository_alias", 100), baseBranch: text(branch.baseBranch, "base_branch", 255) })) : [];
  if (repositoryBranches.length !== repositoryAliases.size || new Set(repositoryBranches.map(branch => branch.repositoryAlias)).size !== repositoryBranches.length || repositoryBranches.some(branch => !repositoryAliases.has(branch.repositoryAlias))) throw new ApiError(400, "invalid_deployment_repository_branches");
  let config: StoredDeploymentConfig;
  try {
    config = resolveConfiguredCapabilitySections(deployment, capabilities, existing);
    if (environmentKey === "dev" && existing?.archivedDevelopment !== undefined) config.archivedDevelopment = existing.archivedDevelopment;
  } catch (error) {
    if (error instanceof CapabilityConfigurationError) throw new ApiError(400, error.message);
    throw error;
  }
  return { environmentKey, repositoryBranches, capabilities, config };
}

function parseServiceConfigurationInput(input: Record<string, unknown>, existing: Map<string, StoredDeploymentConfig>) {
  const repositories = Array.isArray(input.repositories) ? input.repositories.map(record).map(repository => ({ id: optionalText(repository.id, 255), alias: text(repository.alias, "repository_alias", 100), url: text(repository.url, "repository_url") })) : [];
  if (!repositories.length) throw new ApiError(400, "repository_required");
  if (new Set(repositories.map(repository => repository.alias)).size !== repositories.length) throw new ApiError(400, "duplicate_repository_alias");
  if (new Set(repositories.map(repository => repository.url)).size !== repositories.length) throw new ApiError(400, "duplicate_repository");
  const aliases = new Set(repositories.map(repository => repository.alias));
  const deployments = Array.isArray(input.deployments) ? input.deployments.map(record).map(deployment => parseServiceDeployment(deployment, aliases, existing.get(String(deployment.environmentKey)))) : [];
  if (new Set(deployments.map(deployment => deployment.environmentKey)).size !== deployments.length) throw new ApiError(400, "duplicate_deployment_environment");
  return { repositories, deployments };
}

interface PreparedServiceConfiguration {
  parsed: ReturnType<typeof parseServiceConfigurationInput>;
  existingRepositories: Array<typeof serviceRepositories.$inferSelect>;
  existingDeployments: Array<typeof serviceDeployments.$inferSelect>;
  environmentsByKey: Map<string, typeof environments.$inferSelect>;
}

export async function prepareServiceConfiguration(options: { executor: DatabaseExecutor; serviceId: string; input: Record<string, unknown> }): Promise<PreparedServiceConfiguration> {
  const { executor, serviceId } = options;
  const [existingRepositories, existingDeployments, referencedIssues, environmentRows] = await Promise.all([
    executor.select().from(serviceRepositories).where(eq(serviceRepositories.serviceId, serviceId)),
    executor.select().from(serviceDeployments).where(eq(serviceDeployments.serviceId, serviceId)),
    executor.select({ environmentId: issues.environmentId }).from(issues).leftJoin(issueServiceScopes, eq(issueServiceScopes.issueId, issues.id)).where(or(eq(issues.serviceId, serviceId), eq(issueServiceScopes.serviceId, serviceId))),
    executor.select().from(environments).where(inArray(environments.key, ENVIRONMENT_KINDS)),
  ]);
  const environmentsByKey = new Map(environmentRows.map(environment => [environment.key, environment]));
  const environmentKeyById = new Map(environmentRows.map(environment => [environment.id, environment.key]));
  const existing = new Map(existingDeployments.map(deployment => {
    const key = environmentKeyById.get(deployment.environmentId);
    if (!key) throw new Error("deployment_environment_not_found");
    return [key, deployment.config] as const;
  }));
  const parsed = parseServiceConfigurationInput(options.input, existing);
  const catalog = await executor.select({ url: repositoryCatalog.url }).from(repositoryCatalog).where(inArray(repositoryCatalog.url, parsed.repositories.map(repository => repository.url)));
  if (catalog.length !== parsed.repositories.length) throw new ApiError(400, "repository_not_registered");
  if (parsed.deployments.some(deployment => !environmentsByKey.has(deployment.environmentKey))) throw new ApiError(400, "invalid_environment");
  const ids = parsed.repositories.flatMap(repository => repository.id ? [repository.id] : []);
  if (new Set(ids).size !== ids.length || ids.some(id => !existingRepositories.some(repository => repository.id === id))) throw new ApiError(400, "invalid_repository");
  const retained = new Set(parsed.deployments.map(deployment => environmentsByKey.get(deployment.environmentKey)!.id));
  const referenced = new Set(referencedIssues.map(issue => issue.environmentId));
  if (existingDeployments.some(deployment => !retained.has(deployment.environmentId) && referenced.has(deployment.environmentId))) throw new ApiError(409, "deployment_is_used_by_issues");
  return { parsed, existingRepositories, existingDeployments, environmentsByKey };
}

async function applyServiceDeployment(executor: DatabaseExecutor, serviceId: string, environmentId: string, existing: typeof serviceDeployments.$inferSelect | undefined, input: ReturnType<typeof parseServiceDeployment>, repositories: Map<string, { id: string }>) {
  const values = { config: input.config, updatedAt: new Date() };
  const [saved] = existing
    ? await executor.update(serviceDeployments).set(values).where(eq(serviceDeployments.id, existing.id)).returning()
    : await executor.insert(serviceDeployments).values({ serviceId, environmentId, ...values }).returning();
  if (!saved) throw new Error("deployment_save_failed");
  await executor.delete(serviceDeploymentRepositories).where(eq(serviceDeploymentRepositories.deploymentId, saved.id));
  await executor.insert(serviceDeploymentRepositories).values(input.repositoryBranches.map(branch => ({ deploymentId: saved.id, repositoryId: repositories.get(branch.repositoryAlias)!.id, baseBranch: branch.baseBranch })));
  return saved;
}

export async function applyServiceConfiguration(options: { executor: DatabaseExecutor; serviceId: string; prepared: PreparedServiceConfiguration; serviceUpdate?: { name: string; description: string } }): Promise<void> {
  const { executor, serviceId, prepared, serviceUpdate } = options;
  if (serviceUpdate) await executor.update(services).set({ ...serviceUpdate, updatedAt: new Date() }).where(eq(services.id, serviceId));
  const retainedRepositoryIds = new Set<string>();
  const savedRepositoryByAlias = new Map<string, typeof serviceRepositories.$inferSelect>();
  for (const repository of prepared.parsed.repositories) {
    const [saved] = repository.id
      ? await executor.update(serviceRepositories).set({ alias: repository.alias, url: repository.url, updatedAt: new Date() }).where(and(eq(serviceRepositories.id, repository.id), eq(serviceRepositories.serviceId, serviceId))).returning()
      : await executor.insert(serviceRepositories).values({ serviceId, alias: repository.alias, url: repository.url }).returning();
    if (!saved) throw new Error("repository_save_failed");
    retainedRepositoryIds.add(saved.id); savedRepositoryByAlias.set(repository.alias, saved);
  }
  for (const repository of prepared.existingRepositories) if (!retainedRepositoryIds.has(repository.id)) await executor.delete(serviceRepositories).where(eq(serviceRepositories.id, repository.id));
  const retainedDeployments = new Set<string>();
  for (const input of prepared.parsed.deployments) {
    const environmentId = prepared.environmentsByKey.get(input.environmentKey)!.id;
    const saved = await applyServiceDeployment(executor, serviceId, environmentId, prepared.existingDeployments.find(deployment => deployment.environmentId === environmentId), input, savedRepositoryByAlias);
    retainedDeployments.add(saved.id);
  }
  for (const deployment of prepared.existingDeployments) if (!retainedDeployments.has(deployment.id)) await executor.delete(serviceDeployments).where(eq(serviceDeployments.id, deployment.id));
}
