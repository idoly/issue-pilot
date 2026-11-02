import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/libsql/migrator";
import { openDatabase } from "../../src/db/client.ts";

test("converts only the key for the current global provider into a personal model group", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-personal-model-migration-")), folder = path.join(root, "migrations");
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
  const previous = { ...journal, entries: journal.entries.slice(0, journal.entries.findIndex((entry: { tag: string }) => entry.tag === "0067_personal_model_credentials")) };
  await mkdir(path.join(folder, "meta"), { recursive: true }); await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify(previous));
  for (const { tag } of previous.entries) await copyFile(`drizzle/${tag}.sql`, path.join(folder, `${tag}.sql`));
  const db = openDatabase(path.join(root, "issues.db"));
  try {
    await migrate(db.db, { migrationsFolder: folder });
    await db.client.execute("INSERT INTO global_agent_configuration (id,provider,model,thinking_level,codemode,created_at,updated_at) VALUES (1,'global.provider','global-model','high','only',1,1)");
    for (const [subject, keys] of [["matching", { "global.provider": "matching-key", other: "kept-history" }], ["other", { other: "other-key" }], ["empty", { "global.provider": "" }]] as const) {
      await db.client.execute({ sql: "INSERT INTO subjects (subject,created_at,updated_at) VALUES (?,1,1)", args: [subject] });
      await db.client.execute({ sql: "INSERT INTO user_credentials (subject,revision,model_api_keys,updated_at) VALUES (?,3,?,1)", args: [subject, JSON.stringify(keys)] });
    }
    await migrate(db.db, { migrationsFolder: path.resolve("drizzle") });
    const rows = Object.fromEntries((await db.client.execute("SELECT subject, revision, model_api_keys, model_credentials FROM user_credentials")).rows.map(row => [row.subject, row]));
    assert.deepEqual(JSON.parse(String(rows.matching!.model_credentials)), { provider: "global.provider", model: "global-model", thinkingLevel: "high", codemode: "only", apiKey: "matching-key" });
    assert.equal(rows.matching!.revision, 4);
    assert.deepEqual(JSON.parse(String(rows.matching!.model_api_keys)), { "global.provider": "matching-key", other: "kept-history" });
    for (const subject of ["other", "empty"]) { assert.equal(rows[subject]!.model_credentials, null); assert.equal(rows[subject]!.revision, 3); }
    assert.equal((await db.client.execute("PRAGMA integrity_check")).rows[0]!.integrity_check, "ok"); assert.equal((await db.client.execute("PRAGMA foreign_key_check")).rows.length, 0);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
