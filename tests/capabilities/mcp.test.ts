import assert from "node:assert/strict";
import { test } from "node:test";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { connectMcp, createMcpFetch, inspectMcp, type McpConfiguration, type McpTool } from "../../src/mcp/client.ts";

const configuration: McpConfiguration = { id: "service-1", name: "Documents", url: "https://mcp.example.test/mcp", transport: "streamable_http", authorization: "Bearer private-token", enabled: true };
const schema = { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false };
const definitions: McpTool[] = [
  { name: "search", inputSchema: schema, annotations: { readOnlyHint: true } },
  { name: "write", inputSchema: schema, annotations: { destructiveHint: true } },
  { name: "unknown", inputSchema: schema },
];

for (const outcome of ["success", "failure", "cancelled"] as const)
  test(`MCP inspection reports close failures after ${outcome} without exposing private details`, async (context) => {
    const controller = new AbortController();
    const operation = new Error("private query detail"),
      cleanup = new Error("private connection token");
    context.mock.method(AbortSignal, "timeout", () => controller.signal);
    let closes = 0;
    await assert.rejects(
      inspectMcp(configuration, async () => ({
        async list() {
          if (outcome === "cancelled") controller.abort(operation);
          if (outcome !== "success") throw operation;
          return definitions;
        },
        async close() {
          closes++;
          throw cleanup;
        },
      })),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, outcome === "success" ? "mcp_close_failed" : "mcp_operation_cleanup_failed");
        assert.doesNotMatch(error.message, /private/);
        if (outcome === "success") assert.equal(error.cause, cleanup);
        else {
          assert.ok(error.cause instanceof AggregateError);
          assert.deepEqual(error.cause.errors, [operation, cleanup]);
        }
        return true;
      },
    );
    assert.equal(closes, 1);
    context.mock.restoreAll();
    const retry = await inspectMcp(configuration, async () => ({
      async list() {
        return definitions;
      },
      async close() {},
    }));
    assert.equal(retry.length, definitions.length);
  });

test("MCP startup preserves failed connection and cleanup diagnostics", async (context) => {
  const operation = new Error("private startup token"),
    cleanup = new Error("private transport detail");
  context.mock.method(globalThis, "fetch", async () => {
    throw operation;
  });
  let closes = 0;
  context.mock.method(StreamableHTTPClientTransport.prototype, "close", async () => {
    closes++;
    throw cleanup;
  });
  await assert.rejects(connectMcp(configuration, new AbortController().signal), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "mcp_connection_cleanup_failed");
    assert.ok(error.cause instanceof AggregateError);
    assert.ok(error.cause.errors.includes(cleanup));
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
  assert.equal(closes, 1);
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
      if (method === "GET")
        return new Response(
          new ReadableStream({
            start(controller) {
              stream = controller;
              controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      const request = JSON.parse(String(init?.body));
      let result: unknown;
      if (request.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
      if (request.method === "tools/list") result = { tools: definitions };
      if (request.method === "tools/call") {
        calls += 1;
        result = { content: [{ type: "text", text: "ok" }] };
      }
      if (!result) return new Response(null, { status: 202 });
      const message = { jsonrpc: "2.0", id: request.id, result };
      if (transport === "sse") {
        stream!.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
        return new Response(null, { status: 202 });
      }
      return new Response(JSON.stringify(message), { headers: { "content-type": "application/json" } });
    };
    try {
      const tools = await inspectMcp({ ...configuration, transport });
      assert.deepEqual(tools, [
        { name: "search", readOnly: true },
        { name: "write", readOnly: false },
        { name: "unknown", readOnly: false },
      ]);
      assert.equal(calls, 0);
      assert.ok(methods.includes("POST"));
      if (transport === "sse") assert.ok(methods.includes("GET"));
    } finally {
      globalThis.fetch = original;
    }
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
  globalThis.fetch = async () => {
    throw new Error("private-token");
  };
  try {
    await assert.rejects(connectMcp(configuration, AbortSignal.timeout(100)), { message: "mcp_connection_failed" });
    let posted = false;
    globalThis.fetch = async (_input, init) => {
      if ((init?.method ?? "GET") !== "GET") {
        posted = true;
        throw new Error("cross-origin request attempted");
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("event: endpoint\ndata: https://other.example.test/messages\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    await assert.rejects(connectMcp({ ...configuration, transport: "sse" }, AbortSignal.timeout(200)), /mcp_connection_failed|mcp_timeout_or_aborted/);
    assert.equal(posted, false);
  } finally {
    globalThis.fetch = original;
  }
  await assert.rejects(
    inspectMcp(configuration, async () => {
      throw new Error("private-token");
    }),
    { message: "mcp_operation_failed" },
  );
});
