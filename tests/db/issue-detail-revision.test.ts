import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/libsql/migrator";

import { openDatabase } from "../../src/db/client.ts";
import { migrateBefore } from "./migration-fixture.ts";

test("upgrades existing Issue details and versions only committed changes to the owning Issue", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-detail-revision-"));
  const database = openDatabase(path.join(root, "issues.db"));
  try {
    await migrateBefore(database, path.join(root, "before-detail-revision"), "0078_issue_detail_revision");
    await database.client.execute("PRAGMA foreign_keys = ON");
    const initialComment = "INSERT INTO issue_comments (id, issue_id, author_subject, body, created_at) VALUES ('old', 'main', 'owner', 'Existing comment', 1)";
    await database.client.batch(
      [
        "INSERT INTO subjects (subject, role, active, created_at, updated_at) VALUES ('owner', 'developer', 1, 1, 1)",
        "INSERT INTO environments (id, key, name, kind, created_at, updated_at) VALUES ('env', 'test', 'Test', 'test', 1, 1)",
        "INSERT INTO services (id, key, name, created_at, updated_at) VALUES ('service', 'orders', 'Orders', 1, 1), ('included', 'billing', 'Billing', 1, 1)",
        "INSERT INTO service_deployments (id, service_id, environment_id, config, created_at, updated_at) VALUES ('deployment', 'service', 'env', '{}', 1, 1), ('extra', 'included', 'env', '{}', 1, 1)",
        "INSERT INTO issues (id, key, title, description, type, service_id, environment_id, reporter_subject, created_at, updated_at) VALUES ('main', 'ISSUE-20261115-001', 'Issue', 'Existing description', 'smart_analysis', 'service', 'env', 'owner', 1, 1), ('other', 'ISSUE-20261115-002', 'Other', '', 'smart_analysis', 'service', 'env', 'owner', 1, 1)",
        "INSERT INTO issue_workspaces (issue_id, created_at, updated_at) VALUES ('main', 1, 1), ('other', 1, 1)",
        initialComment,
      ],
      "write",
    );
    const { client } = database;
    await migrate(database.db, { migrationsFolder: path.resolve("drizzle") });
    let revision = 0;
    const assertState = async () => {
      assert.deepEqual((await client.execute("SELECT id, detail_revision, updated_at FROM issues ORDER BY id")).rows, [
        { id: "main", detail_revision: revision, updated_at: 1 },
        { id: "other", detail_revision: 0, updated_at: 1 },
      ]);
    };
    await assertState();
    assert.equal((await client.execute("SELECT description FROM issues WHERE id = 'main'")).rows[0]?.description, "Existing description");
    assert.equal((await client.execute("SELECT body FROM issue_comments WHERE id = 'old'")).rows[0]?.body, "Existing comment");

    const descriptionEdit = "UPDATE issues SET description = 'Edited' WHERE id = 'main'";
    const addAttachment =
      "INSERT INTO issue_attachments (id, issue_id, file_name, media_type, size, object_key, sha256, uploaded_by, created_at) VALUES ('attachment', 'main', 'sample.txt', 'text/plain', 1, '.attachment-sample', 'digest', 'owner', 1)";
    // The earlier changes and their version increments must roll back when a later statement fails.
    await assert.rejects(client.batch([descriptionEdit, addAttachment, initialComment], "write"), /UNIQUE/);
    await assertState();
    assert.equal((await client.execute("SELECT description FROM issues WHERE id = 'main'")).rows[0]?.description, "Existing description");
    assert.equal((await client.execute("SELECT count(*) AS count FROM issue_attachments")).rows[0]?.count, 0);

    for (const change of [
      descriptionEdit,
      "INSERT INTO issue_comments (id, issue_id, author_subject, body, created_at) VALUES ('new', 'main', 'owner', 'New comment', 1)",
      addAttachment,
      "DELETE FROM issue_attachments WHERE id = 'attachment'",
      "INSERT INTO issue_relations (issue_id, related_issue_id, created_at) VALUES ('main', 'other', 1)",
      "DELETE FROM issue_relations WHERE issue_id = 'main'",
      "INSERT INTO issue_service_scopes (issue_id, service_id, created_at) VALUES ('main', 'included', 1)",
      "DELETE FROM issue_service_scopes WHERE issue_id = 'main'",
      "INSERT INTO issue_repositories (id, issue_id, url, base_branch, created_at, updated_at) VALUES ('repo', 'main', 'https://example.test/orders.git', 'main', 1, 1)",
      "UPDATE issue_repositories SET base_branch = 'develop' WHERE id = 'repo'",
      "DELETE FROM issue_repositories WHERE id = 'repo'",
      "INSERT INTO issue_scope_transitions (id, issue_id, actor_subject, action, from_service_key, from_service_name, from_work_mode, to_service_key, to_service_name, to_work_mode, plan_hash, repositories, created_at) VALUES ('change', 'main', 'owner', 'rebind_read_only', 'orders', 'Orders', 'test_analysis', 'billing', 'Billing', 'test_analysis', 'fixture', '{}', 1)",
      "INSERT INTO issue_pilot_sessions (issue_id, session_file, workspace_path, created_at, updated_at) VALUES ('main', '.session-1.jsonl', '.', 1, 1)",
      "UPDATE issue_pilot_sessions SET session_file = '.session-2.jsonl' WHERE issue_id = 'main'",
    ]) {
      await client.execute(change);
      revision++;
      await assertState();
    }
    await client.execute(descriptionEdit);
    await assertState();

    // A cascading deletion must not create a version or change the surviving Issue.
    await client.execute("INSERT INTO issue_relations (issue_id, related_issue_id, created_at) VALUES ('main', 'other', 1)");
    await client.execute("DELETE FROM issues WHERE id = 'main'");
    assert.deepEqual((await client.execute("SELECT id, detail_revision FROM issues")).rows, [{ id: "other", detail_revision: 0 }]);
    assert.deepEqual((await client.execute("PRAGMA foreign_key_check")).rows, []);
    assert.equal((await client.execute("PRAGMA integrity_check")).rows[0]?.integrity_check, "ok");
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
