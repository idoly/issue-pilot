import { and, asc, eq, sql } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { serviceDeploymentRepositories, serviceDeployments, serviceRepositories } from "../db/schema.ts";

export interface DeploymentRepository {
  repository: typeof serviceRepositories.$inferSelect;
  baseBranch: string;
}

export async function loadDeploymentRepositories(
  database: Database,
  input: { serviceId: string; environmentId: string },
): Promise<{ deployment: typeof serviceDeployments.$inferSelect; repositories: DeploymentRepository[] }> {
  const [deployment, repositories] = await Promise.all([
    database.select().from(serviceDeployments)
      .where(and(eq(serviceDeployments.serviceId, input.serviceId), eq(serviceDeployments.environmentId, input.environmentId)))
      .limit(1)
      .then((rows) => rows[0]),
    database.select().from(serviceRepositories)
      .where(eq(serviceRepositories.serviceId, input.serviceId))
      .orderBy(asc(serviceRepositories.createdAt), sql`${serviceRepositories}.rowid`),
  ]);
  if (!deployment) throw new Error("issue_service_deployment_not_found");
  if (!repositories.length) throw new Error("selected_service_has_no_repository");

  const configured = await database.select({ repository: serviceRepositories, baseBranch: serviceDeploymentRepositories.baseBranch })
    .from(serviceDeploymentRepositories)
    .innerJoin(serviceRepositories, eq(serviceRepositories.id, serviceDeploymentRepositories.repositoryId))
    .where(eq(serviceDeploymentRepositories.deploymentId, deployment.id));
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
