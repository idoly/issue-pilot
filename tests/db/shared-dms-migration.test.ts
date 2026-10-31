import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/libsql/migrator";
import { openDatabase } from "../../src/db/client.ts";

for (const scenario of ["same", "conflict", "incomplete", "empty"]) test(`shared DMS migration: ${scenario}`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-shared-dms-migration-"));
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
  const previous = { ...journal, entries: journal.entries.filter((entry: { idx: number }) => entry.idx < 65) };
  const folder = path.join(root, "migrations"); await mkdir(path.join(folder, "meta"), { recursive: true });
  await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify(previous));
  for (const { tag } of previous.entries) await copyFile(`drizzle/${tag}.sql`, path.join(folder, `${tag}.sql`));
  const db = openDatabase(path.join(root, "issues.db"));
  try {
    await migrate(db.db, { migrationsFolder: folder });
    await db.client.execute("INSERT INTO services(id,key,name,created_at,updated_at) VALUES ('s1','one','One',1,2),('s2','two','Two',1,2)");
    await db.client.execute("INSERT INTO environments(id,key,name,kind,created_at,updated_at) VALUES ('test','test','Test','test',1,1),('prod','prod','Prod','prod',1,1)");
    const configs = [0, 1].map(index => ({ dms: { url: "https://dms.example.test/sse", authorization: scenario === "conflict" && index ? "Bearer other" : scenario === "incomplete" && index ? "" : "Bearer literal-token", databases: [{ instanceAlias: `alias-${index}`, schemaName: `schema-${index}`, instanceId: "1", instanceHost: "db", instancePort: "3306", databaseId: String(index + 1) }] }, sls: { region: "cn-test", project: "project", logstores: ["*"] } }));
    if (scenario !== "empty") for (let i = 0; i < configs.length; i++) await db.client.execute({ sql: "INSERT INTO service_deployments(id,service_id,environment_id,config,created_at,updated_at) VALUES (?,?,?,?,1,2)", args: [`d${i}`, `s${i + 1}`, i ? "prod" : "test", JSON.stringify(configs[i])] });
    const before = (await db.client.execute("SELECT * FROM service_deployments ORDER BY id")).rows;
    const run = () => migrate(db.db, { migrationsFolder: path.resolve("drizzle") });
    if (scenario === "conflict" || scenario === "incomplete") {
      await assert.rejects(run(), /CHECK constraint/);
      assert.deepEqual((await db.client.execute("SELECT * FROM service_deployments ORDER BY id")).rows, before);
      assert.ok(!(await db.client.execute("PRAGMA table_info(application_settings)")).rows.some(row => row.name === "shared_dms_credentials"));
      configs[1]!.dms.authorization = "Bearer literal-token";
      await db.client.execute({ sql: "UPDATE service_deployments SET config=? WHERE id='d1'", args: [JSON.stringify(configs[1])] });
    }
    await run();
    const shared = (await db.client.execute("SELECT shared_dms_credentials,shared_dms_revision FROM application_settings WHERE id=1")).rows[0];
    if (scenario === "empty") assert.equal(shared, undefined);
    else {
      assert.deepEqual(JSON.parse(String(shared!.shared_dms_credentials)), { url: "https://dms.example.test/sse", authorization: "Bearer literal-token" });
      assert.equal(shared!.shared_dms_revision, 0);
      const after = (await db.client.execute("SELECT * FROM service_deployments ORDER BY id")).rows;
      after.forEach((row, index) => { assert.deepEqual(JSON.parse(String(row.config)), { ...configs[index], dms: { databases: configs[index]!.dms.databases } }); assert.equal(row.created_at, 1); assert.equal(row.updated_at, 2); });
      assert.deepEqual((await db.client.execute("SELECT revision FROM services ORDER BY id")).rows.map(row => row.revision), [1, 1]);
      await run(); assert.deepEqual((await db.client.execute("SELECT * FROM service_deployments ORDER BY id")).rows, after);
    }
    assert.equal((await db.client.execute("PRAGMA integrity_check")).rows[0]!.integrity_check, "ok");
    assert.deepEqual((await db.client.execute("PRAGMA foreign_key_check")).rows, []);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
