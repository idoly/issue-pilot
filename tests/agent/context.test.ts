import assert from "node:assert/strict";
import { test } from "node:test";

import { createAgentSessionContext, sessionToolAllowlist } from "../../src/agent/context.ts";

const agent = { provider: "test-provider", model: "test-model", thinkingLevel: "medium" as const };

function context(environmentKind: "dev" | "prod", repositoryAccess: Array<"read" | "write"> = ["write"]) {
  return createAgentSessionContext({
    issueKey: "ISSUE-20260804-001",
    issueType: environmentKind === "dev" ? "defect_fix" : "smart_analysis",
    deploymentConfig: {
      agent,
      redis: { host: "redis.example.test", port: 6379, username: "reader", password: "secret", database: 0 },
    },
    serviceKey: "orders",
    environmentKey: environmentKind,
    environmentKind,
    repositoryAccess,
  });
}

test("keeps Agent session context small and credential-free", () => {
  const value = context("prod");
  assert.deepEqual(value.capabilities, ["redis"]);
  assert.doesNotMatch(JSON.stringify(value), /redis\.example\.test|reader|secret/);
  assert.deepEqual(sessionToolAllowlist(value), ["read", "grep", "find", "ls", "redis"]);
});

test("allows mutation tools only for writable development repositories", () => {
  assert.equal(context("prod").canModifyCode, false);
  assert.deepEqual(sessionToolAllowlist(context("dev")), ["read", "bash", "edit", "write", "grep", "find", "ls", "redis"]);
  assert.deepEqual(sessionToolAllowlist(context("dev", [])), ["read", "grep", "find", "ls", "redis"]);
});
