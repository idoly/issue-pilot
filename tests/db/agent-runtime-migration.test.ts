import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/libsql/migrator";
import { openDatabase } from "../../src/db/client.ts";

test("adds an empty runtime configuration without changing the global model or codemode selection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-runtime-migration-")), folder = path.join(root, "migrations");
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
  const previous = { ...journal, entries: journal.entries.slice(0, journal.entries.findIndex((entry: { tag: string }) => entry.tag === "0057_agent_runtime")) };
  await mkdir(path.join(folder, "meta"), { recursive: true }); await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify(previous));
  for (const { tag } of previous.entries) await copyFile(`drizzle/${tag}.sql`, path.join(folder, `${tag}.sql`));
  const db = openDatabase(path.join(root, "issues.db"));
  try {
    await migrate(db.db, { migrationsFolder: folder });
    await db.client.execute("INSERT INTO global_agent_configuration (id,provider,model,thinking_level,codemode,created_at,updated_at) VALUES (1,'existing-provider','existing-model','high','only',11,22)");
    const original = (await db.client.execute("SELECT * FROM global_agent_configuration")).rows[0]!;
    await migrate(db.db, { migrationsFolder: path.resolve("drizzle") });
    const { runtime, ...retained } = (await db.client.execute("SELECT * FROM global_agent_configuration")).rows[0]!;
    assert.deepEqual(JSON.parse(String(runtime)), {}); assert.deepEqual(retained, original);
    assert.equal((await db.client.execute("PRAGMA integrity_check")).rows[0]!.integrity_check, "ok"); assert.equal((await db.client.execute("PRAGMA foreign_key_check")).rows.length, 0);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
