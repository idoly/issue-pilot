import assert from "node:assert/strict";
import { test } from "node:test";
import { Compile } from "typebox/compile";
import { capabilityDefinitions, capabilityToolInputSchema } from "../../src/capabilities/registry.ts";
import type { AgentSessionContext } from "../../src/agent/context.ts";
import { createCapabilityTools } from "../../src/agent/service-query-tool.ts";
import type { DeploymentConfig } from "../../src/domain/contracts.ts";
const context: AgentSessionContext = { issueKey: "ISSUE-20260808-001", serviceKey: "orders", environmentKey: "prod", model: { provider: "test-provider", modelId: "test-model", thinkingLevel: "medium" }, codemode: "off", capabilities: ["dms", "sls"], canModifyCode: false };
const config: DeploymentConfig = {
  dms: { url: "https://dms.example.test/sse", authorization: "Bearer private-token", databases: [{ instanceAlias: "ORDERS-PROD", schemaName: "orders", instanceId: "456", instanceHost: "db.example.test", instancePort: "3306", databaseId: "123" }] },
  sls: { accessKeyId: "private-key", accessKeySecret: "private-secret", region: "cn-test", project: "orders", logstores: ["application", "gateway"] },
};
const call = (tool: ReturnType<typeof createCapabilityTools>[number], input: unknown) => tool.execute("call", input && typeof input === "object" ? { environment: "prod", ...input } as never : input as never, undefined, undefined, {} as never);
test("mutating one DMS tool schema does not change base rules or a later tool instance", () => {
  const first = capabilityToolInputSchema("dms", config.dms!, { exportEnabled: true });
  const properties = Reflect.get(first, "properties");
  const script = Reflect.get(properties, "script");
  const fileName = Reflect.get(Reflect.get(Reflect.get(properties, "export"), "properties"), "fileName");
  const minimum = Reflect.get(script, "minLength");
  const maximum = Reflect.get(fileName, "maxLength");
  try {
    // SDK extensions can mutate their own tool definition; later Issues must retain the owner rules.
    Reflect.set(script, "minLength", 0);
    Reflect.set(fileName, "maxLength", 1);
    const second = Compile(capabilityToolInputSchema("dms", config.dms!, { exportEnabled: true }));
    assert.equal(second.Check({ schema: "orders", script: "" }), false);
    assert.equal(second.Check({ schema: "orders", script: "SELECT 1", logic: false, export: { fileName: "evidence.json" } }), true);
    const base = Compile(capabilityDefinitions.dms.inputSchema);
    assert.equal(base.Check({ schema: "orders", script: "" }), false);
    assert.equal(base.Check({ schema: "orders", script: "SELECT 1", export: { fileName: "evidence.json" } }), true);
    assert.equal(base.Check({ schema: "orders", script: "SELECT 1", output: { fileName: "evidence.json" } }), false);
  } finally {
    Reflect.set(script, "minLength", minimum);
    Reflect.set(fileName, "maxLength", maximum);
  }
});

test("SLS query limits remain isolated across single-target and named-target tool schemas", () => {
  for (const configured of [config.sls!, { ...config.sls!, targets: [{ name: "primary", region: "cn-test", project: "orders", logstores: ["application"] }] }]) {
    const first = capabilityToolInputSchema("sls", configured);
    const variants = Reflect.get(first, "anyOf");
    const properties = variants ? Reflect.get(variants[0], "properties") : Reflect.get(first, "properties");
    const query = Reflect.get(properties, "query");
    const maximum = Reflect.get(query, "maxLength");
    try {
      Reflect.set(query, "maxLength", 1);
      const second = Compile(capabilityToolInputSchema("sls", configured));
      assert.equal(second.Check({ logstore: "application", query: "order_id:123", ...(configured.targets ? { target: "primary" } : {}) }), true);
    } finally { Reflect.set(query, "maxLength", maximum); }
  }
});

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
  const [exports] = createCapabilityTools({ ...context }, config);
  await assert.rejects(call(exports!, { service: "orders", capability: "dms", schema: "orders", script: "SELECT 1", export: { fileName: "batch.json" } }), /invalid_service_query_input/);
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
