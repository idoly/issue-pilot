import { isDeepStrictEqual } from "node:util";
import { loadMcpConnections } from "./service-mcp.ts";
import { parseDbHubTargets } from "./dbhub.ts";
import { or, eq, inArray, sql } from "drizzle-orm";
import { resolveConfiguredCapabilitySections } from "./credentials.ts";
import type { Database } from "../db/client.ts";
import { environments, issues, issueServiceScopes, serviceDeploymentRepositories, serviceDeployments, serviceRepositories, repositories as repositoryCatalog, services } from "../db/schema.ts";
import { CAPABILITY_KEYS, ENVIRONMENT_KINDS, isDevelopmentEnvironment, isSshRepositoryUrl, type CapabilityName, type EnvironmentKind, type StoredDeploymentConfig } from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import { closedRecord, optionalText, record, strings, text } from "../domain/input.ts";

type DatabaseExecutor = Pick<Database, "select" | "insert" | "update" | "delete">;

// A deployment carries only its environment, repository baselines and capability targets; model or MCP fields never belong here.
const DEPLOYMENT_FIELDS = ["environmentKey", "capabilities", "repositoryBranches", "dbhub", ...CAPABILITY_KEYS] as const;

function parseServiceDeployment(input: unknown, repositoryAliases: Set<string>, existing: StoredDeploymentConfig | undefined, environmentKinds: ReadonlyMap<string, EnvironmentKind>) {
  const deployment = closedRecord(input, DEPLOYMENT_FIELDS, "invalid_service_deployment");
  const selected = strings(deployment.capabilities ?? [], "capabilities");
  if (new Set(selected).size !== selected.length || selected.some((key) => !CAPABILITY_KEYS.includes(key as CapabilityName))) throw new DomainError("invalid_capabilities", "bad_request");
  const environmentKey = text(deployment.environmentKey, "environment_key", 100);
  // Unknown keys are refused with invalid_environment after parsing; until then they follow the non-development rules.
  const environmentKind = environmentKinds.get(environmentKey);
  const development = isDevelopmentEnvironment(environmentKind);
  const capabilities = CAPABILITY_KEYS.filter((key) => selected.includes(key));
  if (development && capabilities.length) throw new DomainError("development_capabilities_inherited", "bad_request");
  if (development && existing && Object.keys(existing).some((key) => key !== "archivedDevelopment")) throw new DomainError("development_configuration_layout_invalid", "conflict");
  if (development && Array.isArray(deployment.repositoryBranches) && deployment.repositoryBranches.length) throw new DomainError("development_branches_inherited", "bad_request");
  const repositoryBranches = development
    ? []
    : Array.isArray(deployment.repositoryBranches)
      ? deployment.repositoryBranches.map(record).map((branch) => ({ repositoryAlias: text(branch.repositoryAlias, "repository_alias", 100), baseBranch: text(branch.baseBranch, "base_branch", 255) }))
      : [];
  if (
    !development &&
    (repositoryBranches.length !== repositoryAliases.size ||
      new Set(repositoryBranches.map((branch) => branch.repositoryAlias)).size !== repositoryBranches.length ||
      repositoryBranches.some((branch) => !repositoryAliases.has(branch.repositoryAlias)))
  )
    throw new DomainError("invalid_deployment_repository_branches", "bad_request");
  const config: StoredDeploymentConfig = resolveConfiguredCapabilitySections(deployment, capabilities);
  const dbhub = parseDbHubTargets(deployment.dbhub);
  if (development && dbhub.length) throw new DomainError("development_capabilities_inherited", "bad_request");
  if (dbhub.length) config.dbhub = dbhub;
  return { environmentKey, environmentKind, repositoryBranches, config };
}

/** A development deployment promises writable worktrees and therefore personal SSH access for every repository. */
export function assertDevelopmentRepositoryUrls(urls: Iterable<string>): void {
  if ([...urls].some((url) => !isSshRepositoryUrl(url))) throw new DomainError("development_repository_ssh_url_required", "bad_request");
}

function parseServiceConfigurationInput(input: Record<string, unknown>, existing: Map<string, StoredDeploymentConfig>, environmentKinds: ReadonlyMap<string, EnvironmentKind>) {
  const repositories = Array.isArray(input.repositories)
    ? input.repositories
        .map(record)
        .map((repository) => ({ id: optionalText(repository.id, 255), alias: text(repository.alias, "repository_alias", 100), url: text(repository.url, "repository_url") }))
    : [];
  if (!repositories.length) throw new DomainError("repository_required", "bad_request");
  if (new Set(repositories.map((repository) => repository.alias)).size !== repositories.length) throw new DomainError("duplicate_repository_alias", "bad_request");
  if (new Set(repositories.map((repository) => repository.url)).size !== repositories.length) throw new DomainError("duplicate_repository", "bad_request");
  const aliases = new Set(repositories.map((repository) => repository.alias));
  // An omitted deployment list used to be read as "remove every deployment"; require the intent explicitly.
  if (!Array.isArray(input.deployments)) throw new DomainError("invalid_deployments", "bad_request");
  const deployments = input.deployments.map(record).map((deployment) => parseServiceDeployment(deployment, aliases, existing.get(String(deployment.environmentKey)), environmentKinds));
  if (new Set(deployments.map((deployment) => deployment.environmentKey)).size !== deployments.length) throw new DomainError("duplicate_deployment_environment", "bad_request");
  if (deployments.some((deployment) => isDevelopmentEnvironment(deployment.environmentKind)) && !deployments.some((deployment) => deployment.environmentKind === "prod"))
    throw new DomainError("development_production_deployment_required", "bad_request");
  if (deployments.some((deployment) => isDevelopmentEnvironment(deployment.environmentKind))) assertDevelopmentRepositoryUrls(repositories.map(({ url }) => url));
  return { repositories, deployments };
}

/** Plan from the current configuration under the scope queue, before reserving Issues or writing anything. */
export async function prepareServiceConfiguration(options: {
  executor: DatabaseExecutor;
  serviceId: string;
  input: Record<string, unknown>;
  currentService?: Pick<typeof services.$inferSelect, "name" | "description">;
}) {
  const { executor, serviceId } = options;
  const [existingRepositories, existingDeployments, referencedIssues, environmentRows] = await Promise.all([
    executor.select().from(serviceRepositories).where(eq(serviceRepositories.serviceId, serviceId)),
    executor.select().from(serviceDeployments).where(eq(serviceDeployments.serviceId, serviceId)),
    executor
      .select({ environmentId: issues.environmentId })
      .from(issues)
      .leftJoin(issueServiceScopes, eq(issueServiceScopes.issueId, issues.id))
      .where(or(eq(issues.serviceId, serviceId), eq(issueServiceScopes.serviceId, serviceId))),
    executor.select().from(environments).where(inArray(environments.key, ENVIRONMENT_KINDS)),
  ]);
  const environmentsByKey = new Map(environmentRows.map((environment) => [environment.key, environment]));
  const environmentKeyById = new Map(environmentRows.map((environment) => [environment.id, environment.key]));
  const existing = new Map(
    existingDeployments.map((deployment) => {
      const key = environmentKeyById.get(deployment.environmentId);
      if (!key) throw new Error("deployment_environment_not_found");
      return [key, deployment.config] as const;
    }),
  );
  const parsed = parseServiceConfigurationInput(options.input, existing, new Map(environmentRows.map((environment) => [environment.key, environment.kind])));
  const catalog = await executor
    .select({ url: repositoryCatalog.url })
    .from(repositoryCatalog)
    .where(
      inArray(
        repositoryCatalog.url,
        parsed.repositories.map((repository) => repository.url),
      ),
    );
  if (catalog.length !== parsed.repositories.length) throw new DomainError("repository_not_registered", "bad_request");
  if (parsed.deployments.some((deployment) => !environmentsByKey.has(deployment.environmentKey))) throw new DomainError("invalid_environment", "bad_request");
  const existingById = new Map(existingRepositories.map((row) => [row.id, row]));
  const ids = parsed.repositories.flatMap((repository) => (repository.id ? [repository.id] : []));
  if (new Set(ids).size !== ids.length || ids.some((id) => !existingById.has(id))) throw new DomainError("invalid_repository", "bad_request");
  const retained = new Set(parsed.deployments.map((deployment) => environmentsByKey.get(deployment.environmentKey)!.id));
  const referenced = new Set(referencedIssues.map((issue) => issue.environmentId));
  const removed = existingDeployments.filter((row) => !retained.has(row.environmentId));
  if (removed.some((row) => referenced.has(row.environmentId))) throw new DomainError("deployment_is_used_by_issues", "conflict");

  const repositories = parsed.repositories.map((row) => {
    const previous = row.id ? existingById.get(row.id) : undefined;
    return { ...row, previous, unchanged: previous?.alias === row.alias && previous.url === row.url };
  });
  const rebuild = repositories.length !== existingRepositories.length || repositories.some((row) => !row.unchanged);
  // Rebuilding service bindings cascades their branch rows; all retained branch bindings must then be written again.
  const branches =
    !rebuild && existingDeployments.length
      ? await executor
          .select()
          .from(serviceDeploymentRepositories)
          .where(
            inArray(
              serviceDeploymentRepositories.deploymentId,
              existingDeployments.map((row) => row.id),
            ),
          )
      : [];
  const repositoryIdsByAlias = new Map(repositories.map((row) => [row.alias, row.id]));
  const writes = parsed.deployments.flatMap((input) => {
    const environmentId = environmentsByKey.get(input.environmentKey)!.id;
    const previous = existingDeployments.find((row) => row.environmentId === environmentId);
    const archivedDevelopment = previous?.config.archivedDevelopment;
    const config = { ...(archivedDevelopment === undefined ? {} : { archivedDevelopment }), ...input.config };
    const current = branches.filter((row) => row.deploymentId === previous?.id);
    if (
      previous &&
      isDeepStrictEqual(previous.config, config) &&
      current.length === input.repositoryBranches.length &&
      input.repositoryBranches.every((branch) => current.some((row) => row.repositoryId === repositoryIdsByAlias.get(branch.repositoryAlias) && row.baseBranch === branch.baseBranch))
    )
      return [];
    return [{ id: previous?.id, environmentId, config, repositoryBranches: input.repositoryBranches }];
  });
  const serviceUpdate = options.currentService && { name: text(options.input.name, "name", 200), description: optionalText(options.input.description) ?? "" };
  const nameChanged = serviceUpdate?.name !== options.currentService?.name;
  const affectedEnvironmentIds = new Set(removed.map((row) => row.environmentId));
  for (const row of writes) affectedEnvironmentIds.add(row.environmentId);
  if (rebuild || nameChanged || serviceUpdate?.description !== options.currentService?.description) {
    for (const id of retained) affectedEnvironmentIds.add(id);
  }
  return { repositories, rebuild, writes, removed, affectedEnvironmentIds, serviceUpdate, nameChanged };
}

export async function applyServiceConfiguration(options: { executor: DatabaseExecutor; serviceId: string; prepared: Awaited<ReturnType<typeof prepareServiceConfiguration>> }): Promise<void> {
  const { executor, serviceId, prepared } = options;
  const { rebuild, repositories, writes, removed, serviceUpdate, nameChanged } = prepared;
  if (serviceUpdate) {
    await executor
      .update(services)
      .set({ ...serviceUpdate, revision: sql`${services.revision} + 1`, updatedAt: new Date() })
      .where(eq(services.id, serviceId));
    // Issues that include this service display its name in their detail; the entry-service name is already in
    // the summary digest, so only collaborating references need an explicit detail revision.
    if (nameChanged)
      await executor
        .update(issues)
        .set({ detailRevision: sql`${issues.detailRevision} + 1` })
        .where(inArray(issues.id, executor.select({ issueId: issueServiceScopes.issueId }).from(issueServiceScopes).where(eq(issueServiceScopes.serviceId, serviceId))));
  }
  // Rebuild changed sets in request order, keeping IDs and creation times.
  // This permits swaps without temporary URLs that violate the catalog FK;
  // deployment branch bindings are rebuilt below in the same transaction.
  if (rebuild) await executor.delete(serviceRepositories).where(eq(serviceRepositories.serviceId, serviceId));
  const savedRepositoryByAlias = new Map<string, typeof serviceRepositories.$inferSelect>();
  for (const repository of repositories) {
    const existing = repository.previous;
    const saved = !rebuild
      ? existing
      : (
          await executor
            .insert(serviceRepositories)
            .values({
              ...(existing ? { id: existing.id, createdAt: existing.createdAt, ...(repository.unchanged ? { updatedAt: existing.updatedAt } : {}) } : {}),
              serviceId,
              alias: repository.alias,
              url: repository.url,
            })
            .returning()
        )[0];
    if (!saved) throw new Error("repository_save_failed");
    savedRepositoryByAlias.set(repository.alias, saved);
  }
  for (const { id, environmentId, config, repositoryBranches } of writes) {
    const values = { config, updatedAt: new Date() };
    const [saved] = id
      ? await executor.update(serviceDeployments).set(values).where(eq(serviceDeployments.id, id)).returning({ id: serviceDeployments.id })
      : await executor
          .insert(serviceDeployments)
          .values({ serviceId, environmentId, ...values })
          .returning({ id: serviceDeployments.id });
    if (!saved) throw new Error("deployment_save_failed");
    if (id) await executor.delete(serviceDeploymentRepositories).where(eq(serviceDeploymentRepositories.deploymentId, id));
    if (repositoryBranches.length)
      await executor
        .insert(serviceDeploymentRepositories)
        .values(repositoryBranches.map((branch) => ({ deploymentId: saved.id, repositoryId: savedRepositoryByAlias.get(branch.repositoryAlias)!.id, baseBranch: branch.baseBranch })));
  }
  for (const deployment of removed) await executor.delete(serviceDeployments).where(eq(serviceDeployments.id, deployment.id));
  const configurationChanged = rebuild || writes.length > 0 || removed.length > 0;
  if (configurationChanged) await loadMcpConnections(executor);
  if (configurationChanged && !serviceUpdate)
    await executor
      .update(services)
      .set({ revision: sql`${services.revision} + 1`, updatedAt: new Date() })
      .where(eq(services.id, serviceId));
}
