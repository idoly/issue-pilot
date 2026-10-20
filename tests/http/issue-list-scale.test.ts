import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { openDatabase } from "../../src/db/client.ts";
import { environments, issues, services } from "../../src/db/schema.ts";
import { IssueProjectManager } from "../../src/workspace/project.ts";
import { createApiFixture, createService } from "./fixture.ts";

test("lists and hydrates more Issues than SQLite permits in one parameter list", async () => {
  const fixture = await createApiFixture();
  const database = openDatabase(fixture.databaseFile);
  try {
    assert.deepEqual((await fixture.app.inject({ method: "GET", url: "/api/issues" })).json(), []);
    await createService(fixture.app, "Scale", ["test"]);
    const [service] = await database.db.select().from(services).where(eq(services.key, "scale"));
    const [environment] = await database.db.select().from(environments).where(eq(environments.kind, "test"));
    const count = 33000;
    await database.client.execute({ sql: `WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM sequence WHERE n < ${count})
      INSERT INTO issues(id,key,title,description,status,priority,type,service_id,environment_id,reporter_subject,created_at,updated_at)
      SELECT 'scale-'||n,'ISSUE-20261020-'||printf('%05d',n),'Fixture '||n,'','open','p2','smart_analysis',?,?,?,unixepoch(),unixepoch() FROM sequence`,
      args: [service!.id, environment!.id, issuePilotConfig.bootstrapUser.subject] });
    await database.client.execute("INSERT INTO issue_workspaces(issue_id,status,runtime_ready,created_at,updated_at) SELECT id,'not_created',0,unixepoch(),unixepoch() FROM issues");
    await database.client.execute("INSERT INTO issue_repositories(id,issue_id,url,base_branch,created_at,updated_at) SELECT id,id,'https://example.test/scale.git','main',unixepoch(),unixepoch() FROM issues");
    const response = await fixture.app.inject({ method: "GET", url: "/api/issues" });
    assert.equal(response.statusCode, 200, response.body.slice(0, 200));
    const listed = response.json<Array<{ id: string }>>();
    assert.equal(listed.length, count);
    assert.equal(new Set(listed.map(row => row.id)).size, count);
    assert.equal(listed[0]!.id, "ISSUE-20261020-33000");
    assert.equal(listed.at(-1)!.id, "ISSUE-20261020-00001");

    // Exercise batch loading against SQLite without preparing 33,000 Git runtimes.
    const manager = new IssueProjectManager(database.db, fixture.root);
    const hydrated: string[] = [];
    manager.hydrateReadOnlyRuntime = async (issue, _cache, repositories) => {
      assert.ok(repositories);
      assert.equal(repositories.length, 1);
      assert.equal(repositories[0]!.issueId, issue.id);
      hydrated.push(issue.id);
      return "fixture-runtime";
    };
    const rows = await database.db.select().from(issues);
    const result = await manager.hydrateReadOnlyRuntimes(rows);
    assert.equal(result.prepared.length, count);
    assert.deepEqual(result.blocked, []);
    assert.equal(new Set(hydrated).size, count);
    assert.deepEqual((await database.client.execute("PRAGMA foreign_key_check")).rows, []);
  } finally { await database.close(); await fixture.cleanup(); }
});
