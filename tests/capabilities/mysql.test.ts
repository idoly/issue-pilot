import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { test } from "node:test";

import type { Connection, ConnectionOptions, FieldPacket, RowDataPacket } from "mysql2";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { queryMysql, validateReadOnlyQuery, type MysqlConnectionFactory } from "../../src/capabilities/mysql.ts";

function connectionFixture(rows: RowDataPacket[], fields: Array<{ name: string }>, wait?: Promise<void>) {
  const statements: string[] = [];
  let ended = false;
  let destroyed = false;
  let releaseWait: (() => void) | undefined;
  const connection = {
    query(statement: string, callback?: (error: Error | null) => void) {
      statements.push(statement);
      if (callback) { queueMicrotask(() => callback(null)); return undefined; }
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
    end(callback: (error?: Error | null) => void) { ended = true; callback(null); },
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

test("streams MySQL reads inside a server-enforced read-only transaction", async () => {
  let options: ConnectionOptions | undefined;
  const fixture = connectionFixture(
    [{ order_id: "123", status: "ready", nullable: null } as RowDataPacket],
    [{ name: "order_id" }, { name: "status" }, { name: "nullable" }],
  );
  const factory: MysqlConnectionFactory = (value) => { options = value; return fixture.connection; };

  const result = await queryMysql({
    connectionUrl: "mysql://readonly:db-secret@mysql.example.test:3307/orders",
    statement: "SELECT order_id, status, nullable FROM orders LIMIT 20",
  }, undefined, factory);

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
  await assert.rejects(queryMysql({ connectionUrl: "mariadb://readonly:secret@mysql.example.test/orders", statement: "SELECT 1" }, undefined, factory), /unsupported_mysql_connection_protocol/);
  await assert.rejects(queryMysql({ connectionUrl: "mysql://readonly:secret@mysql.example.test/orders", statement: "SELECT 1" }, undefined, factory), /invalid_mysql_connection_url/);
  await assert.rejects(queryMysql({ connectionUrl: "mysql://readonly:secret@mysql.example.test:3306/orders/archive", statement: "SELECT 1" }, undefined, factory), /invalid_mysql_connection_url/);
});

test("stops streaming MySQL results at the configured row boundary", async () => {
  const fixture = connectionFixture(Array.from({ length: 600 }, (_, id) => ({ id }) as RowDataPacket), [{ name: "id" }]);
  await assert.rejects(queryMysql(
    { connectionUrl: "mysql://readonly:secret@mysql.example.test:3306/orders", statement: "SELECT id FROM orders" },
    undefined,
    () => fixture.connection,
  ), /capability_result_too_large/);
  assert.equal(fixture.statements.filter((statement) => statement === "SELECT id FROM orders").length, 1);
  assert.equal(fixture.statements.includes("ROLLBACK"), true);
});

test("destroys an active MySQL connection when the operation is aborted", async () => {
  const controller = new AbortController();
  const fixture = connectionFixture([], [], new Promise<void>(() => {}));
  const query = queryMysql(
    { connectionUrl: "mysql://readonly:secret@mysql.example.test:3306/orders", statement: "SELECT 1" },
    controller.signal,
    () => fixture.connection,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort(new Error("cancelled"));
  await assert.rejects(query, /cancelled/);
  assert.equal(fixture.destroyed(), true);
});
