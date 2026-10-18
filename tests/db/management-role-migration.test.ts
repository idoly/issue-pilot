import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/libsql/migrator";
import { openDatabase } from "../../src/db/client.ts";

test("grants global management only to the specified user without changing business roles or credentials", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-management-migration-")), folder = path.join(root, "migrations");
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
  const previous = { ...journal, entries: journal.entries.slice(0, journal.entries.findIndex((entry: { tag: string }) => entry.tag === "0058_management_role")) };
  await mkdir(path.join(folder, "meta"), { recursive: true });
  await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify(previous));
  for (const { tag } of previous.entries) await copyFile(`drizzle/${tag}.sql`, path.join(folder, `${tag}.sql`));
  const db = openDatabase(path.join(root, "issues.db"));
  try {
    await migrate(db.db, { migrationsFolder: folder });
    for (const subject of ["yx4821@xianhengguoji.com", "other@example.test"]) {
      await db.client.execute({ sql: "INSERT INTO subjects (subject,display_name,role,active,created_at,updated_at) VALUES (?, '严欣', 'developer', 1, 11, 22)", args: [subject] });
      await db.client.execute({ sql: "INSERT INTO user_credentials (subject,model_api_keys,git_private_key,updated_at) VALUES (?, '{\"fixture\":\"private-token\"}', 'private-key', 33)", args: [subject] });
    }
    const credentials = (await db.client.execute("SELECT * FROM user_credentials ORDER BY subject")).rows;
    await migrate(db.db, { migrationsFolder: path.resolve("drizzle") });
    const users = (await db.client.execute("SELECT subject,role,is_admin,created_at,updated_at FROM subjects ORDER BY subject")).rows;
    assert.equal(users[0]!.role, "developer"); assert.equal(users[0]!.is_admin, 0); assert.equal(users[0]!.updated_at, 22);
    assert.equal(users[1]!.role, "developer"); assert.equal(users[1]!.is_admin, 1); assert.equal(users[1]!.created_at, 11);
    assert.deepEqual((await db.client.execute("SELECT * FROM user_credentials ORDER BY subject")).rows, credentials);
    await assert.rejects(db.client.execute("UPDATE subjects SET role='admin'"), /CHECK constraint/);
    await migrate(db.db, { migrationsFolder: path.resolve("drizzle") });
    assert.deepEqual((await db.client.execute("SELECT subject,role,is_admin,created_at,updated_at FROM subjects ORDER BY subject")).rows, users);
    assert.equal((await db.client.execute("PRAGMA integrity_check")).rows[0]!.integrity_check, "ok");
    assert.equal((await db.client.execute("PRAGMA foreign_key_check")).rows.length, 0);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
