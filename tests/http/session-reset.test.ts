import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createPrivateSessionManager } from "../../src/agent/pi-session.ts";
import { openDatabase } from "../../src/db/client.ts";
import { agentSessions, issues, issueWorkspaces } from "../../src/db/schema.ts";
import { issueRoot } from "../../src/workspace/state.ts";
import { createApiFixture, createService, createIssue, issueMetadataPayload } from "./fixture.ts";
const headers = { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject };
async function fixture() {
  const f = await createApiFixture();
  const db = openDatabase(f.databaseFile);
  await createService(f.app, "Sessions");
  const summary = await createIssue(f.app, "sessions");
  f.engine.running.clear();
  const [issue] = await db.db
    .select()
    .from(issues)
    .where(eq(issues.key, String(summary.id)));
  assert.ok(issue);
  const root = issueRoot(f.root, issue.key),
    manager = await createPrivateSessionManager(root, root);
  manager.appendCustomEntry("issue-pilot-user", { message: "Saved old question" });
  await db.db.insert(agentSessions).values({ issueId: issue.id, sessionFile: manager.getSessionFile()!, workspacePath: root });
  await writeFile(root + "/report.txt", "existing report");
  return {
    ...f,
    db,
    issue,
    root,
    manager,
    async cleanup() {
      await db.close();
      await f.cleanup();
    },
  };
}
test("reset preserves the old transcript and files, binds an empty session, and never starts work", async () => {
  const f = await fixture();
  try {
    await f.db.db.update(issueWorkspaces).set({ status: "failed", runtimeReady: true, lastError: "model_response_failed" }).where(eq(issueWorkspaces.issueId, f.issue.id));
    const oldFile = f.manager.getSessionFile()!,
      original = await readFile(oldFile);
    const endpoint = `/api/issues/${f.issue.key}`;
    const reset = await f.app.inject({ method: "POST", url: endpoint + "/reset-session", headers, payload: { expectedSessionId: f.manager.getSessionId() } });
    assert.equal(reset.statusCode, 200, reset.body);
    assert.notEqual(reset.json().sessionId, f.manager.getSessionId());
    assert.deepEqual(await readFile(oldFile), original);
    assert.equal(await readFile(f.root + "/report.txt", "utf8"), "existing report");
    const [binding] = await f.db.db.select().from(agentSessions);
    assert.ok(binding);
    assert.notEqual(binding.sessionFile, oldFile);
    const manager = SessionManager.open(binding.sessionFile);
    assert.deepEqual(manager.buildSessionContext().messages, []);
    assert.equal(f.engine.enqueued.length, 1); // Only the original creation; reset queues nothing.
    assert.equal(f.engine.closedSessions.at(-1), f.issue.id);
    assert.equal((await f.db.db.select().from(issueWorkspaces))[0]!.lastError, null);
    const history = await f.app.inject({ method: "GET", url: endpoint + "/sessions", headers });
    assert.equal(history.statusCode, 200);
    assert.equal(history.json().length, 2);
    assert.equal(history.json()[0].current, true);
    assert.doesNotMatch(history.body, /session_file|\/tmp\//);
    const old = await f.app.inject({ method: "GET", url: endpoint + "/sessions/" + f.manager.getSessionId(), headers });
    assert.match(old.body, /Saved old question/);
    assert.doesNotMatch(old.body, /previousFile|issue-pilot-session-reset/);
    const stale = await f.app.inject({ method: "POST", url: endpoint + "/reset-session", headers, payload: { expectedSessionId: f.manager.getSessionId() } });
    assert.equal(stale.statusCode, 409);
    assert.equal((await readdir(f.root)).filter((name) => name.startsWith(".session-")).length, 2);
    const repeated = await f.app.inject({ method: "POST", url: endpoint + "/reset-session", headers, payload: { expectedSessionId: manager.getSessionId() } });
    assert.equal(repeated.statusCode, 200);
    assert.equal((await f.app.inject({ method: "GET", url: endpoint + "/sessions", headers })).json().length, 3);
  } finally {
    await f.cleanup();
  }
});
test("saving metadata with resetSession resets in the same reservation without starting a round", async () => {
  const f = await fixture();
  try {
    const oldFile = f.manager.getSessionFile()!,
      original = await readFile(oldFile);
    const response = await f.app.inject({ method: "PATCH", url: `/api/issues/${f.issue.key}`, headers, payload: { ...issueMetadataPayload("Saved with reset"), resetSession: true } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().title, "Saved with reset");
    // Creation is the only queued round; the reset must not leave a metadata round behind.
    assert.equal(f.engine.enqueued.length, 1);
    assert.deepEqual(await readFile(oldFile), original);
    const [binding] = await f.db.db.select().from(agentSessions);
    assert.ok(binding);
    assert.notEqual(binding.sessionFile, oldFile);
    assert.deepEqual(SessionManager.open(binding.sessionFile).buildSessionContext().messages, []);
    assert.equal(f.engine.closedSessions.at(-1), f.issue.id);
    assert.equal((await f.app.inject({ method: "PATCH", url: `/api/issues/${f.issue.key}`, headers, payload: { ...issueMetadataPayload("Invalid"), resetSession: "yes" } })).statusCode, 400);
  } finally {
    await f.cleanup();
  }
});
for (const condition of ["resolved", "unbound"] as const) {
  test(`combined save/reset rejects ${condition} Issues before saving metadata or closing the session`, async () => {
    const f = await fixture();
    try {
      if (condition === "resolved") await f.db.db.update(issues).set({ status: "resolved", resolvedAt: new Date() }).where(eq(issues.id, f.issue.id));
      else await f.db.db.delete(agentSessions).where(eq(agentSessions.issueId, f.issue.id));
      const originalFiles = await readdir(f.root);
      const originalSession = await readFile(f.manager.getSessionFile()!);
      const closedSessions = f.engine.closedSessions.length;
      const response = await f.app.inject({ method: "PATCH", url: `/api/issues/${f.issue.key}`, headers, payload: { ...issueMetadataPayload("Must not be saved"), resetSession: true } });
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().error, condition === "resolved" ? "resolved_issue_cannot_reset_session" : "agent_session_not_found");
      const [saved] = await f.db.db.select().from(issues).where(eq(issues.id, f.issue.id));
      assert.equal(saved!.title, f.issue.title);
      assert.equal(saved!.description, f.issue.description);
      assert.equal(saved!.updatedAt.getTime(), f.issue.updatedAt.getTime());
      assert.equal(f.engine.closedSessions.length, closedSessions);
      assert.equal(f.engine.enqueued.length, 1);
      assert.deepEqual(await readdir(f.root), originalFiles);
      assert.deepEqual(await readFile(f.manager.getSessionFile()!), originalSession);
    } finally {
      await f.cleanup();
    }
  });
}
for (const failure of ["binding failure", "session disappearance"] as const) {
  test(`combined save/reset reports committed metadata after ${failure} and permits a reset-only retry`, async () => {
    const f = await fixture();
    try {
      const oldFile = f.manager.getSessionFile()!;
      const originalSession = await readFile(oldFile);
      if (failure === "binding failure") await f.db.client.execute("CREATE TRIGGER fail_reset BEFORE UPDATE ON issue_pilot_sessions BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
      else f.engine.closeSessionHook = async () => rm(oldFile);
      const response = await f.app.inject({ method: "PATCH", url: `/api/issues/${f.issue.key}`, headers, payload: { ...issueMetadataPayload("Saved despite reset failure"), resetSession: true } });
      assert.equal(response.statusCode, 500, response.body);
      assert.equal(response.json().error, "issue_saved_session_reset_failed");
      assert.equal((await f.db.db.select().from(issues).where(eq(issues.id, f.issue.id)))[0]!.title, "Saved despite reset failure");
      assert.equal((await f.db.db.select().from(agentSessions))[0]!.sessionFile, oldFile);
      assert.equal(f.engine.enqueued.length, 1);
      assert.equal((await readdir(f.root)).filter((name) => name.startsWith(".session-")).length, failure === "binding failure" ? 1 : 0);
      if (failure === "binding failure") {
        assert.deepEqual(await readFile(oldFile), originalSession);
        await f.db.client.execute("DROP TRIGGER fail_reset");
      } else {
        f.engine.closeSessionHook = undefined;
        await writeFile(oldFile, originalSession, { mode: 0o600 });
      }
      const retry = await f.app.inject({ method: "POST", url: `/api/issues/${f.issue.key}/reset-session`, headers, payload: { expectedSessionId: f.manager.getSessionId() } });
      assert.equal(retry.statusCode, 200, retry.body);
      assert.notEqual((await f.db.db.select().from(agentSessions))[0]!.sessionFile, oldFile);
      assert.deepEqual(await readFile(oldFile), originalSession);
      assert.equal(f.engine.enqueued.length, 1);
    } finally {
      await f.cleanup();
    }
  });
}
test("running, unauthorized and resolved resets preserve the current session", async () => {
  const f = await fixture();
  try {
    const endpoint = `/api/issues/${f.issue.key}/reset-session`,
      payload = { expectedSessionId: f.manager.getSessionId() };
    f.engine.running.add(f.issue.id);
    assert.equal((await f.app.inject({ method: "POST", url: endpoint, headers, payload })).statusCode, 409);
    f.engine.running.clear();
    await f.app.inject({ method: "POST", url: "/api/users", headers, payload: { subject: "viewer", name: "Viewer", email: "viewer@example.test", role: "product" } });
    assert.equal((await f.app.inject({ method: "POST", url: endpoint, headers: { "x-issue-pilot-subject": "viewer" }, payload })).statusCode, 403);
    await f.db.db.update(issues).set({ status: "resolved", resolvedAt: new Date() }).where(eq(issues.id, f.issue.id));
    assert.equal((await f.app.inject({ method: "POST", url: endpoint, headers, payload })).statusCode, 409);
    assert.equal((await f.db.db.select().from(agentSessions))[0]!.sessionFile, f.manager.getSessionFile());
  } finally {
    await f.cleanup();
  }
});
test("binding rollback removes only the new file and preserves the original state", async () => {
  const f = await fixture();
  try {
    const files = await readdir(f.root),
      old = await readFile(f.manager.getSessionFile()!);
    await f.db.client.execute("CREATE TRIGGER fail_reset BEFORE UPDATE ON issue_pilot_sessions BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    const response = await f.app.inject({ method: "POST", url: `/api/issues/${f.issue.key}/reset-session`, headers, payload: { expectedSessionId: f.manager.getSessionId() } });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(await readdir(f.root), files);
    assert.deepEqual(await readFile(f.manager.getSessionFile()!), old);
    assert.equal((await f.db.db.select().from(agentSessions))[0]!.sessionFile, f.manager.getSessionFile());
    await f.db.client.execute("DROP TRIGGER fail_reset");
    const retry = await f.app.inject({ method: "POST", url: `/api/issues/${f.issue.key}/reset-session`, headers, payload: { expectedSessionId: f.manager.getSessionId() } });
    assert.equal(retry.statusCode, 200);
  } finally {
    await f.cleanup();
  }
});
