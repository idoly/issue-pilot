import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import type { Connection, ConnectionOptions, FieldPacket, RowDataPacket } from "mysql2";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { exportMysql, queryMysql, readMysql, validateReadOnlyQuery, type MysqlConnectionFactory } from "../../src/capabilities/mysql.ts";
import { IssueOutputStore, resolveIssueOutput } from "../../src/outputs/store.ts";

function connectionFixture(rows: RowDataPacket[], fields: Array<{ name: string }>, wait?: Promise<void>, options: { failStatement?: string; endError?: Error; onEnd?: () => void } = {}) {
  const statements: string[] = [];
  let ended = false;
  let destroyed = false;
  let releaseWait: (() => void) | undefined;
  const connection = {
    query(statement: string, callback?: (error: Error | null) => void) {
      statements.push(statement);
      if (callback) { queueMicrotask(() => callback(statement === options.failStatement ? new Error("fixture_statement_failed") : null)); return undefined; }
      const query = new EventEmitter() as EventEmitter & { stream: () => Readable };
      query.stream = () => {
        queueMicrotask(() => query.emit("fields", fields as FieldPacket[]));
        return Readable.from((async function* () {
          if (wait) await Promise.race([wait, new Promise<void>((resolve) => { releaseWait = resolve; })]);
          for (const row of rows) yield row;
        })(), { objectMode: true });
      };
      return query;
    },
    end(callback: (error?: Error | null) => void) { ended = true; options.onEnd?.(); callback(options.endError ?? null); },
    destroy() { destroyed = true; releaseWait?.(); },
  } as unknown as Connection;
  return { connection, statements, ended: () => ended, destroyed: () => destroyed };
}

test("accepts complete MySQL reads and rejects side-effecting read expressions", () => {
  assert.equal(validateReadOnlyQuery("SELECT id FROM orders;"), "SELECT id FROM orders");
  assert.equal(validateReadOnlyQuery("SHOW TABLES"), "SHOW TABLES");
  assert.equal(validateReadOnlyQuery("EXPLAIN SELECT id FROM orders LIMIT 10"), "EXPLAIN SELECT id FROM orders LIMIT 10");

  for (const statement of [
    "SELECT LOAD_FILE('/etc/passwd') LIMIT 1",
    "SELECT GET_LOCK('issue-pilot', 10) LIMIT 1",
    "SELECT id INTO @captured FROM orders LIMIT 1",
    "SELECT id FROM orders PROCEDURE ANALYSE() LIMIT 1",
    "SELECT id FROM orders FOR UPDATE LIMIT 1",
  ]) assert.throws(() => validateReadOnlyQuery(statement), /database_query_must_be_read_only/);
});

const config = { url: "mysql://mysql.example.test:3307/orders", username: "readonly", password: "db-secret" };

test("rejects native MySQL databases outside the deployment allowlist", async () => {
  await assert.rejects(
    readMysql({ databases: [config] }, { database: "inventory", statement: "SELECT 1" }),
    /db_database_not_authorized/,
  );
});

test("streams MySQL reads inside a server-enforced read-only transaction", async () => {
  let options: ConnectionOptions | undefined;
  const fixture = connectionFixture(
    [{ order_id: "123", status: "ready", nullable: null } as RowDataPacket],
    [{ name: "order_id" }, { name: "status" }, { name: "nullable" }],
  );
  const factory: MysqlConnectionFactory = (value) => { options = value; return fixture.connection; };

  const result = await queryMysql({ config, statement: "SELECT order_id, status, nullable FROM orders LIMIT 20" }, undefined, factory);

  assert.equal(options?.host, "mysql.example.test");
  assert.equal(options?.port, 3307);
  assert.equal(options?.user, "readonly");
  assert.equal(options?.password, "db-secret");
  assert.equal(options?.database, "orders");
  assert.equal(options?.connectTimeout, issuePilotConfig.limits.capability.connectionMs);
  assert.equal(options?.multipleStatements, false);
  assert.deepEqual(fixture.statements, ["START TRANSACTION READ ONLY", "SELECT order_id, status, nullable FROM orders LIMIT 20", "ROLLBACK"]);
  assert.deepEqual(result, {
    columns: ["order_id", "status", "nullable"],
    rows: [{ order_id: "123", status: "ready", nullable: null }],
    runtime: "node",
  });
  assert.doesNotMatch(JSON.stringify(result), /db-secret|mysql\.example\.test|readonly/);
  assert.equal(fixture.ended(), true);
});

test("returns every MySQL row without a row or result-byte cap", async () => {
  const rows = Array.from({ length: 600 }, (_, id) => ({ id: String(id), value: "x".repeat(2000) }) as RowDataPacket);
  const fixture = connectionFixture(rows, [{ name: "id" }, { name: "value" }]);
  const result = await readMysql(
    { databases: [config] },
    { database: "orders", statement: "SELECT id, value FROM orders" },
    undefined,
    undefined,
    () => fixture.connection,
  );
  const text = result.content[0]!.text;
  assert.ok(Buffer.byteLength(text) > issuePilotConfig.limits.capability.resultBytes);
  const parsed = JSON.parse(text);
  assert.equal(parsed.rows.length, 600);
  assert.deepEqual(parsed.rows.at(-1), { id: "599", value: "x".repeat(2000) });
  assert.deepEqual(fixture.statements, ["START TRANSACTION READ ONLY", "SELECT id, value FROM orders", "ROLLBACK"]);
  assert.equal(fixture.ended(), true);
});

test("streams unbounded MySQL rows directly into a durable CSV output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-mysql-output-"));
  const fixture = connectionFixture(
    Array.from({ length: 600 }, (_, id) => ({ id: String(id), note: id === 0 ? 'quoted "value"' : `row-${id}` }) as RowDataPacket),
    [{ name: "id" }, { name: "note" }],
  );
  try {
    const result = await exportMysql({
      config,
      statement: "SELECT id, note FROM orders",
      output: { fileName: "orders.csv", format: "csv" },
      store: new IssueOutputStore(root, "ISSUE-20260929-001"),
    }, undefined, () => fixture.connection);
    assert.equal(result.rows, 600);
    assert.deepEqual(result.columns, ["id", "note"]);
    assert.deepEqual(fixture.statements, ["START TRANSACTION READ ONLY", "SELECT id, note FROM orders", "ROLLBACK"]);
    const content = await readFile(await resolveIssueOutput(root, "ISSUE-20260929-001", "orders.csv"), "utf8");
    assert.equal(content.split("\n").filter(Boolean).length, 601);
    assert.match(content, /^"id","note"\n"0","quoted ""value"""\n/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const stage of ["START TRANSACTION READ ONLY", "ROLLBACK", "close", "abort_at_close"] as const) test(`preserves the old MySQL export on ${stage} failure`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-mysql-finalization-"));
  const controller = new AbortController();
  const fixture = connectionFixture([{ id: "1" } as RowDataPacket], [{ name: "id" }], undefined, {
    ...(stage === "close" ? { endError: new Error("fixture_close_failed") } : stage === "abort_at_close" ? { onEnd: () => controller.abort(new Error("cancelled_at_close")) } : { failStatement: stage }),
  });
  try {
    const store = new IssueOutputStore(root, "ISSUE-20261017-001");
    await store.write("result.jsonl", "old-delivery");
    await assert.rejects(exportMysql({ config, statement: "SELECT id FROM orders", output: { fileName: "result.jsonl", format: "jsonl" }, store }, controller.signal, () => fixture.connection), /fixture_statement_failed|fixture_close_failed|cancelled_at_close/);
    assert.equal((await store.read("result.jsonl")).toString(), "old-delivery");
    assert.deepEqual((await store.list()).map(file => file.fileName), ["result.jsonl"]);
    assert.ok(fixture.ended());
    if (stage === "START TRANSACTION READ ONLY") assert.deepEqual(fixture.statements, [stage]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("destroys a MySQL connection that finishes opening after cancellation", async () => {
  const controller = new AbortController();
  const fixture = connectionFixture([], []);
  let finishOpening!: (connection: Connection) => void;
  const pending = queryMysql({ config, statement: "SELECT 1" }, controller.signal, () => new Promise<Connection>((resolve) => { finishOpening = resolve; }));
  controller.abort(new Error("cancelled_while_connecting"));
  finishOpening(fixture.connection);
  await assert.rejects(pending, /cancelled_while_connecting/);
  assert.equal(fixture.destroyed(), true);
  assert.deepEqual(fixture.statements, []);
});

test("destroys an active MySQL connection when the operation is aborted", async () => {
  const controller = new AbortController();
  const fixture = connectionFixture([], [], new Promise<void>(() => {}));
  const query = queryMysql(
    { config, statement: "SELECT 1" },
    controller.signal,
    () => fixture.connection,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort(new Error("cancelled"));
  await assert.rejects(query, /cancelled/);
  assert.equal(fixture.destroyed(), true);
});
