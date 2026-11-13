import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApiFixture, createIssue, createService } from "./fixture.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { openDatabase } from "../../src/db/client.ts";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { issueRoot } from "../../src/workspace/state.ts";
import { subjects, issues, issueAttachments, issueWorkspaces } from "../../src/db/schema.ts";
import { eq } from "drizzle-orm";
import { IssueWorkFileStore } from "../../src/workspace/work-files.ts";

const text = (result: unknown): string => JSON.stringify(result);
// Larger than one MCP response, yet within the read budget, so it must stay readable page by page.
const largeLog = Array.from({ length: 150_000 }, (_, index) => `line ${index} ${"x".repeat(10)}`).join("\n");

test("uses one opaque revision without exposing Workspace diagnostics in MCP projections", async () => {
  const f = await createApiFixture();
  const client = new Client({ name: "revision-fixture", version: "1" });
  const database = openDatabase(f.databaseFile);
  try {
    await createService(f.app, "MCP Revision", ["test"]);
    const issue = await createIssue(f.app, "mcp-revision", "test", "Revision fixture");
    f.engine.running.clear();
    const [row] = await database.db
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.key, String(issue.id)));
    const diagnostic = "synthetic workspace diagnostic";
    const list = async () => (await f.app.inject("/api/issues")).json()[0];
    const before = await list();
    await database.db.update(issueWorkspaces).set({ lastError: diagnostic }).where(eq(issueWorkspaces.issueId, row!.id));
    const summary = await list();
    const detail = (await f.app.inject(`/api/issues/${issue.id}`)).json();
    assert.notEqual(summary.revision, before.revision);
    assert.equal(detail.revision, summary.revision);
    assert.equal(detail.workspace.lastError, diagnostic);
    const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`)) as Parameters<Client["connect"]>[0]);
    for (const result of [await client.callTool({ name: "issue_get", arguments: { key: issue.id } }), await client.callTool({ name: "issues_search", arguments: { query: "Revision fixture" } })]) {
      assert.equal(result.isError, undefined, text(result));
      assert.ok(text(result).includes(String(issue.id)));
      assert.ok(!text(result).includes(diagnostic));
      assert.ok(text(result).includes(summary.revision));
    }
  } finally {
    await client.close();
    database.close();
    await f.cleanup();
  }
});

test("serves application reads over stateless Streamable HTTP without starting an Agent", async () => {
  const f = await createApiFixture();
  const client = new Client({ name: "external-fixture", version: "1" });
  let workbookDownloads = 0;
  f.app.addHook("onRequest", async (request) => {
    if (request.url.endsWith("/files/download?path=result.xlsx")) workbookDownloads++;
  });
  try {
    await createService(f.app, "MCP App", ["test"]);
    const issue = await createIssue(f.app, "mcp-app", "test", "MCP inspection");
    f.engine.running.clear();
    const before = f.engine.enqueued.length;
    const store = new IssueWorkFileStore(f.root, String(issue.id));
    await store.generate("result.csv", async (append) => {
      await append("id,value\n00123,complete\n");
    });
    await store.generate("result.xlsx", async (append) => {
      await append("synthetic-private-workbook");
    });
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
    assert.equal(
      listed.tools.some((tool) => tool.name === "output_read"),
      false,
    );
    assert.ok(listed.tools.some((tool) => tool.name === "work_file_read"));
    assert.equal((await client.callTool({ name: "output_read", arguments: { key: issue.id, fileName: "result.csv" } })).isError, true);
    assert.ok(
      listed.tools
        .filter((tool) => tool.name !== "issue_create" && tool.name !== "issue_message" && tool.name !== "dingtalk_import")
        .every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint === false),
    );
    const creation = listed.tools.find((tool) => tool.name === "issue_create")!;
    assert.equal(creation.annotations?.readOnlyHint, false);
    assert.equal(creation.annotations?.idempotentHint, false);
    const dingtalk = listed.tools.find((tool) => tool.name === "dingtalk_import")!;
    assert.equal(dingtalk.annotations?.readOnlyHint, false);
    assert.equal(dingtalk.annotations?.idempotentHint, false);
    const message = listed.tools.find((tool) => tool.name === "issue_message")!;
    assert.equal(message.annotations?.readOnlyHint, false);
    assert.equal(message.annotations?.idempotentHint, false);
    assert.equal(
      listed.tools.some((tool) => /delete|retry|send_agent/.test(tool.name)),
      false,
    );
    const found = await client.callTool({ name: "issues_search", arguments: { query: "MCP inspection", limit: 1 } });
    assert.ok(text(found).includes(String(issue.id)));
    const detail = await client.callTool({ name: "issue_get", arguments: { key: issue.id } });
    assert.ok(text(detail).includes("MCP inspection"));
    assert.equal(text(detail).includes(f.root), false);
    const files = await client.callTool({ name: "work_files", arguments: { key: issue.id } });
    assert.ok(text(files).includes("result.csv"));
    const read = await client.callTool({ name: "work_file_read", arguments: { key: issue.id, path: "result.csv", offset: 1, limit: 1 } });
    assert.ok(text(read).includes("00123,complete"));
    const workbook = await client.callTool({ name: "work_file_read", arguments: { key: issue.id, path: "result.xlsx" } });
    assert.equal(workbook.isError, undefined);
    const content = workbook.content as Array<{ type: string; text: string }>;
    assert.deepEqual(JSON.parse(content[0]!.text), {
      fileName: "result.xlsx",
      size: Buffer.byteLength("synthetic-private-workbook"),
      downloadPath: `/api/issues/${issue.id}/files/download?path=result.xlsx`,
      binary: true,
    });
    assert.doesNotMatch(text(workbook), /synthetic-private-workbook/);
    assert.equal(workbookDownloads, 0);
    const invalid = await client.callTool({ name: "work_file_read", arguments: { key: issue.id, path: "../issues.db" } });
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
  } finally {
    await client.close();
    await f.cleanup();
  }
});

test("MCP reads listed nested work files while enforcing private-file and traversal checks", async () => {
  const f = await createApiFixture();
  const client = new Client({ name: "nested-file-fixture", version: "1" });
  const outside = await mkdtemp(path.join(tmpdir(), "issue-pilot-mcp-nested-outside-"));
  let detailReads = 0;
  f.app.addHook("onRequest", async (request) => {
    if (/^\/api\/issues\/ISSUE-[0-9-]+$/.test(request.url)) detailReads++;
  });
  try {
    await createService(f.app, "Nested MCP", ["test"]);
    const issue = await createIssue(f.app, "nested-mcp", "test", "Nested working files");
    f.engine.running.clear();
    const root = issueRoot(f.root, String(issue.id));
    const directory = "reports/结果 #1";
    const filePath = `${directory}/result.csv`;
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, filePath), "id,value\n00123,nested\n");
    await writeFile(path.join(root, `${directory}/large.log`), largeLog);
    await writeFile(path.join(root, directory, "result.xlsx"), "private workbook bytes");
    await writeFile(path.join(root, ".session-private.jsonl"), "private session bytes");
    await symlink(path.join(root, ".session-private.jsonl"), path.join(root, directory, "session-alias.csv"));
    await mkdir(path.join(root, ".issue-git"));
    await writeFile(path.join(root, ".issue-git", "private.csv"), "private Git bytes");
    await writeFile(path.join(outside, "secret.csv"), "outside private bytes");
    await symlink(outside, path.join(root, "escape"));
    const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`)) as Parameters<Client["connect"]>[0]);
    detailReads = 0;
    const listing = await client.callTool({ name: "work_files", arguments: { key: issue.id, path: directory } });
    assert.equal(listing.isError, undefined);
    assert.ok(text(listing).includes(filePath));
    const result = await client.callTool({ name: "work_file_read", arguments: { key: issue.id, path: filePath, offset: 1, limit: 1 } });
    assert.equal(result.isError, undefined, text(result));
    const read = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    assert.deepEqual(read.items, ["00123,nested"]);
    assert.equal(read.downloadPath, `/api/issues/${issue.id}/files/download?path=${encodeURIComponent(filePath)}`);
    assert.ok(Buffer.byteLength(largeLog) > issuePilotConfig.limits.mcpServer.responseBytes);
    const largeRead = await client.callTool({ name: "work_file_read", arguments: { key: issue.id, path: `${directory}/large.log`, offset: 1000, limit: 2 } });
    assert.equal(largeRead.isError, undefined, text(largeRead));
    const largePage = JSON.parse((largeRead.content as Array<{ text: string }>)[0]!.text);
    assert.deepEqual(largePage.items, [`line 1000 ${"x".repeat(10)}`, `line 1001 ${"x".repeat(10)}`]);
    assert.equal(largePage.total, 150_000);
    assert.equal(largePage.nextOffset, 1002);
    const binaryPath = `${directory}/result.xlsx`;
    const binary = await client.callTool({ name: "work_file_read", arguments: { key: issue.id, path: binaryPath } });
    assert.equal(binary.isError, undefined, text(binary));
    assert.equal(JSON.parse((binary.content as Array<{ text: string }>)[0]!.text).binary, true);
    assert.doesNotMatch(text(binary), /private workbook bytes/);
    for (const fileName of [
      "../secret.csv",
      "reports/../secret.csv",
      `${directory}/session-alias.csv`,
      ".session-private.jsonl",
      ".issue-git/private.csv",
      "escape/secret.csv",
      `${directory}/missing.csv`,
    ]) {
      const denied = await client.callTool({ name: "work_file_read", arguments: { key: issue.id, path: fileName } });
      assert.equal(denied.isError, true, fileName);
      assert.doesNotMatch(text(denied), /private session bytes|private Git bytes|outside private bytes/);
    }
    assert.equal(detailReads, 0);
  } finally {
    await client.close();
    await f.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test("MCP creates an Issue with text and binary attachments exceeding the former 1 MiB request limit", async () => {
  const f = await createApiFixture(),
    client = new Client({ name: "attachment-fixture", version: "1" });
  const database = openDatabase(f.databaseFile);
  try {
    await createService(f.app, "MCP Attachments", ["test"]);
    const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`)) as Parameters<Client["connect"]>[0]);
    const csv = Buffer.from("编号,结果\n00123,完成\n"),
      binary = Buffer.alloc(1100 * 1024, 0xa5),
      largeText = Buffer.from(largeLog);
    const result = await client.callTool({
      name: "issue_create",
      arguments: {
        title: "With attachments",
        serviceKey: "mcp-attachments",
        workMode: "test_analysis",
        attachments: [
          { fileName: "结果.csv", mediaType: "text/csv", contentBase64: csv.toString("base64") },
          { fileName: "evidence.xlsx", contentBase64: binary.toString("base64") },
          { fileName: "empty.txt", contentBase64: "" },
          { fileName: "large.log", mediaType: "text/plain", contentBase64: largeText.toString("base64") },
        ],
      },
    });
    assert.equal(result.isError, undefined, text(result));
    const summary = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    const detail = (await f.app.inject({ method: "GET", url: `/api/issues/${summary.id}` })).json();
    assert.equal(detail.attachments.length, 4);
    assert.equal(f.engine.enqueued.length, 1);
    for (const [name, content] of [
      ["结果.csv", csv],
      ["evidence.xlsx", binary],
      ["empty.txt", Buffer.alloc(0)],
      ["large.log", largeText],
    ] as const) {
      const file = detail.attachments.find((file: { fileName: string }) => file.fileName === name);
      assert.ok(file, `missing attachment ${name}`);
      assert.equal(file.size, content.length);
      assert.equal(file.sha256, createHash("sha256").update(content).digest("hex"));
      const downloaded = await f.app.inject({ method: "GET", url: `/api/issues/${summary.id}/attachments/${file.id}` });
      assert.equal(downloaded.statusCode, 200);
      assert.deepEqual(downloaded.rawPayload, content);
    }
    for (const row of await database.db.select().from(issueAttachments)) {
      assert.equal((await stat(row.objectKey)).mode & 0o777, 0o400);
      assert.equal(row.uploadedBy, issuePilotConfig.bootstrapUser.subject);
    }
    const read = await client.callTool({ name: "attachment_read", arguments: { key: summary.id, attachmentId: detail.attachments[0].id } });
    assert.equal(read.isError, undefined, text(read));
    const largeAttachment = detail.attachments.find((file: { fileName: string }) => file.fileName === "large.log");
    assert.ok(largeAttachment);
    const largeRead = await client.callTool({ name: "attachment_read", arguments: { key: summary.id, attachmentId: largeAttachment.id, offset: 149_999, limit: 5 } });
    assert.equal(largeRead.isError, undefined, text(largeRead));
    const largePage = JSON.parse((largeRead.content as Array<{ text: string }>)[0]!.text);
    assert.deepEqual(largePage.items, [`line 149999 ${"x".repeat(10)}`]);
    assert.equal(largePage.nextOffset, null);
    assert.doesNotMatch(text(result), /contentBase64|temporaryPath/);
  } finally {
    await client.close();
    database.close();
    await f.cleanup();
  }
});

test("MCP attachment validation rejects invalid input before creating an Issue", async () => {
  const f = await createApiFixture(),
    client = new Client({ name: "invalid-attachment-fixture", version: "1" }),
    database = openDatabase(f.databaseFile);
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
  } finally {
    await client.close();
    database.close();
    await f.cleanup();
  }
});

test("MCP attachment failure rolls back files and Issue and permits an explicit retry", async () => {
  const f = await createApiFixture(),
    client = new Client({ name: "rollback-attachment-fixture", version: "1" }),
    database = openDatabase(f.databaseFile);
  try {
    await createService(f.app, "MCP Rollback", ["test"]);
    const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`)) as Parameters<Client["connect"]>[0]);
    await database.client.execute("CREATE TRIGGER reject_mcp_attachment BEFORE INSERT ON issue_attachments BEGIN SELECT RAISE(ABORT, 'private-attachment-failure'); END");
    const args = { title: "Rollback", serviceKey: "mcp-rollback", workMode: "test_analysis", attachments: [{ fileName: "evidence.txt", contentBase64: "ZXZpZGVuY2U=" }] };
    const failed = await client.callTool({ name: "issue_create", arguments: args });
    assert.equal(failed.isError, true);
    assert.doesNotMatch(text(failed), /private-attachment-failure|ZXZpZGVuY2U=/);
    assert.deepEqual(await database.db.select().from(issues), []);
    assert.deepEqual(await database.db.select().from(issueAttachments), []);
    assert.deepEqual(await readdir(path.join(f.root, "workspaces")), []);
    assert.equal(f.engine.enqueued.length, 0);
    await database.client.execute("DROP TRIGGER reject_mcp_attachment");
    const retry = await client.callTool({ name: "issue_create", arguments: args });
    assert.equal(retry.isError, undefined, text(retry));
    assert.equal((await database.db.select().from(issueAttachments)).length, 1);
    assert.equal(f.engine.enqueued.length, 1);
  } finally {
    await client.close();
    database.close();
    await f.cleanup();
  }
});

test("pins the default MCP identity for internal API dispatch without falling back after deactivation", async () => {
  const f = await createApiFixture(),
    database = openDatabase(f.databaseFile);
  const client = new Client({ name: "identity-fixture", version: "1" });
  const owner = issuePilotConfig.bootstrapUser.subject;
  let armed = false,
    forwardedSubject: string | string[] | undefined;
  f.app.addHook("onRequest", async (request) => {
    if (!armed || request.url !== "/api/me") return;
    armed = false;
    forwardedSubject = request.headers["x-issue-pilot-subject"];
    await database.db.update(subjects).set({ active: false }).where(eq(subjects.subject, owner));
  });
  try {
    const created = await f.app.inject({
      method: "POST",
      url: "/api/users",
      headers: { "x-issue-pilot-subject": owner },
      payload: { subject: "zz-mcp-next-user", name: "Next", email: "next@example.test", role: "developer", isAdmin: true },
    });
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
  } finally {
    await client.close();
    await database.close();
    await f.cleanup();
  }
});

test("MCP rejects an inactive or invalid selected identity before protocol dispatch", async () => {
  const f = await createApiFixture();
  try {
    const response = await f.app.inject({
      method: "POST",
      url: "/mcp",
      headers: { "x-issue-pilot-subject": "missing", accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(JSON.parse(response.body).error, "invalid_current_subject");
  } finally {
    await f.cleanup();
  }
});

test("work_file_read rechecks the budget when a file grows after its listed size was accepted", async () => {
  const f = await createApiFixture();
  const client = new Client({ name: "growing-file-fixture", version: "1" });
  let grow: ((url: string) => Promise<void>) | undefined;
  f.app.addHook("onRequest", async (request) => grow?.(request.url));
  try {
    await createService(f.app, "Growing MCP", ["test"]);
    const issue = await createIssue(f.app, "growing-mcp", "test", "Growing working file");
    f.engine.running.clear();
    const file = path.join(issueRoot(f.root, String(issue.id)), "growing.log");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "small\n");
    const readBytes = issuePilotConfig.limits.mcpServer.readBytes;
    // The listing reports the small size; the file grows (sparse) past the read budget before its download is served.
    grow = async (url) => {
      if (url.startsWith(`/api/issues/${issue.id}/files/download`)) await truncate(file, readBytes + 1);
    };
    const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`)) as Parameters<Client["connect"]>[0]);
    const result = await client.callTool({ name: "work_file_read", arguments: { key: issue.id, path: "growing.log" } });
    assert.equal(result.isError, undefined, text(result));
    const read = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    assert.equal(read.inline, false);
    assert.equal(read.reason, "read_budget_exceeded");
    assert.equal(read.size, readBytes + 1);
    grow = undefined;
    // A file already over the read budget when listed is never downloaded.
    const huge = path.join(issueRoot(f.root, String(issue.id)), "huge.log");
    await writeFile(huge, "");
    await truncate(huge, readBytes + 1);
    const hugeRead = await client.callTool({ name: "work_file_read", arguments: { key: issue.id, path: "huge.log" } });
    assert.equal(JSON.parse((hugeRead.content as Array<{ text: string }>)[0]!.text).reason, "read_budget_exceeded");
  } finally {
    await client.close();
    await f.cleanup();
  }
});

test("rejects MCP attachments above the in-memory budget before decoding them", async () => {
  const f = await createApiFixture(),
    client = new Client({ name: "attachment-budget-fixture", version: "1" });
  try {
    await createService(f.app, "MCP Budget", ["test"]);
    const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`)) as Parameters<Client["connect"]>[0]);
    const oversized = "A".repeat(Math.ceil((issuePilotConfig.limits.mcpServer.attachmentBytes * 4) / 3) + 5);
    const tooLarge = await client.callTool({
      name: "issue_create",
      arguments: { title: "Too large", serviceKey: "mcp-budget", workMode: "test_analysis", attachments: [{ fileName: "huge.bin", contentBase64: oversized }] },
    });
    assert.equal(tooLarge.isError, true);
    assert.match(text(tooLarge), /mcp_attachment_too_large/);
    const tooMany = await client.callTool({
      name: "issue_create",
      arguments: {
        title: "Too many",
        serviceKey: "mcp-budget",
        workMode: "test_analysis",
        attachments: Array.from({ length: issuePilotConfig.limits.mcpServer.attachments + 1 }, (_, index) => ({ fileName: `file-${index}.txt`, contentBase64: "" })),
      },
    });
    assert.equal(tooMany.isError, true);
    assert.equal(f.engine.enqueued.length, 0);
  } finally {
    await client.close();
    await f.cleanup();
  }
});
