import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentSessionContext } from "../../src/agent/context.ts";
import { createCapabilityTools } from "../../src/pi/tools.ts";
import type { ToolRuntime } from "../../src/tool-runtime.ts";

const context: AgentSessionContext = {
  issueKey: "ISSUE-20260808-001",
  serviceKey: "orders",
  environmentKey: "prod",
  model: { provider: "test-provider", modelId: "test-model", thinkingLevel: "medium" },
  capabilities: ["db", "redis", "dms"],
  canModifyCode: false,
};

test("creates only context-selected SDK capability tools", () => {
  const tools = createCapabilityTools(context, {
    db: { url: "mysql://db.example.test:3306/orders", username: "reader", password: "secret" },
    redis: { host: "redis.example.test", port: 6379, username: "", database: 0 },
    dms: { url: "https://dms.example.test/sse", authorization: "Bearer token" },
  });
  assert.deepEqual(tools.map((tool) => tool.name), ["db", "redis", "dms"]);
  assert.match(tools[0]?.promptSnippet ?? "", /read-only MySQL/);
  assert.match(tools[1]?.promptGuidelines?.[0] ?? "", /allowlisted read operations/);
  assert.match(tools[2]?.promptSnippet ?? "", /DMS executeScript/);
  const dmsSchema = tools[2]?.parameters as unknown as { properties: Record<string, unknown>; required: string[] };
  assert.deepEqual(Object.keys(dmsSchema.properties), ["script", "logic"]);
  assert.deepEqual(dmsSchema.required, ["script"]);
});

test("projects the selected deployment SLS logstores into the session-local tool schema", async () => {
  const slsContext: AgentSessionContext = { ...context, capabilities: ["sls"] };
  let calls = 0;
  const unavailable: ToolRuntime = { run: () => { calls += 1; return Promise.reject(new Error("tool_runtime_unavailable")); } };
  const tools = createCapabilityTools(slsContext, {
    sls: {
      accessKeyId: "key",
      accessKeySecret: "secret",
      region: "cn-hangzhou",
      project: "xhgj-zysys",
      logstores: ["srm-api-manage", "srm-api-portal", "srm-batch", "srm-api-supplier"],
    },
  }, unavailable);
  const sls = tools[0]!;
  const schema = sls.parameters as unknown as { properties: { logstore: { enum: string[]; description: string } } };
  assert.deepEqual(schema.properties.logstore.enum, ["srm-api-manage", "srm-api-portal", "srm-batch", "srm-api-supplier"]);
  assert.match(schema.properties.logstore.description, /selected deployment/);
  await assert.rejects(sls.execute("call", { logstore: "srm" }, undefined, undefined, {} as never), /invalid_sls_input/);
  assert.equal(calls, 0);
});

test("validates Pi tool input and passes the application tool runtime directly", async () => {
  const unavailable: ToolRuntime = { run: () => Promise.reject(new Error("tool_runtime_unavailable")) };
  const tools = createCapabilityTools(context, {
    db: { url: "mysql://db.example.test:3306/orders", username: "reader", password: "secret" },
    redis: { host: "redis.example.test", port: 6379, username: "", database: 0 },
    dms: { url: "https://dms.example.test/sse", authorization: "Bearer token" },
  }, unavailable);
  const redis = tools.find((tool) => tool.name === "redis")!;
  const dms = tools.find((tool) => tool.name === "dms")!;
  await assert.rejects(redis.execute("call", { action: "del", key: "order" }, undefined, undefined, {} as never), /invalid_redis_input/);
  await assert.rejects(dms.execute("call", { tool: "query_database", script: "SELECT 1" }, undefined, undefined, {} as never), /invalid_dms_input/);
});
