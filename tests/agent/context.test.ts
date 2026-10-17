import assert from "node:assert/strict";
import { test } from "node:test";

import { createAgentSessionContext, sessionToolAllowlist } from "../../src/agent/context.ts";

const agent = { provider: "test-provider", model: "test-model", thinkingLevel: "medium" as const };

function context(environmentKind: "dev" | "prod", repositoryAccess: Array<"read" | "write"> = ["write"], issueType = environmentKind === "dev" ? "defect_fix" : "smart_analysis") {
  return createAgentSessionContext({
    issueKey: "ISSUE-20260804-001",
    issueType: issueType as "defect_fix" | "smart_analysis" | "data_processing",
    agentConfiguration: agent,
    enabledCapabilities: ["redis"],
    deploymentConfig: {
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
  assert.deepEqual(sessionToolAllowlist(value), ["read", "bash", "edit", "write", "grep", "find", "ls", "service_query"]);
});

test("keeps repository policy independent from the native coding tool set", () => {
  assert.equal(context("prod").canModifyCode, false);
  assert.deepEqual(sessionToolAllowlist(context("dev")), ["read", "bash", "edit", "write", "grep", "find", "ls", "service_query"]);
  assert.equal(context("dev").canModifyCode, true);
  assert.equal(context("dev", []).canModifyCode, false);
  assert.deepEqual(sessionToolAllowlist(context("dev", [])), ["read", "bash", "edit", "write", "grep", "find", "ls", "service_query"]);
});

test("grants only the durable output tool to production data-processing Issues", () => {
  const data = context("prod", ["read"], "data_processing");
  assert.equal(data.canModifyCode, false);
  assert.equal(data.canWriteOutputs, true);
  assert.deepEqual(sessionToolAllowlist(data), ["read", "bash", "edit", "write", "grep", "find", "ls", "output", "service_query"]);
  assert.equal(context("prod", ["read"], "smart_analysis").canWriteOutputs, false);
});
