import assert from "node:assert/strict";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { openDatabase } from "../../src/db/client.ts";
import { issues, subjects } from "../../src/db/schema.ts";
import { createApiFixture, createIssue, createService, issuePayload, json } from "./fixture.ts";

const config = "/api/config/issue-search";
const search = "/api/issue-search";
const refresh = "/api/issue-search/refresh";
const reader = { "x-issue-pilot-subject": "search-reader@example.test" };
const admin = { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject };
const accountId = "a".repeat(32);
const token = "fixture-workers-ai-token";
const vector = (dimension: number) => Array.from({ length: 1024 }, (_, index) => Number(index === dimension));
const output = (data: number[][]) => Response.json({ success: true, result: { data, shape: [data.length, 1024] } });
type EmbeddingInput = { documents?: string[]; queries?: string; instruction?: string };

test("optional global search projects no secret and refreshes only new or edited documents", async (t) => {
  const calls: EmbeddingInput[] = [];
  const f = await createApiFixture({
    issueSearchFetch: async (url, init) => {
      assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/qwen/qwen3-embedding-0.6b`);
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
      assert.equal(init?.redirect, "error");
      const input = JSON.parse(String(init?.body)) as EmbeddingInput;
      calls.push(input);
      if (input.documents) return output(input.documents.map((item) => vector(item.includes("支付") ? 1 : 0)));
      assert.equal(typeof input.instruction, "string");
      return output([vector(1)]);
    },
  });
  const db = openDatabase(f.databaseFile);
  t.after(async () => {
    db.close();
    await f.cleanup();
  });
  await db.db.insert(subjects).values({ subject: reader["x-issue-pilot-subject"], role: "product" });
  assert.deepEqual(await json(await f.app.inject({ url: "/health" })), { ok: true });
  assert.equal((await f.app.inject({ method: "POST", url: search, headers: reader, payload: { query: "扣款后未更新" } })).statusCode, 503);
  assert.ok(!(await readdir(f.root)).includes("vectors.db"));
  assert.equal((await f.app.inject({ url: config, headers: reader })).statusCode, 403);
  assert.equal((await f.app.inject({ method: "PUT", url: config, headers: reader, payload: { enabled: true, accountId, apiToken: token, expectedRevision: 0 } })).statusCode, 403);
  const saved = await f.app.inject({ method: "PUT", url: config, headers: admin, payload: { enabled: true, accountId, apiToken: token, expectedRevision: 0 } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(await json(saved), { enabled: true, accountId, tokenConfigured: true, revision: 1 });
  for (const url of [config, "/api/catalog", "/api/config", "/api/me/credentials"]) {
    const response = await f.app.inject({ url, headers: admin });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(!response.body.includes(token));
  }
  assert.equal((await json(await f.app.inject({ url: "/api/catalog" }))).issueSearchEnabled, true);
  assert.equal((await f.app.inject({ method: "POST", url: search, headers: reader, payload: { query: "扣款后未更新" } })).json().error, "issue_search_index_required");
  assert.equal((await f.app.inject({ method: "POST", url: refresh, headers: reader, payload: {} })).statusCode, 403);
  assert.equal(calls.length, 0);

  await createService(f.app, "Payments", ["test", "prod"]);
  const payment = await createIssue(f.app, "payments", "prod", "支付回调未更新订单");
  await db.db
    .update(issues)
    .set({ status: "resolved", resolvedAt: new Date() })
    .where(eq(issues.key, String(payment.id)));
  const exportIssue = await f.app.inject({ method: "POST", url: "/api/issues", headers: reader, payload: issuePayload("payments", "test", "导出 CSV 乱码") });
  assert.equal(exportIssue.statusCode, 201, exportIssue.body);
  const exportKey = String((await json(exportIssue)).id);
  const index = async () => {
    const response = await f.app.inject({ method: "POST", url: refresh, headers: admin, payload: {} });
    assert.equal(response.statusCode, 200, response.body);
    return json(response);
  };
  const query = async () => {
    const response = await f.app.inject({ method: "POST", url: search, headers: reader, payload: { query: "扣款后未更新" } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<Array<{ key: string; title: string; status: string }>>();
  };
  assert.deepEqual(await index(), { indexed: 2, removed: 0, nextCursor: null });
  assert.equal((await stat(join(f.root, "vectors.db"))).mode & 0o777, 0o600);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.documents?.length, 2);
  assert.deepEqual(await index(), { indexed: 0, removed: 0, nextCursor: null });
  assert.equal(calls.length, 1);
  assert.deepEqual(
    (await query()).map(({ key, status }) => [key, status]),
    [
      [payment.id, "resolved"],
      [exportKey, "open"],
    ],
  );
  assert.equal(calls.at(-1)?.queries, "扣款后未更新");

  await db.db
    .update(issues)
    .set({ title: "支付状态同步延迟" })
    .where(eq(issues.key, String(payment.id)));
  await db.client.execute("PRAGMA foreign_keys = ON");
  await db.db.delete(issues).where(eq(issues.key, exportKey));
  assert.deepEqual(await query(), []);
  assert.deepEqual(await index(), { indexed: 1, removed: 1, nextCursor: null });
  assert.match(calls.at(-1)?.documents?.[0] ?? "", /^支付状态同步延迟/);
  assert.deepEqual(
    (await query()).map(({ title }) => title),
    ["支付状态同步延迟"],
  );

  assert.equal((await f.app.inject({ method: "PUT", url: config, headers: admin, payload: { enabled: false, accountId, expectedRevision: 0 } })).statusCode, 409);
  const disabled = await f.app.inject({ method: "PUT", url: config, headers: admin, payload: { enabled: false, accountId, expectedRevision: 1 } });
  assert.deepEqual(await json(disabled), { enabled: false, accountId, tokenConfigured: true, revision: 2 });
  assert.equal((await json(await f.app.inject({ url: "/api/catalog" }))).issueSearchEnabled, undefined);
  const callsBeforeDisable = calls.length;
  const blocked = await f.app.inject({ method: "POST", url: search, headers: reader, payload: { query: "扣款后未更新" } });
  assert.equal(blocked.statusCode, 503);
  assert.deepEqual(await json(blocked), { error: "issue_search_disabled" });
  assert.equal(calls.length, callsBeforeDisable);
});

test("credential changes reuse the index, invalid responses keep existing vectors, and disabling aborts a query", async (t) => {
  let mode: "ok" | "invalid" | "wait" = "ok";
  const requests: Array<{ url: string; authorization: string | null }> = [];
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = await createApiFixture({
    issueSearchFetch: async (url, init) => {
      requests.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
      if (mode === "invalid") return output([[1]]);
      if (mode === "wait") {
        entered();
        const signal = init?.signal;
        assert.ok(signal);
        signal.throwIfAborted();
        await new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      return output([vector(0)]);
    },
  });
  const db = openDatabase(f.databaseFile);
  t.after(async () => {
    db.close();
    await f.cleanup();
  });
  const configure = (payload: Record<string, unknown>) => f.app.inject({ method: "PUT", url: config, headers: admin, payload });
  const index = () => f.app.inject({ method: "POST", url: refresh, headers: admin, payload: {} });
  const query = () => f.app.inject({ method: "POST", url: search, headers: admin, payload: { query: "test" } });
  assert.equal((await configure({ enabled: true, accountId, apiToken: token, expectedRevision: 0 })).statusCode, 200);
  await createService(f.app, "Index");
  const issue = await createIssue(f.app, "index");
  assert.equal((await index()).statusCode, 200);
  const secondAccount = "b".repeat(32);
  const secondToken = "second-fixture-token";
  assert.equal((await configure({ enabled: true, accountId: secondAccount, expectedRevision: 1 })).statusCode, 400);
  assert.equal((await configure({ enabled: true, accountId: secondAccount, apiToken: secondToken, expectedRevision: 1 })).statusCode, 200);
  assert.deepEqual((await index()).json(), { indexed: 0, removed: 0, nextCursor: null });
  assert.equal(requests.length, 1);
  assert.equal((await query()).json<Array<{ key: string }>>()[0]?.key, issue.id);
  assert.deepEqual(requests.at(-1), {
    url: `https://api.cloudflare.com/client/v4/accounts/${secondAccount}/ai/run/@cf/qwen/qwen3-embedding-0.6b`,
    authorization: `Bearer ${secondToken}`,
  });

  await createIssue(f.app, "index", "test", "新工单尚未建立索引");
  mode = "invalid";
  const failure = await index();
  assert.equal(failure.statusCode, 502);
  assert.deepEqual(await json(failure), { error: "issue_search_cloudflare_invalid_response" });
  mode = "ok";
  assert.deepEqual(
    (await query()).json<Array<{ key: string }>>().map(({ key }) => key),
    [issue.id],
  );
  mode = "wait";
  const pending = query();
  await started;
  assert.equal((await configure({ enabled: false, accountId: secondAccount, apiToken: null, expectedRevision: 2 })).statusCode, 200);
  const cancelled = await pending;
  assert.equal(cancelled.statusCode, 408, cancelled.body);
  assert.deepEqual(await json(cancelled), { error: "issue_search_cancelled" });
});

test("initial indexing resumes at the next Issue after each bounded provider batch", async (t) => {
  const lengths: number[] = [];
  const f = await createApiFixture({
    issueSearchFetch: async (_url, init) => {
      const input = JSON.parse(String(init?.body)) as EmbeddingInput;
      assert.ok(input.documents);
      lengths.push(input.documents.length);
      return output(input.documents.map(() => vector(0)));
    },
  });
  const db = openDatabase(f.databaseFile);
  t.after(async () => {
    db.close();
    await f.cleanup();
  });
  await createService(f.app, "Batch");
  await createIssue(f.app, "batch");
  const [sample] = await db.db.select().from(issues).limit(1);
  assert.ok(sample);
  await db.db.insert(issues).values(
    Array.from({ length: 16 }, (_, i) => ({
      key: `ISSUE-20261110-${String(i + 100).padStart(3, "0")}`,
      title: `Synthetic Issue ${i}`,
      type: sample.type,
      serviceId: sample.serviceId,
      environmentId: sample.environmentId,
      reporterSubject: sample.reporterSubject,
    })),
  );
  assert.equal((await f.app.inject({ method: "PUT", url: config, headers: admin, payload: { enabled: true, accountId, apiToken: token, expectedRevision: 0 } })).statusCode, 200);
  const page = async (after?: string) => {
    const response = await f.app.inject({ method: "POST", url: refresh, headers: admin, payload: after ? { after } : {} });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<{ indexed: number; nextCursor: string | null }>();
  };
  const first = await page();
  assert.equal(first.indexed, 16);
  assert.ok(first.nextCursor);
  const second = await page(first.nextCursor);
  assert.equal(second.indexed, 1);
  assert.equal(second.nextCursor, null);
  assert.equal((await page()).indexed, 0);
  assert.deepEqual(lengths, [16, 1]);
});
