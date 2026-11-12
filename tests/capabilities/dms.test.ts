import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { claimIssueRoot } from "../../src/workspace/state.ts";
import { IssueWorkFileStore } from "../../src/workspace/work-files.ts";
import { test } from "node:test";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

import { DmsQueryRound, DmsOperationError, connectDmsMcp, queryDms, resolveDmsScope, type ConnectDmsMcp, type DmsMcpSession } from "../../src/capabilities/dms.ts";

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
      return { content: [{ type: "text", text: '[{"id":1}]' }] };
    },
    async close() {
      closes += 1;
    },
    ...overrides,
  };
  const connections: Array<{ url: string; authorization: string; signal: AbortSignal }> = [];
  const connect: ConnectDmsMcp = async (configuration, signal) => {
    connections.push({ url: configuration.url, authorization: configuration.authorization, signal });
    return session;
  };
  return { calls, closes: () => closes, connect, connections };
}

test("persists complete DMS results to a work file and returns an export summary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-dms-export-"));
  await claimIssueRoot(root, "ISSUE-20261016-004");
  const store = new IssueWorkFileStore(root, "ISSUE-20261016-004");
  const session = fixtureSession({
    async listTools() {
      return [executeScriptTool];
    },
  });
  try {
    const result = await queryDms({ schema: "orders", script: "SELECT 1", export: { fileName: "batch-001.json" } }, configured, undefined, session.connect, store);
    const reply = JSON.stringify(result);
    assert.ok(reply.includes("batch-001.json"));
    assert.equal(reply.includes('\\"id\\"'), false);
    const summary = JSON.parse(result.content[0]!.text);
    assert.deepEqual(summary.export, {
      fileName: "batch-001.json",
      size: (await stat(path.join(store.directory, "batch-001.json"))).size,
      format: "dms-mcp-json",
      downloadPath: store.downloadPath("batch-001.json"),
    });
    assert.equal("output" in summary, false);
    const saved = JSON.parse((await readFile(path.join(store.directory, "batch-001.json"))).toString("utf8"));
    assert.deepEqual(saved.result.content, [{ type: "text", text: '[{"id":1}]' }]);
    assert.equal(saved.tool, "executeScript");
    assert.equal(session.closes(), 1);
    assert.equal(JSON.stringify(saved).includes(configured.authorization), false);
    await assert.rejects(queryDms({ schema: "orders", script: "SELECT 1", export: { fileName: "x.json" } }, configured, undefined, session.connect), /issue_work_files_not_available/);
    const failure = fixtureSession({
      async listTools() {
        return [executeScriptTool];
      },
      async callTool() {
        return { isError: true };
      },
    });
    await assert.rejects(queryDms({ schema: "orders", script: "SELECT 1", export: { fileName: "batch-001.json" } }, configured, undefined, failure.connect, store), /dms_mcp_tool_failed/);
    assert.deepEqual(JSON.parse((await readFile(path.join(store.directory, "batch-001.json"))).toString("utf8")), saved);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves an earlier DMS output when closing the protocol session fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-dms-close-"));
  await claimIssueRoot(root, "ISSUE-20261018-996");
  const store = new IssueWorkFileStore(root, "ISSUE-20261018-996");
  let closes = 0;
  const fixture = fixtureSession({
    async listTools() {
      return [executeScriptTool];
    },
    async close() {
      closes++;
      throw new Error("dms_close_failed");
    },
  });
  try {
    await store.generate("result.json", async (append) => {
      await append('{"previous":true}');
    });
    await assert.rejects(queryDms({ schema: "orders", script: "SELECT 1", export: { fileName: "result.json" } }, configured, undefined, fixture.connect, store), /dms_mcp_operation_failed/);
    assert.equal((await readFile(path.join(store.directory, "result.json"))).toString(), '{"previous":true}');
    assert.equal(closes, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const output of [false, true])
  for (const phase of ["discovery", "query", "close", "discovery-and-close", "query-and-close"] as const)
    test(`retains DMS ${phase} failures during ${output ? "export" : "query"}`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-dms-errors-"));
      await claimIssueRoot(root, "ISSUE-20261020-991");
      const store = new IssueWorkFileStore(root, "ISSUE-20261020-991");
      const primary = new Error("dms_mcp_tool_failed"),
        cleanup = new Error("private fixture cleanup detail");
      let closes = 0,
        queries = 0;
      const fixture = fixtureSession({
        async listTools() {
          if (phase.startsWith("discovery")) throw primary;
          return [executeScriptTool];
        },
        async callTool() {
          queries++;
          if (phase.startsWith("query")) throw primary;
          return { content: [] };
        },
        async close() {
          closes++;
          if (phase.includes("close")) throw cleanup;
        },
      });
      try {
        await store.generate("result.json", async (append) => {
          await append("old-delivery");
        });
        await assert.rejects(queryDms({ schema: "orders", script: "SELECT 1", ...(output ? { export: { fileName: "result.json" } } : {}) }, configured, undefined, fixture.connect, store), (error) => {
          assert(error instanceof DmsOperationError);
          const original = error.cause;
          assert.equal(error.diagnostics.phase, phase.startsWith("discovery") ? "discovery" : phase.startsWith("query") ? "execute" : "close");
          assert.equal(error.diagnostics.sqlDispatchAttempted, !phase.startsWith("discovery"));
          if (phase.endsWith("-and-close")) {
            assert(original instanceof AggregateError);
            assert.equal(original.message, primary.message);
            assert.deepEqual(original.errors, [primary, cleanup]);
          } else assert.equal(original, phase === "close" ? cleanup : primary);
          assert.doesNotMatch(error.message, /private fixture/);
          return true;
        });
        assert.equal(closes, 1);
        assert.equal(queries, phase.startsWith("discovery") ? 0 : 1);
        assert.equal((await readFile(path.join(store.directory, "result.json"))).toString(), "old-delivery");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

for (const output of [false, true])
  for (const cancellation of ["caller", "deadline"] as const)
    test(`retains DMS ${cancellation} cancellation when ${output ? "export" : "query"} and close fail`, async (context) => {
      const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-dms-cancel-close-"));
      await claimIssueRoot(root, "ISSUE-20261020-992");
      const store = new IssueWorkFileStore(root, "ISSUE-20261020-992");
      const controller = new AbortController(),
        reason = cancellation === "caller" ? new Error("caller_cancelled") : new DOMException("query expired", "TimeoutError"),
        cleanup = new Error("private fixture cleanup detail");
      if (cancellation === "deadline") context.mock.method(AbortSignal, "timeout", () => controller.signal);
      let closes = 0;
      const fixture = fixtureSession({
        async listTools() {
          return [executeScriptTool];
        },
        async callTool() {
          controller.abort(reason);
          throw reason;
        },
        async close() {
          closes++;
          throw cleanup;
        },
      });
      try {
        await store.generate("result.json", async (append) => {
          await append("old-delivery");
        });
        await assert.rejects(
          queryDms(
            { schema: "orders", script: "SELECT 1", ...(output ? { export: { fileName: "result.json" } } : {}) },
            configured,
            cancellation === "caller" ? controller.signal : undefined,
            fixture.connect,
            store,
          ),
          (error) => {
            let original = error;
            if (cancellation === "deadline") {
              assert.ok(error instanceof DmsOperationError);
              assert.equal(error.message, "dms_mcp_timeout");
              assert.equal(error.diagnostics.phase, "execute");
              assert.equal(error.diagnostics.sqlDispatchAttempted, true);
              assert.ok(error.cause instanceof Error);
              assert.equal(error.cause.message, "dms_mcp_timeout");
              original = error.cause.cause;
            }
            assert.ok(original instanceof AggregateError);
            assert.deepEqual(original.errors, [reason, cleanup]);
            return true;
          },
        );
        assert.equal(closes, 1);
        assert.equal((await readFile(path.join(store.directory, "result.json"))).toString(), "old-delivery");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

for (const phase of ["single", "double", "cancel"] as const)
  test(`retains DMS scope resolution ${phase} failure during cleanup`, async () => {
    const controller = new AbortController(),
      primary = new Error("dms_mcp_scope_resolve_failed"),
      cleanup = new Error("private fixture cleanup detail");
    let closes = 0;
    const fixture = fixtureSession({
      async listTools() {
        if (phase === "cancel") controller.abort(primary);
        throw primary;
      },
      async close() {
        closes++;
        if (phase !== "single") throw cleanup;
      },
    });
    await assert.rejects(resolveDmsScope(configured, "ORDERS-PROD", "orders", controller.signal, fixture.connect), (error) => {
      if (phase !== "single") {
        assert(error instanceof AggregateError);
        assert.equal(error.message, primary.message);
        assert.deepEqual(error.errors, [primary, cleanup]);
      } else assert.equal(error, primary);
      return true;
    });
    assert.equal(closes, 1);
  });

for (const outcome of ["initialize_failure", "rate_limited", "connected"] as const)
  test(`DMS transport cleanup is awaited once after ${outcome}`, async (context) => {
    const operation = new Error("private startup payload"),
      cleanup = new Error("private cleanup token");
    const encoder = new TextEncoder();
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let gets = 0,
      closes = 0;
    context.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        gets++;
        if (outcome === "rate_limited") return new Response(null, { status: 429, headers: { "retry-after": "0" } });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const request = JSON.parse(String(init?.body));
      if (request.method === "initialize") {
        if (outcome === "initialize_failure") throw operation;
        stream!.enqueue(
          encoder.encode(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } })}\n\n`,
          ),
        );
      }
      return new Response(null, { status: 202 });
    });
    const originalClose = SSEClientTransport.prototype.close;
    context.mock.method(SSEClientTransport.prototype, "close", async function (this: SSEClientTransport) {
      closes++;
      await originalClose.call(this);
      throw cleanup;
    });
    if (outcome === "connected") {
      const session = await connectDmsMcp(configured, AbortSignal.timeout(5_000));
      await assert.rejects(session.close(), (error) => error === cleanup);
      await assert.rejects(session.close(), (error) => error === cleanup);
    } else {
      await assert.rejects(connectDmsMcp(configured, AbortSignal.timeout(5_000)), (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "dms_mcp_connection_cleanup_failed");
        assert.ok(error.cause instanceof AggregateError);
        assert.equal(error.cause.errors.length, 2);
        assert.equal(error.cause.errors[1], cleanup);
        if (outcome === "initialize_failure") assert.equal(error.cause.errors[0], operation);
        assert.doesNotMatch(error.message, /private/);
        const publicError = new DmsOperationError({ phase: "connect", elapsedMs: 0, phaseElapsedMs: {}, sqlDispatchAttempted: false }, error);
        assert.equal(publicError.message, "dms_mcp_connection_cleanup_failed");
        return true;
      });
    }
    assert.equal(gets, 1, "failed cleanup must prevent a new connection attempt");
    assert.equal(closes, 1, "SDK and owner share the same transport cleanup result");
  });

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
      const content =
        request.params?.name === "getDatabase"
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
    assert.equal(
      requestSignals.every((signal) => !signal.aborted),
      true,
      "successful handshake must cancel its timeout without aborting the SSE session",
    );
    assert.deepEqual(
      (await session.listTools(AbortSignal.timeout(5_000))).map(({ name }) => name),
      ["query_database", "listInstances", "searchDatabase", "getDatabase"],
    );
    assert.deepEqual(await session.callTool("query_database", { sql: "SELECT 1" }, AbortSignal.timeout(5_000)), { content: [{ type: "text", text: "ok" }] });
    await session.close();
    assert.deepEqual(await resolveDmsScope(configured, "ORDERS-PROD", "orders"), { instanceId: "456", instanceHost: "db.example.test", instancePort: "3306", databaseId: "123" });
    assert.deepEqual(toolCalls.at(-1), { name: "getDatabase", arguments: { host: "db.example.test", port: "3306", schema_name: "orders", sid: null } });
    assert.equal(requests.filter(({ method }) => method === "GET").length, 2);
    assert.equal(
      requests.every(({ method }) => method === "GET" || method === "POST"),
      true,
    );
    assert.equal(
      requests.every(({ authorization }) => authorization === configured.authorization),
      true,
    );
    assert.equal(
      requests.every(({ redirect }) => redirect === "error"),
      true,
    );
    assert.equal(
      requests.every(({ url }) => new URL(url).origin === "https://dms.example.test"),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects DMS tool discovery that exceeds the shared tool budget", async () => {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const send = (message: unknown) => stream!.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`));
  const tools = Array.from({ length: issuePilotConfig.limits.capability.mcp.tools + 1 }, (_, index) => ({ name: `tool_${index}`, inputSchema: { type: "object" } }));
  globalThis.fetch = async (input, init) => {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method === "GET") {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          controller.enqueue(encoder.encode("event: endpoint\ndata: /messages?session=budget\n\n"));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const request = JSON.parse(String(init?.body)) as { id?: number; method: string };
    if (request.method === "initialize") {
      send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
    } else if (request.method === "tools/list") {
      send({ jsonrpc: "2.0", id: request.id, result: { tools } });
    }
    return new Response(null, { status: 202 });
  };
  try {
    const session = await connectDmsMcp(configured, AbortSignal.timeout(5_000), 1_000);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await assert.rejects(session.listTools(AbortSignal.timeout(5_000)), { message: "dms_mcp_too_many_tools" });
    await session.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not start a DMS connection for an already cancelled operation", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(null, { status: 403 });
  };
  try {
    const reason = new Error("cancelled_before_connect");
    await assert.rejects(connectDmsMcp(configured, AbortSignal.abort(reason)), (error) => error === reason);
    await assert.rejects(connectDmsMcp(configured, AbortSignal.abort(new DOMException("expired", "TimeoutError"))), { message: "dms_mcp_timeout" });
    await assert.rejects(connectDmsMcp(configured, AbortSignal.abort("private-cancellation-detail")), { message: "dms_mcp_aborted" });
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reports an MCP SSE handshake timeout separately from connection failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
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
      if (gets === 1)
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
        });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            controller.enqueue(encoder.encode("event: endpoint\ndata: /messages?session=retry\n\n"));
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    posts += 1;
    const request = JSON.parse(String(init?.body)) as { id: number; method: string };
    if (request.method === "initialize")
      stream!.enqueue(
        encoder.encode(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } })}\n\n`,
        ),
      );
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

for (const status of [401, 403, 404, 503])
  test(`preserves HTTP ${status} without retrying or exposing the error body`, async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0,
      cancellations = 0;
    globalThis.fetch = async () => {
      requests++;
      return new Response(
        new ReadableStream({
          cancel() {
            cancellations++;
          },
        }),
        { status },
      );
    };
    try {
      await assert.rejects(connectDmsMcp(configured, AbortSignal.timeout(1_000), 20), { message: `dms_mcp_http_${status}` });
      assert.equal(requests, 1);
      assert.equal(cancellations, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

for (const retryAfter of ["120", new Date(Date.now() + 3_600_000).toUTCString()])
  test(`does not retry earlier than a long Retry-After (${retryAfter})`, async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      return new Response("private upstream detail", { status: 429, headers: { "retry-after": retryAfter } });
    };
    try {
      await assert.rejects(connectDmsMcp(configured, AbortSignal.timeout(1_000)), { message: "dms_mcp_http_429" });
      assert.equal(requests, 1);
      await assert.rejects(queryDms({ schema: "orders", script: "SELECT 1" }, configured), (error) => {
        assert(error instanceof DmsOperationError);
        assert.equal(error.message, "dms_mcp_http_429");
        assert.equal(error.diagnostics.phase, "connect");
        assert.equal(error.diagnostics.sqlDispatchAttempted, false);
        assert.ok(error.diagnostics.retryAfterSeconds! >= (retryAfter === "120" ? 120 : 3500));
        assert.ok(error.diagnostics.phaseElapsedMs.connect! >= 0);
        return true;
      });
      assert.equal(requests, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

for (const retryAfter of ["not-a-date", "-1", "99999999999999999999999999"])
  test(`omits an invalid Retry-After without adding retries (${retryAfter})`, { timeout: 5_000 }, async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      return new Response("private upstream detail", { status: 429, headers: { "retry-after": retryAfter } });
    };
    try {
      await assert.rejects(queryDms({ schema: "orders", script: "SELECT 1" }, configured), (error) => {
        assert(error instanceof DmsOperationError);
        assert.equal(error.message, "dms_mcp_http_429");
        assert.equal(error.diagnostics.phase, "connect");
        assert.equal(error.diagnostics.retryAfterSeconds, undefined);
        assert.equal(error.diagnostics.sqlDispatchAttempted, false);
        return true;
      });
      assert.equal(requests, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

for (const failurePhase of ["SSE", "initialize", "discovery", "query"] as const)
  test(failurePhase === "query"
    ? "does not replay SQL after an executeScript HTTP 429"
    : failurePhase === "discovery"
      ? "reports HTTP 429 during tool discovery without retrying or executing SQL"
      : `retries a transient ${failurePhase} HTTP 429 before executing SQL exactly once`, { timeout: 5_000 }, async () => {
    const originalFetch = globalThis.fetch,
      encoder = new TextEncoder();
    let gets = 0,
      initializes = 0,
      queries = 0,
      failed = false;
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const send = (value: unknown) => stream.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(value)}\n\n`));
    const limited = () => {
      failed = true;
      return new Response("private upstream detail", { status: 429, headers: { "retry-after": "0" } });
    };
    globalThis.fetch = async (input, init) => {
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (method === "GET") {
        gets++;
        if (failurePhase === "SSE" && !failed) return limited();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              controller.enqueue(encoder.encode("event: endpoint\ndata: /messages?session=limited\n\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const request = JSON.parse(String(init?.body)) as { id: number; method: string; params?: { name: string } };
      if (request.method === "initialize") {
        initializes++;
        if (failurePhase === "initialize" && !failed) return limited();
        send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
      } else if (request.method === "tools/list") {
        if (failurePhase === "discovery") return limited();
        send({ jsonrpc: "2.0", id: request.id, result: { tools: [executeScriptTool] } });
      } else if (request.method === "tools/call") {
        queries++;
        assert.equal(request.params?.name, "executeScript");
        if (failurePhase === "query") return limited();
        send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "[]" }] } });
      }
      return new Response(null, { status: 202 });
    };
    try {
      const query = queryDms({ schema: "orders", script: "SELECT 1" }, configured, AbortSignal.timeout(4_000));
      if (failurePhase === "query" || failurePhase === "discovery")
        await assert.rejects(query, (error) => {
          assert(error instanceof DmsOperationError);
          assert.equal(error.message, "dms_mcp_http_429");
          assert.equal(error.diagnostics.phase, failurePhase === "query" ? "execute" : "discovery");
          assert.equal(error.diagnostics.sqlDispatchAttempted, failurePhase === "query");
          assert.equal(error.diagnostics.retryAfterSeconds, 0);
          assert.equal(queries, failurePhase === "query" ? 1 : 0);
          return true;
        });
      else await query;
      assert.equal(gets, failurePhase === "query" || failurePhase === "discovery" ? 1 : 2);
      assert.equal(initializes, failurePhase === "initialize" ? 2 : 1);
      assert.equal(queries, failurePhase === "discovery" ? 0 : 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

test("stops repeated rate limits after two handshakes", { timeout: 5_000 }, async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response("private upstream detail", { status: 429, headers: { "retry-after": "0" } });
  };
  try {
    await assert.rejects(connectDmsMcp(configured, AbortSignal.timeout(4_000)), (error) => error instanceof Error && error.message === "dms_mcp_http_429" && error.cause === undefined);
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("honors cancellation during rate-limit backoff", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(null, { status: 429, headers: { "retry-after": "1" } });
  };
  try {
    await assert.rejects(connectDmsMcp(configured, AbortSignal.timeout(30)), { message: "dms_mcp_timeout" });
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preserves a caller cancellation while waiting to retry without Retry-After", async () => {
  const originalFetch = globalThis.fetch,
    controller = new AbortController(),
    reason = new Error("caller_cancelled");
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(null, { status: 429 });
  };
  const timer = setTimeout(() => controller.abort(reason), 30);
  try {
    await assert.rejects(connectDmsMcp(configured, controller.signal), (error) => error === reason);
    assert.equal(requests, 1);
  } finally {
    clearTimeout(timer);
    globalThis.fetch = originalFetch;
  }
});

for (const phase of ["discovery", "execute"] as const)
  test(`measures a ${phase} timeout without repeating SQL`, async () => {
    let queries = 0;
    const timeout = new Error("dms_mcp_timeout");
    const fixture = fixtureSession({
      async listTools() {
        if (phase === "discovery") throw timeout;
        return [executeScriptTool];
      },
      async callTool() {
        queries++;
        throw timeout;
      },
    });
    await assert.rejects(queryDms({ schema: "orders", script: "SELECT 1" }, configured, undefined, fixture.connect), (error) => {
      assert(error instanceof DmsOperationError);
      assert.equal(error.message, "dms_mcp_timeout");
      assert.equal(error.cause, timeout);
      assert.equal(error.diagnostics.phase, phase);
      assert.equal(error.diagnostics.sqlDispatchAttempted, phase === "execute");
      assert.ok(error.diagnostics.phaseElapsedMs[phase]! >= 0);
      assert.ok(error.diagnostics.phaseElapsedMs.close! >= 0);
      return true;
    });
    assert.equal(queries, phase === "execute" ? 1 : 0);
    assert.equal(fixture.closes(), 1);
  });

test("distinguishes export failure from SQL failure and preserves the previous work file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-dms-export-"));
  await claimIssueRoot(root, "ISSUE-20261021-997");
  const store = new IssueWorkFileStore(root, "ISSUE-20261021-997");
  const fixture = fixtureSession({
    async listTools() {
      return [executeScriptTool];
    },
  });
  try {
    await store.generate("result.json", async (append) => {
      await append("previous-delivery");
    });
    store.generate = async () => {
      throw new Error("private filesystem detail");
    };
    await assert.rejects(queryDms({ schema: "orders", script: "SELECT 1", export: { fileName: "result.json" } }, configured, undefined, fixture.connect, store), (error) => {
      assert(error instanceof DmsOperationError);
      assert.equal(error.message, "dms_mcp_operation_failed");
      assert.equal(error.diagnostics.phase, "export");
      assert.equal(error.diagnostics.sqlDispatchAttempted, true);
      assert.doesNotMatch(JSON.stringify(error.diagnostics), /private/);
      return true;
    });
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.closes(), 1);
    assert.equal((await readFile(path.join(store.directory, "result.json"))).toString(), "previous-delivery");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an export destination conflict preserves evidence and closes DMS after one SQL dispatch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-dms-export-conflict-"));
  await claimIssueRoot(root, "ISSUE-20261021-996");
  const store = new IssueWorkFileStore(root, "ISSUE-20261021-996");
  const fixture = fixtureSession({
    async listTools() {
      return [executeScriptTool];
    },
  });
  try {
    await store.generate("previous.json", async (append) => {
      await append("previous working content");
    });
    const destination = path.join(store.directory, "result.json");
    await mkdir(destination);
    await writeFile(path.join(destination, "evidence.txt"), "preserve unknown directory");
    await assert.rejects(queryDms({ schema: "orders", script: "SELECT 1", export: { fileName: "result.json" } }, configured, undefined, fixture.connect, store), (error) => {
      assert(error instanceof DmsOperationError);
      assert.equal(error.message, "dms_mcp_operation_failed");
      assert.equal(error.diagnostics.phase, "export");
      assert.equal(error.diagnostics.sqlDispatchAttempted, true);
      assert.ok(error.diagnostics.phaseElapsedMs.export! >= 0);
      assert.ok(error.diagnostics.phaseElapsedMs.close! >= 0);
      assert.doesNotMatch(JSON.stringify(error.diagnostics), /evidence|result\.json|issue-pilot-dms/);
      return true;
    });
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.closes(), 1);
    assert.equal(await readFile(path.join(destination, "evidence.txt"), "utf8"), "preserve unknown directory");
    assert.equal((await readFile(path.join(store.directory, "previous.json"))).toString(), "previous working content");
    assert.deepEqual((await readdir(store.directory)).sort(), ["previous.json", "result.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves an alias/schema file target before dispatching SQL and validates SQL before discovery", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const fixture = fixtureSession({
    async listTools() {
      return [listInstancesTool, getDatabaseTool, executeScriptTool];
    },
    async callTool(name, args) {
      calls.push({ name, args });
      const result =
        name === "listInstances"
          ? { InstanceAlias: "ORDERS-PROD", InstanceId: "456", Host: "db.example.test", Port: 3306, InstanceType: "mysql", EnvType: "prod" }
          : name === "getDatabase"
            ? { DatabaseId: "123", InstanceId: "456", SchemaName: "orders" }
            : undefined;
      return { content: result ? [{ type: "text", text: JSON.stringify(result) }] : [] };
    },
  });
  const unresolved = { ...configured, databases: [{ instanceAlias: "ORDERS-PROD", schemaName: "orders", instanceId: "", instanceHost: "", instancePort: "", databaseId: "" }] };
  await assert.rejects(queryDms({ schema: "orders", script: "DELETE FROM orders" }, unresolved, undefined, fixture.connect), /database_query_must_be_read_only/);
  assert.equal(fixture.connections.length, 0);
  await queryDms({ schema: "orders", script: "SELECT 1" }, unresolved, undefined, fixture.connect);
  assert.deepEqual(
    calls.map((call) => call.name),
    ["listInstances", "getDatabase", "executeScript"],
  );
  assert.equal(calls[2]!.args.database_id, "123");
  assert.equal(fixture.closes(), 2);
  await queryDms({ schema: "orders", script: "SELECT 1" }, unresolved, undefined, fixture.connect);
  assert.equal(calls.filter((call) => call.name === "listInstances").length, 1);
  assert.equal(fixture.closes(), 3);
  unresolved.authorization = "Bearer changed-fixture-identity";
  await queryDms({ schema: "orders", script: "SELECT 1" }, unresolved, undefined, fixture.connect);
  assert.equal(calls.filter((call) => call.name === "listInstances").length, 2);
  assert.equal(fixture.closes(), 5);
});

test("calls only MCP executeScript and binds it to the configured deployment database", async () => {
  const fixture = fixtureSession({
    async listTools() {
      return [readOnlyTool, executeScriptTool];
    },
  });
  const result = await queryDms({ schema: "orders", script: "SELECT COUNT(*) FROM suppliers;", logic: false }, configured, undefined, fixture.connect);

  assert.deepEqual(fixture.calls, [{ name: "executeScript", args: { database_id: "123", script: "SELECT COUNT(*) FROM suppliers", logic: false }, aborted: false }]);
  assert.deepEqual(result.details, { provider: "aliyun-dms-mcp", tool: "executeScript" });
  assert.equal(JSON.parse(result.content[0]!.text).result.content[0].text, '[{"id":1}]');
  assert.doesNotMatch(JSON.stringify(result), /fixture-token/);
  assert.equal(fixture.closes(), 1);
});

test("returns requested business login tokens without including DMS connection authorization", async () => {
  const rows = [{ token: "business-login-token", Authorization: "Bearer business-login-token", createdAt: "2026-10-23T03:00:00Z" }];
  const fixture = fixtureSession({
    async listTools() {
      return [executeScriptTool];
    },
    async callTool() {
      return { content: [{ type: "text", text: JSON.stringify(rows) }] };
    },
  });
  const result = await queryDms({ schema: "orders", script: "SELECT token, Authorization, createdAt FROM login_sessions ORDER BY createdAt DESC LIMIT 1" }, configured, undefined, fixture.connect);
  assert.deepEqual(JSON.parse(JSON.parse(result.content[0]!.text).result.content[0].text), rows);
  assert.doesNotMatch(JSON.stringify(result), /fixture-token/);
  assert.equal(fixture.closes(), 1);
});

test("rejects writes, multiple statements, missing scope, and unavailable executeScript", async () => {
  const fixture = fixtureSession({
    async listTools() {
      return [executeScriptTool];
    },
  });
  await assert.rejects(queryDms({ schema: "orders", script: "UPDATE suppliers SET active = 1" }, configured, undefined, fixture.connect), /database_query_must_be_read_only/);
  await assert.rejects(queryDms({ schema: "orders", script: "SELECT 1; SELECT 2" }, configured, undefined, fixture.connect), /database_query_must_be_one_statement_without_comments/);
  await assert.rejects(queryDms({ schema: "unknown", script: "SELECT 1" }, configured, undefined, fixture.connect), /dms_database_not_authorized/);
  assert.equal(fixture.connections.length, 0, "invalid queries must not consume a DMS handshake");

  const unavailable = fixtureSession({
    async listTools() {
      return [readOnlyTool];
    },
  });
  await assert.rejects(queryDms({ schema: "orders", script: "SELECT 1" }, configured, undefined, unavailable.connect), /dms_mcp_execute_script_unavailable/);
  const ambiguous = fixtureSession({
    async listTools() {
      return [executeScriptTool, executeScriptTool];
    },
  });
  await assert.rejects(queryDms({ schema: "orders", script: "SELECT 1" }, configured, undefined, ambiguous.connect), /dms_mcp_execute_script_unavailable/);
  assert.equal(fixture.calls.length, 0);
  assert.equal(unavailable.calls.length, 0);
  assert.equal(ambiguous.calls.length, 0);
});

test("handles MCP errors, unbounded SQL and results, and abort", async () => {
  const failure = fixtureSession({
    async listTools() {
      return [executeScriptTool];
    },
    async callTool() {
      return { isError: true, content: [{ type: "text", text: "denied" }] };
    },
  });
  await assert.rejects(queryDms({ schema: "orders", script: "SELECT 1" }, configured, undefined, failure.connect), /dms_mcp_tool_failed/);

  const largeValue = "x".repeat(1_100_000);
  const unbounded = fixtureSession({
    async listTools() {
      return [executeScriptTool];
    },
    async callTool(name, args, signal) {
      return { content: [{ type: "text", text: JSON.stringify({ name, args, aborted: signal.aborted, value: largeValue }) }] };
    },
  });
  // SQL without LIMIT is allowed, but an inline result over the capability budget must be exported instead.
  await assert.rejects(queryDms({ schema: "orders", script: "SELECT value FROM large_values" }, configured, undefined, unbounded.connect), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "dms_mcp_result_too_large_use_export");
    assert.equal(error.message.includes(largeValue), false);
    return true;
  });
  assert.equal(unbounded.closes(), 1);
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-dms-large-"));
  try {
    await claimIssueRoot(root, "ISSUE-20261016-005");
    const store = new IssueWorkFileStore(root, "ISSUE-20261016-005");
    const exported = await queryDms({ schema: "orders", script: "SELECT value FROM large_values", export: { fileName: "large.json" } }, configured, undefined, unbounded.connect, store);
    assert.equal(JSON.parse(exported.content[0]!.text).export.fileName, "large.json");
    assert.ok((await stat(path.join(store.directory, "large.json"))).size > 1_100_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const aborted = fixtureSession({
    async listTools(signal) {
      throw signal.reason;
    },
  });
  await assert.rejects(queryDms({ schema: "orders", script: "SELECT 1" }, configured, controller.signal, aborted.connect), /cancelled/);
  assert.equal(aborted.closes(), 1);
});

test("DMS round reuses connection/discovery and does not inherit a completed query's cancellation", async () => {
  let connects = 0,
    discoveries = 0,
    calls = 0,
    closes = 0;
  const transportSignals: AbortSignal[] = [];
  const round = new DmsQueryRound(async (_config, signal) => {
    connects++;
    transportSignals.push(signal);
    return {
      listTools: async () => {
        discoveries++;
        return [executeScriptTool];
      },
      callTool: async (_name, _args, requestSignal) => {
        requestSignal.throwIfAborted();
        calls++;
        return { content: [{ type: "text", text: "[]" }] };
      },
      close: async () => {
        closes++;
      },
    };
  });
  const first = new AbortController();
  try {
    await round.query({ schema: "orders", script: "SELECT 1" }, configured, first.signal);
    first.abort(new Error("completed request expired"));
    assert.equal(transportSignals[0]!.aborted, false);
    await round.query({ schema: "orders", script: "SELECT 2" }, configured);
    assert.deepEqual({ connects, discoveries, calls, closes }, { connects: 1, discoveries: 1, calls: 2, closes: 0 });
    await round.query({ schema: "orders", script: "SELECT 3" }, { ...configured, authorization: "Bearer another-identity" });
    assert.equal(connects, 2);
  } finally {
    await round.close();
  }
  assert.equal(closes, 2);
  await assert.rejects(round.query({ schema: "orders", script: "SELECT 4" }, configured));
  assert.equal(calls, 3);
  await round.close();
  assert.equal(closes, 2);
});

test("DMS round never replays a failed SQL dispatch and serializes calls", async () => {
  let calls = 0,
    connects = 0,
    active = 0,
    maximum = 0,
    closes = 0;
  const round = new DmsQueryRound(async () => {
    connects++;
    return {
      listTools: async () => [executeScriptTool],
      callTool: async () => {
        calls++;
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        if (calls === 1) throw new Error("uncertain_remote_result");
        return { content: [{ type: "text", text: "[]" }] };
      },
      close: async () => {
        closes++;
      },
    };
  });
  try {
    await assert.rejects(round.query({ schema: "orders", script: "SELECT 1" }, configured));
    assert.equal(calls, 1);
    await Promise.all([round.query({ schema: "orders", script: "SELECT 2" }, configured), round.query({ schema: "orders", script: "SELECT 3" }, configured)]);
    assert.deepEqual({ connects, calls, maximum, closes }, { connects: 2, calls: 3, maximum: 1, closes: 1 });
  } finally {
    await round.close();
  }
});

test("DMS round returns completed evidence before separately reporting close failure", async () => {
  const round = new DmsQueryRound(async () => ({
    listTools: async () => [executeScriptTool],
    callTool: async () => ({ content: [{ type: "text", text: "completed evidence" }] }),
    close: async () => {
      throw new Error("fixture_close_failure");
    },
  }));
  const result = await round.query({ schema: "orders", script: "SELECT 1" }, configured);
  assert.match(JSON.stringify(result), /completed evidence/);
  await assert.rejects(round.close(), /dms_mcp_connection_cleanup_failed/);
});

for (const phase of ["connect", "execute"] as const)
  test(`DMS round close cancels ${phase} and never dispatches queued work`, async () => {
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let calls = 0,
      connects = 0,
      closes = 0;
    const waitForAbort = async (signal: AbortSignal) => {
      enter();
      if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      throw signal.reason;
    };
    const round = new DmsQueryRound(async (_config, signal) => {
      connects++;
      if (phase === "connect") await waitForAbort(signal);
      return {
        listTools: async () => [executeScriptTool],
        callTool: async (_name, _args, requestSignal) => {
          calls++;
          return waitForAbort(requestSignal);
        },
        close: async () => {
          closes++;
        },
      };
    });
    const first = assert.rejects(round.query({ schema: "orders", script: "SELECT 1" }, configured));
    await entered;
    const queued = assert.rejects(round.query({ schema: "orders", script: "SELECT 2" }, configured));
    await round.close();
    await Promise.all([first, queued]);
    assert.equal(connects, 1);
    assert.equal(calls, phase === "execute" ? 1 : 0);
    assert.equal(closes, phase === "execute" ? 1 : 0);
  });

test("DMS round retains a committed export when round disposal fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-dms-round-export-"));
  await claimIssueRoot(root, "ISSUE-20261016-004");
  const store = new IssueWorkFileStore(root, "ISSUE-20261016-004");
  let calls = 0;
  const round = new DmsQueryRound(async () => ({
    listTools: async () => [executeScriptTool],
    callTool: async () => {
      calls++;
      return { content: [{ type: "text", text: "completed evidence" }] };
    },
    close: async () => {
      throw new Error("fixture_close_failure");
    },
  }));
  try {
    const result = await round.query({ schema: "orders", script: "SELECT 1", export: { fileName: "evidence.json" } }, configured, undefined, store);
    assert.equal(JSON.parse(result.content[0]!.text).export.fileName, "evidence.json");
    await assert.rejects(round.close(), /dms_mcp_connection_cleanup_failed/);
    assert.match(await readFile(path.join(store.directory, "evidence.json"), "utf8"), /completed evidence/);
    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DMS round retains timeout phase and dispatch diagnostics", async (t) => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => deadline.signal);
  const round = new DmsQueryRound(async () => ({
    listTools: async () => [executeScriptTool],
    callTool: async () => {
      deadline.abort(new DOMException("fixture timeout", "TimeoutError"));
      throw deadline.signal.reason;
    },
    close: async () => {},
  }));
  try {
    await assert.rejects(round.query({ schema: "orders", script: "SELECT 1" }, configured), (error) => {
      assert.ok(error instanceof DmsOperationError);
      assert.equal(error.message, "dms_mcp_timeout");
      assert.equal(error.diagnostics.phase, "execute");
      assert.equal(error.diagnostics.sqlDispatchAttempted, true);
      return true;
    });
  } finally {
    await round.close();
  }
});
