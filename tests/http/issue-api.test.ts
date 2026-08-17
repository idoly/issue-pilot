import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { eq } from "drizzle-orm";

import { openDatabase } from "../../src/db/client.ts";
import { issues, issueWorkspaces } from "../../src/db/schema.ts";
import { createApiFixture, createIssue, createService, issuePayload, json } from "./fixture.ts";

test("validates Issue scope, subjects, priority, and environment type", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha", ["test"]);
    await createService(fixture.app, "Beta", ["dev"]);
    for (const [payload, expected] of [
      [{ ...issuePayload("alpha"), assigneeSubject: "missing-user" }, "invalid_subject"],
      [{ ...issuePayload("alpha"), priority: "urgent" }, "invalid_priority"],
      [{ ...issuePayload("beta", "dev"), type: "smart_analysis" }, "invalid_issue_type_for_environment"],
      [{ ...issuePayload("missing"), serviceKey: "missing" }, "invalid_service_for_environment"],
    ] as const) {
      const response = await fixture.app.inject({ method: "POST", url: "/api/issues", payload });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal((await json(response)).error, expected);
    }
    assert.deepEqual(await fixture.app.inject({ method: "GET", url: "/api/issues" }).then((response) => JSON.parse(response.body)), []);
  } finally {
    await fixture.cleanup();
  }
});

test("serializes retries, status transitions, messages, and comments with one Issue reservation", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha");
    const issue = await createIssue(fixture.app, "alpha", "test", "Lifecycle issue");
    const issueId = fixture.engine.enqueued[0]!;
    const runningRetry = await fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/retry` });
    assert.equal(runningRetry.statusCode, 409);
    fixture.engine.running.delete(issueId);

    const database = openDatabase(fixture.databaseFile);
    await database.db.update(issues).set({ status: "open" }).where(eq(issues.id, issueId));
    await database.db.update(issueWorkspaces).set({ status: "failed" }).where(eq(issueWorkspaces.issueId, issueId));
    await database.close();
    const retries = await Promise.all([
      fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/retry` }),
      fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/retry` }),
    ]);
    assert.deepEqual(retries.map(({ statusCode }) => statusCode).sort(), [202, 409]);
    fixture.engine.running.delete(issueId);

    assert.equal((await fixture.app.inject({ method: "PATCH", url: `/api/issues/${issue.id}/status`, payload: { status: "resolved" } })).statusCode, 409);
    const pending = openDatabase(fixture.databaseFile);
    await pending.db.update(issues).set({ status: "pending" }).where(eq(issues.id, issueId));
    await pending.close();
    fixture.engine.closeSessionHook = async () => { throw new Error("stop_failed"); };
    assert.equal((await fixture.app.inject({ method: "PATCH", url: `/api/issues/${issue.id}/status`, payload: { status: "resolved" } })).statusCode, 500);
    fixture.engine.closeSessionHook = undefined;
    assert.equal((await fixture.app.inject({ method: "PATCH", url: `/api/issues/${issue.id}/status`, payload: { status: "resolved" } })).statusCode, 200);
    assert.equal((await fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/agent-messages`, payload: { message: "blocked" } })).statusCode, 409);
    assert.equal((await fixture.app.inject({ method: "PATCH", url: `/api/issues/${issue.id}/status`, payload: { status: "open" } })).statusCode, 200);

    const commentUser = await fixture.app.inject({ method: "POST", url: "/api/users", payload: { subject: "lyz5613@xianhengguoji.com", name: "刘宜展", email: "lyz5613@xianhengguoji.com" } });
    assert.equal(commentUser.statusCode, 201);
    const comment = await fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/comments`, headers: { "x-issue-pilot-subject": "lyz5613@xianhengguoji.com" }, payload: { body: "A note" } });
    assert.equal(comment.statusCode, 201);
    const detail = await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` }).then((response) => JSON.parse(response.body)) as { comments: Array<{ author: string; body: string }> };
    assert.deepEqual(detail.comments.map(({ author, body }) => ({ author, body })), [{ author: "刘宜展", body: "A note" }]);
    const message = await fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/agent-messages`, payload: { message: "Check evidence" } });
    assert.equal(message.statusCode, 202);
    assert.equal(fixture.engine.messages.at(-1), "Check evidence");
    assert.equal((await fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/agent-messages`, payload: { message: "" } })).statusCode, 400);
  } finally {
    await fixture.cleanup();
  }
});

test("lists newer Issues first without letting later updates reorder them", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha");
    const older = await createIssue(fixture.app, "alpha", "test", "Older");
    const newer = await createIssue(fixture.app, "alpha", "test", "Newer");
    fixture.engine.running.clear();

    const database = openDatabase(fixture.databaseFile);
    await database.db.update(issues).set({ createdAt: new Date("2026-08-14T00:00:00.000Z"), updatedAt: new Date("2026-08-14T02:00:00.000Z") }).where(eq(issues.key, String(older.id)));
    await database.db.update(issues).set({ createdAt: new Date("2026-08-14T01:00:00.000Z"), updatedAt: new Date("2026-08-14T01:00:00.000Z") }).where(eq(issues.key, String(newer.id)));
    await database.close();

    const listed = await fixture.app.inject({ method: "GET", url: "/api/issues" }).then((response) => JSON.parse(response.body)) as Array<{ id: string }>;
    assert.deepEqual(listed.map(({ id }) => id), [newer.id, older.id]);
  } finally {
    await fixture.cleanup();
  }
});

test("generates concurrent Issue keys and refuses unmanaged state", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha");
    const first = await createIssue(fixture.app, "alpha", "test", "First");
    fixture.engine.running.clear();
    const unmanagedKey = String(first.id).replace(/001$/, "002");
    const unmanagedRoot = path.join(fixture.root, "issues", unmanagedKey.toLowerCase());
    await mkdir(unmanagedRoot, { recursive: true });
    const evidence = path.join(unmanagedRoot, "evidence.txt");
    await writeFile(evidence, "preserve", "utf8");
    const blocked = await fixture.app.inject({ method: "POST", url: "/api/issues", payload: issuePayload("alpha", "test", "Blocked") });
    assert.equal(blocked.statusCode, 409);
    assert.equal((await json(blocked)).error, "unmanaged_issue_state");
    assert.equal(await readFile(evidence, "utf8"), "preserve");
    await rm(unmanagedRoot, { recursive: true });

    const concurrent = await Promise.all([
      fixture.app.inject({ method: "POST", url: "/api/issues", payload: issuePayload("alpha", "test", "Concurrent A") }),
      fixture.app.inject({ method: "POST", url: "/api/issues", payload: issuePayload("alpha", "test", "Concurrent B") }),
    ]);
    assert.deepEqual(concurrent.map(({ statusCode }) => statusCode), [201, 201]);
    const keys = await Promise.all(concurrent.map(async (response) => String((await json(response)).id)));
    assert.equal(new Set(keys).size, 2);
    assert.deepEqual(keys.sort(), [unmanagedKey, String(first.id).replace(/001$/, "003")]);
  } finally {
    await fixture.cleanup();
  }
});

test("exposes production analysis conversion as a guarded dedicated action", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "ProductionOnly", ["prod"]);
    const productionIssue = await createIssue(fixture.app, "productiononly", "prod", "Convert me");
    const productionIssueId = fixture.engine.enqueued.at(-1)!;
    const running = await fixture.app.inject({ method: "POST", url: `/api/issues/${productionIssue.id}/development` });
    assert.equal(running.statusCode, 409);
    assert.equal((await json(running)).error, "issue_already_running");

    fixture.engine.running.clear();
    const database = openDatabase(fixture.databaseFile);
    await database.db.update(issues).set({ status: "pending" }).where(eq(issues.id, productionIssueId));
    await database.db.update(issueWorkspaces).set({ status: "ready" }).where(eq(issueWorkspaces.issueId, productionIssueId));
    await database.close();
    const missingDevelopmentDeployment = await fixture.app.inject({ method: "POST", url: `/api/issues/${productionIssue.id}/development` });
    assert.equal(missingDevelopmentDeployment.statusCode, 409);
    assert.equal((await json(missingDevelopmentDeployment)).error, "issue_service_deployment_not_found");

    await createService(fixture.app, "TestOnly", ["test"]);
    const testIssue = await createIssue(fixture.app, "testonly", "test", "Not production");
    const testIssueId = fixture.engine.enqueued.at(-1)!;
    fixture.engine.running.clear();
    const pending = openDatabase(fixture.databaseFile);
    await pending.db.update(issues).set({ status: "pending" }).where(eq(issues.id, testIssueId));
    await pending.db.update(issueWorkspaces).set({ status: "ready" }).where(eq(issueWorkspaces.issueId, testIssueId));
    await pending.close();
    const notProduction = await fixture.app.inject({ method: "POST", url: `/api/issues/${testIssue.id}/development` });
    assert.equal(notProduction.statusCode, 409);
    assert.equal((await json(notProduction)).error, "issue_not_convertible_to_development");
  } finally {
    await fixture.cleanup();
  }
});

test("keeps Issue detail shallow and workspace statistics explicit", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha");
    const issue = await createIssue(fixture.app, "alpha");
    fixture.engine.running.clear();
    const response = await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` });
    assert.equal(response.statusCode, 200);
    const detail = await json(response);
    assert.deepEqual(Object.keys(detail.workspace as Record<string, unknown>).sort(), ["lastError", "retryable", "sourceAvailable", "status"]);
    assert.equal("agentSession" in detail, false);
    assert.equal("scopeCandidates" in detail, false);
    const unavailableSource = await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}/source/repositories` });
    assert.equal(unavailableSource.statusCode, 409);
    assert.equal(unavailableSource.headers["cache-control"], "private, no-store");
    const malformedSourceHeader = await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}/source/tree`, headers: { "X-Issue-Pilot-Repository": "%" } });
    assert.equal(malformedSourceHeader.statusCode, 400);
    const invalidBlameLine = await fixture.app.inject({
      method: "GET",
      url: `/api/issues/${issue.id}/source/blame`,
      headers: { "X-Issue-Pilot-Repository": "alpha-1", "X-Issue-Pilot-Path": "src/index.ts", "X-Issue-Pilot-Line": "0" },
    });
    assert.equal(invalidBlameLine.statusCode, 400);
    assert.equal((await json(invalidBlameLine)).error, "invalid_source_request");
    const invalidSearchMode = await fixture.app.inject({
      method: "GET",
      url: `/api/issues/${issue.id}/source/search`,
      headers: {
        "X-Issue-Pilot-Repository": "alpha-1",
        "X-Issue-Pilot-Query": "needle",
        "X-Issue-Pilot-Case-Sensitive": "yes",
        "X-Issue-Pilot-Word-Match": "false",
      },
    });
    assert.equal(invalidSearchMode.statusCode, 400);
    assert.equal((await json(invalidSearchMode)).error, "invalid_source_request");
    const acceptedSearchModes = await fixture.app.inject({
      method: "GET",
      url: `/api/issues/${issue.id}/source/search`,
      headers: {
        "X-Issue-Pilot-Repository": "alpha-1",
        "X-Issue-Pilot-Query": "needle",
        "X-Issue-Pilot-Case-Sensitive": "false",
        "X-Issue-Pilot-Word-Match": "true",
      },
    });
    assert.equal(acceptedSearchModes.statusCode, 409);
    assert.equal((await json(acceptedSearchModes)).error, "source_browser_unavailable");
    const stats = await fixture.app.inject({ method: "GET", url: "/api/workspaces/stats" });
    assert.equal(stats.statusCode, 200);
    const body = await json(stats) as { totalBytes: number; policy: Record<string, unknown>; workspaces: Array<Record<string, unknown>> };
    assert.equal(typeof body.totalBytes, "number");
    assert.deepEqual(Object.keys(body.policy).sort(), ["highWaterBytes", "maintenanceIntervalMinutes", "retentionHours", "targetBytes"]);
    assert.equal(body.workspaces.some((workspace) => "issueId" in workspace), false);
    assert.equal((await fixture.app.inject({ method: "GET", url: "/api/issues/not-an-issue" })).statusCode, 404);
  } finally {
    await fixture.cleanup();
  }
});
