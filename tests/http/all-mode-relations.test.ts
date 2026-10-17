import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { ISSUE_WORK_MODES } from "../../src/domain/contracts.ts";
import { openDatabase } from "../../src/db/client.ts";
import { issues, issueWorkspaces } from "../../src/db/schema.ts";
import { createApiFixture, createIssue, createService, issuePayload } from "./fixture.ts";

test("all work modes can create and edit related Issues without weakening reservation checks", async () => {
  const f = await createApiFixture();
  const db = openDatabase(f.databaseFile);
  try {
    await createService(f.app, "Relations", ["prod", "test", "dev"]);
    const evidence = await createIssue(f.app, "relations", "test");
    const evidenceId = f.engine.enqueued.at(-1)!;
    f.engine.running.clear();
    for (const workMode of ISSUE_WORK_MODES) {
      const response = await f.app.inject({ method: "POST", url: "/api/issues", payload: { ...issuePayload("relations"), workMode, relatedIssueKeys: [evidence.id] } });
      assert.equal(response.statusCode, 201, `${workMode}: ${response.body}`);
      const key = JSON.parse(response.body).id;
      const id = f.engine.enqueued.at(-1)!;
      f.engine.running.clear();
      await db.db.update(issueWorkspaces).set({ status: "ready", runtimeReady: true }).where(eq(issueWorkspaces.issueId, id));
      const detail = JSON.parse((await f.app.inject({ method: "GET", url: `/api/issues/${key}` })).body);
      assert.deepEqual(detail.relatedIssues.map((row: { id: string }) => row.id), [evidence.id]);
      const self = await f.app.inject({ method: "PUT", url: `/api/issues/${key}/related-issues`, payload: { relatedIssueKeys: [key] } });
      assert.equal(self.statusCode, 400, self.body);
      f.engine.running.add(evidenceId);
      assert.equal((await f.app.inject({ method: "PUT", url: `/api/issues/${key}/related-issues`, payload: { relatedIssueKeys: [] } })).statusCode, 409);
      f.engine.running.clear();
      const removed = await f.app.inject({ method: "PUT", url: `/api/issues/${key}/related-issues`, payload: { relatedIssueKeys: [] } });
      assert.equal(removed.statusCode, 204, removed.body);
      f.engine.running.clear();
      await db.db.update(issues).set({ status: "resolved", resolvedAt: new Date() }).where(eq(issues.id, id));
      assert.equal((await f.app.inject({ method: "PUT", url: `/api/issues/${key}/related-issues`, payload: { relatedIssueKeys: [evidence.id] } })).statusCode, 409);
    }
  } finally { db.close(); await f.cleanup(); }
});
