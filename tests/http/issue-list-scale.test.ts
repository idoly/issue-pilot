import assert from "node:assert/strict";
import { test } from "node:test";
import type { InArgs, InStatement, TransactionMode } from "@libsql/client";
import { eq } from "drizzle-orm";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { openDatabase } from "../../src/db/client.ts";
import { environments, services } from "../../src/db/schema.ts";
import { createApiFixture, createIssue, createService } from "./fixture.ts";

for (const endpoint of ["list", "detail"] as const) {
  test(`${endpoint} reads Issue and Workspace status from the same committed state`, async (t) => {
    const fixture = await createApiFixture();
    const database = openDatabase(fixture.databaseFile);
    try {
      await createService(fixture.app, "Snapshot", ["test"]);
      const created = await createIssue(fixture.app, "snapshot");
      const prototype = Object.getPrototypeOf(database.client) as typeof database.client;
      const execute = prototype.execute;
      const transaction: (mode?: TransactionMode) => ReturnType<typeof prototype.transaction> = prototype.transaction;
      let committed = false;
      // Commit a state transition as soon as the first Issue query reads its result.
      const afterRead = async (statement: InStatement) => {
        const sql = typeof statement === "string" ? statement : statement.sql;
        if (committed || !/\bfrom "issues"/i.test(sql)) return;
        committed = true;
        await database.client.batch(["UPDATE issues SET status = 'resolved', resolved_at = unixepoch()", "UPDATE issue_workspaces SET status = 'stopped'"], "write");
      };
      t.mock.method(prototype, "execute", async function (this: typeof database.client, statement: InStatement, args?: InArgs) {
        const result = await (typeof statement === "string" ? execute.call(this, statement, args) : execute.call(this, statement.sql, statement.args));
        await afterRead(statement);
        return result;
      });
      t.mock.method(prototype, "transaction", async function (this: typeof database.client, mode?: TransactionMode) {
        const snapshot = await transaction.call(this, mode);
        const read = snapshot.execute.bind(snapshot);
        snapshot.execute = async (statement) => {
          const result = await read(statement);
          await afterRead(statement);
          return result;
        };
        return snapshot;
      });

      type IssueState = { status: string; workspaceStatus: string; workspace?: { status: string } };
      const url = endpoint === "list" ? "/api/issues" : `/api/issues/${created.id}`;
      const readState = async () => {
        const response = await fixture.app.inject({ method: "GET", url });
        assert.equal(response.statusCode, 200, response.body);
        const issue = endpoint === "list" ? response.json<IssueState[]>()[0]! : response.json<IssueState>();
        if (endpoint === "detail") assert.equal(issue.workspace?.status, issue.workspaceStatus);
        return [issue.status, issue.workspaceStatus];
      };
      assert.deepEqual(await readState(), ["open", "not_created"]);
      assert.equal(committed, true);
      assert.deepEqual(await readState(), ["resolved", "stopped"]);
    } finally {
      t.mock.restoreAll();
      database.close();
      await fixture.cleanup();
    }
  });
}

test("lists more Issues than SQLite permits in one parameter list", async () => {
  const fixture = await createApiFixture();
  const database = openDatabase(fixture.databaseFile);
  try {
    assert.deepEqual((await fixture.app.inject({ method: "GET", url: "/api/issues" })).json(), []);
    await createService(fixture.app, "Scale", ["test"]);
    const [service] = await database.db.select().from(services).where(eq(services.key, "scale"));
    const [environment] = await database.db.select().from(environments).where(eq(environments.kind, "test"));
    const count = 33000;
    await database.client.execute({
      sql: `WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM sequence WHERE n < ${count})
      INSERT INTO issues(id,key,title,description,status,priority,type,service_id,environment_id,reporter_subject,created_at,updated_at)
      SELECT 'scale-'||n,'ISSUE-20261020-'||printf('%05d',n),'Fixture '||n,'','open','p2','smart_analysis',?,?,?,unixepoch(),unixepoch() FROM sequence`,
      args: [service!.id, environment!.id, issuePilotConfig.bootstrapUser.subject],
    });
    await database.client.execute("INSERT INTO issue_workspaces(issue_id,status,runtime_ready,created_at,updated_at) SELECT id,'not_created',0,unixepoch(),unixepoch() FROM issues");
    await database.client.execute(
      "INSERT INTO issue_repositories(id,issue_id,url,base_branch,created_at,updated_at) SELECT id,id,'https://example.test/scale.git','main',unixepoch(),unixepoch() FROM issues",
    );
    const response = await fixture.app.inject({ method: "GET", url: "/api/issues" });
    assert.equal(response.statusCode, 200, response.body.slice(0, 200));
    const listed = response.json<Array<{ id: string }>>();
    assert.equal(listed.length, count);
    assert.equal(new Set(listed.map((row) => row.id)).size, count);
    assert.equal(listed[0]!.id, "ISSUE-20261020-33000");
    assert.equal(listed.at(-1)!.id, "ISSUE-20261020-00001");

    assert.deepEqual((await database.client.execute("PRAGMA foreign_key_check")).rows, []);
  } finally {
    await database.close();
    await fixture.cleanup();
  }
});
