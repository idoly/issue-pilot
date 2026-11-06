import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/libsql/migrator";
import { openDatabase } from "../../src/db/client.ts";

test("0072 removes only current SLS target names, preserves exact scopes and private history, and runs once", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-sls-scope-migration-"));
  const folder = path.join(root, "migrations");
  const db = openDatabase(path.join(root, "issues.db"));
  try {
    const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
    const entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 72);
    await mkdir(path.join(folder, "meta"), { recursive: true });
    await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    for (const { tag } of entries) await copyFile(`drizzle/${tag}.sql`, path.join(folder, `${tag}.sql`));
    await migrate(db.db, { migrationsFolder: folder });
    await db.client.execute("INSERT INTO services(id,key,name,revision,created_at,updated_at) VALUES ('s','orders','Orders',4,1,2),('u','unchanged','Unchanged',7,1,2)");
    await db.client.execute("INSERT INTO environments(id,key,name,kind,created_at,updated_at) VALUES ('test','test','Test','test',1,2),('prod','prod','Prod','prod',1,2)");
    const scope = { region: "cn-hangzhou", project: "orders-project", logstores: ["orders"] };
    const config = {
      sls: {
        ...scope,
        targets: [
          { name: "test", ...scope },
          { name: "target-1", ...scope, logstores: ["gateway"] },
        ],
      },
      dms: { databases: [{ instanceAlias: "ACTUAL-INSTANCE", schemaName: "orders" }] },
      archivedDevelopment: { sls: { targets: [{ name: "historical", ...scope }] } },
    };
    for (const [id, env, value] of [
      ["d1", "test", config],
      ["d2", "prod", config],
    ] as const) {
      await db.client.execute({ sql: "INSERT INTO service_deployments(id,service_id,environment_id,config,created_at,updated_at) VALUES (?,'s',?,?,1,2)", args: [id, env, JSON.stringify(value)] });
    }
    await db.client.execute({
      sql: "INSERT INTO service_deployments(id,service_id,environment_id,config,created_at,updated_at) VALUES ('flat','u','test',?,1,2)",
      args: [JSON.stringify({ sls: scope })],
    });
    const untouched = (await db.client.execute("SELECT * FROM service_deployments WHERE id='flat'")).rows;
    await migrate(db.db, { migrationsFolder: path.resolve("drizzle") });
    for (const row of (await db.client.execute("SELECT config,created_at FROM service_deployments WHERE service_id='s' ORDER BY id")).rows) {
      assert.deepEqual(JSON.parse(String(row.config)), { ...config, sls: { ...scope, targets: [scope, { ...scope, logstores: ["gateway"] }] } });
      assert.equal(row.created_at, 1);
    }
    assert.deepEqual((await db.client.execute("SELECT * FROM service_deployments WHERE id='flat'")).rows, untouched);
    assert.deepEqual(
      (await db.client.execute("SELECT revision FROM services ORDER BY id")).rows.map((row) => row.revision),
      [5, 7],
    );
    const beforeRetry = (await db.client.execute("SELECT * FROM service_deployments ORDER BY id")).rows;
    await migrate(db.db, { migrationsFolder: path.resolve("drizzle") });
    assert.deepEqual((await db.client.execute("SELECT * FROM service_deployments ORDER BY id")).rows, beforeRetry);
    assert.deepEqual(
      (await db.client.execute("SELECT revision FROM services ORDER BY id")).rows.map((row) => row.revision),
      [5, 7],
    );
    assert.deepEqual((await db.client.execute("PRAGMA foreign_key_check")).rows, []);
    assert.equal((await db.client.execute("PRAGMA integrity_check")).rows[0]!.integrity_check, "ok");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
