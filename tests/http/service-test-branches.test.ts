import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiFixture, createService } from "./fixture.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";

test("adds missing IQS test deployment and persists every selected branch without rewriting existing branches", async () => {
  const f = await createApiFixture();
  const headers = { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject };
  try {
    await createService(f.app, "IQS", ["prod", "dev"], ["git@example.test:iqs/front.git", "git@example.test:iqs/server.git"]);
    const configuration = JSON.parse((await f.app.inject({ method: "GET", url: "/api/config" })).body);
    const service = configuration.services[0];
    const deployments = ["dev", "test", "prod"].map(environmentKey => ({ environmentKey, capabilities: [], mcpServices: [], repositoryBranches: service.repositories.map((repository: { alias: string; id: string }) => ({ repositoryAlias: repository.alias, baseBranch: environmentKey === "test" ? "release/test" : service.deployments.find((row: { environmentKey: string }) => row.environmentKey === environmentKey).repositoryBranches.find((row: { repositoryId: string }) => row.repositoryId === repository.id).baseBranch })) }));
    const response = await f.app.inject({ method: "PATCH", url: "/api/services/iqs", headers, payload: { name: service.name, description: service.description, repositories: service.repositories, deployments } });
    assert.equal(response.statusCode, 200, response.body);
    const saved = JSON.parse((await f.app.inject({ method: "GET", url: "/api/config" })).body).services[0];
    assert.equal(saved.deployments.length, 3);
    assert.deepEqual(saved.deployments.find((row: { environmentKey: string }) => row.environmentKey === "test").repositoryBranches.map((row: { baseBranch: string }) => row.baseBranch), ["release/test", "release/test"]);
    for (const original of service.deployments) assert.deepEqual(saved.deployments.find((row: { environmentKey: string }) => row.environmentKey === original.environmentKey).repositoryBranches, original.repositoryBranches);
  } finally { await f.cleanup(); }
});
