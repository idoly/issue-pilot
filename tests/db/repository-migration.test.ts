import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/libsql/migrator";
import { openDatabase } from "../../src/db/client.ts";

test("imports unique repository URLs and preserves binding IDs, branch rows and row order", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-repository-migration-"));
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
  const previous = { ...journal, entries: journal.entries.slice(0, journal.entries.findIndex((entry: { tag: string }) => entry.tag === "0047_repository_catalog")) };
  const migrations = path.join(root, "migrations");
  await mkdir(path.join(migrations, "meta"), { recursive: true });
  await writeFile(path.join(migrations, "meta/_journal.json"), JSON.stringify(previous));
  for (const { tag } of previous.entries) await copyFile(`drizzle/${tag}.sql`, path.join(migrations, `${tag}.sql`));
  const db = openDatabase(path.join(root, "issues.db"));
  try {
    await migrate(db.db, { migrationsFolder: migrations });
    await db.client.execute("insert into services (id,key,name,description,created_at,updated_at) values ('s1','alpha','Alpha','',1,2),('s2','beta','Beta','',1,2)");
    await db.client.execute("insert into environments (id,key,name,kind,created_at,updated_at) values ('test','test','Test','test',1,1)");
    await db.client.execute("insert into service_repositories (id,service_id,alias,url,created_at,updated_at) values ('r1','s1','one','git@git.example.test:shared.git',1,2),('r2','s1','two','git@git.example.test:other.git',1,2),('r3','s2','three','git@git.example.test:shared.git',1,2)");
    await db.client.execute("insert into service_deployments (id,service_id,environment_id,config,created_at,updated_at) values ('d1','s1','test','{}',1,2),('d2','s2','test','{}',1,2)");
    await db.client.execute("insert into service_deployment_repositories (deployment_id,repository_id,base_branch,created_at,updated_at) values ('d1','r2','release',1,2),('d1','r1','main',1,2),('d2','r3','test',1,2)");
    const before = (await db.client.execute("select rowid,* from service_repositories order by rowid")).rows;
    const branches = (await db.client.execute("select rowid,* from service_deployment_repositories order by rowid")).rows;
    await migrate(db.db, { migrationsFolder: path.resolve("drizzle") });
    assert.deepEqual((await db.client.execute("select rowid,* from service_repositories order by rowid")).rows, before);
    assert.deepEqual((await db.client.execute("select rowid,* from service_deployment_repositories order by rowid")).rows, branches);
    assert.equal((await db.client.execute("select count(*) count from repositories")).rows[0]!.count, 2);
    await db.client.execute("update repositories set url='git@git.example.test:new.git' where url='git@git.example.test:shared.git'");
    assert.equal((await db.client.execute("select count(*) count from service_repositories where url='git@git.example.test:new.git'")).rows[0]!.count, 2);
    await assert.rejects(db.client.execute("delete from repositories where url='git@git.example.test:new.git'"), /FOREIGN KEY/);
    assert.equal((await db.client.execute("pragma foreign_key_check")).rows.length, 0);
    assert.equal((await db.client.execute("pragma integrity_check")).rows[0]!.integrity_check, "ok");
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
