import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/libsql/migrator";

import { openDatabase } from "../../src/db/client.ts";
import { constraintFailure } from "../../src/db/constraints.ts";
import { migrateBefore } from "./migration-fixture.ts";

test("guards closed Issue, Workspace and Environment domains and included-service deployments without coercing rows", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-closed-domains-"));
  const database = openDatabase(path.join(root, "issues.db"));
  const { client } = database;
  const current = () => migrate(database.db, { migrationsFolder: path.resolve("drizzle") });
  try {
    await migrateBefore(database, path.join(root, "before-closed-domains"), "0080_closed_domain_guards");
    await client.batch(
      [
        "INSERT INTO subjects (subject, role, active, created_at, updated_at) VALUES ('owner', 'developer', 1, 1, 1)",
        "INSERT INTO environments (id, key, name, kind, created_at, updated_at) VALUES ('env', 'test', 'Test', 'test', 1, 1), ('other-env', 'dev', 'Dev', 'dev', 1, 1), ('prod-env', 'prod', 'Prod', 'prod', 1, 1)",
        "INSERT INTO services (id, key, name, created_at, updated_at) VALUES ('entry', 'orders', 'Orders', 1, 1), ('included', 'billing', 'Billing', 1, 1)",
        "INSERT INTO service_deployments (id, service_id, environment_id, config, created_at, updated_at) VALUES ('entry-test', 'entry', 'env', '{}', 1, 1), ('included-test', 'included', 'env', '{}', 1, 1), ('included-dev', 'included', 'other-env', '{}', 1, 1)",
        "INSERT INTO issues (id, key, title, type, service_id, environment_id, reporter_subject, created_at, updated_at) VALUES ('issue', 'ISSUE-20261117-001', 'Issue', 'smart_analysis', 'entry', 'env', 'owner', 1, 1)",
        "INSERT INTO issue_workspaces (issue_id, created_at, updated_at) VALUES ('issue', 1, 1)",
        "INSERT INTO issue_service_scopes (issue_id, service_id, created_at) VALUES ('issue', 'included', 1)",
      ],
      "write",
    );

    // Each pre-existing out-of-domain value blocks the upgrade instead of being rewritten.
    for (const [corrupt, restore] of [
      ["UPDATE issues SET status = 'closed'", "UPDATE issues SET status = 'open'"],
      ["UPDATE issues SET priority = 'urgent'", "UPDATE issues SET priority = 'p2'"],
      ["UPDATE issue_workspaces SET status = 'archived'", "UPDATE issue_workspaces SET status = 'not_created'"],
      ["UPDATE environments SET kind = 'staging' WHERE id = 'other-env'", "UPDATE environments SET kind = 'dev' WHERE id = 'other-env'"],
    ] as const) {
      await client.execute(corrupt);
      await assert.rejects(current(), /CHECK constraint failed/, corrupt);
      await client.execute(restore);
    }
    await current();
    await client.execute("PRAGMA foreign_keys = ON");

    for (const [statement, code] of [
      ["UPDATE issues SET status = 'closed'", "invalid_issue_status"],
      ["UPDATE issues SET priority = 'urgent'", "invalid_issue_priority"],
      ["UPDATE issue_workspaces SET status = 'archived'", "invalid_workspace_status"],
      ["UPDATE environments SET kind = 'staging' WHERE id = 'other-env'", "invalid_environment_kind"],
      [
        "INSERT INTO issues (id, key, title, type, status, service_id, environment_id, reporter_subject, created_at, updated_at) VALUES ('bad', 'ISSUE-20261117-002', 'Bad', 'smart_analysis', 'closed', 'entry', 'env', 'owner', 1, 1)",
        "invalid_issue_status",
      ],
      [
        "INSERT INTO issues (id, key, title, type, priority, service_id, environment_id, reporter_subject, created_at, updated_at) VALUES ('bad', 'ISSUE-20261117-002', 'Bad', 'smart_analysis', 'p9', 'entry', 'env', 'owner', 1, 1)",
        "invalid_issue_priority",
      ],
      ["INSERT INTO environments (id, key, name, kind, created_at, updated_at) VALUES ('stage', 'stage', 'Stage', 'staging', 1, 1)", "invalid_environment_kind"],
    ] as const)
      await assert.rejects(client.execute(statement), new RegExp(code), statement);
    await assert.rejects(client.execute("INSERT INTO issue_workspaces (issue_id, status, created_at, updated_at) VALUES ('missing', 'archived', 1, 1)"), /invalid_workspace_status/);

    // Values inside the closed sets, including the recovery transitions, still apply.
    await client.batch(
      [
        "UPDATE issues SET status = 'in_progress', priority = 'p0'",
        "UPDATE issue_workspaces SET status = 'running'",
        "UPDATE issue_workspaces SET status = 'failed'",
        "UPDATE issues SET status = 'pending'",
        "UPDATE environments SET kind = 'dev' WHERE id = 'other-env'",
      ],
      "write",
    );

    // The included service's deployment in the Issue environment is protected; its other deployments are not.
    const blocked = await client.execute("DELETE FROM service_deployments WHERE id = 'included-test'").catch((error: unknown) => error);
    assert.equal(constraintFailure(blocked)?.message, "deployment_is_used_by_issues");
    await assert.rejects(client.execute("UPDATE service_deployments SET environment_id = 'prod-env' WHERE id = 'included-test'"), /deployment_is_used_by_issues/);
    await client.execute("DELETE FROM service_deployments WHERE id = 'included-dev'");
    await client.execute("DELETE FROM issue_service_scopes WHERE issue_id = 'issue'");
    await client.execute("DELETE FROM service_deployments WHERE id = 'included-test'");

    assert.equal((await client.execute("PRAGMA integrity_check")).rows[0]!.integrity_check, "ok");
    assert.equal((await client.execute("PRAGMA foreign_key_check")).rows.length, 0);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
