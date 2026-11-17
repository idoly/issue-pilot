import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/libsql/migrator";

import { openDatabase } from "../../src/db/client.ts";
import { migrateBefore } from "./migration-fixture.ts";

test("drops retired Issue comments with their trigger and index while other detail revisions keep advancing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-drop-comments-"));
  const database = openDatabase(path.join(root, "issues.db"));
  const { client } = database;
  try {
    await migrateBefore(database, path.join(root, "before-comment-removal"), "0081_drop_issue_comments");
    await client.execute("PRAGMA foreign_keys = ON");
    await client.batch(
      [
        "INSERT INTO subjects (subject, role, active, created_at, updated_at) VALUES ('owner', 'developer', 1, 1, 1)",
        "INSERT INTO environments (id, key, name, kind, created_at, updated_at) VALUES ('env', 'test', 'Test', 'test', 1, 1)",
        "INSERT INTO services (id, key, name, created_at, updated_at) VALUES ('service', 'orders', 'Orders', 1, 1)",
        "INSERT INTO service_deployments (id, service_id, environment_id, config, created_at, updated_at) VALUES ('deployment', 'service', 'env', '{}', 1, 1)",
        "INSERT INTO issues (id, key, title, type, service_id, environment_id, reporter_subject, created_at, updated_at) VALUES ('main', 'ISSUE-20261117-001', 'Issue', 'smart_analysis', 'service', 'env', 'owner', 1, 1), ('other', 'ISSUE-20261117-002', 'Other', 'smart_analysis', 'service', 'env', 'owner', 1, 1)",
        "INSERT INTO issue_workspaces (issue_id, created_at, updated_at) VALUES ('main', 1, 1), ('other', 1, 1)",
        "INSERT INTO issue_comments (id, issue_id, author_subject, body, created_at) VALUES ('c1', 'main', 'owner', 'Historical note', 1), ('c2', 'other', 'owner', 'Another', 1)",
      ],
      "write",
    );
    const revision = async () => Number((await client.execute("SELECT detail_revision FROM issues WHERE id = 'main'")).rows[0]!.detail_revision);
    assert.equal(await revision(), 1);
    assert.equal((await client.execute("SELECT count(*) AS count FROM issue_comments")).rows[0]!.count, 2);

    await migrate(database.db, { migrationsFolder: path.resolve("drizzle") });
    assert.deepEqual((await client.execute("SELECT type, name FROM sqlite_master WHERE name LIKE '%comment%' OR sql LIKE '%issue_comments%'")).rows, []);
    // Existing counters are kept, and the remaining 0078 triggers still advance them.
    assert.equal(await revision(), 1);
    await client.execute("UPDATE issues SET description = 'Edited' WHERE id = 'main'");
    await client.execute("INSERT INTO issue_relations (issue_id, related_issue_id, created_at) VALUES ('main', 'other', 1)");
    assert.equal(await revision(), 3);
    assert.equal((await client.execute("SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%revision'")).rows[0]!.count, 13);
    assert.equal((await client.execute("PRAGMA integrity_check")).rows[0]!.integrity_check, "ok");
    assert.equal((await client.execute("PRAGMA foreign_key_check")).rows.length, 0);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
