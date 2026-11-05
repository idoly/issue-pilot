import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/libsql/migrator";
import { openDatabase } from "../../src/db/client.ts";

test("backfills the prior repository groups without changing existing bindings, branches or revisions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-repository-groups-"));
  const folder = path.join(root, "migrations");
  const db = openDatabase(path.join(root, "issues.db"));
  try {
    const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
    const entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 71);
    await mkdir(path.join(folder, "meta"), { recursive: true });
    await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
    for (const { tag } of entries) await copyFile(`drizzle/${tag}.sql`, path.join(folder, `${tag}.sql`));
    await migrate(db.db, { migrationsFolder: folder });

    const examples = [
      ["git@example.test:digital-biz-projects/oms/fronts/order.git", "oms"],
      ["git@example.test:/digital-biz-projects/srm/srm-server.git", "srm"],
      ["https://example.test/DIGITAL-BIZ-PROJECTS/XHGJ-MALL/servers/cart.git", "mall"],
      ["ssh://git@example.test:2222/digital-biz-projects/mdm/servers/data.git", "mdm"],
      ["git@example.test:digital-biz-projects/crm/crm.git", "crm"],
      ["https://example.test/digital-biz-projects/iqs/iqs.git", "iqs"],
      ["git@example.test:digital-biz-projects/mpm/mpm.git", "mpm"],
      ["git@example.test:other/digital-biz-projects/mdm/app.git", "other"],
      ["git@example.test://digital-biz-projects/mdm/app.git", "other"],
      ["git@example.test:digital-biz-projects/mdm//app.git", "other"],
      ["https://example.test/digital-biz-projects/mall/shop.git", "other"],
      ["https://example.test/digital-biz-projects/crm.git", "other"],
    ] as const;
    for (const [index, [url]] of examples.entries()) {
      await db.client.execute({ sql: "INSERT INTO repositories (id, name, url, revision, created_at, updated_at) VALUES (?, ?, ?, 4, 10, 11)", args: [`r${index}`, `Repo ${index}`, url] });
    }
    await db.client.execute("INSERT INTO services (id,key,name,description,created_at,updated_at) VALUES ('s','order','Order','',10,11)");
    await db.client.execute("INSERT INTO environments (id,key,name,kind,created_at,updated_at) VALUES ('test','test','Test','test',10,11)");
    await db.client.execute("INSERT INTO service_deployments (id,service_id,environment_id,config,created_at,updated_at) VALUES ('d','s','test','{}',10,11)");
    await db.client.execute({ sql: "INSERT INTO service_repositories (id,service_id,alias,url,created_at,updated_at) VALUES ('b','s','order',?,10,11)", args: [examples[0][0]] });
    await db.client.execute("INSERT INTO service_deployment_repositories (deployment_id,repository_id,base_branch,created_at,updated_at) VALUES ('d','b','release',10,11)");
    const unchangedQueries = ["SELECT id,name,url,revision,created_at,updated_at FROM repositories ORDER BY id", "SELECT * FROM service_repositories", "SELECT * FROM service_deployment_repositories"];
    const before = await Promise.all(unchangedQueries.map(async (sql) => (await db.client.execute(sql)).rows));
    await migrate(db.db, { migrationsFolder: path.resolve("drizzle") });
    assert.deepEqual(await Promise.all(unchangedQueries.map(async (sql) => (await db.client.execute(sql)).rows)), before);
    const rows = (await db.client.execute("SELECT url, repository_group FROM repositories ORDER BY rowid")).rows;
    assert.deepEqual(
      rows.map((row) => [row.url, row.repository_group]),
      examples,
    );
    await db.client.execute("UPDATE repositories SET repository_group = 'my team' WHERE id = 'r0'");
    await migrate(db.db, { migrationsFolder: path.resolve("drizzle") });
    assert.equal((await db.client.execute("SELECT repository_group FROM repositories WHERE id = 'r0'")).rows[0]!.repository_group, "my team");
    assert.deepEqual((await db.client.execute("PRAGMA foreign_key_check")).rows, []);
    assert.equal((await db.client.execute("PRAGMA integrity_check")).rows[0]!.integrity_check, "ok");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
