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
  canWriteOutputs: false,
};

test("creates only context-selected SDK capability tools", () => {
  const tools = createCapabilityTools(context, {
    db: { databases: [{ url: "mysql://db.example.test:3306/orders", username: "reader", password: "secret" }] },
    redis: { host: "redis.example.test", port: 6379, username: "", database: 0 },
    dms: { url: "https://dms.example.test/sse", authorization: "Bearer token", databases: [{ instanceAlias: "ORDERS-PROD", schemaName: "orders", instanceId: "456", instanceHost: "db.example.test", instancePort: "3306", databaseId: "123" }] },
  });
  assert.deepEqual(tools.map((tool) => tool.name), ["db", "redis", "dms"]);
  assert.match(tools[0]?.promptSnippet ?? "", /read-only MySQL/);
  assert.match(tools[1]?.promptGuidelines?.[0] ?? "", /allowlisted read operations/);
  assert.match(tools[2]?.promptSnippet ?? "", /configured DMS schema through executeScript/);
  const dbSchema = tools[0]?.parameters as unknown as { properties: Record<string, unknown>; required: string[] };
  assert.deepEqual(Object.keys(dbSchema.properties), ["database", "statement"]);
  assert.deepEqual(dbSchema.required, ["database", "statement"]);
  assert.deepEqual((dbSchema.properties.database as { enum: string[] }).enum, ["orders"]);
  const dmsSchema = tools[2]?.parameters as unknown as { properties: Record<string, unknown>; required: string[] };
  assert.deepEqual(Object.keys(dmsSchema.properties), ["schema", "script", "logic"]);
  assert.deepEqual(dmsSchema.required, ["schema", "script"]);
  assert.deepEqual((dmsSchema.properties.schema as { enum: string[] }).enum, ["orders"]);
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

test("exposes direct MySQL export only when the Issue has an output store", async () => {
  const outputContext = { ...context, canWriteOutputs: true };
  const tools = createCapabilityTools(outputContext, {
    db: { databases: [{ url: "mysql://db.example.test:3306/orders", username: "reader", password: "secret" }] },
    redis: { host: "redis.example.test", port: 6379, username: "", database: 0 },
    dms: { url: "https://dms.example.test/sse", authorization: "Bearer token", databases: [{ instanceAlias: "ORDERS-PROD", schemaName: "orders", instanceId: "456", instanceHost: "db.example.test", instancePort: "3306", databaseId: "123" }] },
  });
  const db = tools.find((tool) => tool.name === "db")!;
  const schema = db.parameters as unknown as { properties: Record<string, unknown> };
  assert.deepEqual(Object.keys(schema.properties), ["database", "statement", "output"]);
  await assert.rejects(db.execute("call", { database: "orders", statement: "SELECT 1", output: { fileName: "orders.csv", format: "csv" } }, undefined, undefined, {} as never), /issue_output_not_available/);
});

test("validates Pi tool input and passes the application tool runtime directly", async () => {
  const unavailable: ToolRuntime = { run: () => Promise.reject(new Error("tool_runtime_unavailable")) };
  const tools = createCapabilityTools(context, {
    db: { databases: [{ url: "mysql://db.example.test:3306/orders", username: "reader", password: "secret" }] },
    redis: { host: "redis.example.test", port: 6379, username: "", database: 0 },
    dms: { url: "https://dms.example.test/sse", authorization: "Bearer token", databases: [{ instanceAlias: "ORDERS-PROD", schemaName: "orders", instanceId: "456", instanceHost: "db.example.test", instancePort: "3306", databaseId: "123" }] },
  }, unavailable);
  const db = tools.find((tool) => tool.name === "db")!;
  const redis = tools.find((tool) => tool.name === "redis")!;
  const dms = tools.find((tool) => tool.name === "dms")!;
  await assert.rejects(db.execute("call", { database: "unknown", statement: "SELECT 1" }, undefined, undefined, {} as never), /invalid_db_input/);
  await assert.rejects(redis.execute("call", { action: "del", key: "order" }, undefined, undefined, {} as never), /invalid_redis_input/);
  await assert.rejects(dms.execute("call", { schema: "unknown", script: "SELECT 1" }, undefined, undefined, {} as never), /invalid_dms_input/);
});
