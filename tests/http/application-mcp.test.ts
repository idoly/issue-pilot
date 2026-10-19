import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApiFixture, createIssue, createService } from "./fixture.ts";
import { IssueOutputStore } from "../../src/outputs/store.ts";

const text = (result: unknown): string => JSON.stringify(result);

test("serves application reads over stateless Streamable HTTP without starting an Agent", async () => {
  const f = await createApiFixture();
  const client = new Client({ name: "external-fixture", version: "1" });
  let workbookDownloads = 0;
  f.app.addHook("onRequest", async request => { if (request.url.endsWith("/outputs/result.xlsx")) workbookDownloads++; });
  try {
    await createService(f.app, "MCP App", ["test"]);
    const issue = await createIssue(f.app, "mcp-app", "test", "MCP inspection");
    f.engine.running.clear();
    const before = f.engine.enqueued.length;
    const store = new IssueOutputStore(f.root, String(issue.id));
    await store.write("result.csv", "id,value\n00123,complete\n");
    await store.write("result.xlsx", "synthetic-private-workbook");
    assert.equal((await f.app.inject({ method: "GET", url: `/api/issues/${issue.id}/outputs/result.xlsx` })).statusCode, 200);
    assert.equal(workbookDownloads, 1);
    workbookDownloads = 0;
    const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
    const transport = new StreamableHTTPClientTransport(new URL(`${address}/mcp`));
    await client.connect(transport as Parameters<Client["connect"]>[0]);
    const listed = await client.listTools();
    const endpointResponse = await f.app.inject({ method: "GET", url: "/api/endpoints" });
    assert.equal(endpointResponse.statusCode, 200);
    assert.equal(endpointResponse.headers["cache-control"], "private, no-store");
    const endpoint = JSON.parse(endpointResponse.body).endpoints[0];
    assert.equal(endpoint.path, "/mcp");
    assert.equal(endpoint.transport, "Streamable HTTP");
    assert.equal(endpoint.readOnly, false);
    assert.deepEqual(endpoint.tools, listed.tools);
    assert.doesNotMatch(endpointResponse.body, /authorization|accessKeySecret|credentialUpdate/);
    assert.equal(listed.tools.length, 9);
    assert.ok(listed.tools.filter(tool => tool.name !== "issue_create" && tool.name !== "issue_message").every(tool => tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint === false));
    const creation = listed.tools.find(tool => tool.name === "issue_create")!;
    assert.equal(creation.annotations?.readOnlyHint, false);
    assert.equal(creation.annotations?.idempotentHint, false);
    const message = listed.tools.find(tool => tool.name === "issue_message")!;
    assert.equal(message.annotations?.readOnlyHint, false);
    assert.equal(message.annotations?.idempotentHint, false);
    assert.equal(listed.tools.some((tool) => /delete|retry|send_agent/.test(tool.name)), false);
    const found = await client.callTool({ name: "issues_search", arguments: { query: "MCP inspection", limit: 1 } });
    assert.ok(text(found).includes(String(issue.id)));
    const detail = await client.callTool({ name: "issue_get", arguments: { key: issue.id } });
    assert.ok(text(detail).includes("MCP inspection"));
    assert.equal(text(detail).includes(f.root), false);
    const outputs = await client.callTool({ name: "issue_get", arguments: { key: issue.id } });
    assert.ok(text(outputs).includes("result.csv"));
    const read = await client.callTool({ name: "output_read", arguments: { key: issue.id, fileName: "result.csv", offset: 1, limit: 1 } });
    assert.ok(text(read).includes("00123,complete"));
    const workbook = await client.callTool({ name: "output_read", arguments: { key: issue.id, fileName: "result.xlsx" } });
    assert.equal(workbook.isError, undefined);
    const content = workbook.content as Array<{ type: string; text: string }>;
    assert.deepEqual(JSON.parse(content[0]!.text), { fileName: "result.xlsx", size: Buffer.byteLength("synthetic-private-workbook"), downloadPath: `/api/issues/${issue.id}/outputs/result.xlsx`, binary: true });
    assert.doesNotMatch(text(workbook), /synthetic-private-workbook/);
    assert.equal(workbookDownloads, 0);
    const invalid = await client.callTool({ name: "output_read", arguments: { key: issue.id, fileName: "../issues.db" } });
    assert.equal(invalid.isError, true);
    const unknown = await client.callTool({ name: "issue_create", arguments: {} });
    assert.equal(unknown.isError, true);
    const templates = await client.listResourceTemplates();
    assert.equal(templates.resourceTemplates[0]!.uriTemplate, "issue-pilot://issues/{key}");
    const resources = await client.listResources();
    assert.equal(resources.resources.length, 2);
    const resource = await client.readResource({ uri: `issue-pilot://issues/${issue.id}` });
    assert.ok(text(resource).includes("MCP inspection"));
    const catalog = await client.readResource({ uri: "issue-pilot://catalog/services" });
    assert.ok(text(catalog).includes("MCP App"));
    const people = await client.callTool({ name: "users_list", arguments: {} });
    assert.ok(text(people).includes("currentUser"));
    assert.ok(text(people).includes("subject"));
    const removed = await client.callTool({ name: "service_query", arguments: {} });
    assert.equal(removed.isError, true);
    assert.equal(f.engine.enqueued.length, before);
    assert.equal((await f.app.inject({ method: "GET", url: "/mcp" })).statusCode, 405);
  } finally { await client.close(); await f.cleanup(); }
});

test("MCP rejects an inactive or invalid selected identity before protocol dispatch", async () => {
  const f = await createApiFixture();
  try {
    const response = await f.app.inject({ method: "POST", url: "/mcp", headers: { "x-issue-pilot-subject": "missing", accept: "application/json, text/event-stream" }, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    assert.equal(response.statusCode, 400);
    assert.equal(JSON.parse(response.body).error, "invalid_current_subject");
  } finally { await f.cleanup(); }
});
