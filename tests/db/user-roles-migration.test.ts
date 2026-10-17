import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/libsql/migrator";
import { openDatabase } from "../../src/db/client.ts";

test("migrates existing users to developers and defaults new users to product without creating credentials", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-role-migration-"));
  const migrationRoot = path.join(root, "migrations");
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
  const previous = { ...journal, entries: journal.entries.slice(0, journal.entries.findIndex((entry: { tag: string }) => entry.tag === "0045_user_roles_credentials")) };
  await mkdir(path.join(migrationRoot, "meta"), { recursive: true });
  await writeFile(path.join(migrationRoot, "meta/_journal.json"), JSON.stringify(previous));
  for (const { tag } of previous.entries) await copyFile(`drizzle/${tag}.sql`, path.join(migrationRoot, `${tag}.sql`));
  const connection = openDatabase(path.join(root, "issues.db"));
  try {
    await migrate(connection.db, { migrationsFolder: migrationRoot });
    await connection.client.execute("insert into subjects (subject, display_name, email, created_at, updated_at, active) values ('old', 'Old', 'old@example.test', 1, 1, 1)");
    await migrate(connection.db, { migrationsFolder: path.resolve("drizzle") });
    assert.equal((await connection.client.execute("select role from subjects where subject='old'")).rows[0]!.role, "developer");
    await connection.client.execute("insert into subjects (subject, created_at, updated_at) values ('new', 1, 1)");
    assert.equal((await connection.client.execute("select role from subjects where subject='new'")).rows[0]!.role, "product");
    await assert.rejects(connection.client.execute("update subjects set role='admin'"), /CHECK constraint/);
    assert.equal((await connection.client.execute("select count(*) count from user_credentials")).rows[0]!.count, 0);
    assert.equal((await connection.client.execute("pragma integrity_check")).rows[0]!.integrity_check, "ok");
    assert.equal((await connection.client.execute("pragma foreign_key_check")).rows.length, 0);
  } finally { connection.close(); await rm(root, { recursive: true, force: true }); }
});
