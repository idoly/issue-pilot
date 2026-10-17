import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/libsql/migrator";
import { openDatabase } from "../../src/db/client.ts";

for (const invalid of [false, true]) test(`resource migration ${invalid ? "rolls back incomplete credentials" : "deduplicates shared connections and preserves targets, environments and service tags"}`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-resource-migration-"));
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
  const entries = journal.entries.slice(0, journal.entries.findIndex((entry: { tag: string }) => entry.tag === "0050_resource_catalog"));
  const folder = path.join(root, "migrations");
  await mkdir(path.join(folder, "meta"), { recursive: true });
  await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const { tag } of entries) await copyFile(`drizzle/${tag}.sql`, path.join(folder, `${tag}.sql`));
  const db = openDatabase(path.join(root, "issues.db"));
  try {
    await migrate(db.db, { migrationsFolder: folder });
    await db.client.execute("insert into services (id,key,name,description,created_at,updated_at) values ('s1','alpha','Alpha','',1,2),('s2','beta','Beta','',1,2)");
    await db.client.execute("insert into environments (id,key,name,kind,created_at,updated_at) values ('test','test','Test','test',1,1),('prod','prod','Prod','prod',1,1)");
    const config = (authorization = "Bearer shared") => ({
      dms: { url: "https://dms.example.test/sse", authorization, databases: [{ instanceAlias: "shared", schemaName: "orders", instanceId: "i1", instanceHost: "db.example.test", instancePort: "3306", databaseId: "42" }] },
      sls: { accessKeyId: "fixture-id", accessKeySecret: "fixture-secret", region: "cn-hangzhou", project: "shared", logstores: ["orders", "gateway"] },
      redis: { host: "redis.example.test", port: 6379, database: 0 },
    });
    const values = [config(invalid ? "" : "Bearer shared"), config(), config(), config("Bearer separate")];
    for (let index = 0; index < values.length; index++) await db.client.execute({ sql: "insert into service_deployments (id,service_id,environment_id,config,created_at,updated_at) values (?,?,?,?,1,2)", args: [`d${index}`, index % 2 ? "s2" : "s1", index < 2 ? "test" : "prod", JSON.stringify(values[index])] });
    const before = (await db.client.execute("select * from service_deployments order by id")).rows;
    const catalogEntries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 51);
    await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: catalogEntries }));
    for (const { tag } of catalogEntries) await copyFile(`drizzle/${tag}.sql`, path.join(folder, `${tag}.sql`));
    if (invalid) {
      await assert.rejects(migrate(db.db, { migrationsFolder: folder }));
      assert.deepEqual((await db.client.execute("select * from service_deployments order by id")).rows, before);
      assert.equal((await db.client.execute("select name from sqlite_master where name='resource_connections'")).rows.length, 0);
      return;
    }
    await migrate(db.db, { migrationsFolder: folder });
    assert.equal((await db.client.execute("select count(*) n from resource_connections")).rows[0]!.n, 3);
    assert.equal((await db.client.execute("select count(*) n from resources")).rows[0]!.n, 7);
    const projections = (await db.client.execute("select d.id,d.service_id,d.environment_id,r.config as target,c.kind,c.config as connection from service_deployments d join resource_services t on t.service_id=d.service_id join resources r on r.id=t.resource_id and r.environment_id=d.environment_id join resource_connections c on c.id=r.connection_id order by d.id,c.kind,r.config")).rows;
    for (let index = 0; index < values.length; index++) {
      const rows = projections.filter(row => row.id === `d${index}`);
      assert.equal(rows.length, 3);
      const dms = rows.find(row => row.kind === "dms")!;
      assert.deepEqual(JSON.parse(String(dms.connection)), { url: values[index]!.dms.url, authorization: values[index]!.dms.authorization });
      assert.deepEqual(JSON.parse(String(dms.target)), values[index]!.dms.databases[0]);
      assert.deepEqual(rows.filter(row => row.kind === "sls").map(row => JSON.parse(String(row.target)).logstore).sort(), ["gateway", "orders"]);
    }
    const after = (await db.client.execute("select * from service_deployments order by id")).rows;
    assert.deepEqual(after.map(row => ({ ...row, config: JSON.stringify(JSON.parse(String(row.config)).redis) })), before.map(row => ({ ...row, config: JSON.stringify(JSON.parse(String(row.config)).redis) })));
    assert.ok(after.every(row => !JSON.parse(String(row.config)).dms && !JSON.parse(String(row.config)).sls));
    assert.equal((await db.client.execute("pragma integrity_check")).rows[0]!.integrity_check, "ok");
    assert.deepEqual((await db.client.execute("pragma foreign_key_check")).rows, []);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
