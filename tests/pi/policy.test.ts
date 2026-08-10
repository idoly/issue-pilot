import assert from "node:assert/strict";
import { test } from "node:test";

import { createDeploymentPolicy, createIssuePolicy as createPolicy, piToolAllowlist } from "../../src/pi/policy.ts";

const model = { provider: "test", modelId: "test-model", thinkingLevel: "medium" as const };
const createIssuePolicy = (input: Omit<Parameters<typeof createPolicy>[0], "model">) => createPolicy({ ...input, model });

function service(environmentKind: "prod" | "test" | "dev" = "dev") {
  return {
    serviceKey: "orders",
    environmentKey: environmentKind,
    environmentKind,
    capabilities: [] as [],
    repositories: [
      { codeAccess: "write" as const, repositoryPath: "/tmp/issue-policy/repository", baseCommit: "a".repeat(40) },
      { codeAccess: "read" as const, repositoryPath: "/tmp/issue-policy/dependency", baseCommit: "b".repeat(40) },
    ],
  };
}

test("keeps policy focused on model and service scopes", () => {
  const policy = createIssuePolicy({
    issueKey: "issue-20260804-002",
    issueType: "defect_fix",
    workspaceRoot: "/tmp/issue-policy",
    service: service(),
  });
  assert.equal("tools" in policy, false);
  assert.equal("attachments" in policy, false);
  assert.equal(policy.issueKey, "ISSUE-20260804-002");
  assert.equal(policy.service.repositories[0]?.codeAccess, "write");
  assert.equal(policy.service.repositories[1]?.codeAccess, "read");
});

test("derives credential-free capability scopes from deployment configuration", () => {
  const policy = createDeploymentPolicy({
    issueKey: "ISSUE-20260804-007",
    issueType: "smart_analysis",
    workspaceRoot: "/tmp/deployment-policy",
    deploymentId: "deployment-1",
    deploymentConfig: {
      agent: { provider: "provider", model: "model", thinkingLevel: "high" },
      nacos: { serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP", dataIds: ["orders-test.yaml"], username: "reader", password: "nacos-secret" },
      db: { url: "mysql://db.example.test:3306/app", username: "reader", password: "db-secret" },
    },
    serviceKey: "orders",
    environmentKey: "test",
    environmentKind: "test",
    repositories: service("test").repositories,
  });
  assert.deepEqual(policy.service.capabilities, ["nacos", "db"]);
  assert.equal(policy.model.thinkingLevel, "high");
  assert.doesNotMatch(JSON.stringify(policy), /nacos-secret|db-secret|username/);
});

test("requires model authorization from deployment configuration", () => {
  assert.throws(() => createDeploymentPolicy({
    issueKey: "ISSUE-20260804-008", issueType: "smart_analysis", workspaceRoot: "/tmp/no-model", deploymentId: "deployment-no-model",
    deploymentConfig: {}, serviceKey: "orders", environmentKey: "test", environmentKind: "test", repositories: service("test").repositories,
  }), /issue_pilot_model_not_configured/);
});

test("turns repositories read-only outside writable dev issue types", () => {
  const question = createIssuePolicy({ issueKey: "ISSUE-20260804-003", issueType: "smart_analysis", workspaceRoot: "/tmp/question", service: service() });
  const prod = createIssuePolicy({ issueKey: "ISSUE-20260804-004", issueType: "defect_fix", workspaceRoot: "/tmp/prod", service: service("prod") });
  assert.equal(question.service.repositories.every((repository) => repository.codeAccess === "read"), true);
  assert.equal(prod.service.repositories.every((repository) => repository.codeAccess === "read"), true);
});

test("keeps zero-repository policies read-only", () => {
  const policy = createIssuePolicy({
    issueKey: "ISSUE-20260808-099", issueType: "defect_fix", workspaceRoot: "/tmp/issue-pilot-empty-repositories",
    service: { serviceKey: "empty", environmentKey: "dev", environmentKind: "dev", capabilities: [], repositories: [] },
  });
  assert.deepEqual(piToolAllowlist(policy), ["read", "grep", "find", "ls"]);
});

test("freezes and validates external capability scopes", () => {
  const policy = createIssuePolicy({
    issueKey: "ISSUE-20260804-005",
    issueType: "smart_analysis",
    workspaceRoot: "/tmp/sls",
    service: {
      ...service("test"),
      capabilities: ["sls"],
      sls: { deploymentId: "orders-test", region: "cn-test", project: "orders-test", logstores: ["application"] },
    },
  });
  assert.deepEqual(policy.service.sls, { deploymentId: "orders-test", region: "cn-test", project: "orders-test", logstores: ["application"] });
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.model), true);
  assert.equal(Object.isFrozen(policy.service), true);
  assert.equal(Object.isFrozen(policy.service.repositories[0]), true);
  assert.equal(Object.isFrozen(policy.service.sls), true);
  assert.equal(Object.isFrozen(policy.service.sls?.logstores), true);
  assert.throws(() => policy.service.sls?.logstores.push("mutated"), TypeError);
});

test("rejects capability declarations without matching scopes", () => {
  assert.throws(() => createIssuePolicy({
    issueKey: "ISSUE-20260804-006",
    issueType: "smart_analysis",
    workspaceRoot: "/tmp/invalid",
    service: { ...service("test"), capabilities: ["db"] },
  }), /invalid_db_service_scope/);
});
