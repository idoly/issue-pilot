import { registerTestRepositories } from "../helpers/repositories.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { and, eq } from "drizzle-orm";

import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { environments, serviceDeploymentRepositories, serviceDeployments, serviceRepositories, services } from "../../src/db/schema.ts";
import { loadDeploymentRepositories } from "../../src/workspace/deployment.ts";

test("loads deployment branches in service repository order and rejects incomplete ownership", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-deployment-repositories-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  try {
    const [prod] = await database.db.select().from(environments).where(eq(environments.kind, "prod")).limit(1);
    const [service, otherService] = await database.db.insert(services).values([
      { key: "orders", name: "Orders" },
      { key: "payments", name: "Payments" },
    ]).returning();
    await registerTestRepositories(database.db, ["https://example.test/orders-api.git", "https://example.test/orders-web.git", "https://example.test/payments-api.git"]);
    const repositories = await database.db.insert(serviceRepositories).values([
      { serviceId: service!.id, alias: "orders-api", url: "https://example.test/orders-api.git" },
      { serviceId: service!.id, alias: "orders-web", url: "https://example.test/orders-web.git" },
      { serviceId: otherService!.id, alias: "payments-api", url: "https://example.test/payments-api.git" },
    ]).returning();
    const [deployment] = await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: prod!.id, config: {} }).returning();
    await database.db.insert(serviceDeploymentRepositories).values([
      { deploymentId: deployment!.id, repositoryId: repositories[1]!.id, baseBranch: "release" },
      { deploymentId: deployment!.id, repositoryId: repositories[0]!.id, baseBranch: "main" },
    ]);

    const loaded = await loadDeploymentRepositories(database.db, { serviceId: service!.id, environmentId: prod!.id });
    assert.equal(loaded.deployment.id, deployment!.id);
    assert.deepEqual(loaded.repositories.map(({ repository, baseBranch }) => ({ alias: repository.alias, baseBranch })), [
      { alias: "orders-api", baseBranch: "main" },
      { alias: "orders-web", baseBranch: "release" },
    ]);

    await database.db.delete(serviceDeploymentRepositories).where(and(
      eq(serviceDeploymentRepositories.deploymentId, deployment!.id),
      eq(serviceDeploymentRepositories.repositoryId, repositories[1]!.id),
    ));
    await assert.rejects(loadDeploymentRepositories(database.db, { serviceId: service!.id, environmentId: prod!.id }), /deployment_repository_branches_invalid/);

    await database.db.insert(serviceDeploymentRepositories).values([
      { deploymentId: deployment!.id, repositoryId: repositories[1]!.id, baseBranch: "release" },
      { deploymentId: deployment!.id, repositoryId: repositories[2]!.id, baseBranch: "main" },
    ]);
    await assert.rejects(loadDeploymentRepositories(database.db, { serviceId: service!.id, environmentId: prod!.id }), /deployment_repository_branches_invalid/);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
