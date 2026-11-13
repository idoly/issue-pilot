import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/libsql/migrator";

import { openDatabase } from "../../src/db/client.ts";

test("backfills the release marker only for recorded development snapshots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-release-migration-"));
  const folder = path.join(root, "migrations");
  const database = openDatabase(path.join(root, "issues.db"));
  try {
    const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
    const entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 77);
    await mkdir(path.join(folder, "meta"), { recursive: true });
    await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    for (const { tag } of entries) await copyFile(`drizzle/${tag}.sql`, path.join(folder, `${tag}.sql`));
    await migrate(database.db, { migrationsFolder: folder });

    await database.client.execute("INSERT INTO subjects (subject, role, active, created_at, updated_at) VALUES ('owner', 'developer', 1, 1, 1)");
    await database.client.execute("INSERT INTO environments (id, key, name, kind, created_at, updated_at) VALUES ('env', 'dev', 'Dev', 'dev', 1, 1)");
    await database.client.execute("INSERT INTO services (id, key, name, created_at, updated_at) VALUES ('service', 'orders', 'Orders', 1, 1)");
    await database.client.execute("INSERT INTO service_deployments (id, service_id, environment_id, config, created_at, updated_at) VALUES ('deployment', 'service', 'env', '{}', 1, 1)");
    for (const [id, updatedAt] of [
      ["released", 111],
      ["active", 222],
      ["readonly", 333],
      ["running", 444],
    ] as const) {
      await database.client.execute({
        sql: "INSERT INTO issues (id, key, title, type, service_id, environment_id, reporter_subject, status, resolved_at, created_at, updated_at) VALUES (?, ?, 'Release fixture', 'defect_fix', 'service', 'env', 'owner', 'resolved', ?, 1, ?)",
        args: [id, `ISSUE-20261113-${String(updatedAt).slice(-3)}`, updatedAt, updatedAt],
      });
    }
    for (const [issueId, status, updatedAt] of [
      ["released", "stopped", 111],
      ["active", "stopped", 222],
      ["readonly", "stopped", 333],
      ["running", "ready", 444],
    ] as const) {
      await database.client.execute({
        sql: "INSERT INTO issue_workspaces (issue_id, status, runtime_ready, created_at, updated_at) VALUES (?, ?, 0, 1, ?)",
        args: [issueId, status, updatedAt],
      });
    }
    for (const [issueId, url, localPath, workingBranch] of [
      ["released", "https://example.test/released.git", null, "hotfix-issue-20261113-111"],
      ["active", "https://example.test/active.git", "/state/workspaces/active/repo", "hotfix-issue-20261113-222"],
      ["readonly", "https://example.test/readonly.git", null, null],
      ["running", "https://example.test/running.git", null, "hotfix-issue-20261113-444"],
    ] as const) {
      await database.client.execute({
        sql: "INSERT INTO issue_repositories (id, issue_id, url, base_branch, working_branch, local_path, created_at, updated_at) VALUES (?, ?, ?, 'main', ?, ?, 1, 1)",
        args: [`repository-${issueId}`, issueId, url, workingBranch, localPath],
      });
    }

    await migrate(database.db, { migrationsFolder: path.resolve("drizzle") });
    const rows = (await database.client.execute("SELECT issue_id, released_at FROM issue_workspaces ORDER BY issue_id")).rows;
    assert.deepEqual(
      rows.map((row) => [row.issue_id, row.released_at]),
      [
        ["active", null],
        ["readonly", null],
        ["released", 111],
        ["running", null],
      ],
    );
    assert.deepEqual((await database.client.execute("PRAGMA foreign_key_check")).rows, []);
    assert.equal((await database.client.execute("PRAGMA integrity_check")).rows[0]!.integrity_check, "ok");
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
