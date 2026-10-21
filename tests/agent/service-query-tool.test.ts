import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSessionContext } from "../../src/agent/context.ts";
import { createCapabilityTools } from "../../src/agent/service-query-tool.ts";
import type { DeploymentConfig } from "../../src/domain/contracts.ts";
const context: AgentSessionContext = { issueKey: "ISSUE-20260808-001", serviceKey: "orders", environmentKey: "prod", model: { provider: "test-provider", modelId: "test-model", thinkingLevel: "medium" }, codemode: "off", capabilities: ["dms", "sls"], canModifyCode: false, canWriteOutputs: false };
const config: DeploymentConfig = {
  dms: { url: "https://dms.example.test/sse", authorization: "Bearer private-token", databases: [{ instanceAlias: "ORDERS-PROD", schemaName: "orders", instanceId: "456", instanceHost: "db.example.test", instancePort: "3306", databaseId: "123" }] },
  sls: { accessKeyId: "private-key", accessKeySecret: "private-secret", region: "cn-test", project: "orders", logstores: ["application", "gateway"] },
};
const call = (tool: ReturnType<typeof createCapabilityTools>[number], input: unknown) => tool.execute("call", input && typeof input === "object" ? { environment: "prod", ...input } as never : input as never, undefined, undefined, {} as never);
test("exposes only selected DMS/SLS targets without credentials", () => {
  const tools = createCapabilityTools(context, config);
  assert.deepEqual(tools.map(tool => tool.name), ["service_query"]);
  const serialized = JSON.stringify(tools[0]!.parameters);
  assert.doesNotMatch(serialized, /private-token|private-key|private-secret|databaseId/);
  const schemas = (tools[0]!.parameters as unknown as { anyOf: Array<{ properties: Record<string, unknown>; required: string[] }> }).anyOf;
  assert.equal(schemas.length, 2);
  assert.deepEqual((schemas[0]!.properties.schema as { enum: string[] }).enum, ["orders"]);
  assert.deepEqual((schemas[1]!.properties.logstore as { enum: string[] }).enum, ["application", "gateway"]);
});
test("rejects retired adapters and undeclared targets before invoking external systems", async () => {
  const [tool] = createCapabilityTools(context, config);
  for (const input of [
    { service: "orders", capability: "sls", logstore: "unconfigured" },
    { service: "other", capability: "dms", schema: "orders", script: "SELECT 1" },
    { service: "orders", capability: "dms", schema: "unknown", script: "SELECT 1" },
    { service: "orders", capability: "dms", schema: "orders", script: "SELECT 1", databaseId: "different" },
    ...["nacos", "db", "redis", "mq", "es", "mcp"].map(capability => ({ service: "orders", capability })),
  ]) await assert.rejects(call(tool!, input), /invalid_service_query_input/);
  const [exports] = createCapabilityTools({ ...context, canWriteOutputs: true }, config);
  await assert.rejects(call(exports!, { service: "orders", capability: "dms", schema: "orders", script: "SELECT 1", output: { fileName: "batch.json" } }), /issue_output_not_available/);
  assert.deepEqual(createCapabilityTools({ ...context, capabilities: [] }, {}), []);
});
test("returns safe DMS diagnostics to the agent without SDK details or credentials", async () => {
  const originalFetch = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response("private upstream detail", { status: 429, headers: { "retry-after": "120" } }); };
  try {
    const [tool] = createCapabilityTools(context, config);
    await assert.rejects(call(tool!, { service: "orders", capability: "dms", schema: "orders", script: "SELECT 1" }), error => {
      assert(error instanceof Error);
      const result = JSON.parse(error.message);
      assert.equal(result.error, "dms_mcp_http_429");
      assert.equal(result.diagnostics.phase, "connect");
      assert.equal(result.diagnostics.retryAfterSeconds, 120);
      assert.equal(result.diagnostics.sqlDispatchAttempted, false);
      assert.doesNotMatch(error.message, /private|example|Bearer|SELECT/);
      assert.equal(error.cause, undefined); return true;
    });
    assert.equal(requests, 1);
  } finally { globalThis.fetch = originalFetch; }
});
