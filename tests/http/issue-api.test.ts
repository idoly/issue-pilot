import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { eq } from "drizzle-orm";

import { openDatabase } from "../../src/db/client.ts";
import { agentSessions, issueRelations, issueRepositories, issues, issueWorkspaces } from "../../src/db/schema.ts";
import { createApiFixture, createIssue, createService, issuePayload, json } from "./fixture.ts";

test("allocates numeric Issue sequences beyond three digits within the current date", async () => {
  const fixture = await createApiFixture();
  const database = openDatabase(fixture.databaseFile);
  try {
    await createService(fixture.app, "Sequence", ["test"]);
    const first = await createIssue(fixture.app, "sequence", "test");
    const prefix = String(first.id).slice(0, -3);
    const [original] = await database.db.select().from(issues).where(eq(issues.key, String(first.id)));
    for (const key of [`${prefix}099`, `${prefix}999`, `${prefix}1000`, "ISSUE-19000101-999999"]) {
      const id = randomUUID();
      await database.db.transaction(async tx => {
        await tx.insert(issues).values({ ...original!, id, key });
        await tx.insert(issueWorkspaces).values({ issueId: id });
      });
    }
    assert.equal((await createIssue(fixture.app, "sequence", "test")).id, `${prefix}1001`);
    assert.equal((await createIssue(fixture.app, "sequence", "test")).id, `${prefix}1002`);
  } finally { database.close(); await fixture.cleanup(); }
});

test("treats whitespace-only optional Issue fields as empty", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Optional", ["test"]);
    const response = await fixture.app.inject({ method: "POST", url: "/api/issues", payload: { ...issuePayload("optional", "test"), description: " \t ", assigneeSubject: " \t " } });
    assert.equal(response.statusCode, 201, response.body);
    const created = await json(response);
    assert.equal(created.assigneeSubject, null);
    fixture.engine.running.clear();
    const updated = await fixture.app.inject({ method: "PATCH", url: `/api/issues/${created.id}`, payload: { title: "Optional fields", description: " \t ", priority: "p2", assigneeSubject: " \t ", ccSubjects: [] } });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal((await json(updated)).assigneeSubject, null);
    const detail = await fixture.app.inject({ method: "GET", url: `/api/issues/${created.id}` });
    assert.equal((await json(detail)).description, "");
  } finally { await fixture.cleanup(); }
});

test("creates each Issue work mode and rejects ambiguous scope input", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha", ["prod", "test", "dev"]);
    for (const [workMode, environmentKey, type] of [
      ["production_analysis", "prod", "smart_analysis"],
      ["test_analysis", "test", "smart_analysis"],
      ["development_fix", "dev", "defect_fix"],
      ["development_feature", "dev", "feature_development"],
    ] as const) {
      const response = await fixture.app.inject({ method: "POST", url: "/api/issues", payload: { ...issuePayload("alpha"), workMode, title: workMode } });
      assert.equal(response.statusCode, 201, response.body);
      const created = await json(response);
      assert.equal(created.environmentKey, environmentKey);
      assert.equal(created.type, type);
    }
    fixture.engine.running.clear();
    for (const [payload, expected] of [
      [{ ...issuePayload("alpha"), assigneeSubject: "missing-user" }, "invalid_subject"],
      [{ ...issuePayload("alpha"), priority: "urgent" }, "invalid_priority"],
      [{ ...issuePayload("alpha"), workMode: "unknown_mode" }, "invalid_work_mode"],
      [{ ...issuePayload("missing"), serviceKey: "missing" }, "invalid_service_for_work_mode"],
      [{ ...issuePayload("alpha"), environmentKey: "test", type: "smart_analysis" }, "issue_create_scope_contract_invalid"],
    ] as const) {
      const response = await fixture.app.inject({ method: "POST", url: "/api/issues", payload });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal((await json(response)).error, expected);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("creates production smart-analysis Issues with related context", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Orders", ["prod", "dev"]);
    const development = await createIssue(fixture.app, "orders", "dev", "Implemented fix");
    const developmentId = fixture.engine.enqueued.at(-1)!;
    fixture.engine.running.clear();
    const workspacePath = path.join(fixture.root, "workspaces", String(development.id).toLowerCase(), "orders");
    const sessionRoot = path.join(fixture.root, "workspaces", String(development.id).toLowerCase());
    const sessionFile = path.join(sessionRoot, "session.jsonl");
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(sessionFile, "{\"type\":\"session\"}\n", { mode: 0o600 });
    const database = openDatabase(fixture.databaseFile);
    await database.db.insert(issueRepositories).values({ issueId: developmentId, url: "https://example.test/orders.git", baseBranch: "develop", workingBranch: `hotfix-${String(development.id).toLowerCase()}`, localPath: workspacePath, workspaceName: "orders", commitBefore: "a".repeat(40) });
    await database.db.insert(agentSessions).values({ issueId: developmentId, sessionFile, workspacePath: path.dirname(workspacePath) });
    await database.db.update(issueWorkspaces).set({ status: "ready", runtimeReady: true }).where(eq(issueWorkspaces.issueId, developmentId));
    await database.close();

    const payload = { ...issuePayload("orders", "prod", "Production regression"), relatedIssueKeys: [development.id] };
    const response = await fixture.app.inject({ method: "POST", url: "/api/issues", payload });
    assert.equal(response.statusCode, 201, response.body);
    const created = await json(response);
    const detail = await fixture.app.inject({ method: "GET", url: `/api/issues/${created.id}` }).then((result) => JSON.parse(result.body)) as { relatedIssues: Array<{ id: string; title: string; environmentKey: string }> };
    assert.deepEqual(detail.relatedIssues.map(({ id, title, environmentKey }) => ({ id, title, environmentKey })), [{ id: development.id, title: "Implemented fix", environmentKey: "dev" }]);

    const persisted = openDatabase(fixture.databaseFile);
    const targetIssueId = fixture.engine.enqueued.at(-1)!;
    await persisted.db.update(issueWorkspaces).set({ status: "ready", runtimeReady: true }).where(eq(issueWorkspaces.issueId, targetIssueId));
    assert.deepEqual((await persisted.db.select().from(issueRelations)).map(({ relatedIssueId }) => relatedIssueId), [developmentId]);

    fixture.engine.running.clear();
    const missingRelated = await fixture.app.inject({ method: "POST", url: "/api/issues", payload: { ...payload, workMode: "production_analysis", relatedIssueKeys: ["ISSUE-20260101-999"] } });
    assert.equal(missingRelated.statusCode, 400);
    assert.equal((await json(missingRelated)).error, "invalid_related_issues");
    fixture.engine.running.clear();
    const enqueueCount = fixture.engine.enqueued.length;
    const unchanged = await fixture.app.inject({ method: "PUT", url: `/api/issues/${created.id}/related-issues`, payload: { relatedIssueKeys: [development.id] } });
    assert.equal(unchanged.statusCode, 204, unchanged.body);
    assert.equal(fixture.engine.enqueued.length, enqueueCount);

    const invalidUpdate = await fixture.app.inject({ method: "PUT", url: `/api/issues/${created.id}/related-issues`, payload: { relatedIssueKeys: [created.id] } });
    assert.equal(invalidUpdate.statusCode, 400);
    assert.equal((await json(invalidUpdate)).error, "invalid_related_issues");
    assert.deepEqual((await persisted.db.select().from(issueRelations)).map(({ relatedIssueId }) => relatedIssueId), [developmentId]);

    fixture.engine.running.add(developmentId);
    const runningRelated = await fixture.app.inject({ method: "PUT", url: `/api/issues/${created.id}/related-issues`, payload: { relatedIssueKeys: [] } });
    assert.equal(runningRelated.statusCode, 409);
    assert.equal((await json(runningRelated)).error, "issue_already_running");
    fixture.engine.running.delete(developmentId);

    fixture.engine.closeSessionHook = async () => { throw new Error("stop_failed"); };
    const closeFailure = await fixture.app.inject({ method: "PUT", url: `/api/issues/${created.id}/related-issues`, payload: { relatedIssueKeys: [] } });
    assert.equal(closeFailure.statusCode, 500);
    fixture.engine.closeSessionHook = undefined;
    assert.deepEqual((await persisted.db.select().from(issueRelations)).map(({ relatedIssueId }) => relatedIssueId), [developmentId]);

    const removed = await fixture.app.inject({ method: "PUT", url: `/api/issues/${created.id}/related-issues`, payload: { relatedIssueKeys: [] } });
    assert.equal(removed.statusCode, 204, removed.body);
    assert.equal(fixture.engine.enqueued.length, enqueueCount + 1);
    assert.deepEqual(await persisted.db.select().from(issueRelations), []);
    const [updatedWorkspace] = await persisted.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, fixture.engine.enqueued.at(-1)!));
    assert.equal(updatedWorkspace?.runtimeReady, false);

    const tooMany = await fixture.app.inject({ method: "PUT", url: `/api/issues/${created.id}/related-issues`, payload: { relatedIssueKeys: Array.from({ length: 21 }, (_, index) => `ISSUE-20260809-${String(index + 1).padStart(3, "0")}`) } });
    assert.equal(tooMany.statusCode, 400);
    assert.equal((await json(tooMany)).error, "related_issue_limit_exceeded");
    await persisted.close();
  } finally {
    await fixture.cleanup();
  }
});

test("allows production investigations to relate Issues without development branches or sessions", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Orders", ["prod", "test"]);
    const related = await createIssue(fixture.app, "orders", "test", "Test environment evidence");
    fixture.engine.running.clear();

    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/issues",
      payload: { ...issuePayload("orders", "prod", "Production investigation"), relatedIssueKeys: [related.id] },
    });
    assert.equal(response.statusCode, 201, response.body);
    const created = await json(response);
    const detail = await fixture.app.inject({ method: "GET", url: `/api/issues/${created.id}` }).then((result) => JSON.parse(result.body)) as { relatedIssues: Array<{ id: string; environmentKey: string }> };
    assert.deepEqual(detail.relatedIssues.map(({ id, environmentKey }) => ({ id, environmentKey })), [{ id: related.id, environmentKey: "test" }]);
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

for (const [code, status] of [["agent_message_outcome_unknown", 409], ["agent_session_file_incomplete", 500], ["agent_session_file_missing", 500]] as const) test(`classifies ${code} without resubmitting the message`, async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Uncertain");
    const issue = await createIssue(fixture.app, "uncertain", "test", "Uncertain message");
    const queued = fixture.engine.enqueued.length;
    fixture.engine.send = async () => { throw new Error(code); };
    const response = await fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/agent-messages`, payload: { message: "check the outcome" } });
    assert.equal(response.statusCode, status);
    assert.deepEqual(JSON.parse(response.body), { error: code });
    assert.equal(fixture.engine.enqueued.length, queued);
  } finally { await fixture.cleanup(); }
});

test("serializes Issue assignee changes with user deactivation", async () => {
  const fixture = await createApiFixture();
  let release!: () => void;
  try {
    await createService(fixture.app, "Assignment");
    const actor = await fixture.app.inject({ method: "GET", url: "/api/me" }).then(json);
    const headers = { "x-issue-pilot-subject": String(actor.subject) };
    const created = await fixture.app.inject({ method: "POST", url: "/api/users", headers, payload: { subject: "next-owner", name: "Next Owner", email: "next@example.test", role: "developer" } });
    assert.equal(created.statusCode, 201, created.body);
    const issue = await fixture.app.inject({ method: "POST", url: "/api/issues", headers, payload: issuePayload("assignment") }).then(json);
    fixture.engine.running.clear();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    fixture.engine.closeSessionHook = async () => { entered(); await gate; };
    const edit = fixture.app.inject({ method: "PATCH", url: `/api/issues/${issue.id}`, headers, payload: { title: "Assign to next owner", description: "Keep owner valid", priority: "p1", assigneeSubject: "next-owner", ccSubjects: [] } });
    await started;
    const disable = fixture.app.inject({ method: "PATCH", url: "/api/users/next-owner", headers, payload: { name: "Next Owner", email: "next@example.test", role: "developer", active: false } }).then(response => response);
    const disabledBeforeEdit = await Promise.race([disable.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 100))]);
    release();
    assert.equal((await edit).statusCode, 200);
    assert.equal((await disable).statusCode, 409);
    assert.equal(disabledBeforeEdit, false);
    const detail = await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` }).then(json);
    assert.equal(detail.assigneeSubject, "next-owner");
    const users = await fixture.app.inject({ method: "GET", url: "/api/users" }).then(response => JSON.parse(response.body) as Array<{ subject: string }>);
    assert.ok(users.some(user => user.subject === "next-owner"));
  } finally { release?.(); await fixture.cleanup(); }
});

test("edits only Issue metadata and rejects scope fields", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha", ["test", "prod"]);
    await createService(fixture.app, "Beta", ["test", "prod"]);
    const issue = await createIssue(fixture.app, "alpha", "test", "Cross-system investigation");
    const issueId = fixture.engine.enqueued.at(-1)!;
    fixture.engine.running.clear();

    const database = openDatabase(fixture.databaseFile);
    await database.db.insert(issueRepositories).values({ issueId, url: "https://example.test/alpha.git", baseBranch: "main", commitBefore: "a".repeat(40) });
    await database.db.update(issueWorkspaces).set({ status: "ready", runtimeReady: true }).where(eq(issueWorkspaces.issueId, issueId));
    await database.close();

    const scopeUpdate = await fixture.app.inject({ method: "PATCH", url: `/api/issues/${issue.id}`, payload: issuePayload("beta", "prod", "Continue in Beta") });
    assert.equal(scopeUpdate.statusCode, 400);
    assert.equal((await json(scopeUpdate)).error, "issue_scope_update_not_allowed");

    const metadataUpdate = await fixture.app.inject({ method: "PATCH", url: `/api/issues/${issue.id}`, payload: {
      title: "Updated investigation", description: "Preserve scope", priority: "p2", assigneeSubject: null, ccSubjects: [],
    } });
    assert.equal(metadataUpdate.statusCode, 200, metadataUpdate.body);
    assert.equal((await json(metadataUpdate)).environmentKey, "test");
    assert.equal(((await json(metadataUpdate)).service as { key: string }).key, "alpha");
    assert.equal(fixture.engine.closedSessions.at(-1), issueId);
    assert.equal(fixture.engine.enqueued.at(-1), issueId);
    assert.equal(fixture.engine.recordedMessages.at(-1), false);
    assert.match(fixture.engine.messages.at(-1) ?? "", /"environmentKey": "test"/);
    assert.match(fixture.engine.messages.at(-1) ?? "", /"key": "alpha"/);

    fixture.engine.running.clear();
    const detail = await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` }).then((response) => JSON.parse(response.body)) as { title: string; environmentKey: string; service: { key: string }; repositories: unknown[]; workspace: { status: string; sourceAvailable: boolean } };
    assert.equal(detail.title, "Updated investigation");
    assert.equal(detail.environmentKey, "test");
    assert.equal(detail.service.key, "alpha");
    assert.equal(detail.repositories.length, 1);
    assert.equal(detail.workspace.status, "ready");
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

    const listed = await fixture.app.inject({ method: "GET", url: "/api/issues" }).then((response) => JSON.parse(response.body)) as Array<{ id: string; environmentKey: string; workspaceStatus: string; agentRunning: boolean; resolvedAt: string | null }>;
    assert.deepEqual(listed.map(({ id }) => id), [newer.id, older.id]);
    assert.deepEqual(listed.map(({ environmentKey }) => environmentKey), ["test", "test"]);
    assert.deepEqual(listed.map(({ workspaceStatus, agentRunning, resolvedAt }) => ({ workspaceStatus, agentRunning, resolvedAt })), [
      { workspaceStatus: "not_created", agentRunning: false, resolvedAt: null },
      { workspaceStatus: "not_created", agentRunning: false, resolvedAt: null },
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("persists personal queue pins without changing Issue order or ownership", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha");
    const currentUser = await fixture.app.inject({ method: "GET", url: "/api/me" }).then((response) => JSON.parse(response.body)) as { subject: string };
    const assignedResponse = await fixture.app.inject({
      method: "POST",
      url: "/api/issues",
      payload: { ...issuePayload("alpha", "test", "Assigned and pinned"), assigneeSubject: currentUser.subject },
    });
    assert.equal(assignedResponse.statusCode, 201, assignedResponse.body);
    const assigned = await json(assignedResponse);
    const unassigned = await createIssue(fixture.app, "alpha", "test", "Not in personal queue");

    assert.equal((await fixture.app.inject({ method: "PUT", url: `/api/issues/${assigned.id}/pin` })).statusCode, 204);
    assert.equal((await fixture.app.inject({ method: "PUT", url: `/api/issues/${assigned.id}/pin` })).statusCode, 204);
    const pins = await fixture.app.inject({ method: "GET", url: "/api/issue-pins" });
    assert.equal(pins.statusCode, 200);
    assert.deepEqual(JSON.parse(pins.body), [assigned.id]);

    const rejected = await fixture.app.inject({ method: "PUT", url: `/api/issues/${unassigned.id}/pin` });
    assert.equal(rejected.statusCode, 409);
    assert.equal((await json(rejected)).error, "issue_not_assigned_to_current_user");
    assert.equal((await fixture.app.inject({ method: "DELETE", url: `/api/issues/${assigned.id}/pin` })).statusCode, 204);
    assert.deepEqual(JSON.parse((await fixture.app.inject({ method: "GET", url: "/api/issue-pins" })).body), []);
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
    const unmanagedRoot = path.join(fixture.root, "workspaces", unmanagedKey.toLowerCase());
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

test("plans and applies read-only scope transitions with stale-plan protection", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha", ["test", "prod"]);
    await createService(fixture.app, "Beta", ["prod"]);
    const issue = await createIssue(fixture.app, "alpha", "test", "Move investigation");
    const issueId = fixture.engine.enqueued.at(-1)!;
    fixture.engine.running.clear();
    const database = openDatabase(fixture.databaseFile);
    await database.db.insert(issueRepositories).values({ issueId, url: "https://example.test/alpha.git", baseBranch: "main", commitBefore: "a".repeat(40) });
    await database.db.update(issueWorkspaces).set({ status: "ready", runtimeReady: true }).where(eq(issueWorkspaces.issueId, issueId));
    await database.close();

    const target = { serviceKey: "beta", workMode: "production_analysis" };
    const planResponse = await fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/scope-transition/plan`, payload: target });
    assert.equal(planResponse.statusCode, 200, planResponse.body);
    const plan = await json(planResponse) as { planHash: string; expectedIssueUpdatedAt: string; action: string; repositories: { added: unknown[]; removed: unknown[] } };
    assert.equal(plan.action, "rebind_read_only");
    assert.equal(plan.repositories.added.length, 1);
    assert.equal(plan.repositories.removed.length, 1);

    const stale = await fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/scope-transition/apply`, payload: { ...target, expectedIssueUpdatedAt: plan.expectedIssueUpdatedAt, expectedPlanHash: `sha256:${"0".repeat(64)}` } });
    assert.equal(stale.statusCode, 409);
    assert.equal((await json(stale)).error, "scope_transition_plan_stale");

    const applied = await fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/scope-transition/apply`, payload: { ...target, expectedIssueUpdatedAt: plan.expectedIssueUpdatedAt, expectedPlanHash: plan.planHash } });
    assert.equal(applied.statusCode, 200, applied.body);
    const detail = await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` }).then((response) => JSON.parse(response.body)) as { service: { key: string }; environmentKey: string; repositories: unknown[]; workspace: { status: string; sourceAvailable: boolean }; scopeTransitions: Array<{ action: string; planHash: string; from: { service: { key: string }; workMode: string }; to: { service: { key: string }; workMode: string }; repositories: { added: string[]; removed: string[] }; actor: { subject: string } }> };
    assert.equal(detail.service.key, "beta");
    assert.equal(detail.environmentKey, "prod");
    assert.deepEqual(detail.repositories, []);
    assert.equal(detail.workspace.status, "not_created");
    assert.equal(detail.workspace.sourceAvailable, false);
    assert.equal(detail.scopeTransitions.length, 1);
    assert.equal(detail.scopeTransitions[0]!.action, "rebind_read_only");
    assert.equal(detail.scopeTransitions[0]!.planHash, plan.planHash);
    assert.deepEqual(detail.scopeTransitions[0]!.from, { service: { key: "alpha", name: "Alpha" }, workMode: "test_analysis" });
    assert.deepEqual(detail.scopeTransitions[0]!.to, { service: { key: "beta", name: "Beta" }, workMode: "production_analysis" });
    assert.deepEqual(detail.scopeTransitions[0]!.repositories, { retained: [], added: ["https://example.test/beta.git"], removed: ["https://example.test/alpha.git"] });
    const historyResponse = await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}/scope-transitions` });
    assert.equal(historyResponse.statusCode, 200);
    assert.equal((JSON.parse(historyResponse.body) as unknown[]).length, 1);
    assert.equal((await fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/development` })).statusCode, 404);

    fixture.engine.running.clear();
    await createService(fixture.app, "Convertible", ["prod", "dev"]);
    const convertible = await createIssue(fixture.app, "convertible", "prod", "Convert through plan");
    const convertibleId = fixture.engine.enqueued.at(-1)!;
    fixture.engine.running.clear();
    const conversionDatabase = openDatabase(fixture.databaseFile);
    await conversionDatabase.db.insert(issueRepositories).values({ issueId: convertibleId, url: "https://example.test/convertible.git", baseBranch: "main", commitBefore: "b".repeat(40) });
    await conversionDatabase.db.update(issues).set({ status: "pending" }).where(eq(issues.id, convertibleId));
    await conversionDatabase.db.update(issueWorkspaces).set({ status: "ready", runtimeReady: true }).where(eq(issueWorkspaces.issueId, convertibleId));
    await conversionDatabase.close();
    const conversionPlanResponse = await fixture.app.inject({ method: "POST", url: `/api/issues/${convertible.id}/scope-transition/plan`, payload: { serviceKey: "convertible", workMode: "development_fix" } });
    assert.equal(conversionPlanResponse.statusCode, 200, conversionPlanResponse.body);
    const conversionPlan = await json(conversionPlanResponse) as { action: string; branch: string };
    assert.equal(conversionPlan.action, "convert_to_development");
    assert.equal(conversionPlan.branch, `hotfix-${String(convertible.id).toLowerCase()}`);
    const invalidExpectation = await fixture.app.inject({ method: "POST", url: `/api/issues/${convertible.id}/scope-transition/apply`, payload: { serviceKey: "convertible", workMode: "development_fix", expectedIssueUpdatedAt: "invalid", expectedPlanHash: "invalid" } });
    assert.equal(invalidExpectation.statusCode, 400);
    assert.equal((await json(invalidExpectation)).error, "invalid_scope_transition_expectation");
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
    assert.equal(detail.environmentKey, "test");
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
    const invalidSourceWrite = await fixture.app.inject({
      method: "PUT",
      url: `/api/issues/${issue.id}/source/file`,
      headers: { "X-Issue-Pilot-Repository": "alpha-1", "X-Issue-Pilot-Path": "src/index.ts", "X-Issue-Pilot-Sha256": "invalid" },
      payload: { content: "not plain text" },
    });
    assert.equal(invalidSourceWrite.statusCode, 400);
    assert.equal((await json(invalidSourceWrite)).error, "invalid_source_request");
    const largeSourceWrite = await fixture.app.inject({
      method: "PUT",
      url: `/api/issues/${issue.id}/source/file`,
      headers: { "Content-Type": "text/plain", "X-Issue-Pilot-Repository": "alpha-1", "X-Issue-Pilot-Path": "src/index.ts", "X-Issue-Pilot-Sha256": "a".repeat(64) },
      payload: "x".repeat(2 * 1024 * 1024 + 1),
    });
    assert.equal(largeSourceWrite.statusCode, 409);
    assert.equal((await json(largeSourceWrite)).error, "source_browser_unavailable");
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
