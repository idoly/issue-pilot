import assert from "node:assert/strict";
import test from "node:test";

import { validateReadOnlyQuery } from "../../src/evidence/mysql.ts";

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
