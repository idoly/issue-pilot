import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";

import { constraintFailure } from "../../src/db/constraints.ts";
import { DomainError } from "../../src/domain/errors.ts";

test("translates driver constraint failures once and ignores codes embedded in query parameters", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-constraints-"));
  const client = createClient({ url: `file:${path.join(root, "constraints.db")}` });
  const db = drizzle(client);
  const failure = async (statement: ReturnType<typeof sql>) => {
    try {
      await db.run(statement);
    } catch (error) {
      return error;
    }
    assert.fail("statement must fail");
  };
  try {
    await client.execute("PRAGMA foreign_keys = ON");
    await client.batch([
      "CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT UNIQUE)",
      "CREATE TABLE child (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES parent(id), note TEXT)",
      "CREATE TRIGGER known BEFORE INSERT ON child WHEN new.note = 'known' BEGIN SELECT RAISE(ABORT, 'deployment_is_used_by_issues'); END",
      "CREATE TRIGGER unknown BEFORE INSERT ON child WHEN new.note = 'unknown' BEGIN SELECT RAISE(ABORT, 'fixture_write_failed'); END",
      "INSERT INTO parent VALUES (1, 'taken')",
    ]);
    const cases: Array<[ReturnType<typeof sql>, string | undefined]> = [
      [sql`INSERT INTO parent VALUES (2, ${"taken"})`, "conflict"],
      [sql`INSERT INTO parent VALUES (1, ${"other"})`, "conflict"],
      [sql`INSERT INTO child VALUES (1, 99, ${"plain"})`, "resource_in_use"],
      [sql`INSERT INTO child VALUES (2, 1, ${"known"})`, "deployment_is_used_by_issues"],
      [sql`INSERT INTO child VALUES (3, 1, ${"unknown"})`, undefined],
      // A parameter that spells a trigger code must not be mistaken for the trigger itself.
      [sql`INSERT INTO child VALUES (4, 1, ${"unknown"}), (5, 1, ${"SQLITE_CONSTRAINT: issue_deployment_required"})`, undefined],
    ];
    for (const [statement, code] of cases) {
      const translated = constraintFailure(await failure(statement));
      if (code === undefined) assert.equal(translated, undefined);
      else {
        assert.ok(translated instanceof DomainError);
        assert.equal(translated.code, code);
        assert.equal(translated.statusCode, 409);
      }
    }
    assert.equal(constraintFailure(new Error("UNIQUE constraint failed: parent.name")), undefined, "message text alone is not a constraint failure");
  } finally {
    client.close();
    await rm(root, { recursive: true, force: true });
  }
});
