import assert from "node:assert/strict";
import { test } from "node:test";

import { createIssuePolicy } from "../../src/pi/policy.ts";

test("freezes credential-free Redis, Elasticsearch, and RabbitMQ grants", () => {
  const policy = createIssuePolicy({
    issueKey: "ISSUE-20260805-101",
    issueType: "smart_analysis",
    workspaceRoot: "/tmp/issue-policy-external",
    model: { provider: "test", modelId: "test-model", thinkingLevel: "medium" },
    service: {
      serviceKey: "orders",
      environmentKey: "prod",
      environmentKind: "prod",
      capabilities: ["redis", "mq", "es"],
      redis: { deploymentId: "orders-prod" },
      mq: { deploymentId: "orders-prod", virtualHost: "/" },
      es: { deploymentId: "orders-prod" },
      repositories: [{ codeAccess: "read", repositoryPath: "/tmp/issue-policy-external/repository", baseCommit: "a".repeat(40) }],
    },
  });
  assert.deepEqual(policy.service.capabilities, ["redis", "mq", "es"]);
  assert.doesNotMatch(JSON.stringify(policy), /password|username|192\.168/);
});
