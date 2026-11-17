import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { openDatabase } from "../../src/db/client.ts";
import { migrateBefore, migrateThrough } from "./migration-fixture.ts";

test("drops redundant retired-type triggers and replaces the production-data guard with a closed work-mode set", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-trigger-cleanup-"));
  const database = openDatabase(path.join(root, "issues.db"));
  const { client } = database;
  const folder = path.join(root, "through-trigger-cleanup");
  const transition = (id: string, from: string, to: string) =>
    `INSERT INTO issue_scope_transitions (id, issue_id, actor_subject, action, from_service_key, from_service_name, from_work_mode, to_service_key, to_service_name, to_work_mode, plan_hash, repositories, created_at)
     VALUES ('${id}', 'issue', 'owner', 'rebind', 'orders', 'Orders', '${from}', 'orders', 'Orders', '${to}', 'plan-${id}', '[]', 1)`;
  const triggerNames = async () => (await client.execute("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")).rows.map((row) => row.name);
  try {
    await migrateBefore(database, path.join(root, "before-trigger-cleanup"), "0083_redundant_trigger_cleanup");
    await client.batch(
      [
        "INSERT INTO subjects (subject, role, active, created_at, updated_at) VALUES ('owner', 'developer', 1, 1, 1)",
        "INSERT INTO environments (id, key, name, kind, created_at, updated_at) VALUES ('test', 'test', 'Test', 'test', 1, 1)",
        "INSERT INTO services (id, key, name, created_at, updated_at) VALUES ('orders', 'orders', 'Orders', 1, 1)",
        "INSERT INTO service_deployments (id, service_id, environment_id, config, created_at, updated_at) VALUES ('deployment', 'orders', 'test', '{}', 1, 1)",
        "INSERT INTO issues (id, key, title, type, service_id, environment_id, reporter_subject, created_at, updated_at) VALUES ('issue', 'ISSUE-20261117-001', 'Issue', 'smart_analysis', 'orders', 'test', 'owner', 1, 1)",
        transition("valid", "production_analysis", "test_analysis"),
        // Before 0083 the retired-mode trigger only rejects production_data, so an unknown value is still accepted.
        transition("legacy", "legacy_mode", "test_analysis"),
      ],
      "write",
    );
    assert.ok((await triggerNames()).includes("issues_retired_type_insert"));
    assert.ok((await triggerNames()).includes("scope_transitions_retired_mode_insert"));

    // Existing out-of-set rows block the upgrade instead of being rewritten.
    await assert.rejects(migrateThrough(database, folder, "0083_redundant_trigger_cleanup"), /CHECK constraint failed/);
    await client.execute("UPDATE issue_scope_transitions SET from_work_mode = 'production_analysis' WHERE id = 'legacy'");
    await migrateThrough(database, folder, "0083_redundant_trigger_cleanup");

    const triggers = await triggerNames();
    for (const removed of ["issues_retired_type_insert", "issues_retired_type_update", "scope_transitions_retired_mode_insert", "scope_transitions_retired_mode_update"])
      assert.equal(triggers.includes(removed), false, removed);
    for (const kept of [
      "issues_type_valid_insert",
      "issues_type_valid_update",
      "issue_scope_transitions_work_mode_valid_insert",
      "issue_scope_transitions_work_mode_valid_update",
      "issues_status_valid_insert",
      "issues_resolution_state_insert",
      "issue_workspaces_status_valid_insert",
      "environments_kind_valid_insert",
    ])
      assert.ok(triggers.includes(kept), kept);

    for (const [statement, message] of [
      [transition("retired", "production_data", "test_analysis"), "invalid_issue_work_mode"],
      [transition("unknown", "test_analysis", "legacy_mode"), "invalid_issue_work_mode"],
      ["UPDATE issue_scope_transitions SET to_work_mode = 'production_data' WHERE id = 'valid'", "invalid_issue_work_mode"],
      ["UPDATE issues SET type = 'request' WHERE id = 'issue'", "invalid_issue_type"],
    ] as const)
      await assert.rejects(client.execute(statement), new RegExp(message), statement);

    await client.batch(
      [
        transition("closed", "production_analysis", "test_analysis"),
        transition("development", "development_fix", "development_feature"),
        "UPDATE issue_scope_transitions SET to_work_mode = 'test_analysis' WHERE id = 'valid'",
      ],
      "write",
    );
    assert.equal((await client.execute("SELECT count(*) AS count FROM issue_scope_transitions")).rows[0]!.count, 4);
    assert.equal((await client.execute("PRAGMA integrity_check")).rows[0]!.integrity_check, "ok");
    assert.equal((await client.execute("PRAGMA foreign_key_check")).rows.length, 0);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
