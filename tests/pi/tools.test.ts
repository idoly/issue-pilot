import assert from "node:assert/strict";
import { test } from "node:test";

import { createIssuePolicy } from "../../src/pi/policy.ts";
import { createCapabilityTools } from "../../src/pi/tools.ts";

const policy = createIssuePolicy({
  issueKey: "ISSUE-20260808-001",
  issueType: "data_processing",
  workspaceRoot: "/tmp/issue-workspace",
  model: { provider: "test-provider", modelId: "test-model", thinkingLevel: "medium" },
  service: {
    serviceKey: "orders",
    environmentKey: "prod",
    environmentKind: "prod",
    capabilities: ["db", "redis", "dms"],
    db: { deploymentId: "deployment-1" },
    dms: { deploymentId: "deployment-1", dbId: "123456", logic: false },
    redis: { deploymentId: "deployment-1" },
    repositories: [{ codeAccess: "read", repositoryPath: "/tmp/issue-workspace/orders", baseCommit: "abc123" }],
  },
});

test("creates only policy-selected SDK capability tools", () => {
  const tools = createCapabilityTools(policy, { db: {}, dms: {}, redis: {} });
  assert.deepEqual(tools.map((tool) => tool.name), ["db", "redis", "dms"]);
  assert.match(tools[0]?.promptSnippet ?? "", /read-only MySQL/);
  assert.match(tools[1]?.promptGuidelines?.[0] ?? "", /allowlisted read operations/);
  assert.match(tools[2]?.promptSnippet ?? "", /Alibaba Cloud DMS/);
});

test("SDK capability tools call the authoritative broker function directly", async () => {
  const [database] = createCapabilityTools(createIssuePolicy({
    ...policy,
    service: {
      serviceKey: policy.service.serviceKey,
      environmentKey: policy.service.environmentKey,
      environmentKind: policy.service.environmentKind,
      capabilities: ["db"],
      db: policy.service.db!,
      repositories: policy.service.repositories,
    },
  }), { db: {} });
  await assert.rejects(database!.execute("call", { statement: "SELECT 1" }, undefined, undefined, {} as never), /db_configuration_not_found/);
});
