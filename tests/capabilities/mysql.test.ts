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
import { resolveConfiguredCapabilitySections } from "../../src/configuration/credentials.ts";

function connectionFixture(rows: RowDataPacket[], fields: Array<{ name: string }>, wait?: Promise<void>, options: { failStatement?: string; queryError?: Error; endError?: Error; onEnd?: () => void } = {}) {
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
          if (options.queryError) throw options.queryError;
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

test("passes significant MySQL password whitespace from configuration to the driver unchanged", async () => {
  const password = "  driver-private-password \t";
  const stored = resolveConfiguredCapabilitySections({ db: { databases: [{ url: config.url, username: config.username, credentialUpdate: { mode: "replace", values: { password } } }] } }, ["db"]);
  const fixture = connectionFixture([{ id: "1" } as RowDataPacket], [{ name: "id" }]);
  let options: ConnectionOptions | undefined;
  const result = await readMysql(stored.db!, { database: "orders", statement: "SELECT id FROM orders" }, undefined, undefined, value => { options = value; return fixture.connection; });
  assert.equal(options?.password, password);
  assert.doesNotMatch(JSON.stringify(result), /driver-private-password/);
  assert.equal(fixture.ended(), true);
});

test("retains both MySQL values with unique column aliases", async () => {
  const fixture = connectionFixture([{ left_id: "first", right_id: "second" } as RowDataPacket], [{ name: "left_id" }, { name: "right_id" }]);
  const result = await queryMysql({ config, statement: "SELECT a.id AS left_id, b.id AS right_id FROM a JOIN b" }, undefined, () => fixture.connection);
  assert.deepEqual(result.columns, ["left_id", "right_id"]);
  assert.deepEqual(result.rows, [{ left_id: "first", right_id: "second" }]);
  assert.equal(fixture.ended(), true);
});

for (const empty of [false, true]) test(`rejects duplicate MySQL result columns for ${empty ? "empty" : "nonempty"} results and preserves exports`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-mysql-columns-"));
  const fields = [{ name: "id" }, { name: "id" }];
  const rows = empty ? [] : [{ id: "second-column-value" } as RowDataPacket];
  try {
    const queried = connectionFixture(rows, fields);
    await assert.rejects(queryMysql({ config, statement: "SELECT a.id, b.id FROM a JOIN b" }, undefined, () => queried.connection), /database_query_duplicate_columns/);
    assert.equal(queried.ended(), true);
    assert.equal(queried.statements.at(-1), "ROLLBACK");
    const store = new IssueOutputStore(root, "ISSUE-20261018-991");
    for (const format of ["csv", "jsonl"] as const) {
      const name = `result.${format}`;
      await store.write(name, "old-delivery");
      const exported = connectionFixture(rows, fields);
      await assert.rejects(exportMysql({ config, statement: "SELECT a.id, b.id FROM a JOIN b", output: { fileName: name, format }, store }, undefined, () => exported.connection), /database_query_duplicate_columns/);
      assert.equal((await store.read(name)).toString(), "old-delivery");
      assert.equal(exported.ended(), true);
      assert.equal(exported.statements.at(-1), "ROLLBACK");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("retains empty-result columns and format-specific headers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-mysql-empty-"));
  const fields = [{ name: "id" }, { name: "note" }];
  try {
    const queried = connectionFixture([], fields);
    const result = await queryMysql({ config, statement: "SELECT id, note FROM orders WHERE 1 = 0" }, undefined, () => queried.connection);
    assert.deepEqual(result.columns, ["id", "note"]);
    assert.deepEqual(result.rows, []);
    const store = new IssueOutputStore(root, "ISSUE-20261019-008");
    for (const format of ["csv", "jsonl"] as const) {
      const fixture = connectionFixture([], fields), fileName = `empty.${format}`;
      const output = await exportMysql({ config, statement: "SELECT id, note FROM orders WHERE 1 = 0", output: { fileName, format }, store }, undefined, () => fixture.connection);
      assert.equal(output.rows, 0);
      assert.deepEqual(output.columns, ["id", "note"]);
      assert.equal((await store.read(fileName)).toString(), format === "csv" ? '"id","note"\n' : "");
      assert.equal(fixture.ended(), true);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
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

for (const output of [false, true]) for (const rollbackFails of [false, true]) test(`keeps MySQL query and cleanup errors for ${output ? "export" : "query"}, rollback failure ${rollbackFails}`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-mysql-errors-"));
  const primary = new Error("fixture_query_failed"), closing = new Error("fixture_shutdown_failed");
  const fixture = connectionFixture([], [{ name: "id" }], undefined, { queryError: primary, endError: closing, ...(rollbackFails ? { failStatement: "ROLLBACK" } : {}) });
  const store = new IssueOutputStore(root, "ISSUE-20261019-009");
  try {
    await store.write("result.jsonl", "old-delivery");
    const pending = output
      ? exportMysql({ config, statement: "SELECT id FROM orders", output: { fileName: "result.jsonl", format: "jsonl" }, store }, undefined, () => fixture.connection)
      : queryMysql({ config, statement: "SELECT id FROM orders" }, undefined, () => fixture.connection);
    await assert.rejects(pending, error => {
      assert(error instanceof AggregateError);
      assert.equal(error.message, primary.message);
      assert.equal(error.errors[0], primary);
      assert.equal(error.errors.at(-1), closing);
      assert.equal(error.errors.length, rollbackFails ? 3 : 2);
      if (rollbackFails) assert.equal(error.errors[1].message, "fixture_statement_failed");
      return true;
    });
    assert.equal(fixture.ended(), true);
    assert.deepEqual(fixture.statements, ["START TRANSACTION READ ONLY", "SELECT id FROM orders", "ROLLBACK"]);
    assert.equal((await store.read("result.jsonl")).toString(), "old-delivery");
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const phase of ["query", "close"] as const) test(`preserves the original single MySQL ${phase} error`, async () => {
  const failure = new Error(`fixture_${phase}_failed`);
  const fixture = connectionFixture([], [], undefined, phase === "query" ? { queryError: failure } : { endError: failure });
  await assert.rejects(queryMysql({ config, statement: "SELECT 1" }, undefined, () => fixture.connection), error => error === failure);
  assert.equal(fixture.ended(), true);
});

test("retains caller cancellation when MySQL query and shutdown also fail", async () => {
  const controller = new AbortController(), reason = new Error("caller_cancelled_at_shutdown");
  const fixture = connectionFixture([], [], undefined, { queryError: new Error("query_failed"), endError: new Error("shutdown_failed"), onEnd: () => controller.abort(reason) });
  await assert.rejects(queryMysql({ config, statement: "SELECT 1" }, controller.signal, () => fixture.connection), error => error === reason);
  assert.equal(fixture.destroyed(), true);
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

for (const output of [false, true]) test(`cancels MySQL ${output ? "export" : "query"} while connection shutdown is pending`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-mysql-close-cancel-"));
  const controller = new AbortController(), fixture = connectionFixture([], []);
  const store = new IssueOutputStore(root, "ISSUE-20261018-002");
  let started!: () => void, finishClose: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const closing = new Promise<void>(resolve => { started = resolve; });
  fixture.connection.end = callback => { finishClose = () => callback?.(null); started(); };
  await store.write("result.jsonl", "old-delivery");
  const pending = output
    ? exportMysql({ config, statement: "SELECT 1", output: { fileName: "result.jsonl", format: "jsonl" }, store }, controller.signal, () => fixture.connection)
    : queryMysql({ config, statement: "SELECT 1" }, controller.signal, () => fixture.connection);
  try {
    await closing;
    controller.abort(new Error("cancelled_while_closing"));
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("mysql_close_did_not_cancel")), 200); });
    await assert.rejects(Promise.race([pending, deadline]), /cancelled_while_closing/);
    assert.equal(fixture.destroyed(), true);
    if (output) assert.equal((await store.read("result.jsonl")).toString(), "old-delivery");
  } finally {
    clearTimeout(timer); finishClose?.(); await pending.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
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
