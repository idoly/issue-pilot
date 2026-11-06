import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApiFixture, createService } from "./fixture.ts";

test("rejects oversized MCP JSON before dispatch with declared and streamed request sizes", async () => {
  const fixture = await createApiFixture();
  let dispatched = 0;
  fixture.app.addHook("preHandler", async (request) => {
    if (request.url === "/mcp") dispatched++;
  });
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  try {
    // Malformed JSON must be rejected for size before it can reach the parser or protocol handler.
    const declared = await fixture.app.inject({ method: "POST", url: "/mcp", headers: { ...headers, "content-length": String(33 * 1024 * 1024) }, payload: "{" });
    assert.equal(declared.statusCode, 413, declared.body);
    assert.equal(declared.json().error, "payload_too_large");
    const chunk = Buffer.alloc(64 * 1024, "x");
    const streamed = await fixture.app.inject({
      method: "POST",
      url: "/mcp",
      headers,
      payload: Readable.from(
        (function* () {
          yield '{"jsonrpc":"2.0","id":1,"method":"tools/list","padding":"';
          for (let index = 0; index < 33 * 16; index++) yield chunk;
          yield '"}';
        })(),
      ),
    });
    assert.equal(streamed.statusCode, 413, streamed.body);
    assert.equal(streamed.json().error, "payload_too_large");
    assert.equal(dispatched, 0);
    assert.equal(fixture.engine.enqueued.length, 0);
    const retry = await fixture.app.inject({ method: "POST", url: "/mcp", headers, payload: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(dispatched, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("checks the entire MCP attachment budget before decoding and accepts the exact aggregate boundary", async (context) => {
  const fixture = await createApiFixture();
  const client = new Client({ name: "aggregate-attachment-budget", version: "1" });
  try {
    await createService(fixture.app, "MCP Total Budget", ["test"]);
    const address = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`)) as Parameters<Client["connect"]>[0]);
    const part = Buffer.alloc(10 * 1024 * 1024, "x").toString("base64");
    const fields = {
      title: "Attachment total boundary",
      serviceKey: "mcp-total-budget",
      workMode: "test_analysis",
      attachments: [
        { fileName: "first.bin", contentBase64: part },
        { fileName: "second.bin", contentBase64: part },
      ],
    };
    let decodes = 0;
    const from = Buffer.from;
    const decoder = context.mock.method(Buffer, "from", (...args: unknown[]) => {
      if (args[1] === "base64") decodes++;
      return Reflect.apply(from, Buffer, args);
    });
    const oversized = await client.callTool({ name: "issue_create", arguments: { ...fields, attachments: [...fields.attachments, { fileName: "extra.bin", contentBase64: "eA==" }] } });
    decoder.mock.restore();
    assert.equal(oversized.isError, true, JSON.stringify(oversized));
    assert.match(JSON.stringify(oversized), /mcp_attachments_too_large/);
    assert.equal(decodes, 0);
    assert.deepEqual((await fixture.app.inject({ method: "GET", url: "/api/issues" })).json(), []);
    assert.equal(fixture.engine.enqueued.length, 0);

    const accepted = await client.callTool({ name: "issue_create", arguments: fields });
    assert.equal(accepted.isError, undefined, JSON.stringify(accepted));
    const issue = JSON.parse((accepted.content as Array<{ text: string }>)[0]!.text);
    const detail = (await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` })).json();
    assert.deepEqual(
      detail.attachments.map((attachment: { size: number }) => attachment.size),
      [10 * 1024 * 1024, 10 * 1024 * 1024],
    );
    assert.equal(fixture.engine.enqueued.length, 1);
  } finally {
    context.mock.restoreAll();
    await client.close();
    await fixture.cleanup();
  }
});
