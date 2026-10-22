import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { stringify } from "yaml";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { dingtalkIssueImports, issues, mcpServices, subjects } from "../../src/db/schema.ts";
import type { McpConfiguration, McpConnector } from "../../src/mcp/client.ts";
import type { DingtalkPreviewResponse, DingtalkRecord } from "../../src/mcp/dingtalk-contracts.ts";
import { createApiFixture, createService } from "./fixture.ts";

const url = "https://alidocs.dingtalk.com/i/nodes/base?entrance=data&sheetId=table&token=fixture-share-secret";
const fields = [ ["title", "工单标题"], ["description", "工单描述"], ["assignee", "参与人"], ["status", "研发任务状态"], ["module", "对应模块"], ["number", "序号"] ].map(([fieldId, fieldName]) => ({ fieldId, fieldName, type: "text" }));
async function fixture() {
  const state = { rows: [] as DingtalkRecord[], configurations: [] as McpConfiguration[], calls: [] as Array<{ name: string; input: Record<string, unknown> }>, closed: 0, failure: false, badCursor: false, beforeRecords: undefined as ((signal: AbortSignal) => Promise<void>) | undefined };
  const connector: McpConnector = async (configuration, signal) => {
    state.configurations.push(configuration);
    if (state.failure) throw new Error("transport fixture-private-credential");
    return {
      list: async () => [], close: async () => { state.closed++; },
      async call(name, input) {
        state.calls.push({ name, input });
        assert.ok(["get_tables", "query_records"].includes(name), "only known read operations may execute");
        if (name === "get_tables") return { structuredContent: { status: "success", data: { tables: [{ tableId: "table", fields }] } } };
        await state.beforeRecords?.(signal);
        const sourceRows = state.rows;
        const ids = input.recordIds as string[] | undefined, offset = input.cursor ? Number(String(input.cursor).replace("offset-", "")) || 0 : 0;
        const rows = ids ? sourceRows.filter(row => ids.includes(row.recordId)) : sourceRows.slice(offset, offset + Number(input.limit));
        const next = state.badCursor ? "offset-0" : !ids && offset + rows.length < sourceRows.length ? `offset-${offset + rows.length}` : "";
        return { structuredContent: { status: "success", data: { records: structuredClone(rows), nextCursor: next } } };
      },
    };
  };
  const value = await createApiFixture({ dingtalkConnector: connector }), database = await openApplicationDatabase(value.databaseFile);
  const actor = (await value.app.inject({ method: "GET", url: "/api/me" })).json();
  await database.db.insert(mcpServices).values({ name: "dingtalk", transport: "streamable_http", url: "https://gateway.example.test/mcp?key=fixture-shared-key", authorization: "fixture-shared-header", enabled: true });
  const service = await createService(value.app, "Orders", ["prod", "dev"]);
  const row = (id: string, assignee: string): DingtalkRecord => ({ recordId: id, cells: { title: `Order ${id}`, description: { text: `Description ${id}`, authorization: "fixture-never-project" }, assignee: { refFieldType: "text", value: [`负责人：${assignee}（研发）`] }, status: { value: ["A待安排"] }, module: "Orders", number: `EXT-${id}` } });
  state.rows = [row("one", actor.name), row("other", "Other Person"), row("similar", actor.name + "Extra"), row("two", actor.name)];
  const preview = async (input: Record<string, unknown> = {}) => {
    const response = await value.app.inject({ method: "POST", url: "/api/dingtalk/preview", headers: { "x-issue-pilot-subject": actor.subject }, payload: { url, ...input } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<DingtalkPreviewResponse>();
  };
  const payload = (response: DingtalkPreviewResponse) => ({ url, columns: response.columns, records: response.records.map(row => ({ recordId: row.recordId, token: row.token })), serviceKey: service.key, workMode: "production_analysis", priority: "p2", startAgent: false });
  return { ...value, state, database, actor, preview, payload, async cleanup() { database.close(); await value.cleanup(); } };
}

test("DingTalk preview uses computed display fields, selects the current person and creates only on request", async () => {
  const f = await fixture();
  try {
    const preview = await f.preview({ url: "https://alidocs.dingtalk.com/i/nodes/base?iframeQuery=entrance%3Ddata%26sheetId%3Dtable" });
    assert.deepEqual(preview.records.map(row => row.recordId), ["one", "two"]);
    assert.deepEqual(preview.statusOptions, ["A待安排"]);
    assert.equal(preview.records[0]!.title, "EXT-one Order one");
    assert.equal(preview.records[0]!.description, "Description one");
    assert.doesNotMatch(JSON.stringify(preview), /fixture-shared-key|fixture-shared-header|fixture-never-project|fixture-share-secret/);
    assert.deepEqual(await f.database.db.select().from(issues), []);
    assert.equal(f.engine.enqueued.length, 0);
    const payload = f.payload(preview);
    const results = await Promise.all([f.app.inject({ method: "POST", url: "/api/dingtalk/import", payload }), f.app.inject({ method: "POST", url: "/api/dingtalk/import", payload })]);
    for (const response of results) assert.equal(response.statusCode, 200, response.body);
    assert.equal(results.flatMap(result => result.json().results).filter(result => result.status === "created").length, 2);
    assert.equal((await f.database.db.select().from(issues)).length, 2);
    assert.equal((await f.database.db.select().from(dingtalkIssueImports)).length, 2);
    assert.equal(f.engine.enqueued.length, 0);
    for (const issue of await f.database.db.select().from(issues)) { assert.equal(issue.assigneeSubject, f.actor.subject); assert.equal(issue.reporterSubject, f.actor.subject); assert.doesNotMatch(issue.description, /fixture-share-secret|viewId=/); }
    assert.ok(f.state.calls.some(call => call.name === "query_records" && Array.isArray(call.input.recordIds)));
    assert.equal(f.state.closed, f.state.configurations.length);
    const remaining = await f.preview();
    assert.equal(remaining.records.length, 0);
    assert.equal(remaining.skippedImported, 2);
  } finally { await f.cleanup(); }
});

test("DingTalk filters existing manual Issues by exact external number or full title", async () => {
  const f = await fixture();
  try {
    const payload = f.payload(await f.preview());
    const existing = await f.app.inject({ method: "POST", url: "/api/issues", payload: { ...payload, title: "EXT-one", description: "Existing manual Issue", assigneeSubject: f.actor.subject, ccSubjects: [] } });
    assert.equal(existing.statusCode, 201, existing.body);
    const preview = await f.preview();
    assert.equal(preview.skippedImported, 1);
    assert.ok(preview.records.every(row => row.recordId !== "one"));
    payload.records = payload.records.filter(row => row.recordId === "one");
    const imported = await f.app.inject({ method: "POST", url: "/api/dingtalk/import", payload });
    assert.equal(imported.statusCode, 200, imported.body);
    assert.equal(imported.json().results[0].status, "existing");
    assert.equal(imported.json().results[0].issueKey, existing.json().id);
    assert.equal((await f.database.db.select().from(issues)).length, 1);
  } finally { await f.cleanup(); }
});

test("DingTalk ignores view IDs and displays only the current user's pending table records", async () => {
  const f = await fixture();
  try {
    const viewUrl = url + "&iframeQuery=viewId%3Dview";
    f.state.rows[3]!.cells.status = { value: ["D已完成"] };
    const response = await f.preview({ url: viewUrl });
    assert.deepEqual(response.records.map(row => row.recordId), ["one"]);
    const calls = f.state.calls.filter(call => call.name === "query_records");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.input.filters, { operator: "and", operands: [{ operator: "eq", operands: ["status", "A待安排"] }] });
    assert.equal(calls[0]!.input.sort, undefined);
    const payload = { ...f.payload(response), url: viewUrl };
    f.state.rows[0]!.cells.status = { value: ["D已完成"] };
    const stale = await f.app.inject({ method: "POST", url: "/api/dingtalk/import", payload });
    assert.equal(stale.statusCode, 200, stale.body);
    assert.equal(stale.json().results[0].status, "stale");
    assert.equal((await f.database.db.select().from(issues)).length, 0);
    assert.ok(f.state.calls.every(call => call.name !== "get_views"));
  } finally { await f.cleanup(); }
});

test("DingTalk filters only the exact A待安排 status", async () => {
  const f = await fixture();
  try {
    const template = f.state.rows[0]!;
    f.state.rows = ["待处理", "待安排", "A待安排", "D已完成", "X挂起", "Y无需处理"].map((status, index) => ({ recordId: `status-${index}`, cells: { ...structuredClone(template.cells), status: { value: [status] } } }));
    const preview = await f.preview();
    assert.deepEqual(preview.records.map(row => row.recordId), ["status-2"]);
  } finally { await f.cleanup(); }
});

test("DingTalk preview batches dense matches without dropping records across continuation pages", async () => {
  const f = await fixture();
  try {
    const template = f.state.rows[0]!;
    f.state.rows = Array.from({ length: 240 }, (_, index) => ({ recordId: `record-${index}`, cells: structuredClone(template.cells) }));
    const first = await f.preview();
    assert.equal(first.records.length, 100);
    assert.equal(f.state.calls.filter(call => call.name === "query_records").length, 1);
    const second = await f.preview({ columns: first.columns, cursor: first.cursor });
    const third = await f.preview({ columns: second.columns, cursor: second.cursor });
    const ids = [...first.records, ...second.records, ...third.records].map(row => row.recordId);
    assert.deepEqual(ids, f.state.rows.map(row => row.recordId));
    assert.equal(new Set(ids).size, 240);
    assert.equal(third.cursor, "");
    assert.equal(f.state.calls.filter(call => call.name === "query_records").length, 3);
  } finally { await f.cleanup(); }
});

test("a page without matching users keeps its cursor and finds pending records on later pages", async () => {
  const f = await fixture();
  try {
    const own = f.state.rows[0]!, other = f.state.rows[1]!;
    f.state.rows = Array.from({ length: 101 }, (_, index) => ({ recordId: `row-${index}`, cells: structuredClone((index === 100 ? own : other).cells) }));
    const first = await f.preview();
    assert.deepEqual(first.records, []); assert.equal(first.scanned, 100); assert.ok(first.cursor);
    assert.equal(f.state.calls.filter(call => call.name === "query_records").length, 1);
    const second = await f.preview({ columns: first.columns, cursor: first.cursor });
    assert.deepEqual(second.records.map(row => row.recordId), ["row-100"]);
    assert.equal(second.cursor, "");
    assert.equal(f.state.calls.filter(call => call.name === "query_records").length, 2);
  } finally { await f.cleanup(); }
});

test("DingTalk requires person and status columns before reading records", async () => {
  const f = await fixture();
  try {
    const preview = await f.preview({ columns: { assignee: "", status: "" }, statusFilter: "non-matching legacy input" });
    assert.deepEqual(preview.records, []);
    assert.equal(preview.needsMapping, true);
    assert.equal(f.state.calls.filter(call => call.name === "query_records").length, 0);
  } finally { await f.cleanup(); }
});

test("DingTalk verifies fresh records and actor-bound preview tokens, rejecting changed, forged and repeated-cursor results", async () => {
  const f = await fixture();
  try {
    const preview = await f.preview(), payload = f.payload(preview);
    f.state.rows[0]!.cells.title = "Changed after preview";
    payload.records = payload.records.slice(0, 2);
    payload.records[1]!.token = "0".repeat(64);
    const stale = await f.app.inject({ method: "POST", url: "/api/dingtalk/import", payload });
    assert.equal(stale.statusCode, 200, stale.body);
    assert.ok(stale.json().results.every((result: { status: string }) => result.status === "stale"));
    assert.equal((await f.database.db.select().from(issues)).length, 0);
    await f.database.db.insert(subjects).values({ subject: "bob", displayName: "Bob", role: "developer" });
    f.state.rows[0]!.cells.assignee = { value: [f.actor.name, "Bob"] };
    const actorPreview = await f.preview();
    const wrongActor = await f.app.inject({ method: "POST", url: "/api/dingtalk/import", headers: { "x-issue-pilot-subject": "bob" }, payload: { ...f.payload(actorPreview), records: [{ recordId: "one", token: actorPreview.records[0]!.token }] } });
    assert.equal(wrongActor.statusCode, 200, wrongActor.body);
    assert.equal(wrongActor.json().results[0].status, "stale");
    f.state.badCursor = true;
    const firstPage = await f.app.inject({ method: "POST", url: "/api/dingtalk/preview", payload: { url } });
    const invalid = await f.app.inject({ method: "POST", url: "/api/dingtalk/preview", payload: { url, cursor: firstPage.json().cursor } });
    assert.equal(invalid.statusCode, 409, invalid.body);
    assert.equal(invalid.json().error, "dingtalk_snapshot_changed");
    assert.equal((await f.database.db.select().from(issues)).length, 0);
  } finally { await f.cleanup(); }
});

test("DingTalk source claims roll back with Issue/filesystem failures and an explicit retry enqueues only once", async () => {
  const f = await fixture();
  try {
    const payload = f.payload(await f.preview()); payload.records = [payload.records[0]!]; payload.startAgent = true;
    await f.database.client.execute("CREATE TRIGGER fail_dingtalk_import BEFORE INSERT ON dingtalk_issue_imports BEGIN SELECT RAISE(ABORT, 'fixture-import-failure'); END");
    const failed = await f.app.inject({ method: "POST", url: "/api/dingtalk/import", payload });
    assert.equal(failed.statusCode, 200, failed.body); assert.equal(failed.json().results[0].status, "failed");
    assert.equal((await f.database.db.select().from(issues)).length, 0);
    assert.equal((await f.database.db.select().from(dingtalkIssueImports)).length, 0);
    assert.equal((await readdir(path.join(f.root, "issues"))).length, 0);
    assert.equal(f.engine.enqueued.length, 0);
    await f.database.client.execute("DROP TRIGGER fail_dingtalk_import");
    for (let index = 0; index < 2; index++) {
      const response = await f.app.inject({ method: "POST", url: "/api/dingtalk/import", payload });
      assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().results[0].status, index ? "existing" : "created");
    }
    assert.equal(f.engine.enqueued.length, 1);
  } finally { await f.cleanup(); }
});

test("DingTalk personal connections are never replaced with another person's credentials or retried with shared credentials", async () => {
  const f = await fixture();
  try {
    await f.database.db.insert(subjects).values({ subject: "bob", displayName: "Bob", role: "developer" });
    await writeFile(path.join(f.root, "user.yaml"), stringify({ version: 2, shared: { dingtalk: { apiKey: "fixture-explicit-shared" } }, users: { [f.actor.subject]: { dingtalk: { apiKey: "fixture-personal", source: { mcp: "dingtalk", url, assignee: f.actor.name, intervalMinutes: 15 } } }, bob: {} } }), { mode: 0o600 });
    const owner = await f.app.inject({ method: "GET", url: "/api/dingtalk/source", headers: { "x-issue-pilot-subject": f.actor.subject } }), bob = await f.app.inject({ method: "GET", url: "/api/dingtalk/source", headers: { "x-issue-pilot-subject": "bob" } });
    assert.equal(owner.json().connection.kind, "personal"); assert.equal(bob.json().connection.kind, "shared"); assert.equal(bob.json().url, ""); assert.equal(bob.json().assignee, "Bob");
    assert.doesNotMatch(owner.body + bob.body, /fixture-personal|fixture-explicit-shared|fixture-share-secret/);
    await f.preview();
    assert.equal(new URL(f.state.configurations.at(-1)!.url).searchParams.get("key"), "fixture-personal");
    assert.equal(f.state.configurations.at(-1)!.authorization, "");
    f.state.failure = true;
    const count = f.state.configurations.length, failed = await f.app.inject({ method: "POST", url: "/api/dingtalk/preview", headers: { "x-issue-pilot-subject": f.actor.subject }, payload: { url } });
    assert.equal(failed.statusCode, 502, failed.body); assert.equal(f.state.configurations.length, count + 1);
    assert.doesNotMatch(failed.body, /fixture-private-credential|fixture-personal|fixture-shared/);
  } finally { await f.cleanup(); }
});

test("DingTalk reauthorizes the selected work mode after a remote read", async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  try {
    const payload = { ...f.payload(await f.preview()), workMode: "production_data" };
    const waiting = new Promise<void>(resolve => { entered = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
    f.state.beforeRecords = async () => { entered(); await resume; };
    const response = f.app.inject({ method: "POST", url: "/api/dingtalk/import", headers: { "x-issue-pilot-subject": f.actor.subject }, payload });
    await waiting;
    await f.database.db.update(subjects).set({ role: "product" }).where(eq(subjects.subject, f.actor.subject));
    release();
    const result = await response;
    assert.equal(result.statusCode, 200, result.body);
    assert.ok(result.json().results.every((row: { status: string; error: string }) => row.status === "failed" && row.error === "developer_role_required"));
    assert.equal((await f.database.db.select().from(issues)).length, 0);
  } finally { release?.(); await f.cleanup(); }
});

test("cancelling a DingTalk HTTP read closes its MCP session", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    f.state.beforeRecords = signal => new Promise<void>((_resolve, reject) => { entered(); signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
    const address = await f.app.listen({ host: "127.0.0.1", port: 0 }), controller = new AbortController();
    const response = fetch(address + "/api/dingtalk/preview", { method: "POST", headers: { "Content-Type": "application/json", "X-Issue-Pilot-Subject": f.actor.subject }, body: JSON.stringify({ url }), signal: controller.signal });
    await waiting; controller.abort();
    await assert.rejects(response, error => error instanceof Error && error.name === "AbortError");
    await f.stop();
    assert.equal(f.state.closed, 1);
    assert.equal((await f.database.db.select().from(issues)).length, 0);
  } finally { await f.cleanup(); }
});
