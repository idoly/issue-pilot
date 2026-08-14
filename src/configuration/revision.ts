import { createHmac, randomBytes } from "node:crypto";

import { eq, inArray } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { serviceDeploymentRepositories, serviceDeployments, serviceRepositories, services } from "../db/schema.ts";

type ServiceRow = typeof services.$inferSelect;
type RepositoryRow = typeof serviceRepositories.$inferSelect;
type DeploymentRow = typeof serviceDeployments.$inferSelect;
type DeploymentRepositoryRow = typeof serviceDeploymentRepositories.$inferSelect;

const revisionKey = randomBytes(32);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareText(left, right)).map(([key, entry]) => [key, canonicalValue(entry)]));
}

export function serviceConfigurationRevision(
  service: ServiceRow,
  repositories: RepositoryRow[],
  deployments: DeploymentRow[],
  deploymentRepositories: DeploymentRepositoryRow[],
): string {
  const content = {
    service: { id: service.id, key: service.key, name: service.name, description: service.description },
    repositories: repositories.map(({ id, alias, url }) => ({ id, alias, url })).sort((left, right) => compareText(left.id, right.id)),
    deployments: deployments.map(({ id, environmentId, config }) => ({ id, environmentId, config: canonicalValue(config) })).sort((left, right) => compareText(left.id, right.id)),
    deploymentRepositories: deploymentRepositories.map(({ deploymentId, repositoryId, baseBranch }) => ({ deploymentId, repositoryId, baseBranch })).sort((left, right) => compareText(left.deploymentId, right.deploymentId) || compareText(left.repositoryId, right.repositoryId)),
  };
  return createHmac("sha256", revisionKey).update(JSON.stringify(content)).digest("hex");
}

export async function loadServiceConfigurationRevision(database: Pick<Database, "select">, service: ServiceRow): Promise<string> {
  const [repositories, deployments] = await Promise.all([
    database.select().from(serviceRepositories).where(eq(serviceRepositories.serviceId, service.id)),
    database.select().from(serviceDeployments).where(eq(serviceDeployments.serviceId, service.id)),
  ]);
  const deploymentRepositories = deployments.length
    ? await database.select().from(serviceDeploymentRepositories).where(inArray(serviceDeploymentRepositories.deploymentId, deployments.map((deployment) => deployment.id)))
    : [];
  return serviceConfigurationRevision(service, repositories, deployments, deploymentRepositories);
}
