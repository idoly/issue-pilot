import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/libsql/migrator";
import { openDatabase } from "../../src/db/client.ts";

test("adds enabled codemode to the global Agent without changing its existing model", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-codemode-migration-")), folder = path.join(root, "migrations");
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
  const previous = { ...journal, entries: journal.entries.slice(0, journal.entries.findIndex((entry: { tag: string }) => entry.tag === "0056_agent_codemode")) };
  await mkdir(path.join(folder, "meta"), { recursive: true });
  await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify(previous));
  for (const { tag } of previous.entries) await copyFile(`drizzle/${tag}.sql`, path.join(folder, `${tag}.sql`));
  const db = openDatabase(path.join(root, "issues.db"));
  try {
    await migrate(db.db, { migrationsFolder: folder });
    await db.client.execute("INSERT INTO global_agent_configuration (id,provider,model,thinking_level,created_at,updated_at) VALUES (1,'existing-provider','existing-model','high',11,22)");
    const original = (await db.client.execute("SELECT * FROM global_agent_configuration")).rows[0]!;
    await migrate(db.db, { migrationsFolder: path.resolve("drizzle") });
    const migrated = (await db.client.execute("SELECT * FROM global_agent_configuration")).rows[0]!;
    const retained = Object.fromEntries(Object.keys(original).map(key => [key, migrated[key]]));
    assert.equal(migrated.codemode, "on"); assert.deepEqual(retained, original);
    await assert.rejects(db.client.execute("UPDATE global_agent_configuration SET codemode='invalid'"), /CHECK constraint/);
    assert.equal((await db.client.execute("PRAGMA integrity_check")).rows[0]!.integrity_check, "ok");
    assert.equal((await db.client.execute("PRAGMA foreign_key_check")).rows.length, 0);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
