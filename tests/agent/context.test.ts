import assert from "node:assert/strict";
import { test } from "node:test";

import { createAgentSessionContext, sessionToolAllowlist } from "../../src/agent/context.ts";

const agent = { provider: "test-provider", model: "test-model", thinkingLevel: "medium" as const, codemode: "off" as const, runtime: {} };

function context(environmentKind: "dev" | "prod", repositoryAccess: Array<"read" | "write"> = ["write"], issueType = environmentKind === "dev" ? "defect_fix" : "smart_analysis") {
  return createAgentSessionContext({
    issueKey: "ISSUE-20260804-001",
    issueType: issueType as "defect_fix" | "smart_analysis",
    agentConfiguration: agent,
    enabledCapabilities: ["sls"],
    deploymentConfig: {
      sls: { region: "cn-test", project: "orders-test", logstores: ["application"], accessKeyId: "reader", accessKeySecret: "secret" },
    },
    serviceKey: "orders",
    environmentKey: environmentKind,
    environmentKind,
    repositoryAccess,
  });
}

test("keeps Agent session context small and credential-free", () => {
  const value = context("prod");
  assert.deepEqual(value.capabilities, ["sls"]);
  assert.doesNotMatch(JSON.stringify(value), /orders-test|reader|secret/);
  assert.deepEqual(sessionToolAllowlist(value), ["read", "bash", "edit", "write", "grep", "find", "ls", "service_query"]);
});

test("keeps repository policy independent from the native coding tool set", () => {
  assert.equal(context("prod").canModifyCode, false);
  assert.deepEqual(sessionToolAllowlist(context("dev")), ["read", "bash", "edit", "write", "grep", "find", "ls", "service_query"]);
  assert.equal(context("dev").canModifyCode, true);
  assert.equal(context("dev", []).canModifyCode, false);
  assert.deepEqual(sessionToolAllowlist(context("dev", [])), ["read", "bash", "edit", "write", "grep", "find", "ls", "service_query"]);
});

test("all Issue types use ordinary working files without a publication permission", () => {
  for (const environment of ["dev", "prod"] as const) {
    const value = context(environment);
    assert.equal("canWriteOutputs" in value, false);
    assert.equal(sessionToolAllowlist(value).includes("output"), false);
    assert.ok(sessionToolAllowlist(value).includes("write"));
  }
});
