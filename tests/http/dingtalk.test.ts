import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import { stringify } from "yaml";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { dingtalkIssueImports, issues, mcpServices, subjects } from "../../src/db/schema.ts";
import type { McpConfiguration, McpConnector } from "../../src/mcp/client.ts";
import type { DingtalkRecord } from "../../src/mcp/dingtalk-contracts.ts";
import { createApiFixture, createService } from "./fixture.ts";

const recordUrl = "https://alidocs.dingtalk.com/notable/record?dentryUuid=base&sheetId=table&rowId=one&viewId=ignored&token=fixture-private";
const fields = [["title", "工单标题"], ["description", "工单描述"], ["owner", "开发人员（归档字段）"], ["status", "状态（归档字段）"], ["module", "对应模块"], ["number", "序号"], ["attachments", "附件"]].map(([fieldId, fieldName]) => ({ fieldId, fieldName, type: "text" }));
async function fixture() {
  const state = { row: { recordId: "one", cells: { title: "Task", description: "Description", owner: "Other Person", status: { name: "待处理" }, module: "Orders", number: "EXT-one" } } as DingtalkRecord, fields, calls: [] as Array<{ name: string; input: Record<string, unknown> }>, configurations: [] as McpConfiguration[], closed: 0, failConnection: false, beforeRecords: undefined as ((signal: AbortSignal) => Promise<void>) | undefined };
  const connector: McpConnector = async (configuration, signal) => {
    state.configurations.push(configuration);
    if (state.failConnection) throw new Error("fixture-private-connection");
    return { list: async () => [], close: async () => { state.closed++; }, call: async (name, input) => {
      state.calls.push({ name, input });
      assert.ok(["get_tables", "query_records"].includes(name));
      if (name === "get_tables") return { structuredContent: { status: "success", data: { tables: [{ tableId: "table", fields: state.fields }] } } };
      await state.beforeRecords?.(signal);
      return { structuredContent: { status: "success", data: { records: (input.recordIds as string[]).includes(state.row.recordId) ? [structuredClone(state.row)] : [], nextCursor: "" } } };
    } };
  };
  const f = await createApiFixture({ dingtalkConnector: connector }), database = await openApplicationDatabase(f.databaseFile);
  const user = (await f.app.inject({ method: "GET", url: "/api/me" })).json();
  await database.db.insert(mcpServices).values({ name: "dingtalk", transport: "streamable_http", url: "https://gateway.example.test/mcp?key=fixture-shared", authorization: "fixture-shared-header", enabled: true });
  const service = await createService(f.app, "Orders", ["prod", "dev"]);
  const payload = { url: recordUrl, serviceKey: service.key, workMode: "production_analysis", priority: "p2", startAgent: false };
  const submit = (overrides = {}, headers = { "x-issue-pilot-subject": user.subject }) => f.app.inject({ method: "POST", url: "/api/dingtalk/import", headers, payload: { ...payload, ...overrides } });
  return { ...f, state, database, user, payload, submit, async cleanup() { database.close(); await f.cleanup(); } };
}

test("direct record import skips preview, ignores personnel and uses only the requested record", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject({ method: "POST", url: "/api/dingtalk/preview", payload: {} })).statusCode, 404);
    const result = await f.submit(); assert.equal(result.statusCode, 200, result.body); assert.equal(result.json().status, "created");
    assert.equal(f.state.calls.filter(call => call.name === "query_records").length, 1);
    assert.deepEqual(f.state.calls.find(call => call.name === "query_records")!.input.recordIds, ["one"]);
    const [issue] = await f.database.db.select().from(issues);
    assert.equal(issue!.title, "EXT-one"); assert.equal(issue!.assigneeSubject, f.user.subject);
    assert.doesNotMatch(issue!.description, /viewId|fixture-private/);
    assert.equal(f.engine.enqueued.length, 0); assert.equal(f.state.closed, 1);
  } finally { await f.cleanup(); }
});

test("MCP dingtalk_import dispatches the same single-record workflow and duplicate result", async () => {
  const f = await fixture(), client = new Client({ name: "dingtalk-import-fixture", version: "1" });
  try {
    f.state.row.cells.status = { name: "开发中" }; f.state.row.cells.owner = "Other Person";
    const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${address}/mcp`), { requestInit: { headers: { "X-Issue-Pilot-Subject": f.user.subject } } }) as Parameters<Client["connect"]>[0]);
    const { startAgent: _start, priority: _priority, ...args } = f.payload;
    for (const status of ["created", "existing"]) {
      const response = await client.callTool({ name: "dingtalk_import", arguments: args });
      assert.equal(response.isError, undefined, JSON.stringify(response));
      const result = JSON.parse((response.content as Array<{ text: string }>)[0]!.text);
      assert.equal(result.status, status); assert.equal(result.user.subject, f.user.subject);
    }
    assert.equal((await f.database.db.select().from(issues)).length, 1);
    assert.equal(f.engine.enqueued.length, 0);
    const invalid = await client.callTool({ name: "dingtalk_import", arguments: { ...args, url: "https://alidocs.dingtalk.com/i/nodes/base?sheetId=table" } });
    assert.equal(invalid.isError, true);
    assert.match(JSON.stringify(invalid), /invalid_dingtalk_record_url/);
  } finally { await client.close(); await f.cleanup(); }
});

test("concurrent and repeated record imports return the existing Issue without replaying Agent startup", async () => {
  const f = await fixture();
  try {
    const results = await Promise.all([f.submit({ startAgent: true }), f.submit({ startAgent: true })]);
    for (const result of results) assert.equal(result.statusCode, 200, result.body);
    assert.deepEqual(results.map(result => result.json().status).sort(), ["created", "existing"]);
    assert.equal((await f.database.db.select().from(issues)).length, 1);
    assert.equal((await f.database.db.select().from(dingtalkIssueImports)).length, 1);
    const calls = f.state.calls.length;
    const repeated = await f.submit(); assert.equal(repeated.json().status, "existing"); assert.equal(f.state.calls.length, calls);
    assert.equal(f.engine.enqueued.length, 1);
  } finally { await f.cleanup(); }
});

test("table links and client field mappings are rejected; all personnel and statuses can import", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.submit({ url: "https://alidocs.dingtalk.com/i/nodes/base?sheetId=table" })).json().error, "invalid_dingtalk_record_url");
    assert.equal((await f.submit({ columns: { title: "title" } })).json().error, "invalid_dingtalk_import");
    f.state.row.cells.status = { name: "开发中" };
    assert.equal((await f.submit()).json().status, "created");
    assert.equal((await f.submit({ url: recordUrl.replace("rowId=one", "rowId=missing") })).json().error, "dingtalk_record_not_found");
    assert.equal((await f.database.db.select().from(issues)).length, 1);
  } finally { await f.cleanup(); }
});

test("field mappings come from shared and personal user.yaml configuration and support exact names and IDs", async () => {
  const f = await fixture();
  try {
    f.state.fields = [...fields, { fieldId: "custom-title", fieldName: "自定义标题", type: "text" }, { fieldId: "runtime-status", fieldName: "研发任务状态", type: "text" }];
    f.state.row.cells["custom-title"] = "Configured title"; f.state.row.cells["runtime-status"] = { value: ["A待安排"] };
    await writeFile(path.join(f.root, "user.yaml"), stringify({ version: 2, shared: { dingtalk: { fields: { title: "自定义标题", attachments: "" } } }, users: { [f.user.subject]: { dingtalk: { fields: { number: "" } } } } }), { mode: 0o600 });
    const response = await f.submit(); assert.equal(response.statusCode, 200, response.body);
    assert.equal((await f.database.db.select().from(issues))[0]!.title, "Configured title");
    const query = f.state.calls.find(call => call.name === "query_records")!;
    assert.ok((query.input.fieldIds as string[]).includes("custom-title")); assert.ok(!(query.input.fieldIds as string[]).includes("runtime-status"));
  } finally { await f.cleanup(); }
});

test("existing manual Issues are detected by exact title or external number", async () => {
  const f = await fixture();
  try {
    const existing = await f.app.inject({ method: "POST", url: "/api/issues", payload: { title: "EXT-one", serviceKey: f.payload.serviceKey, workMode: "production_analysis", priority: "p2", description: "Manual", assigneeSubject: f.user.subject, ccSubjects: [] } });
    assert.equal(existing.statusCode, 201, existing.body);
    const response = await f.submit(); assert.equal(response.json().status, "existing"); assert.equal(response.json().issueKey, existing.json().id);
    assert.equal((await f.database.db.select().from(issues)).length, 1);
  } finally { await f.cleanup(); }
});

test("record attachments are downloaded and saved atomically; failure leaves an explicit retry possible", async t => {
  const f = await fixture();
  const download = t.mock.method(globalThis, "fetch", async () => new Response("bad", { status: 403 }));
  try {
    f.state.row.cells.attachments = [{ resourceId: "resource", filename: "evidence.txt", size: 4, url: "https://alidocs2.oss-cn-zhangjiakou.aliyuncs.com/file?signature=fixture-private" }];
    const failed = await f.submit(); assert.equal(failed.statusCode, 502, failed.body); assert.equal(failed.json().error, "dingtalk_attachment_download_failed");
    assert.deepEqual(await f.database.db.select().from(issues), []);
    download.mock.mockImplementation(async () => new Response("data"));
    const response = await f.submit(); assert.equal(response.statusCode, 200, response.body);
    const key = response.json().issueKey, detail = (await f.app.inject({ method: "GET", url: `/api/issues/${key}` })).json();
    assert.equal(detail.attachments.length, 1);
    const file = await f.app.inject({ method: "GET", url: `/api/issues/${key}/attachments/${detail.attachments[0].id}` });
    assert.equal(file.body, "data"); assert.doesNotMatch(response.body, /fixture-private|aliyuncs/);
  } finally { download.mock.restore(); await f.cleanup(); }
});

test("source binding failure rolls back Issue and files and permits retry", async () => {
  const f = await fixture();
  try {
    await f.database.client.execute("CREATE TRIGGER fail_dingtalk_import BEFORE INSERT ON dingtalk_issue_imports BEGIN SELECT RAISE(ABORT, 'fixture-private-failure'); END");
    const failed = await f.submit(); assert.equal(failed.statusCode, 500); assert.doesNotMatch(failed.body, /fixture-private-failure/);
    assert.deepEqual(await f.database.db.select().from(issues), []); assert.deepEqual(await readdir(path.join(f.root, "issues")), []);
    await f.database.client.execute("DROP TRIGGER fail_dingtalk_import");
    assert.equal((await f.submit()).json().status, "created");
  } finally { await f.cleanup(); }
});

test("DingTalk reauthorizes work mode after the remote read", async () => {
  const f = await fixture(); let entered!: () => void, release!: () => void;
  try {
    const waiting = new Promise<void>(resolve => { entered = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
    f.state.beforeRecords = async () => { entered(); await resume; };
    const pending = f.submit({ workMode: "production_data" }).then(value => value);
    await waiting; await f.database.db.update(subjects).set({ role: "product" }).where(eq(subjects.subject, f.user.subject)); release();
    const response = await pending; assert.equal(response.statusCode, 403, response.body); assert.equal(response.json().error, "developer_role_required");
    assert.deepEqual(await f.database.db.select().from(issues), []);
  } finally { release?.(); await f.cleanup(); }
});

test("old table source defaults are omitted and personal connection failure never falls back", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, "user.yaml"), stringify({ version: 2, shared: { dingtalk: { apiKey: "fixture-shared" } }, users: { [f.user.subject]: { dingtalk: { apiKey: "fixture-personal", source: { mcp: "dingtalk", url: "https://alidocs.dingtalk.com/i/nodes/base?sheetId=table", assignee: "Ignored" } } } } }), { mode: 0o600 });
    const source = await f.app.inject({ method: "GET", url: "/api/dingtalk/source" });
    assert.equal(source.json().url, ""); assert.equal(source.json().connection.kind, "personal"); assert.doesNotMatch(source.body, /fixture-personal|fixture-shared/);
    f.state.failConnection = true;
    const response = await f.submit(); assert.equal(response.json().error, "dingtalk_connection_failed"); assert.equal(f.state.configurations.length, 1);
    assert.equal(new URL(f.state.configurations[0]!.url).searchParams.get("key"), "fixture-personal");
  } finally { await f.cleanup(); }
});

test("cancelling a record import closes the MCP session", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
    f.state.beforeRecords = signal => new Promise<void>((_resolve, reject) => { entered(); signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
    const address = await f.app.listen({ host: "127.0.0.1", port: 0 }), controller = new AbortController();
    const response = fetch(address + "/api/dingtalk/import", { method: "POST", headers: { "content-type": "application/json", "x-issue-pilot-subject": f.user.subject }, body: JSON.stringify(f.payload), signal: controller.signal });
    await waiting; controller.abort(); await assert.rejects(response, error => error instanceof Error && error.name === "AbortError");
    await f.stop(); assert.equal(f.state.closed, 1); assert.deepEqual(await f.database.db.select().from(issues), []);
  } finally { await f.cleanup(); }
});
