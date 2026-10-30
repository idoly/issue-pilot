import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createPrivateSessionManager } from "../../src/agent/pi-session.ts";
import { openDatabase } from "../../src/db/client.ts";
import { agentSessions, issues, issueWorkspaces } from "../../src/db/schema.ts";
import { issueRoot } from "../../src/workspace/state.ts";
import { createApiFixture, createService, createIssue } from "./fixture.ts";
const headers = { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject };
async function fixture() {
  const f = await createApiFixture(); const db = openDatabase(f.databaseFile);
  await createService(f.app, "Sessions"); const summary = await createIssue(f.app, "sessions"); f.engine.running.clear();
  const [issue] = await db.db.select().from(issues).where(eq(issues.key, String(summary.id))); assert.ok(issue);
  const root = issueRoot(f.root, issue.key), manager = await createPrivateSessionManager(root, root);
  manager.appendCustomEntry("issue-pilot-user", { message: "Saved old question" });
  await db.db.insert(agentSessions).values({ issueId: issue.id, sessionFile: manager.getSessionFile()!, workspacePath: root });
  await writeFile(root + "/report.txt", "existing report");
  return { ...f, db, issue, root, manager, async cleanup() { await db.close(); await f.cleanup(); } };
}
test("reset preserves the old transcript and files, binds an empty session, and never starts work", async () => {
  const f = await fixture();
  try {
    await f.db.db.update(issueWorkspaces).set({ status: "failed", runtimeReady: true, lastError: "model_response_failed" }).where(eq(issueWorkspaces.issueId, f.issue.id));
    const oldFile = f.manager.getSessionFile()!, original = await readFile(oldFile);
    const endpoint = `/api/issues/${f.issue.key}`;
    const reset = await f.app.inject({ method: "POST", url: endpoint + "/reset-session", headers, payload: { expectedSessionId: f.manager.getSessionId() } });
    assert.equal(reset.statusCode, 200, reset.body);
    assert.notEqual(reset.json().sessionId, f.manager.getSessionId());
    assert.deepEqual(await readFile(oldFile), original); assert.equal(await readFile(f.root + "/report.txt", "utf8"), "existing report");
    const [binding] = await f.db.db.select().from(agentSessions); assert.ok(binding); assert.notEqual(binding.sessionFile, oldFile);
    const manager = SessionManager.open(binding.sessionFile);
    assert.deepEqual(manager.buildSessionContext().messages, []);
    assert.equal(f.engine.enqueued.length, 1); // Only the original creation; reset queues nothing.
    assert.equal(f.engine.closedSessions.at(-1), f.issue.id);
    assert.equal((await f.db.db.select().from(issueWorkspaces))[0]!.lastError, null);
    const history = await f.app.inject({ method: "GET", url: endpoint + "/sessions", headers });
    assert.equal(history.statusCode, 200); assert.equal(history.json().length, 2); assert.equal(history.json()[0].current, true); assert.doesNotMatch(history.body, /session_file|\/tmp\//);
    const old = await f.app.inject({ method: "GET", url: endpoint + "/sessions/" + f.manager.getSessionId(), headers });
    assert.match(old.body, /Saved old question/); assert.doesNotMatch(old.body, /previousFile|issue-pilot-session-reset/);
    const stale = await f.app.inject({ method: "POST", url: endpoint + "/reset-session", headers, payload: { expectedSessionId: f.manager.getSessionId() } });
    assert.equal(stale.statusCode, 409); assert.equal((await readdir(f.root)).filter(name => name.startsWith(".session-")).length, 2);
    const repeated = await f.app.inject({ method: "POST", url: endpoint + "/reset-session", headers, payload: { expectedSessionId: manager.getSessionId() } });
    assert.equal(repeated.statusCode, 200); assert.equal((await f.app.inject({ method: "GET", url: endpoint + "/sessions", headers })).json().length, 3);
  } finally { await f.cleanup(); }
});
test("running, unauthorized and resolved resets preserve the current session", async () => {
  const f = await fixture();
  try {
    const endpoint = `/api/issues/${f.issue.key}/reset-session`, payload = { expectedSessionId: f.manager.getSessionId() };
    f.engine.running.add(f.issue.id);
    assert.equal((await f.app.inject({ method: "POST", url: endpoint, headers, payload })).statusCode, 409);
    f.engine.running.clear();
    await f.app.inject({ method: "POST", url: "/api/users", headers, payload: { subject: "viewer", name: "Viewer", email: "viewer@example.test", role: "product" } });
    assert.equal((await f.app.inject({ method: "POST", url: endpoint, headers: { "x-issue-pilot-subject": "viewer" }, payload })).statusCode, 403);
    await f.db.db.update(issues).set({ status: "resolved", resolvedAt: new Date() }).where(eq(issues.id, f.issue.id));
    assert.equal((await f.app.inject({ method: "POST", url: endpoint, headers, payload })).statusCode, 409);
    assert.equal((await f.db.db.select().from(agentSessions))[0]!.sessionFile, f.manager.getSessionFile());
  } finally { await f.cleanup(); }
});
test("binding rollback removes only the new file and preserves the original state", async () => {
  const f = await fixture();
  try {
    const files = await readdir(f.root), old = await readFile(f.manager.getSessionFile()!);
    await f.db.client.execute("CREATE TRIGGER fail_reset BEFORE UPDATE ON issue_pilot_sessions BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    const response = await f.app.inject({ method: "POST", url: `/api/issues/${f.issue.key}/reset-session`, headers, payload: { expectedSessionId: f.manager.getSessionId() } });
    assert.equal(response.statusCode, 500); assert.deepEqual(await readdir(f.root), files); assert.deepEqual(await readFile(f.manager.getSessionFile()!), old);
    assert.equal((await f.db.db.select().from(agentSessions))[0]!.sessionFile, f.manager.getSessionFile());
    await f.db.client.execute("DROP TRIGGER fail_reset");
    const retry = await f.app.inject({ method: "POST", url: `/api/issues/${f.issue.key}/reset-session`, headers, payload: { expectedSessionId: f.manager.getSessionId() } });
    assert.equal(retry.statusCode, 200);
  } finally { await f.cleanup(); }
});
