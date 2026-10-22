import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/libsql/migrator";
import { openDatabase } from "../../src/db/client.ts";

test("retired production data Issues and both history directions become investigation while preserving bindings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-retired-mode-")), migrations = path.join(root, "migrations"), source = path.resolve("drizzle");
  const database = openDatabase(path.join(root, "issues.db"));
  try {
    const journal = JSON.parse(await readFile(path.join(source, "meta", "_journal.json"), "utf8"));
    journal.entries = journal.entries.filter((entry: { tag: string }) => entry.tag !== "0062_retire_production_data");
    await mkdir(path.join(migrations, "meta"), { recursive: true });
    await writeFile(path.join(migrations, "meta", "_journal.json"), JSON.stringify(journal));
    await Promise.all(journal.entries.map((entry: { tag: string }) => copyFile(path.join(source, entry.tag + ".sql"), path.join(migrations, entry.tag + ".sql"))));
    await migrate(database.db, { migrationsFolder: migrations });
    await database.client.executeMultiple(`
      PRAGMA foreign_keys=ON;
      INSERT INTO subjects(subject,display_name,role,created_at,updated_at) VALUES('owner','Owner','developer',1,1);
      INSERT INTO environments(id,key,name,kind,created_at,updated_at) VALUES('prod','prod','Production','prod',1,1);
      INSERT INTO services(id,key,name,description,created_at,updated_at) VALUES('service','service','Service','',1,1);
      INSERT INTO service_deployments(id,service_id,environment_id,config,created_at,updated_at) VALUES('deployment','service','prod','{}',1,1);
      INSERT INTO issues(id,key,title,type,service_id,environment_id,reporter_subject,created_at,updated_at) VALUES('issue','ISSUE-20261022-001','Report','data_processing','service','prod','owner',1,1);
      INSERT INTO issue_workspaces(issue_id,status,created_at,updated_at) VALUES('issue','ready',1,1);
      INSERT INTO issue_pilot_sessions(issue_id,session_file,workspace_path,created_at,updated_at) VALUES('issue','/state/session.jsonl','/state/work',1,1);
      INSERT INTO issue_scope_transitions(id,issue_id,actor_subject,action,from_service_key,from_service_name,from_work_mode,to_service_key,to_service_name,to_work_mode,plan_hash,repositories,created_at)
      VALUES('transition','issue','owner','rebind','service','Service','production_data','service','Service','production_data','unchanged-plan','[]',1);
    `);
    await migrate(database.db, { migrationsFolder: source });
    assert.deepEqual((await database.client.execute("SELECT id,type,updated_at FROM issues")).rows, [{ id: "issue", type: "smart_analysis", updated_at: 1 }]);
    assert.deepEqual((await database.client.execute("SELECT from_work_mode,to_work_mode,plan_hash FROM issue_scope_transitions")).rows, [{ from_work_mode: "production_analysis", to_work_mode: "production_analysis", plan_hash: "unchanged-plan" }]);
    assert.deepEqual((await database.client.execute("SELECT session_file,workspace_path FROM issue_pilot_sessions")).rows, [{ session_file: "/state/session.jsonl", workspace_path: "/state/work" }]);
    await assert.rejects(database.client.execute("UPDATE issues SET type='data_processing'"), /retired_issue_type/);
    await assert.rejects(database.client.execute("UPDATE issue_scope_transitions SET to_work_mode='production_data'"), /retired_issue_work_mode/);
    await assert.rejects(database.client.execute("INSERT INTO issues(id,key,title,type,service_id,environment_id,reporter_subject,created_at,updated_at) VALUES('other','ISSUE-20261022-002','Other','data_processing','service','prod','owner',1,1)"), /retired_issue_type/);
    assert.equal((await database.client.execute("PRAGMA integrity_check")).rows[0]!.integrity_check, "ok");
    assert.deepEqual((await database.client.execute("PRAGMA foreign_key_check")).rows, []);
    await migrate(database.db, { migrationsFolder: source });
    assert.equal((await database.client.execute("SELECT count(*) AS count FROM issue_scope_transitions")).rows[0]!.count, 1);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
