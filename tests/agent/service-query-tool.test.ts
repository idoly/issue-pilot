import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import type { AgentSessionContext } from "../../src/agent/context.ts";
import { createCapabilityTools } from "../../src/agent/service-query-tool.ts";
import type { DeploymentConfig } from "../../src/domain/contracts.ts";

const context: AgentSessionContext = { issueKey: "ISSUE-20260808-001", serviceKey: "orders", environmentKey: "prod", model: { provider: "test-provider", modelId: "test-model", thinkingLevel: "medium" }, codemode: "off", capabilities: ["db", "redis", "dms"], canModifyCode: false, canWriteOutputs: false };
const config: DeploymentConfig = {
  db: { databases: [{ url: "mysql://db.example.test:3306/orders", username: "reader", password: "private-password" }] },
  redis: { host: "redis.example.test", port: 6379, username: "", database: 0 },
  dms: { url: "https://dms.example.test/sse", authorization: "Bearer private-token", databases: [{ instanceAlias: "ORDERS-PROD", schemaName: "orders", instanceId: "456", instanceHost: "db.example.test", instancePort: "3306", databaseId: "123" }] },
};
const call = (tool: ReturnType<typeof createCapabilityTools>[number], input: unknown) => tool.execute("call", input && typeof input === "object" ? { environment: "prod", ...input } as never : input as never, undefined, undefined, {} as never);

test("folds context-selected adapters into one query schema without exposing credentials", () => {
  const tools = createCapabilityTools(context, config);
  assert.deepEqual(tools.map(tool => tool.name), ["service_query"]);
  const serialized = JSON.stringify(tools[0]!.parameters);
  assert.doesNotMatch(serialized, /private-password|private-token|databaseId/);
  const schemas = (tools[0]!.parameters as unknown as { anyOf: Array<{ properties: Record<string, unknown>; required: string[] }> }).anyOf;
  assert.equal(schemas.length, 3);
  assert.deepEqual(schemas[0]!.required, ["environment", "service", "capability", "database", "statement"]);
  assert.deepEqual((schemas[0]!.properties.database as { enum: string[] }).enum, ["orders"]);
  assert.deepEqual((schemas[2]!.properties.schema as { enum: string[] }).enum, ["orders"]);
});

test("projects exact SLS targets and rejects undeclared logstores before starting any request", async () => {
  const [tool] = createCapabilityTools({ ...context, capabilities: ["sls"] }, { sls: { accessKeyId: "key", accessKeySecret: "secret", region: "cn-hangzhou", project: "orders", logstores: ["application", "gateway"] } });
  const schema = tool!.parameters as unknown as { properties: { logstore: { enum: string[] } } };
  assert.deepEqual(schema.properties.logstore.enum, ["application", "gateway"]);
  await assert.rejects(call(tool!, { service: "orders", capability: "sls", logstore: "unconfigured" }), /invalid_service_query_input/);
});

test("keeps native write/target restrictions after combining the dispatch entry", async () => {
  const [tool] = createCapabilityTools(context, config);
  for (const input of [
    { service: "other-environment", capability: "db", database: "orders", statement: "SELECT 1" },
    { service: "orders", capability: "db", database: "unknown", statement: "SELECT 1" },
    { service: "orders", capability: "redis", action: "del", key: "order" },
    { service: "orders", capability: "dms", schema: "unknown", script: "SELECT 1" },
    { service: "orders", capability: "dms", schema: "orders", script: "SELECT 1", databaseId: "different" },
  ]) await assert.rejects(call(tool!, input), /invalid_service_query_input/);
  const [exports] = createCapabilityTools({ ...context, canWriteOutputs: true }, config);
  await assert.rejects(call(exports!, { service: "orders", capability: "dms", schema: "orders", script: "SELECT 1", output: { fileName: "batch.json" } }), /issue_output_not_available/);
  await assert.rejects(call(exports!, { service: "orders", capability: "db", database: "orders", statement: "SELECT 1", output: { fileName: "batch.csv", format: "csv" } }), /issue_output_not_available/);
});

test("configured MCP calls share the query entry and remain scoped to the declared service", async () => {
  let received: unknown;
  const [tool] = createCapabilityTools({ ...context, capabilities: [] }, {}, { mcpScopes: [{ environmentKey: "prod", serviceKey: "other", serviceName: "Other", tools: [{ name: "mcp_fixture", label: "Search", description: "Read docs", parameters: Type.Object({ query: Type.String() }, { additionalProperties: false }), async call(input) { received = input; return { content: [{ type: "text", text: JSON.stringify({ value: "found" }) }], details: undefined }; } }] }] });
  const result = await call(tool!, { service: "other", capability: "mcp", tool: "mcp_fixture", input: { query: "evidence" } });
  assert.deepEqual(received, { query: "evidence" });
  assert.deepEqual(result.structuredContent, { value: "found" });
  assert.match(JSON.stringify(result.content), /found/);
  await assert.rejects(call(tool!, { service: "orders", capability: "mcp", tool: "mcp_fixture", input: { query: "evidence" } }), /invalid_service_query_input/);
});
