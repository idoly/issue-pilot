import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/libsql/migrator";
import { openDatabase } from "../../src/db/client.ts";
import { loadApplicationParameterState } from "../../src/configuration/parameters.ts";

test("moves the saved Agent concurrency into validated parameters without losing other settings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-parameters-migration-")),
    folder = path.join(root, "migrations");
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
  const previous = {
    ...journal,
    entries: journal.entries.slice(
      0,
      journal.entries.findIndex((entry: { tag: string }) => entry.tag === "0069_application_parameters"),
    ),
  };
  await mkdir(path.join(folder, "meta"), { recursive: true });
  await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify(previous));
  for (const { tag } of previous.entries) await copyFile(`drizzle/${tag}.sql`, path.join(folder, `${tag}.sql`));
  const db = openDatabase(path.join(root, "issues.db"));
  try {
    await migrate(db.db, { migrationsFolder: folder });
    await db.client.execute('INSERT INTO application_settings (id,max_concurrent_issues,dingtalk_fields) VALUES (1,7,\'{"title":"序号"}\')');
    await migrate(db.db, { migrationsFolder: path.resolve("drizzle") });
    const rows = (await db.client.execute("SELECT id, parameters, parameters_revision, dingtalk_fields FROM application_settings")).rows;
    assert.deepEqual(JSON.parse(String(rows[0]!.parameters)), { maxConcurrentIssues: 7 });
    assert.equal(rows[0]!.parameters_revision, 1);
    assert.deepEqual(JSON.parse(String(rows[0]!.dingtalk_fields)), { title: "序号" });
    // 0082 drops the retired concurrency column after 0069 copied it into parameters.
    assert.equal(
      (await db.client.execute("PRAGMA table_info('application_settings')")).rows.some((column) => column.name === "max_concurrent_issues"),
      false,
    );

    assert.equal((await loadApplicationParameterState(db.db)).values.maxConcurrentIssues, 7);
    assert.equal((await loadApplicationParameterState(db.db)).values.networkMode, "open");
    await db.client.execute("UPDATE application_settings SET parameters = '{}' WHERE id = 1");
    assert.equal((await loadApplicationParameterState(db.db)).values.maxConcurrentIssues, 10);
    assert.equal((await db.client.execute("PRAGMA integrity_check")).rows[0]!.integrity_check, "ok");
    assert.equal((await db.client.execute("PRAGMA foreign_key_check")).rows.length, 0);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
