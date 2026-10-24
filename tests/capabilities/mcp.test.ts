import assert from "node:assert/strict";
import { test } from "node:test";
import { connectMcp, createMcpFetch, inspectMcp, type McpConfiguration, type McpTool } from "../../src/mcp/client.ts";

const configuration: McpConfiguration = { id: "service-1", name: "Documents", url: "https://mcp.example.test/mcp", transport: "streamable_http", authorization: "Bearer private-token", enabled: true };
const schema = { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false };
const definitions: McpTool[] = [
  { name: "search", inputSchema: schema, annotations: { readOnlyHint: true } },
  { name: "write", inputSchema: schema, annotations: { destructiveHint: true } },
  { name: "unknown", inputSchema: schema },
];

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

test("guarded fetch preserves Request cancellation and RequestInit signal overrides", async () => {
  const original = globalThis.fetch;
  const requests: RequestInit[] = [];
  globalThis.fetch = async (input, init) => {
    assert.ok(input instanceof Request);
    assert.ok(init);
    requests.push(init);
    return new Response("ok");
  };
  try {
    for (const override of [undefined, null, new AbortController().signal]) {
      const lifetime = new AbortController();
      const caller = new AbortController();
      const request = new Request(configuration.url, { signal: caller.signal });
      await createMcpFetch(configuration, lifetime.signal)(request, override === undefined ? undefined : { signal: override });
      const forwarded = requests.at(-1)?.signal;
      assert.ok(forwarded);
      const reason = new Error("caller_cancelled");
      caller.abort(reason);
      assert.equal(forwarded.aborted, override === undefined);
      if (override === undefined) assert.equal(forwarded.reason, reason);
      else {
        lifetime.abort(reason);
        assert.equal(forwarded.aborted, true);
        assert.equal(forwarded.reason, reason);
      }
    }
    const lifetime = new AbortController();
    const caller = new AbortController();
    await createMcpFetch(configuration, lifetime.signal)(new Request(configuration.url), { signal: caller.signal });
    caller.abort();
    assert.equal(requests.at(-1)?.signal?.aborted, true);
  } finally {
    globalThis.fetch = original;
  }
});

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
  await assert.rejects(inspectMcp(configuration, async () => { throw new Error("private-token"); }), { message: "mcp_operation_failed" });
});
