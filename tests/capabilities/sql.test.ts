import assert from "node:assert/strict";
import { test } from "node:test";

import { validateReadOnlySql } from "../../src/capabilities/sql.ts";

test("accepts single read-only statements and strips one trailing terminator", () => {
  assert.equal(validateReadOnlySql("  SELECT * FROM orders;  ", 1_000), "SELECT * FROM orders");
  assert.equal(validateReadOnlySql("SHOW TABLES", 1_000), "SHOW TABLES");
});

test("rejects row-locking and table-writing select variants", () => {
  for (const query of [
    "SELECT * FROM orders FOR UPDATE",
    "SELECT * FROM orders FOR NO KEY UPDATE",
    "SELECT * FROM orders FOR SHARE",
    "SELECT * FROM orders FOR KEY SHARE",
    "SELECT * FROM orders LOCK IN SHARE MODE",
    "SELECT * INTO copied_orders FROM orders",
    "SELECT * FROM orders INTO OUTFILE '/tmp/orders.csv'",
    "SELECT @value := 1 INTO @value",
  ])
    assert.throws(() => validateReadOnlySql(query, 1_000), /read_only/, query);
});

test("rejects writes, multiple statements, comments and side-effecting functions", () => {
  for (const query of ["UPDATE orders SET status = 'closed'", "SELECT 1; SELECT 2", "SELECT 1 -- comment", "SELECT * FROM orders WHERE id = SLEEP(1)"])
    assert.throws(() => validateReadOnlySql(query, 1_000), /read_only|one_statement_without_comments/, query);
  assert.throws(() => validateReadOnlySql("SELECT 1", 0), /invalid_database_query/);
});

test("rejects PostgreSQL side effects, server file reads and functions that execute SQL text", () => {
  for (const query of [
    "SELECT nextval('orders_id_seq')",
    "SELECT setval('s', 1)",
    "SELECT pg_advisory_lock(1)",
    "SELECT pg_try_advisory_xact_lock(1)",
    "SELECT pg_sleep(100)",
    'SELECT "pg_sleep"(100)',
    "SELECT pg_catalog.pg_terminate_backend(42)",
    "SELECT pg_cancel_backend(42)",
    "SELECT set_config('statement_timeout', '0', false)",
    "SELECT lo_unlink(1)",
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT query_to_xml('DE' || 'LETE FROM orders RETURNING 1', true, false, '')",
    "SELECT * FROM dblink('db', 'select 1') AS t(x int)",
    "SELECT `sleep`(1)",
  ])
    assert.throws(() => validateReadOnlySql(query, 1_000), /read_only/, query);
  // Ordinary reads that merely mention similar words stay allowed.
  for (const query of ["SELECT currval_note, settings FROM orders", "SELECT * FROM pg_stat_activity", "SELECT lo FROM t"]) assert.equal(validateReadOnlySql(query, 1_000), query);
});

test("ignores keywords inside quoted literals and identifiers but never relaxes ambiguous quoting", () => {
  for (const query of [
    "SELECT id FROM logs WHERE msg LIKE '%logged into%'",
    "SELECT id FROM logs WHERE msg LIKE '%update failed, retry%'",
    "SELECT id, `into` FROM t",
    "SELECT \"set\", note FROM t WHERE note = 'for share (x)'",
    "SELECT id FROM t WHERE note = 'it''s an update'",
  ])
    assert.equal(validateReadOnlySql(query, 1_000), query, query);
  for (const query of [
    "SELECT * INTO t2 FROM t",
    "SELECT 'x' INTO OUTFILE '/tmp/x'",
    // A backslash makes literal boundaries dialect-dependent; the original text is checked and rejected.
    "SELECT '\\' INTO OUTFILE '/tmp/x' FROM t WHERE a = '",
    "SELECT 'unterminated update",
    'SELECT "pg_sleep"(1)',
    "SELECT * FROM t FOR UPDATE",
  ])
    assert.throws(() => validateReadOnlySql(query, 1_000), /read_only/, query);
});

test("never masks text that dollar-quoted or alternate-quoted strings could hide", () => {
  for (const query of [
    "SELECT $a$'$a$ AS x INTO evil FROM pg_class WHERE relname = $b$'$b$ AND true",
    "SELECT $$a$$ INTO evil FROM pg_class",
    "SELECT q'[']' AS x INTO evil FROM dual WHERE 1 = 1",
    "SELECT q'<x>' INTO evil FROM dual",
    "SELECT $é$'$é$ INTO evil FROM t WHERE x = $é$'$é$",
    "SELECT q'!a'b!' INTO evil FROM dual WHERE x = q'!c'd!'",
    "SELECT nq'[x]' INTO evil FROM dual",
  ])
    assert.throws(() => validateReadOnlySql(query, 1_000), /read_only/, query);
  // Ordinary reads that merely use a dollar sign still pass.
  assert.equal(validateReadOnlySql("SELECT price FROM t WHERE note = 'cost $5'", 1_000), "SELECT price FROM t WHERE note = 'cost $5'");
});
