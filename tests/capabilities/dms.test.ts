import assert from "node:assert/strict";
import { test } from "node:test";

import { connectDmsMcp, queryDms, resolveDmsScope, type ConnectDmsMcp, type DmsMcpSession } from "../../src/capabilities/dms.ts";

const configured = {
  url: "https://dms.example.test/sse",
  authorization: "Bearer fixture-token",
  databases: [{ instanceAlias: "ORDERS-PROD", schemaName: "orders", instanceId: "456", instanceHost: "db.example.test", instancePort: "3306", databaseId: "123" }],
};
const readOnlyTool = {
  name: "query_database",
  description: "Query a database without changing it",
  inputSchema: { type: "object" as const, properties: { sql: { type: "string" } }, required: ["sql"] },
  annotations: { readOnlyHint: true, destructiveHint: false },
};
const listInstancesTool = {
  name: "listInstances",
  description: "Search DMS instances",
  inputSchema: { type: "object" as const, properties: {} },
  annotations: { readOnlyHint: true },
};
const searchDatabaseTool = {
  name: "searchDatabase",
  description: "Search databases in DMS",
  inputSchema: { type: "object" as const, properties: { search_key: { type: "string" } }, required: ["search_key"] },
  annotations: { readOnlyHint: true },
};
const getDatabaseTool = {
  name: "getDatabase",
  description: "Get one database by instance and schema",
  inputSchema: { type: "object" as const, properties: { host: { type: "string" }, port: { type: "string" }, schema_name: { type: "string" } }, required: ["host", "port", "schema_name"] },
  annotations: { readOnlyHint: true },
};
const executeScriptTool = {
  name: "executeScript",
  description: "Execute a SQL script through DMS",
  inputSchema: {
    type: "object" as const,
    properties: { database_id: { type: "string" }, script: { type: "string" }, logic: { type: "boolean", default: false } },
    required: ["database_id", "script"],
  },
  annotations: { readOnlyHint: false, destructiveHint: true },
};

function fixtureSession(overrides: Partial<DmsMcpSession> = {}) {
  let closes = 0;
  const calls: Array<{ name: string; args: Record<string, unknown>; aborted: boolean }> = [];
  const session: DmsMcpSession = {
    async listTools() {
      return [
        readOnlyTool,
        { name: "unannotated", inputSchema: { type: "object" } },
        { name: "drop_database", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, destructiveHint: true } },
      ];
    },
    async callTool(name, args, signal) {
      calls.push({ name, args, aborted: signal.aborted });
      return { content: [{ type: "text", text: "[{\"id\":1}]" }] };
    },
    async close() { closes += 1; },
    ...overrides,
  };
  const connections: Array<{ url: string; authorization: string; signal: AbortSignal }> = [];
  const connect: ConnectDmsMcp = async (configuration, signal) => {
    connections.push({ url: configuration.url, authorization: configuration.authorization, signal });
    return session;
  };
  return { calls, closes: () => closes, connect, connections };
}

test("uses Authorization for both sides of the MCP SSE protocol", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ method: string; url: string; authorization: string | null; redirect?: RequestRedirect }> = [];
  const requestSignals: AbortSignal[] = [];
  const toolCalls: Array<{ name?: string; arguments?: Record<string, unknown> }> = [];
  const encoder = new TextEncoder();
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const send = (message: unknown) => stream!.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (init?.signal) requestSignals.push(init.signal);
    requests.push({ method, url, authorization: new Headers(init?.headers).get("authorization"), ...(init?.redirect ? { redirect: init.redirect } : {}) });
    if (method === "GET") {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          controller.enqueue(encoder.encode("event: endpoint\ndata: /messages?session=fixed\n\n"));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const request = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (request.method === "initialize") {
      send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
    } else if (request.method === "tools/list") {
      send({ jsonrpc: "2.0", id: request.id, result: { tools: [readOnlyTool, listInstancesTool, searchDatabaseTool, getDatabaseTool] } });
    } else if (request.method === "tools/call") {
      toolCalls.push(request.params ?? {});
      const content = request.params?.name === "getDatabase"
        ? [{ type: "text", text: JSON.stringify({ DatabaseId: 123, InstanceId: 456, DbType: "mysql", SchemaName: "orders" }) }]
        : request.params?.name === "searchDatabase"
          ? [{ type: "text", text: JSON.stringify({ DatabaseId: 123, Host: "db.example.test", Port: 3306, DbType: "mysql", SchemaName: "orders" }) }]
        : request.params?.name === "listInstances"
          ? [{ type: "text", text: JSON.stringify({ InstanceId: 456, InstanceAlias: "ORDERS-PROD", Host: "db.example.test", Port: 3306, InstanceType: "mysql", EnvType: "product" }) }]
          : [{ type: "text", text: "ok" }];
      send({ jsonrpc: "2.0", id: request.id, result: { content } });
    }
    return new Response(null, { status: 202 });
  };
  try {
    const session = await connectDmsMcp(configured, AbortSignal.timeout(5_000), 20);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(requestSignals.every((signal) => !signal.aborted), true, "successful handshake must cancel its timeout without aborting the SSE session");
    assert.deepEqual((await session.listTools(AbortSignal.timeout(5_000))).map(({ name }) => name), ["query_database", "listInstances", "searchDatabase", "getDatabase"]);
    assert.deepEqual(await session.callTool("query_database", { sql: "SELECT 1" }, AbortSignal.timeout(5_000)), { content: [{ type: "text", text: "ok" }] });
    await session.close();
    assert.deepEqual(await resolveDmsScope(configured, "ORDERS-PROD", "orders"), { instanceId: "456", instanceHost: "db.example.test", instancePort: "3306", databaseId: "123" });
    assert.deepEqual(toolCalls.at(-1), { name: "getDatabase", arguments: { host: "db.example.test", port: "3306", schema_name: "orders", sid: null } });
    assert.equal(requests.filter(({ method }) => method === "GET").length, 2);
    assert.equal(requests.every(({ method }) => method === "GET" || method === "POST"), true);
    assert.equal(requests.every(({ authorization }) => authorization === configured.authorization), true);
    assert.equal(requests.every(({ redirect }) => redirect === "error"), true);
    assert.equal(requests.every(({ url }) => new URL(url).origin === "https://dms.example.test"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports an MCP SSE handshake timeout separately from connection failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  try {
    await assert.rejects(connectDmsMcp(configured, AbortSignal.timeout(25)), /dms_mcp_timeout/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retries a stalled SSE handshake once without repeating tool calls", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  let gets = 0;
  let posts = 0;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  globalThis.fetch = async (input, init) => {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method === "GET") {
      gets += 1;
      if (gets === 1) return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          controller.enqueue(encoder.encode("event: endpoint\ndata: /messages?session=retry\n\n"));
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    posts += 1;
    const request = JSON.parse(String(init?.body)) as { id: number; method: string };
    if (request.method === "initialize") stream!.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } })}\n\n`));
    return new Response(null, { status: 202 });
  };
  try {
    const session = await connectDmsMcp(configured, AbortSignal.timeout(1_000), 20);
    await session.close();
    assert.equal(gets, 2);
    assert.ok(posts >= 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not retry an SSE authorization failure", async () => {
  const originalFetch = globalThis.fetch;
  let gets = 0;
  globalThis.fetch = async () => { gets += 1; return new Response(null, { status: 403 }); };
  try {
    await assert.rejects(connectDmsMcp(configured, AbortSignal.timeout(1_000), 20), /dms_mcp_connection_failed/);
    assert.equal(gets, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("calls only MCP executeScript and binds it to the configured deployment database", async () => {
  const fixture = fixtureSession({ async listTools() { return [readOnlyTool, executeScriptTool]; } });
  const result = await queryDms({ schema: "orders", script: "SELECT COUNT(*) FROM suppliers;", logic: false }, configured, undefined, fixture.connect);

  assert.deepEqual(fixture.calls, [{ name: "executeScript", args: { database_id: "123", script: "SELECT COUNT(*) FROM suppliers", logic: false }, aborted: false }]);
  assert.deepEqual(result.details, { provider: "aliyun-dms-mcp", tool: "executeScript" });
  assert.equal(JSON.parse(result.content[0]!.text).result.content[0].text, '[{"id":1}]');
  assert.doesNotMatch(JSON.stringify(result), /fixture-token/);
  assert.equal(fixture.closes(), 1);
});

test("rejects writes, multiple statements, missing scope, and unavailable executeScript", async () => {
  const fixture = fixtureSession({ async listTools() { return [executeScriptTool]; } });
  await assert.rejects(queryDms({ schema: "orders", script: "UPDATE suppliers SET active = 1" }, configured, undefined, fixture.connect), /database_query_must_be_read_only/);
  await assert.rejects(queryDms({ schema: "orders", script: "SELECT 1; SELECT 2" }, configured, undefined, fixture.connect), /database_query_must_be_one_statement_without_comments/);
  await assert.rejects(queryDms({ schema: "unknown", script: "SELECT 1" }, configured, undefined, fixture.connect), /dms_database_not_authorized/);

  const unavailable = fixtureSession({ async listTools() { return [readOnlyTool]; } });
  await assert.rejects(queryDms({ schema: "orders", script: "SELECT 1" }, configured, undefined, unavailable.connect), /dms_mcp_execute_script_unavailable/);
  const ambiguous = fixtureSession({ async listTools() { return [executeScriptTool, executeScriptTool]; } });
  await assert.rejects(queryDms({ schema: "orders", script: "SELECT 1" }, configured, undefined, ambiguous.connect), /dms_mcp_execute_script_unavailable/);
  assert.equal(fixture.calls.length, 0);
  assert.equal(unavailable.calls.length, 0);
  assert.equal(ambiguous.calls.length, 0);
});

test("handles MCP errors, unbounded SQL and results, and abort", async () => {
  const failure = fixtureSession({ async listTools() { return [executeScriptTool]; }, async callTool() { return { isError: true, content: [{ type: "text", text: "denied" }] }; } });
  await assert.rejects(queryDms({ schema: "orders", script: "SELECT 1" }, configured, undefined, failure.connect), /dms_mcp_tool_failed/);

  const largeValue = "x".repeat(1_100_000);
  const unbounded = fixtureSession({ async listTools() { return [executeScriptTool]; }, async callTool(name, args, signal) { return { content: [{ type: "text", text: JSON.stringify({ name, args, aborted: signal.aborted, value: largeValue }) }] }; } });
  const result = await queryDms({ schema: "orders", script: `SELECT '${largeValue}'` }, configured, undefined, unbounded.connect);
  assert.ok(result.content[0]!.text.length > 1_100_000);

  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const aborted = fixtureSession({ async listTools(signal) { throw signal.reason; } });
  await assert.rejects(queryDms({ schema: "orders", script: "SELECT 1" }, configured, controller.signal, aborted.connect), /cancelled/);
  assert.equal(aborted.closes(), 1);
});
