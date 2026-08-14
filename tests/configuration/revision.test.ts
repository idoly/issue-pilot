import assert from "node:assert/strict";
import { test } from "node:test";

import { serviceConfigurationRevision } from "../../src/configuration/revision.ts";

const now = new Date(0);
const service = { id: "service", key: "orders", name: "Orders", description: "", createdAt: now, updatedAt: now };
const repositories = [
  { id: "repo-b", serviceId: "service", alias: "web", url: "git@example.test:web.git", createdAt: now, updatedAt: now },
  { id: "repo-a", serviceId: "service", alias: "api", url: "git@example.test:api.git", createdAt: now, updatedAt: now },
];
const deployments = [{ id: "deployment", serviceId: "service", environmentId: "test", config: { db: { username: "reader", password: "secret", url: "mysql://db.example.test:3306/orders" }, agent: { thinkingLevel: "high" as const, model: "model", provider: "provider" } }, createdAt: now, updatedAt: now }];
const branches = repositories.map((repository) => ({ deploymentId: "deployment", repositoryId: repository.id, baseBranch: "main", createdAt: now, updatedAt: now }));

test("builds an order-independent revision from the complete Service configuration", () => {
  const revision = serviceConfigurationRevision(service, repositories, deployments, branches);
  assert.match(revision, /^[a-f0-9]{64}$/);
  assert.equal(serviceConfigurationRevision({ ...service, updatedAt: new Date() }, [...repositories].reverse(), [{ ...deployments[0]!, config: { agent: deployments[0]!.config.agent, db: deployments[0]!.config.db } }], [...branches].reverse()), revision);
  assert.notEqual(serviceConfigurationRevision(service, repositories, [{ ...deployments[0]!, config: { ...deployments[0]!.config, db: { ...deployments[0]!.config.db, password: "rotated" } } }], branches), revision);
  assert.notEqual(serviceConfigurationRevision(service, repositories, deployments, [{ ...branches[0]!, baseBranch: "release" }, branches[1]!]), revision);
});
