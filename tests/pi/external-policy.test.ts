import assert from "node:assert/strict";
import test from "node:test";

import { createIssuePolicy } from "../../src/pi/policy.ts";

test("freezes credential-free Redis, Elasticsearch, and RabbitMQ grants", () => {
  const policy = createIssuePolicy({
    issueKey: "ISSUE-20260805-101",
    issueType: "question",
    workspaceRoot: "/tmp/issue-policy-external",
    service: {
      serviceKey: "orders",
      environmentKey: "production",
      environmentKind: "production",
      capabilities: ["redis", "mq", "es"],
      redis: { deploymentId: "orders-production" },
      mq: { deploymentId: "orders-production", virtualHost: "/" },
      es: { deploymentId: "orders-production" },
      repositories: [{ codeAccess: "read", repositoryPath: "/tmp/issue-policy-external/repository", baseCommit: "a".repeat(40) }],
    },
  });
  assert.equal(policy.version, 14);
  assert.equal(policy.tools.includes("redis"), true);
  assert.equal(policy.tools.includes("mq"), true);
  assert.equal(policy.tools.includes("es"), true);
  assert.doesNotMatch(JSON.stringify(policy), /password|username|192\.168/);
});
