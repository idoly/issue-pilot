import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApiFixture, createIssue, createService } from "./fixture.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { openDatabase } from "../../src/db/client.ts";
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { subjects, issues, issueAttachments } from "../../src/db/schema.ts";
import { eq } from "drizzle-orm";
import { IssueOutputStore } from "../../src/outputs/store.ts";

const text = (result: unknown): string => JSON.stringify(result);

test("serves application reads over stateless Streamable HTTP without starting an Agent", async () => {
  const f = await createApiFixture();
  const client = new Client({ name: "external-fixture", version: "1" });
  let workbookDownloads = 0;
  f.app.addHook("onRequest", async request => { if (request.url.endsWith("/files/download?path=result.xlsx")) workbookDownloads++; });
  try {
    await createService(f.app, "MCP App", ["test"]);
    const issue = await createIssue(f.app, "mcp-app", "test", "MCP inspection");
    f.engine.running.clear();
    const before = f.engine.enqueued.length;
    const store = new IssueOutputStore(f.root, String(issue.id));
    await store.write("result.csv", "id,value\n00123,complete\n");
    await store.write("result.xlsx", "synthetic-private-workbook");
    assert.equal((await f.app.inject({ method: "GET", url: `/api/issues/${issue.id}/files/download?path=result.xlsx` })).statusCode, 200);
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
    assert.equal(listed.tools.length, 11);
    assert.ok(listed.tools.filter(tool => tool.name !== "issue_create" && tool.name !== "issue_message" && tool.name !== "dingtalk_import").every(tool => tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint === false));
    const creation = listed.tools.find(tool => tool.name === "issue_create")!;
    assert.equal(creation.annotations?.readOnlyHint, false);
    assert.equal(creation.annotations?.idempotentHint, false);
    const dingtalk = listed.tools.find(tool => tool.name === "dingtalk_import")!;
    assert.equal(dingtalk.annotations?.readOnlyHint, false); assert.equal(dingtalk.annotations?.idempotentHint, false);
    const message = listed.tools.find(tool => tool.name === "issue_message")!;
    assert.equal(message.annotations?.readOnlyHint, false);
    assert.equal(message.annotations?.idempotentHint, false);
    assert.equal(listed.tools.some((tool) => /delete|retry|send_agent/.test(tool.name)), false);
    const found = await client.callTool({ name: "issues_search", arguments: { query: "MCP inspection", limit: 1 } });
    assert.ok(text(found).includes(String(issue.id)));
    const detail = await client.callTool({ name: "issue_get", arguments: { key: issue.id } });
    assert.ok(text(detail).includes("MCP inspection"));
    assert.equal(text(detail).includes(f.root), false);
    const outputs = await client.callTool({ name: "work_files", arguments: { key: issue.id } });
    assert.ok(text(outputs).includes("result.csv"));
    const read = await client.callTool({ name: "output_read", arguments: { key: issue.id, fileName: "result.csv", offset: 1, limit: 1 } });
    assert.ok(text(read).includes("00123,complete"));
    const workbook = await client.callTool({ name: "output_read", arguments: { key: issue.id, fileName: "result.xlsx" } });
    assert.equal(workbook.isError, undefined);
    const content = workbook.content as Array<{ type: string; text: string }>;
    assert.deepEqual(JSON.parse(content[0]!.text), { fileName: "result.xlsx", size: Buffer.byteLength("synthetic-private-workbook"), downloadPath: `/api/issues/${issue.id}/files/download?path=result.xlsx`, binary: true });
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

test("MCP creates an Issue with text and binary attachments exceeding the former 1 MiB request limit", async () => {
  const f = await createApiFixture(), client = new Client({ name: "attachment-fixture", version: "1" });
  const database = openDatabase(f.databaseFile);
  try {
    await createService(f.app, "MCP Attachments", ["test"]);
    const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`)) as Parameters<Client["connect"]>[0]);
    const csv = Buffer.from("编号,结果\n00123,完成\n"), binary = Buffer.alloc(1100 * 1024, 0xa5);
    const result = await client.callTool({ name: "issue_create", arguments: { title: "With attachments", serviceKey: "mcp-attachments", workMode: "test_analysis", attachments: [
      { fileName: "结果.csv", mediaType: "text/csv", contentBase64: csv.toString("base64") },
      { fileName: "evidence.xlsx", contentBase64: binary.toString("base64") },
      { fileName: "empty.txt", contentBase64: "" },
    ] } });
    assert.equal(result.isError, undefined, text(result));
    const summary = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    const detail = (await f.app.inject({ method: "GET", url: `/api/issues/${summary.id}` })).json();
    assert.equal(detail.attachments.length, 3);
    assert.equal(f.engine.enqueued.length, 1);
    for (const [name, content] of [["结果.csv", csv], ["evidence.xlsx", binary], ["empty.txt", Buffer.alloc(0)]] as const) {
      const file = detail.attachments.find((file: { fileName: string }) => file.fileName === name);
      assert.ok(file, `missing attachment ${name}`);
      assert.equal(file.size, content.length);
      assert.equal(file.sha256, createHash("sha256").update(content).digest("hex"));
      const downloaded = await f.app.inject({ method: "GET", url: `/api/issues/${summary.id}/attachments/${file.id}` });
      assert.equal(downloaded.statusCode, 200); assert.deepEqual(downloaded.rawPayload, content);
    }
    for (const row of await database.db.select().from(issueAttachments)) {
      assert.equal((await stat(row.objectKey)).mode & 0o777, 0o400);
      assert.equal(row.uploadedBy, issuePilotConfig.bootstrapUser.subject);
    }
    const read = await client.callTool({ name: "attachment_read", arguments: { key: summary.id, attachmentId: detail.attachments[0].id } });
    assert.equal(read.isError, undefined, text(read));
    assert.doesNotMatch(text(result), /contentBase64|temporaryPath/);
  } finally { await client.close(); database.close(); await f.cleanup(); }
});

test("MCP attachment validation rejects invalid input before creating an Issue", async () => {
  const f = await createApiFixture(), client = new Client({ name: "invalid-attachment-fixture", version: "1" }), database = openDatabase(f.databaseFile);
  try {
    await createService(f.app, "MCP Invalid Attachments", ["test"]);
    const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`)) as Parameters<Client["connect"]>[0]);
    for (const attachment of [
      { fileName: "../secret.txt", contentBase64: "YQ==" },
      { fileName: "folder\\secret.txt", contentBase64: "YQ==" },
      { fileName: "bad\r\nname", contentBase64: "YQ==" },
      { fileName: "secret.txt", contentBase64: "YQ==private-invalid" },
      { fileName: "secret.txt", contentBase64: "data:text/plain;base64,YQ==" },
      { fileName: "secret.txt", mediaType: "text/plain\r\nprivate-header", contentBase64: "YQ==" },
    ]) {
      const result = await client.callTool({ name: "issue_create", arguments: { title: "Invalid", serviceKey: "mcp-invalid-attachments", workMode: "test_analysis", attachments: [attachment] } });
      assert.equal(result.isError, true, text(result));
      assert.doesNotMatch(text(result), /private-invalid|private-header/);
    }
    assert.deepEqual(await database.db.select().from(issues), []);
    assert.deepEqual(await database.db.select().from(issueAttachments), []);
    assert.equal(f.engine.enqueued.length, 0);
  } finally { await client.close(); database.close(); await f.cleanup(); }
});

test("MCP attachment failure rolls back files and Issue and permits an explicit retry", async () => {
  const f = await createApiFixture(), client = new Client({ name: "rollback-attachment-fixture", version: "1" }), database = openDatabase(f.databaseFile);
  try {
    await createService(f.app, "MCP Rollback", ["test"]);
    const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`)) as Parameters<Client["connect"]>[0]);
    await database.client.execute("CREATE TRIGGER reject_mcp_attachment BEFORE INSERT ON issue_attachments BEGIN SELECT RAISE(ABORT, 'private-attachment-failure'); END");
    const args = { title: "Rollback", serviceKey: "mcp-rollback", workMode: "test_analysis", attachments: [{ fileName: "evidence.txt", contentBase64: "ZXZpZGVuY2U=" }] };
    const failed = await client.callTool({ name: "issue_create", arguments: args });
    assert.equal(failed.isError, true); assert.doesNotMatch(text(failed), /private-attachment-failure|ZXZpZGVuY2U=/);
    assert.deepEqual(await database.db.select().from(issues), []);
    assert.deepEqual(await database.db.select().from(issueAttachments), []);
    assert.deepEqual(await readdir(path.join(f.root, "workspaces")), []);
    assert.equal(f.engine.enqueued.length, 0);
    await database.client.execute("DROP TRIGGER reject_mcp_attachment");
    const retry = await client.callTool({ name: "issue_create", arguments: args });
    assert.equal(retry.isError, undefined, text(retry));
    assert.equal((await database.db.select().from(issueAttachments)).length, 1);
    assert.equal(f.engine.enqueued.length, 1);
  } finally { await client.close(); database.close(); await f.cleanup(); }
});

test("pins the default MCP identity for internal API dispatch without falling back after deactivation", async () => {
  const f = await createApiFixture(), database = openDatabase(f.databaseFile);
  const client = new Client({ name: "identity-fixture", version: "1" });
  const owner = issuePilotConfig.bootstrapUser.subject;
  let armed = false, forwardedSubject: string | string[] | undefined;
  f.app.addHook("onRequest", async request => {
    if (!armed || request.url !== "/api/me") return;
    armed = false; forwardedSubject = request.headers["x-issue-pilot-subject"];
    await database.db.update(subjects).set({ active: false }).where(eq(subjects.subject, owner));
  });
  try {
    const created = await f.app.inject({ method: "POST", url: "/api/users", headers: { "x-issue-pilot-subject": owner }, payload: { subject: "zz-mcp-next-user", name: "Next", email: "next@example.test", role: "developer", isAdmin: true } });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(JSON.parse((await f.app.inject({ method: "GET", url: "/api/me" })).body).subject, owner);
    const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`)) as Parameters<Client["connect"]>[0]);
    armed = true;
    const result = await client.callTool({ name: "users_list", arguments: {} });
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.match(JSON.stringify(result), /invalid_current_subject/);
    assert.equal(forwardedSubject, owner);
    const next = await f.app.inject({ method: "GET", url: "/api/me" });
    assert.equal(next.statusCode, 200, next.body);
    assert.equal(JSON.parse(next.body).subject, "zz-mcp-next-user");
  } finally { await client.close(); await database.close(); await f.cleanup(); }
});

test("MCP rejects an inactive or invalid selected identity before protocol dispatch", async () => {
  const f = await createApiFixture();
  try {
    const response = await f.app.inject({ method: "POST", url: "/mcp", headers: { "x-issue-pilot-subject": "missing", accept: "application/json, text/event-stream" }, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    assert.equal(response.statusCode, 400);
    assert.equal(JSON.parse(response.body).error, "invalid_current_subject");
  } finally { await f.cleanup(); }
});
