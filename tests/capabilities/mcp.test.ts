import assert from "node:assert/strict";
import { test } from "node:test";
import { connectMcp, createMcpToolBindings, inspectMcp, type McpToolBinding, type McpConfiguration, type McpConnector, type McpTool } from "../../src/mcp/client.ts";
import { createCapabilityTools } from "../../src/agent/service-query-tool.ts";

const configuration: McpConfiguration = { id: "service-1", name: "Documents", url: "https://mcp.example.test/mcp", transport: "streamable_http", authorization: "Bearer private-token", enabled: true };
const schema = { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false };
const definitions: McpTool[] = [
  { name: "search", inputSchema: schema, annotations: { readOnlyHint: true } },
  { name: "write", inputSchema: schema, annotations: { destructiveHint: true } },
  { name: "unknown", inputSchema: schema },
];

function queryTool(bindings: McpToolBinding[]) {
  return createCapabilityTools({ environmentKey: "prod", serviceKey: "orders", capabilities: [], canWriteOutputs: false }, {}, { mcpScopes: [{ environmentKey: "prod", serviceKey: "orders", serviceName: "Orders", tools: bindings }] })[0]!;
}
const invoke = (tool: ReturnType<typeof queryTool>, binding: McpToolBinding, input: Record<string, unknown>) => tool.execute("call", { environment: "prod", service: "orders", capability: "mcp", tool: binding.name, input }, undefined, undefined, {} as never);

test("filters remote tools by Issue access, validates input and closes all sessions", async () => {
  let closes = 0; let calls = 0; let readonly = true;
  const connect: McpConnector = async () => ({ list: async () => definitions.map((tool) => tool.name === "search" ? { ...tool, annotations: { readOnlyHint: readonly } } : tool), call: async (name, args) => { calls += 1; return { content: [{ type: "text", text: `${name}:${args.query}` }] }; }, close: async () => { closes += 1; } });
  const tools = await createMcpToolBindings([configuration], false, connect);
  assert.equal(tools.length, 1);
  assert.equal(closes, 1);
  assert.equal(JSON.stringify(tools).includes("private-token"), false);
  const query = queryTool(tools);
  await assert.rejects(invoke(query, tools[0]!, {}), /invalid_service_query_input/);
  assert.equal(calls, 0);
  const result = await invoke(query, tools[0]!, { query: "evidence" });
  assert.ok(JSON.stringify(result).includes("search:evidence"));
  assert.equal(closes, 2);
  readonly = false;
  await assert.rejects(invoke(query, tools[0]!, { query: "no" }), /mcp_tool_not_allowed/);
  assert.equal(calls, 1);
  assert.equal(closes, 3);
  assert.equal((await createMcpToolBindings([configuration], true, connect)).length, 3);
  assert.deepEqual(await createMcpToolBindings([{ ...configuration, enabled: false }], true, connect), []);
});

for (const transport of ["streamable_http", "sse"] as const) {
  test(`connects ${transport} with protected headers and tests tools without invoking them`, async () => {
    const original = globalThis.fetch;
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    let calls = 0;
    const methods: string[] = [];
    globalThis.fetch = async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), configuration.authorization);
      assert.equal(init?.redirect, "error");
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "GET") return new Response(new ReadableStream({ start(controller) { stream = controller; controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
      const request = JSON.parse(String(init?.body));
      let result: unknown;
      if (request.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
      if (request.method === "tools/list") result = { tools: definitions };
      if (request.method === "tools/call") { calls += 1; result = { content: [{ type: "text", text: "ok" }] }; }
      if (!result) return new Response(null, { status: 202 });
      const message = { jsonrpc: "2.0", id: request.id, result };
      if (transport === "sse") { stream!.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`)); return new Response(null, { status: 202 }); }
      return new Response(JSON.stringify(message), { headers: { "content-type": "application/json" } });
    };
    try {
      const tools = await inspectMcp({ ...configuration, transport });
      assert.deepEqual(tools, [{ name: "search", readOnly: true }, { name: "write", readOnly: false }, { name: "unknown", readOnly: false }]);
      assert.equal(calls, 0);
      assert.ok(methods.includes("POST"));
      if (transport === "sse") assert.ok(methods.includes("GET"));
    } finally { globalThis.fetch = original; }
  });
}

test("rejects redirects and cross-origin SSE targets without leaking remote errors", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("private-token"); };
  try {
    await assert.rejects(connectMcp(configuration, AbortSignal.timeout(100)), { message: "mcp_connection_failed" });
    let posted = false;
    globalThis.fetch = async (_input, init) => {
      if ((init?.method ?? "GET") !== "GET") { posted = true; throw new Error("cross-origin request attempted"); }
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("event: endpoint\ndata: https://other.example.test/messages\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
    };
    await assert.rejects(connectMcp({ ...configuration, transport: "sse" }, AbortSignal.timeout(200)), /mcp_connection_failed|mcp_timeout_or_aborted/);
    assert.equal(posted, false);
  } finally { globalThis.fetch = original; }
  const connect: McpConnector = async () => ({ list: async () => definitions, call: async () => { throw new Error("private-token"); }, close: async () => {} });
  const tools = await createMcpToolBindings([configuration], false, connect);
  await assert.rejects(invoke(queryTool(tools), tools[0]!, { query: "test" }), { message: "mcp_operation_failed" });
});
