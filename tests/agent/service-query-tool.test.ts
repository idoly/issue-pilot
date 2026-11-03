import assert from "node:assert/strict";
import { test } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { compile } from "@earendil-works/pi-schema";
import { capabilityInputSchemas, capabilityToolInputSchema } from "../../src/capabilities/registry.ts";
import type { AgentSessionContext } from "../../src/agent/context.ts";
import { createCapabilityTools } from "../../src/agent/service-query-tool.ts";
import type { DeploymentConfig } from "../../src/domain/contracts.ts";
const context: AgentSessionContext = {
  issueKey: "ISSUE-20260808-001",
  serviceKey: "orders",
  environmentKey: "prod",
  model: { provider: "test-provider", modelId: "test-model", thinkingLevel: "medium" },
  codemode: "off",
  capabilities: ["dms", "sls"],
  canModifyCode: false,
};
const config: DeploymentConfig = {
  dms: {
    url: "https://dms.example.test/sse",
    authorization: "Bearer private-token",
    databases: [{ instanceAlias: "ORDERS-PROD", schemaName: "orders", instanceId: "456", instanceHost: "db.example.test", instancePort: "3306", databaseId: "123" }],
  },
  sls: { accessKeyId: "private-key", accessKeySecret: "private-secret", region: "cn-test", project: "orders", logstores: ["application", "gateway"] },
};
const call = (tool: ReturnType<typeof createCapabilityTools>[number], input: unknown) =>
  tool.execute("call", input && typeof input === "object" ? ({ environment: "prod", ...input } as never) : (input as never), undefined, undefined, {} as never);
test("mutating one DMS tool schema does not change base rules or a later tool instance", () => {
  const first = capabilityToolInputSchema("dms", config.dms!, { exportEnabled: true });
  const properties = Reflect.get(first, "properties") as Record<string, object>;
  const script = Reflect.get(properties, "script");
  const fileName = Reflect.get(Reflect.get(Reflect.get(properties, "export"), "properties"), "fileName");
  const minimum = Reflect.get(script, "minLength");
  const maximum = Reflect.get(fileName, "maxLength");
  try {
    // SDK extensions can mutate their own tool definition; later Issues must retain the owner rules.
    Reflect.set(script, "minLength", 0);
    Reflect.set(fileName, "maxLength", 1);
    const second = compile(capabilityToolInputSchema("dms", config.dms!, { exportEnabled: true }));
    assert.equal(second.check({ schema: "orders", script: "" }), false);
    assert.equal(second.check({ schema: "orders", script: "SELECT 1", logic: false, export: { fileName: "evidence.json" } }), true);
    const base = compile(capabilityInputSchemas.dms);
    assert.equal(base.check({ schema: "orders", script: "" }), false);
    assert.equal(base.check({ schema: "orders", script: "SELECT 1", export: { fileName: "evidence.json" } }), true);
    assert.equal(base.check({ schema: "orders", script: "SELECT 1", output: { fileName: "evidence.json" } }), false);
  } finally {
    Reflect.set(script, "minLength", minimum);
    Reflect.set(fileName, "maxLength", maximum);
  }
});

test("SLS query limits remain isolated across single-target and named-target tool schemas", () => {
  for (const configured of [config.sls!, { ...config.sls!, targets: [{ name: "primary", region: "cn-test", project: "orders", logstores: ["application"] }] }]) {
    const first = capabilityToolInputSchema("sls", configured);
    const variants = Reflect.get(first, "anyOf") as object[] | undefined;
    const properties = Reflect.get(variants?.[0] ?? first, "properties") as Record<string, object>;
    const query = Reflect.get(properties, "query");
    const maximum = Reflect.get(query, "maxLength");
    try {
      Reflect.set(query, "maxLength", 1);
      const second = compile(capabilityToolInputSchema("sls", configured));
      assert.equal(second.check({ logstore: "application", query: "order_id:123", ...(configured.targets ? { target: "primary" } : {}) }), true);
    } finally {
      Reflect.set(query, "maxLength", maximum);
    }
  }
});

test("exposes only selected DMS/SLS targets without credentials", () => {
  const tools = createCapabilityTools(context, config);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["service_query"],
  );
  const serialized = JSON.stringify(tools[0]!.parameters);
  assert.doesNotMatch(serialized, /private-token|private-key|private-secret|databaseId/);
  const schemas = (tools[0]!.parameters as unknown as { anyOf: Array<{ properties: Record<string, unknown>; required: string[] }> }).anyOf;
  assert.equal(schemas.length, 2);
  assert.deepEqual((schemas[0]!.properties.schema as { enum: string[] }).enum, ["orders"]);
  assert.deepEqual((schemas[1]!.properties.logstore as { enum: string[] }).enum, ["application", "gateway"]);
});
test("multi-target tool parameters keep an object root so strict OpenAI-compatible providers accept them", () => {
  for (const [scopeContext, scopeConfig, union] of [
    [context, config, true],
    [{ ...context, capabilities: ["dms"] as AgentSessionContext["capabilities"] }, config, false],
  ] as const) {
    const [tool] = createCapabilityTools(scopeContext, scopeConfig);
    const parameters = tool!.parameters as unknown as { type?: string; anyOf?: unknown[] };
    // DeepSeek rejects a bare anyOf root as `schema must be a JSON Schema of type: "object", got type: null`.
    assert.equal(parameters.type, "object");
    assert.equal(Array.isArray(parameters.anyOf), union);
    const validate = compile(tool!.parameters);
    assert.equal(validate.check({ environment: "prod", service: "orders", capability: "dms", schema: "orders", script: "SELECT 1" }), true);
    assert.equal(validate.check({ environment: "prod", service: "orders", capability: "dms", schema: "orders", script: "SELECT 1", databaseId: "other" }), false);
    assert.equal(validate.check({ environment: "prod", service: "orders", capability: "unknown" }), false);
  }
});
test("rejects retired adapters and undeclared targets before invoking external systems", async () => {
  const [tool] = createCapabilityTools(context, config);
  for (const input of [
    { service: "orders", capability: "sls", logstore: "unconfigured" },
    { service: "other", capability: "dms", schema: "orders", script: "SELECT 1" },
    { service: "orders", capability: "dms", schema: "unknown", script: "SELECT 1" },
    { service: "orders", capability: "dms", schema: "orders", script: "SELECT 1", databaseId: "different" },
    ...["nacos", "db", "redis", "mq", "es", "mcp"].map((capability) => ({ service: "orders", capability })),
  ])
    await assert.rejects(call(tool!, input), /invalid_service_query_input/);
  const [exports] = createCapabilityTools({ ...context }, config);
  await assert.rejects(call(exports!, { service: "orders", capability: "dms", schema: "orders", script: "SELECT 1", export: { fileName: "batch.json" } }), /invalid_service_query_input/);
  assert.deepEqual(createCapabilityTools({ ...context, capabilities: [] }, {}), []);
});
test("Pi schema coercion accepts valid DMS input without changing the transcript or bypassing read-only checks", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response("fixture rate limit", { status: 429, headers: { "retry-after": "120" } });
  };
  try {
    const [tool] = createCapabilityTools({ ...context, capabilities: ["dms"] }, config);
    const raw = { environment: "prod", service: "orders", capability: "dms", schema: "orders", script: "SELECT 1", logic: "false" };
    const normalized = validateToolArguments(tool!, { type: "toolCall", id: "coercion", name: "service_query", arguments: raw });
    assert.equal(normalized.logic, false);
    assert.equal(raw.logic, "false");
    const optionalNull = validateToolArguments(tool!, { type: "toolCall", id: "null", name: "service_query", arguments: { ...raw, logic: null } });
    assert.equal(Object.hasOwn(optionalNull, "logic"), false);
    assert.throws(() => validateToolArguments(tool!, { type: "toolCall", id: "unknown", name: "service_query", arguments: { ...raw, export: null } }), /unknown field/);
    await assert.rejects(call(tool!, normalized), /dms_mcp_http_429/);
    assert.equal(requests, 1);
    const write = validateToolArguments(tool!, { type: "toolCall", id: "write", name: "service_query", arguments: { ...raw, script: "DELETE FROM orders" } });
    await assert.rejects(call(tool!, write), /database_query_must_be_read_only/);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SDK-coerced arguments still cannot widen service scope through a mutable tool schema", async () => {
  const [tool] = createCapabilityTools({ ...context, capabilities: ["dms"] }, config);
  // Pi hooks may mutate the public definition after the owner compiled its checks.
  Reflect.set(Reflect.get(Reflect.get(tool!.parameters, "properties"), "service"), "const", "unauthorized");
  const normalized = validateToolArguments(tool!, {
    type: "toolCall",
    id: "scope",
    name: "service_query",
    arguments: { environment: "prod", service: "unauthorized", capability: "dms", schema: "orders", script: "SELECT 1", logic: "true" },
  });
  assert.equal(normalized.logic, true);
  assert.equal(normalized.service, "unauthorized");
  await assert.rejects(call(tool!, normalized), /invalid_service_query_input|service_capability_not_available/);
});

test("execute validation keeps an independent schema snapshot after a Pi hook weakens public constraints", async () => {
  const [tool] = createCapabilityTools({ ...context, capabilities: ["dms"] }, config);
  Reflect.set(Reflect.get(Reflect.get(tool!.parameters, "properties"), "script"), "minLength", 0);
  const normalized = validateToolArguments(tool!, {
    type: "toolCall",
    id: "weakened",
    name: "service_query",
    arguments: { environment: "prod", service: "orders", capability: "dms", schema: "orders", script: "" },
  });
  assert.equal(normalized.script, "");
  await assert.rejects(call(tool!, normalized), /invalid_service_query_input/);
});

test("returns safe DMS diagnostics to the agent without SDK details or credentials", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response("private upstream detail", { status: 429, headers: { "retry-after": "120" } });
  };
  try {
    const [tool] = createCapabilityTools(context, config);
    await assert.rejects(call(tool!, { service: "orders", capability: "dms", schema: "orders", script: "SELECT 1" }), (error) => {
      assert(error instanceof Error);
      const result = JSON.parse(error.message);
      assert.equal(result.error, "dms_mcp_http_429");
      assert.equal(result.diagnostics.phase, "connect");
      assert.equal(result.diagnostics.retryAfterSeconds, 120);
      assert.equal(result.diagnostics.sqlDispatchAttempted, false);
      assert.doesNotMatch(error.message, /private|example|Bearer|SELECT/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a missing credential for one capability does not block another capability on the same service", async () => {
  const tools = createCapabilityTools(
    context,
    {},
    { serviceScopes: [{ environmentKey: "prod", serviceKey: "orders", serviceName: "Orders", config, credentialErrors: { sls: "personal_sls_credentials_incomplete" } }] },
  );
  await assert.rejects(call(tools[0]!, { service: "orders", capability: "sls", logstore: "application", query: "*", from: 0, to: 1 }), /personal_sls_credentials_incomplete/);
  // DMS is not rejected by the SLS credential error; it proceeds to SQL validation.
  await assert.rejects(call(tools[0]!, { service: "orders", capability: "dms", schema: "orders", script: "DELETE FROM orders" }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /sls_credentials/);
    return true;
  });
});

test("reports a missing credential when the selected capability runs, not while preparing the session", async () => {
  const tools = createCapabilityTools(
    context,
    {},
    { serviceScopes: [{ environmentKey: "prod", serviceKey: "orders", serviceName: "Orders", config, credentialErrors: { dms: "dms_credentials_not_configured" } }] },
  );
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["service_query"],
  );
  await assert.rejects(call(tools[0]!, { service: "orders", capability: "dms", schema: "orders", script: "SELECT 1" }), /dms_credentials_not_configured/);
});
