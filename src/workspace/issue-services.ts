import { asc, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { issueServiceScopes, environments, services, serviceDeployments } from "../db/schema.ts";
import { ENVIRONMENT_KINDS } from "../domain/contracts.ts";
import { loadDeploymentRepositories } from "./deployment.ts";

type IssueScope = { id: string; serviceId: string; environmentId: string };
export async function listEnvironmentServices(database: Database, environmentId: string, investigation = false) {
  const [current] = investigation ? await database.select().from(environments).where(eq(environments.id, environmentId)).limit(1) : [];
  const includeSources = current?.kind === "dev";
  return database.select({ service: services, deployment: serviceDeployments, environment: environments }).from(serviceDeployments)
    .innerJoin(services, eq(services.id, serviceDeployments.serviceId)).innerJoin(environments, eq(environments.id, serviceDeployments.environmentId))
    .where(includeSources ? inArray(environments.kind, ENVIRONMENT_KINDS) : eq(serviceDeployments.environmentId, environmentId)).orderBy(asc(environments.key), asc(services.createdAt), asc(services.key));
}
export async function issueServiceIds(database: Database, issue: IssueScope) {
  const extra = await database.select().from(issueServiceScopes).where(eq(issueServiceScopes.issueId, issue.id)).orderBy(asc(issueServiceScopes.createdAt), asc(issueServiceScopes.serviceId));
  return [...new Set([issue.serviceId, ...extra.map((row) => row.serviceId)])];
}
export async function loadServiceRepositorySet(database: Database, serviceIds: string[], environmentId: string) {
  const primary = await loadDeploymentRepositories(database, { serviceId: serviceIds[0]!, environmentId });
  const repositories = [...primary.repositories];
  const byUrl = new Map(repositories.map((row) => [row.repository.url, row]));
  for (const serviceId of serviceIds.slice(1)) {
    const additional = await loadDeploymentRepositories(database, { serviceId, environmentId });
    for (const row of additional.repositories) {
      const existing = byUrl.get(row.repository.url);
      if (existing && existing.baseBranch !== row.baseBranch) throw new Error("cross_service_repository_branch_conflict");
      if (!existing) { byUrl.set(row.repository.url, row); repositories.push(row); }
    }
  }
  return { deployment: primary.deployment, repositories };
}
export async function loadIssueDeployments(database: Database, issue: IssueScope) { return loadServiceRepositorySet(database, await issueServiceIds(database, issue), issue.environmentId); }
export async function participatingServices(database: Database, issue: IssueScope) {
  const rows = await database.select({ id: services.id, key: services.key, name: services.name }).from(issueServiceScopes).innerJoin(services, eq(services.id, issueServiceScopes.serviceId)).where(eq(issueServiceScopes.issueId, issue.id));
  return rows.filter((row) => row.id !== issue.serviceId).map(({ key, name }) => ({ key, name }));
}
