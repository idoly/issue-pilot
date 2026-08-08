import assert from "node:assert/strict";
import test from "node:test";

import type { Connection, ConnectionOptions } from "mysql2/promise";
import { queryMysql, validateReadOnlyQuery, type MysqlConnectionFactory } from "../../src/capabilities/mysql.ts";

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

test("queries MySQL through mysql2 with bounded, read-only connection settings", async () => {
  let options: ConnectionOptions | undefined;
  let statement = "";
  let ended = false;
  const connection = {
    async query(value: string) {
      statement = value;
      return [[{ order_id: "123", status: "ready", nullable: null }], [{ name: "order_id" }, { name: "status" }, { name: "nullable" }]];
    },
    async end() { ended = true; },
    destroy() {},
  } as unknown as Connection;
  const factory: MysqlConnectionFactory = async (value) => {
    options = value;
    return connection;
  };

  const result = await queryMysql({
    connectionUrl: "mysql://readonly:db-secret@mysql.example.test:3307/orders",
    statement: "SELECT order_id, status, nullable FROM orders LIMIT 20",
  }, undefined, factory);

  assert.equal(options?.host, "mysql.example.test");
  assert.equal(options?.port, 3307);
  assert.equal(options?.user, "readonly");
  assert.equal(options?.password, "db-secret");
  assert.equal(options?.database, "orders");
  assert.equal(options?.connectTimeout, 10_000);
  assert.equal(options?.multipleStatements, false);
  assert.equal(statement, "SELECT order_id, status, nullable FROM orders LIMIT 20");
  assert.deepEqual(result, {
    columns: ["order_id", "status", "nullable"],
    rows: [{ order_id: "123", status: "ready", nullable: null }],
    runtime: "node",
  });
  assert.doesNotMatch(JSON.stringify(result), /db-secret|mysql\.example\.test|readonly/);
  assert.equal(ended, true);
  await assert.rejects(queryMysql({ connectionUrl: "mariadb://readonly:secret@mysql.example.test/orders", statement: "SELECT 1" }, undefined, factory), /unsupported_mysql_connection_protocol/);
});

test("bounds MySQL results before returning them to Pi", async () => {
  const connection = {
    async query() { return [Array.from({ length: 600 }, (_, id) => ({ id })), [{ name: "id" }]]; },
    async end() {},
    destroy() {},
  } as unknown as Connection;
  await assert.rejects(queryMysql(
    { connectionUrl: "mysql://readonly:secret@mysql.example.test/orders", statement: "SELECT id FROM orders" },
    undefined,
    async () => connection,
  ), /capability_result_too_large/);
});

test("destroys an active MySQL connection when the operation is aborted", async () => {
  const controller = new AbortController();
  let destroyed = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const connection = {
    async query() { await pending; return [[], []]; },
    async end() {},
    destroy() { destroyed = true; release(); },
  } as unknown as Connection;

  const query = queryMysql(
    { connectionUrl: "mysql://readonly:secret@mysql.example.test/orders", statement: "SELECT 1" },
    controller.signal,
    async () => connection,
  );
  await Promise.resolve();
  controller.abort(new Error("cancelled"));
  await assert.rejects(query, /cancelled/);
  assert.equal(destroyed, true);
});
