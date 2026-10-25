import { and, asc, eq, sql } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { serviceDeploymentRepositories, serviceDeployments, serviceRepositories, environments } from "../db/schema.ts";

export interface DeploymentRepository {
  repository: typeof serviceRepositories.$inferSelect;
  baseBranch: string;
}

export async function loadDeploymentRepositories(
  database: Database,
  input: { serviceId: string; environmentId: string },
): Promise<{ deployment: typeof serviceDeployments.$inferSelect; repositories: DeploymentRepository[] }> {
  const [scope, repositories] = await Promise.all([
    database.select({ deployment: serviceDeployments, kind: environments.kind }).from(serviceDeployments)
      .innerJoin(environments, eq(environments.id, serviceDeployments.environmentId))
      .where(and(eq(serviceDeployments.serviceId, input.serviceId), eq(serviceDeployments.environmentId, input.environmentId)))
      .limit(1)
      .then((rows) => rows[0]),
    database.select().from(serviceRepositories)
      .where(eq(serviceRepositories.serviceId, input.serviceId))
      .orderBy(asc(serviceRepositories.createdAt), sql`${serviceRepositories}.rowid`),
  ]);
  const deployment = scope?.deployment;
  if (!deployment) throw new Error("issue_service_deployment_not_found");
  let branchDeployment = deployment;
  if (scope.kind === "dev") {
    const [production] = await database.select({ deployment: serviceDeployments }).from(serviceDeployments)
      .innerJoin(environments, eq(environments.id, serviceDeployments.environmentId))
      .where(and(eq(serviceDeployments.serviceId, input.serviceId), eq(environments.kind, "prod"))).limit(1);
    if (!production) throw new Error("development_production_deployment_required");
    branchDeployment = production.deployment;
  }
  if (!repositories.length) throw new Error("selected_service_has_no_repository");

  const configured = await database.select({ repository: serviceRepositories, baseBranch: serviceDeploymentRepositories.baseBranch })
    .from(serviceDeploymentRepositories)
    .innerJoin(serviceRepositories, eq(serviceRepositories.id, serviceDeploymentRepositories.repositoryId))
    .where(eq(serviceDeploymentRepositories.deploymentId, branchDeployment.id));
  const branchByRepositoryId = new Map(configured.map(({ repository, baseBranch }) => [repository.id, baseBranch]));
  if (
    configured.length !== repositories.length
    || configured.some(({ repository }) => repository.serviceId !== input.serviceId)
    || repositories.some((repository) => !branchByRepositoryId.has(repository.id))
  ) throw new Error("deployment_repository_branches_invalid");

  return {
    deployment,
    repositories: repositories.map((repository) => ({ repository, baseBranch: branchByRepositoryId.get(repository.id)! })),
  };
}
