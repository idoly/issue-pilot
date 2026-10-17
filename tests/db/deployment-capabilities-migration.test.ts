import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/libsql/migrator";
import { openDatabase } from "../../src/db/client.ts";

for (const mode of ["valid", "orphan", "ambiguous", "disabled"] as const) test(`folds resource targets into deployments: ${mode}`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-deployment-migration-"));
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
  const entries = journal.entries.filter((row: { idx: number }) => row.idx < 52);
  const folder = path.join(root, "migrations");
  await mkdir(path.join(folder, "meta"), { recursive: true });
  await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const { tag } of entries) await copyFile(`drizzle/${tag}.sql`, path.join(folder, `${tag}.sql`));
  const db = openDatabase(path.join(root, "issues.db"));
  try {
    await migrate(db.db, { migrationsFolder: folder });
    await db.client.execute("insert into services (id,key,name,description,created_at,updated_at) values ('a','alpha','Alpha','business notes',1,2),('b','beta','Beta','other notes',1,2)");
    await db.client.execute("insert into environments (id,key,name,kind,created_at,updated_at) values ('prod','prod','Prod','prod',1,1),('test','test','Test','test',1,1)");
    await db.client.execute("insert into service_deployments (id,service_id,environment_id,config,created_at,updated_at) values ('ap','a','prod','{}',1,2),('bp','b','prod','{}',1,2),('at','a','test','{}',1,2)");
    for (const [id, kind, config] of [["dms", "dms", { url: "https://dms.example.test/sse", authorization: "Bearer fixture-private" }], ["sls", "sls", { accessKeyId: "fixture-key", accessKeySecret: "fixture-secret" }]] as const) await db.client.execute({ sql: "insert into resource_connections (id,name,kind,config,enabled,created_at,updated_at) values (?,?,?,?,1,1,2)", args: [id, id, kind, JSON.stringify(config)] });
    await db.client.execute("insert into mcp_services (id,name,url,transport,authorization,enabled,created_at,updated_at) values ('docs','Docs','https://docs.example.test/mcp','streamable_http','',0,1,2)");
    const dms = { instanceAlias: "Orders", schemaName: "orders", instanceId: "i1", instanceHost: "db.example.test", instancePort: "3306", databaseId: "42" };
    const rows = [
      ["dp", "dms", "prod", dms], ["dt", "dms", "test", { ...dms, schemaName: "orders_test", databaseId: "43" }],
      ["sp", "sls", "prod", { region: "cn-hangzhou", project: "business-prod", logstore: "application" }],
      ["sg", "sls", "prod", { region: "cn-hangzhou", project: mode === "ambiguous" ? "different-project" : "business-prod", logstore: "gateway" }],
    ] as const;
    for (const [id, connection, environment, config] of rows) await db.client.execute({ sql: "insert into resources (id,name,description,connection_id,environment_id,config,enabled,created_at,updated_at) values (?,?,?,?,?,?,?,1,2)", args: [id, id, "join by order_no", connection, environment, JSON.stringify(config), mode === "disabled" && id === "sg" ? 0 : 1] });
    await db.client.execute("insert into resource_services (resource_id,service_id) values ('dp','a'),('dp','b'),('dt','a'),('sp','a'),('sp','b')");
    if (mode !== "orphan") await db.client.execute("insert into resource_services (resource_id,service_id) values ('sg','a')");
    await db.client.execute("insert into environments (id,key,name,kind,created_at,updated_at) values ('dev','dev','Dev','dev',1,1)");
    await db.client.execute({ sql: "insert into service_deployments (id,service_id,environment_id,config,created_at,updated_at) values ('ad','a','dev',?,1,2)", args: [JSON.stringify({ redis: { host: "legacy-dev", port: 6379, database: 0, password: "old-private" } })] });
    const before = (await db.client.execute("select * from service_deployments order by id")).rows;
    const connections = (await db.client.execute("select * from resource_connections order by id")).rows;
    const nextEntries = journal.entries.filter((row: { idx: number }) => row.idx <= 52);
    await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: nextEntries }));
    for (const { tag } of nextEntries) await copyFile(`drizzle/${tag}.sql`, path.join(folder, `${tag}.sql`));
    if (mode !== "valid") {
      await assert.rejects(migrate(db.db, { migrationsFolder: folder }));
      assert.deepEqual((await db.client.execute("select * from service_deployments order by id")).rows, before);
      assert.equal((await db.client.execute("select count(*) n from resources")).rows[0]!.n, 4);
      return;
    }
    await migrate(db.db, { migrationsFolder: folder });
    const after = (await db.client.execute("select * from service_deployments order by id")).rows;
    assert.deepEqual((await db.client.execute("select * from resource_connections order by id")).rows, connections);
    assert.equal((await db.client.execute("select count(*) n from sqlite_master where name in ('resources','resource_services')")).rows[0]!.n, 0);
    for (const row of after) {
      const config = JSON.parse(String(row.config));
      if (row.id === "ad") {
        assert.deepEqual(config, { archivedDevelopment: { redis: { host: "legacy-dev", port: 6379, database: 0, password: "old-private" } } });
        continue;
      }
      assert.deepEqual(config.mcpServices, ["docs"]);
      assert.equal(config.dms.connectionId, "dms");
      assert.equal(config.dms.databases[0].databaseId, row.id === "at" ? "43" : "42");
      assert.ok(!String(row.config).includes("fixture-private"));
      assert.deepEqual({ ...row, config: undefined, description: undefined }, { ...before.find(previous => previous.id === row.id), config: undefined, description: undefined });
    }
    const alpha = JSON.parse(String(after.find(row => row.id === "ap")!.config));
    assert.deepEqual(alpha.sls, { connectionId: "sls", region: "cn-hangzhou", project: "business-prod", logstores: ["gateway", "application"] });
    const notes = String((await db.client.execute("select description from services where id='a'")).rows[0]!.description);
    assert.match(notes, /^business notes/); assert.match(notes, /join by order_no/); assert.match(notes, /Prod/); assert.match(notes, /Test/);
    assert.equal((await db.client.execute("pragma integrity_check")).rows[0]!.integrity_check, "ok");
    assert.deepEqual((await db.client.execute("pragma foreign_key_check")).rows, []);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
