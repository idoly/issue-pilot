import assert from "node:assert/strict";
import { DomainError } from "../../src/domain/errors.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { eq } from "drizzle-orm";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { openDatabase } from "../../src/db/client.ts";
import { agentSessions, issueKeySequences, issueRelations, issueRepositories, issues, issueWorkspaces } from "../../src/db/schema.ts";
import { workspaceStatistics, issueEditVersion, createApiFixture, createIssue, createService, issueMetadataPayload, issuePayload, json } from "./fixture.ts";

for (const step of ["enqueue", "summary"] as const)
  test(`returns the committed Issue key if ${step} fails after creation`, async (t) => {
    const f = await createApiFixture();
    try {
      await createService(f.app, "create-receipt");
      const fail = () => {
        throw new Error("fixture_private_detail");
      };
      const hook = step === "enqueue" ? t.mock.method(f.engine, "enqueue", fail) : t.mock.method(f.engine, "getRunState", fail);
      const response = await f.app.inject({ method: "POST", url: "/api/issues", payload: issuePayload("create-receipt") });
      hook.mock.restore();
      const rows = (await f.app.inject({ url: "/api/issues" })).json();
      assert.equal(rows.length, 1);
      assert.equal(response.statusCode, 500);
      assert.deepEqual(response.json(), { error: step === "enqueue" ? "issue_created_enqueue_unconfirmed" : "issue_created_summary_unavailable", outcome: "committed", issueKey: rows[0].id });
      assert.equal((await f.app.inject({ url: `/api/issues/${rows[0].id}` })).statusCode, 200);
      assert.equal(f.engine.enqueued.length, step === "enqueue" ? 0 : 1);
    } finally {
      await f.cleanup();
    }
  });

for (const step of ["before-enqueue", "after-enqueue", "summary"] as const)
  test(`an edit reports committed metadata and uploads after ${step} failure`, async (t) => {
    const f = await createApiFixture();
    try {
      await createService(f.app, "edit-receipt");
      const issue = await createIssue(f.app, "edit-receipt"),
        url = `/api/issues/${issue.id}`;
      f.engine.running.clear();
      const expectedEditVersion = await issueEditVersion(f.app, issue.id);
      const enqueue = f.engine.enqueue.bind(f.engine);
      const fail = () => {
        throw new Error("fixture_private_detail");
      };
      const hook =
        step === "summary"
          ? t.mock.method(f.engine, "getRunState", fail)
          : t.mock.method(f.engine, "enqueue", (id: string) => {
              if (step === "after-enqueue") enqueue(id);
              fail();
            });
      const form = new FormData();
      form.append("issue", JSON.stringify({ ...issueMetadataPayload("Committed edit"), expectedEditVersion }));
      form.append("files", new Blob(["fixture evidence"]), "receipt.txt");
      const request = new Request("http://fixture.test", { method: "PATCH", body: form });
      const result = await f.app.inject({ method: "PATCH", url, headers: { "content-type": request.headers.get("content-type")! }, payload: Buffer.from(await request.arrayBuffer()) });
      hook.mock.restore();
      assert.equal(result.statusCode, 500);
      assert.deepEqual(result.json(), { error: step === "summary" ? "issue_edit_summary_unavailable" : "issue_edit_enqueue_unconfirmed", outcome: "committed" });
      const saved = (await f.app.inject({ url })).json();
      assert.equal(saved.title, "Committed edit");
      assert.notEqual(saved.editVersion, expectedEditVersion);
      assert.equal(saved.attachments.length, 1);
      assert.equal(await readFile(path.join(saved.workingDirectory, saved.attachments[0].storedFileName), "utf8"), "fixture evidence");
      assert.equal(f.engine.enqueued.length, step === "before-enqueue" ? 1 : 2);
    } finally {
      await f.cleanup();
    }
  });

test("every edit requires a valid version before metadata, attachments or session state can change", async () => {
  const f = await createApiFixture();
  try {
    await createService(f.app, "Required version");
    const issue = await createIssue(f.app, "required-version");
    f.engine.running.clear();
    const url = `/api/issues/${issue.id}`;
    const original = (await f.app.inject({ url })).json();
    const enqueued = [...f.engine.enqueued];
    const metadata = { title: "Must not persist", description: "Changed", priority: "p2", resetSession: true };
    for (const expectedEditVersion of [undefined, null, 1, "", "a".repeat(63), "A".repeat(64)]) {
      const response = await f.app.inject({ method: "PATCH", url, payload: { ...metadata, expectedEditVersion } });
      assert.equal(response.statusCode, 400, response.body);
      assert.equal(response.json().error, "invalid_issue_edit_version");
    }
    const form = new FormData();
    form.append("issue", JSON.stringify(metadata));
    form.append("files", new Blob(["Must not be stored"]), "rejected.txt");
    const request = new Request("http://fixture.test", { method: "PATCH", body: form });
    const response = await f.app.inject({ method: "PATCH", url, headers: { "content-type": request.headers.get("content-type")! }, payload: Buffer.from(await request.arrayBuffer()) });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error, "invalid_issue_edit_version");
    assert.deepEqual((await f.app.inject({ url })).json(), original);
    assert.deepEqual(f.engine.enqueued, enqueued);
    assert.deepEqual(f.engine.closedSessions, []);
  } finally {
    await f.cleanup();
  }
});

test("concurrent editors cannot overwrite metadata, CC or attachment changes with an old version", async () => {
  const f = await createApiFixture();
  const database = openDatabase(f.databaseFile);
  try {
    await createService(f.app, "Edit versions");
    const created = await createIssue(f.app, "edit-versions");
    await database.db
      .update(issues)
      .set({ status: "resolved", resolvedAt: new Date() })
      .where(eq(issues.key, String(created.id)));
    const url = `/api/issues/${created.id}`;
    const detail = async () => (await f.app.inject({ url })).json();
    const input = { title: "Edited", description: "Draft", priority: "p2", assigneeSubject: null, ccSubjects: [] };
    const save = async (expectedEditVersion: string, extra: object = {}) => {
      f.engine.running.clear();
      return f.app.inject({ method: "PATCH", url, payload: { ...input, expectedEditVersion, ...extra } });
    };
    const initial = await detail();
    assert.match(initial.editVersion, /^[0-9a-f]{64}$/);
    f.engine.running.clear();
    const writesBefore = f.engine.enqueued.length;
    const results = await Promise.all([
      f.app.inject({ method: "PATCH", url, payload: { ...input, expectedEditVersion: initial.editVersion, title: "First editor" } }),
      f.app.inject({ method: "PATCH", url, payload: { ...input, expectedEditVersion: initial.editVersion, title: "Second editor" } }),
    ]);
    assert.deepEqual(results.map(({ statusCode }) => statusCode).sort(), [200, 409]);
    assert.equal(results.find(({ statusCode }) => statusCode === 409)!.json().error, "issue_edit_conflict");
    assert.equal(f.engine.enqueued.length, writesBefore);
    assert.equal(f.engine.closedSessions.length, 1);
    const current = await detail();
    assert.notEqual(current.editVersion, initial.editVersion);
    // Background progress changes timestamps, not the edited state.
    await database.db
      .update(issues)
      .set({ updatedAt: new Date(1_000) })
      .where(eq(issues.key, String(created.id)));
    assert.equal((await detail()).editVersion, current.editVersion);
    const ccSubject = current.reporter.subject;
    assert.equal((await save(current.editVersion, { ccSubjects: [ccSubject] })).statusCode, 200);
    const withCc = await detail();
    assert.equal((await save(current.editVersion)).statusCode, 409);
    assert.equal((await detail()).ccRecipients[0].subject, ccSubject);

    const form = new FormData();
    form.append("issue", JSON.stringify({ ...input, ccSubjects: [ccSubject], expectedEditVersion: withCc.editVersion }));
    form.append("attachments", new Blob(["saved evidence"], { type: "text/plain" }), "evidence.txt");
    const request = new Request("http://fixture.test", { method: "PATCH", body: form });
    f.engine.running.clear();
    const uploaded = await f.app.inject({ method: "PATCH", url, headers: { "content-type": request.headers.get("content-type")! }, payload: Buffer.from(await request.arrayBuffer()) });
    assert.equal(uploaded.statusCode, 200, uploaded.body);
    const withAttachment = await detail();
    assert.notEqual(withAttachment.editVersion, withCc.editVersion);
    const closedBefore = f.engine.closedSessions.length;
    const conflict = await save(withCc.editVersion, { removedAttachmentIds: [withAttachment.attachments[0].id], resetSession: true, expectedResetVersion: "0".repeat(64) });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error, "issue_edit_conflict");
    assert.equal(f.engine.closedSessions.length, closedBefore);
    assert.deepEqual((await detail()).attachments, withAttachment.attachments);
  } finally {
    database.close();
    await f.cleanup();
  }
});

test("allocates numeric Issue sequences beyond three digits within the current date", async () => {
  // A fixed clock keeps every creation on one regional day even when the suite runs across midnight.
  const fixture = await createApiFixture({ now: () => new Date("2026-11-15T04:00:00.000Z") });
  const database = openDatabase(fixture.databaseFile);
  try {
    await createService(fixture.app, "Sequence", ["test"]);
    assert.equal((await createIssue(fixture.app, "sequence", "test")).id, "ISSUE-20261115-001");
    await database.db.update(issueKeySequences).set({ lastValue: 998 }).where(eq(issueKeySequences.day, "20261115"));
    await database.db.insert(issueKeySequences).values({ day: "19000101", lastValue: 999999 });
    assert.equal((await createIssue(fixture.app, "sequence", "test")).id, "ISSUE-20261115-999");
    const thousandth = await createIssue(fixture.app, "sequence", "test");
    assert.equal(thousandth.id, "ISSUE-20261115-1000");
    assert.equal((await createIssue(fixture.app, "sequence", "test")).id, "ISSUE-20261115-1001");
    const detail = await fixture.app.inject({ url: `/api/issues/${thousandth.id}` });
    assert.equal(detail.statusCode, 200, detail.body);
  } finally {
    database.close();
    await fixture.cleanup();
  }
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
    const updated = await fixture.app.inject({
      method: "PATCH",
      url: `/api/issues/${created.id}`,
      payload: { expectedEditVersion: await issueEditVersion(fixture.app, created.id), title: "Optional fields", description: " \t ", priority: "p2", assigneeSubject: " \t ", ccSubjects: [] },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal((await json(updated)).assigneeSubject, null);
    const detail = await fixture.app.inject({ method: "GET", url: `/api/issues/${created.id}` });
    assert.equal((await json(detail)).description, "");
  } finally {
    await fixture.cleanup();
  }
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
    await writeFile(sessionFile, '{"type":"session"}\n', { mode: 0o600 });
    const database = openDatabase(fixture.databaseFile);
    await database.db.insert(issueRepositories).values({
      issueId: developmentId,
      url: "https://example.test/orders.git",
      baseBranch: "develop",
      workingBranch: `hotfix-${String(development.id).toLowerCase()}`,
      localPath: workspacePath,
      workspaceName: "orders",
      commitBefore: "a".repeat(40),
    });
    await database.db.insert(agentSessions).values({ issueId: developmentId, sessionFile, workspacePath: path.dirname(workspacePath) });
    await database.db.update(issueWorkspaces).set({ status: "ready", runtimeReady: true }).where(eq(issueWorkspaces.issueId, developmentId));
    await database.close();

    const payload = { ...issuePayload("orders", "prod", "Production regression"), relatedIssueKeys: [development.id] };
    const response = await fixture.app.inject({ method: "POST", url: "/api/issues", payload });
    assert.equal(response.statusCode, 201, response.body);
    const created = await json(response);
    const detail = (await fixture.app.inject({ method: "GET", url: `/api/issues/${created.id}` }).then((result) => JSON.parse(result.body))) as {
      relatedIssues: Array<{ id: string; title: string; environmentKey: string }>;
    };
    assert.deepEqual(
      detail.relatedIssues.map(({ id, title, environmentKey }) => ({ id, title, environmentKey })),
      [{ id: development.id, title: "Implemented fix", environmentKey: "dev" }],
    );

    const persisted = openDatabase(fixture.databaseFile);
    const targetIssueId = fixture.engine.enqueued.at(-1)!;
    await persisted.db.update(issueWorkspaces).set({ status: "ready", runtimeReady: true }).where(eq(issueWorkspaces.issueId, targetIssueId));
    assert.deepEqual(
      (await persisted.db.select().from(issueRelations)).map(({ relatedIssueId }) => relatedIssueId),
      [developmentId],
    );

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
    assert.deepEqual(
      (await persisted.db.select().from(issueRelations)).map(({ relatedIssueId }) => relatedIssueId),
      [developmentId],
    );

    fixture.engine.running.add(developmentId);
    const runningRelated = await fixture.app.inject({ method: "PUT", url: `/api/issues/${created.id}/related-issues`, payload: { relatedIssueKeys: [] } });
    assert.equal(runningRelated.statusCode, 409);
    assert.equal((await json(runningRelated)).error, "issue_already_running");
    fixture.engine.running.delete(developmentId);

    fixture.engine.closeSessionHook = async () => {
      throw new Error("stop_failed");
    };
    const closeFailure = await fixture.app.inject({ method: "PUT", url: `/api/issues/${created.id}/related-issues`, payload: { relatedIssueKeys: [] } });
    assert.equal(closeFailure.statusCode, 500);
    fixture.engine.closeSessionHook = undefined;
    assert.deepEqual(
      (await persisted.db.select().from(issueRelations)).map(({ relatedIssueId }) => relatedIssueId),
      [developmentId],
    );

    const removed = await fixture.app.inject({ method: "PUT", url: `/api/issues/${created.id}/related-issues`, payload: { relatedIssueKeys: [] } });
    assert.equal(removed.statusCode, 204, removed.body);
    assert.equal(fixture.engine.enqueued.length, enqueueCount + 1);
    assert.deepEqual(await persisted.db.select().from(issueRelations), []);
    const [updatedWorkspace] = await persisted.db
      .select()
      .from(issueWorkspaces)
      .where(eq(issueWorkspaces.issueId, fixture.engine.enqueued.at(-1)!));
    assert.equal(updatedWorkspace?.runtimeReady, false);

    const tooMany = await fixture.app.inject({
      method: "PUT",
      url: `/api/issues/${created.id}/related-issues`,
      payload: { relatedIssueKeys: Array.from({ length: 21 }, (_, index) => `ISSUE-20260809-${String(index + 1).padStart(3, "0")}`) },
    });
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
    const detail = (await fixture.app.inject({ method: "GET", url: `/api/issues/${created.id}` }).then((result) => JSON.parse(result.body))) as {
      relatedIssues: Array<{ id: string; environmentKey: string }>;
    };
    assert.deepEqual(
      detail.relatedIssues.map(({ id, environmentKey }) => ({ id, environmentKey })),
      [{ id: related.id, environmentKey: "test" }],
    );
  } finally {
    await fixture.cleanup();
  }
});

test("serializes retries, status transitions and messages with one Issue reservation; comments are retired", async () => {
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
    const retries = await Promise.all([fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/retry` }), fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/retry` })]);
    assert.deepEqual(retries.map(({ statusCode }) => statusCode).sort(), [202, 409]);
    fixture.engine.running.delete(issueId);

    const pendingRetry = openDatabase(fixture.databaseFile);
    await pendingRetry.db.update(issues).set({ status: "pending" }).where(eq(issues.id, issueId));
    await pendingRetry.close();
    // The detail view offers "继续处理" for an unresolved pending Issue; the route must accept it.
    assert.equal((await fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/retry` })).statusCode, 202);
    fixture.engine.running.delete(issueId);
    const reopened = openDatabase(fixture.databaseFile);
    await reopened.db.update(issues).set({ status: "open" }).where(eq(issues.id, issueId));
    await reopened.close();

    assert.equal((await fixture.app.inject({ method: "PATCH", url: `/api/issues/${issue.id}/status`, payload: { status: "resolved" } })).statusCode, 409);
    const pending = openDatabase(fixture.databaseFile);
    await pending.db.update(issues).set({ status: "pending" }).where(eq(issues.id, issueId));
    await pending.close();
    fixture.engine.closeSessionHook = async () => {
      throw new Error("stop_failed");
    };
    assert.equal((await fixture.app.inject({ method: "PATCH", url: `/api/issues/${issue.id}/status`, payload: { status: "resolved" } })).statusCode, 500);
    fixture.engine.closeSessionHook = undefined;
    assert.equal((await fixture.app.inject({ method: "PATCH", url: `/api/issues/${issue.id}/status`, payload: { status: "resolved" } })).statusCode, 200);
    assert.equal((await fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/agent-messages`, payload: { message: "blocked" } })).statusCode, 409);
    assert.equal((await fixture.app.inject({ method: "PATCH", url: `/api/issues/${issue.id}/status`, payload: { status: "open" } })).statusCode, 200);

    // Comments are retired: no write route, no detail field, and migration 0081 removed the table.
    const history = openDatabase(fixture.databaseFile);
    try {
      const comment = await fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/comments`, payload: { body: "A note" } });
      assert.equal(comment.statusCode, 404);
      const detail = JSON.parse((await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` })).body) as Record<string, unknown>;
      assert.equal(Object.hasOwn(detail, "comments"), false);
      assert.deepEqual((await history.client.execute("SELECT name FROM sqlite_master WHERE name LIKE '%comment%'")).rows, []);
    } finally {
      await history.close();
    }
    const message = await fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/agent-messages`, payload: { message: "Check evidence" } });
    assert.equal(message.statusCode, 202);
    assert.equal(fixture.engine.messages.at(-1), "Check evidence");
    assert.equal((await fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/agent-messages`, payload: { message: "" } })).statusCode, 400);
  } finally {
    await fixture.cleanup();
  }
});

// The engine owns the refusal category; operational state damage stays an internal failure.
for (const [code, status, failure] of [
  ["agent_message_outcome_unknown", 409, () => new DomainError("agent_message_outcome_unknown", "conflict")],
  ["agent_session_file_incomplete", 500, () => new Error("agent_session_file_incomplete")],
  ["agent_session_file_missing", 500, () => new Error("agent_session_file_missing")],
  ["issue_root_missing", 500, () => new Error("issue_root_missing")],
  ["invalid_issue_root", 500, () => new Error("invalid_issue_root")],
] as const)
  test(`classifies ${code} without resubmitting the message`, async () => {
    const fixture = await createApiFixture();
    try {
      await createService(fixture.app, "Uncertain");
      const issue = await createIssue(fixture.app, "uncertain", "test", "Uncertain message");
      const queued = fixture.engine.enqueued.length;
      fixture.engine.send = async () => {
        throw failure();
      };
      const response = await fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/agent-messages`, payload: { message: "check the outcome" } });
      assert.equal(response.statusCode, status);
      assert.deepEqual(JSON.parse(response.body), { error: code });
      assert.equal(fixture.engine.enqueued.length, queued);
    } finally {
      await fixture.cleanup();
    }
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
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.engine.closeSessionHook = async () => {
      entered();
      await gate;
    };
    const edit = fixture.app.inject({
      method: "PATCH",
      url: `/api/issues/${issue.id}`,
      headers,
      payload: {
        expectedEditVersion: await issueEditVersion(fixture.app, issue.id),
        title: "Assign to next owner",
        description: "Keep owner valid",
        priority: "p1",
        assigneeSubject: "next-owner",
        ccSubjects: [],
      },
    });
    await started;
    const settled: string[] = [];
    const disable = fixture.app
      .inject({ method: "PATCH", url: "/api/users/next-owner", headers, payload: { expectedRevision: 0, name: "Next Owner", email: "next@example.test", role: "developer", active: false } })
      .then((response) => {
        settled.push("disable");
        return response;
      });
    const edited = edit.then((response) => {
      settled.push("edit");
      return response;
    });
    release();
    // Deactivation queues behind the held edit: it observes the committed assignee and refuses instead of racing it.
    assert.equal((await edited).statusCode, 200);
    assert.equal((await disable).statusCode, 409);
    assert.deepEqual(settled, ["edit", "disable"]);
    const detail = await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` }).then(json);
    assert.equal(detail.assigneeSubject, "next-owner");
    const users = await fixture.app.inject({ method: "GET", url: "/api/users" }).then((response) => JSON.parse(response.body) as Array<{ subject: string }>);
    assert.ok(users.some((user) => user.subject === "next-owner"));
  } finally {
    release?.();
    await fixture.cleanup();
  }
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

    const scopeUpdate = await fixture.app.inject({
      method: "PATCH",
      url: `/api/issues/${issue.id}`,
      payload: { ...issuePayload("beta", "prod", "Continue in Beta"), expectedEditVersion: await issueEditVersion(fixture.app, issue.id) },
    });
    assert.equal(scopeUpdate.statusCode, 400);
    assert.equal((await json(scopeUpdate)).error, "issue_scope_update_not_allowed");

    const metadataUpdate = await fixture.app.inject({
      method: "PATCH",
      url: `/api/issues/${issue.id}`,
      payload: {
        title: "Updated investigation",
        expectedEditVersion: await issueEditVersion(fixture.app, issue.id),
        description: "Preserve scope",
        priority: "p2",
        assigneeSubject: null,
        ccSubjects: [],
      },
    });
    assert.equal(metadataUpdate.statusCode, 200, metadataUpdate.body);
    assert.equal((await json(metadataUpdate)).environmentKey, "test");
    assert.equal(((await json(metadataUpdate)).service as { key: string }).key, "alpha");
    assert.equal(fixture.engine.closedSessions.at(-1), issueId);
    assert.equal(fixture.engine.enqueued.at(-1), issueId);
    assert.match(fixture.engine.messages.at(-1) ?? "", /"environmentKey": "test"/);
    assert.match(fixture.engine.messages.at(-1) ?? "", /"key": "alpha"/);

    fixture.engine.running.clear();
    const detail = (await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` }).then((response) => JSON.parse(response.body))) as {
      title: string;
      environmentKey: string;
      service: { key: string };
      repositories: unknown[];
      workspace: { status: string; sourceAvailable: boolean };
    };
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
    await database.db
      .update(issues)
      .set({ createdAt: new Date("2026-08-14T00:00:00.000Z"), updatedAt: new Date("2026-08-14T02:00:00.000Z") })
      .where(eq(issues.key, String(older.id)));
    await database.db
      .update(issues)
      .set({ createdAt: new Date("2026-08-14T01:00:00.000Z"), updatedAt: new Date("2026-08-14T01:00:00.000Z") })
      .where(eq(issues.key, String(newer.id)));
    await database.close();

    const listed = (await fixture.app.inject({ method: "GET", url: "/api/issues" }).then((response) => JSON.parse(response.body))) as Array<{
      id: string;
      environmentKey: string;
      workspaceStatus: string;
      agentRunning: boolean;
      resolvedAt: string | null;
    }>;
    assert.deepEqual(
      listed.map(({ id }) => id),
      [newer.id, older.id],
    );
    assert.deepEqual(
      listed.map(({ environmentKey }) => environmentKey),
      ["test", "test"],
    );
    assert.deepEqual(
      listed.map(({ workspaceStatus, agentRunning, resolvedAt }) => ({ workspaceStatus, agentRunning, resolvedAt })),
      [
        { workspaceStatus: "not_created", agentRunning: false, resolvedAt: null },
        { workspaceStatus: "not_created", agentRunning: false, resolvedAt: null },
      ],
    );
  } finally {
    await fixture.cleanup();
  }
});

test("lists reporter and CC subjects and refreshes the revision for CC changes within the same second", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-15T15:00:00Z") });
  const fixture = await createApiFixture();
  try {
    for (const subject of ["cc-one@example.test", "cc-two@example.test"]) {
      const user = await fixture.app.inject({
        method: "POST",
        url: "/api/users",
        headers: { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject },
        payload: { subject, name: subject, email: subject },
      });
      assert.equal(user.statusCode, 201, user.body);
    }
    await createService(fixture.app, "Alpha");
    const plain = await createIssue(fixture.app, "alpha", "test", "Without CC");
    const response = await fixture.app.inject({
      method: "POST",
      url: "/api/issues",
      payload: { ...issuePayload("alpha", "test", "With CC"), assigneeSubject: null, ccSubjects: ["cc-two@example.test", "cc-one@example.test"] },
    });
    assert.equal(response.statusCode, 201, response.body);
    const created = await json(response);
    const reporterSubject = String(created.reporterSubject);
    assert.deepEqual(created.ccSubjects, ["cc-one@example.test", "cc-two@example.test"]);
    fixture.engine.running.clear();
    type Summary = { id: string; reporterSubject: string; assigneeSubject: string | null; ccSubjects: string[]; revision: string; updatedAt: string };
    const list = async () => (await fixture.app.inject({ url: "/api/issues" })).json() as Summary[];
    const before = await list();
    assert.deepEqual(
      before.map(({ id, reporterSubject, assigneeSubject, ccSubjects }) => ({ id, reporterSubject, assigneeSubject, ccSubjects })),
      [
        { id: created.id, reporterSubject, assigneeSubject: null, ccSubjects: ["cc-one@example.test", "cc-two@example.test"] },
        { id: plain.id, reporterSubject: String(plain.reporterSubject), assigneeSubject: null, ccSubjects: [] },
      ],
    );

    const { title, description, priority, assigneeSubject } = issuePayload("alpha", "test", "With CC");
    const updated = await fixture.app.inject({
      method: "PATCH",
      url: `/api/issues/${created.id}`,
      payload: { expectedEditVersion: await issueEditVersion(fixture.app, created.id), title, description, priority, assigneeSubject, ccSubjects: ["cc-two@example.test"] },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    // A PATCH schedules a round; hold execution state constant to isolate the CC change.
    fixture.engine.running.clear();
    const after = (await list()).find(({ id }) => id === created.id)!;
    assert.deepEqual(after.ccSubjects, ["cc-two@example.test"]);
    assert.equal(after.updatedAt, before[0]!.updatedAt);
    // A CC-only edit must invalidate open details through the shared revision token.
    assert.notEqual(after.revision, before[0]!.revision);
    const detail = (await fixture.app.inject({ url: `/api/issues/${created.id}` })).json() as Summary;
    assert.deepEqual([detail.ccSubjects, detail.reporterSubject, detail.revision], [after.ccSubjects, reporterSubject, after.revision]);
  } finally {
    await fixture.cleanup();
  }
});

test("refreshes same-second description changes without conflating detail freshness with the edit version", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-15T15:00:00Z") });
  const f = await createApiFixture();
  try {
    await createService(f.app, "Freshness");
    const title = "Detail only";
    const issue = await createIssue(f.app, "freshness", "test", title);
    const url = `/api/issues/${issue.id}`;
    type Summary = { revision: string; updatedAt: string };
    type Detail = Summary & { editVersion: string; description: string };
    const readDetail = async () => {
      const response = await f.app.inject(url);
      const list = await f.app.inject("/api/issues");
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(list.statusCode, 200, list.body);
      const detail = response.json<Detail>();
      const [summary] = list.json<Summary[]>();
      assert.equal(summary?.revision, detail.revision);
      assert.equal(Object.hasOwn(summary!, "detailRevision"), false);
      return detail;
    };
    f.engine.running.clear();
    const initial = await readDetail();
    const description = "Edited during the same second";
    const saved = await f.app.inject({
      method: "PATCH",
      url,
      payload: { ...issueMetadataPayload(title), description, expectedEditVersion: initial.editVersion },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    f.engine.running.clear();
    const edited = await readDetail();
    assert.equal(edited.updatedAt, initial.updatedAt);
    assert.equal(edited.description, description);
    assert.notEqual(edited.revision, initial.revision);
    assert.notEqual(edited.editVersion, initial.editVersion);
  } finally {
    await f.cleanup();
  }
});

test("persists personal queue pins without changing Issue order or ownership", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha");
    const currentUser = (await fixture.app.inject({ method: "GET", url: "/api/me" }).then((response) => JSON.parse(response.body))) as { subject: string };
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
    const concurrent = await Promise.all([
      fixture.app.inject({ method: "POST", url: "/api/issues", payload: issuePayload("alpha", "test", "Concurrent A") }),
      fixture.app.inject({ method: "POST", url: "/api/issues", payload: issuePayload("alpha", "test", "Concurrent B") }),
    ]);
    assert.deepEqual(
      concurrent.map(({ statusCode }) => statusCode),
      [201, 201],
    );
    const keys = await Promise.all(concurrent.map(async (response) => String((await json(response)).id)));
    assert.equal(new Set(keys).size, 2);
    assert.deepEqual(keys.sort(), [String(first.id).replace(/001$/, "003"), String(first.id).replace(/001$/, "004")]);
    assert.equal(await readFile(evidence, "utf8"), "preserve");
  } finally {
    await fixture.cleanup();
  }
});

test("deleting the last Issue of a day does not recycle its key or link", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Sequence");
    const first = await createIssue(fixture.app, "sequence", "test", "Original");
    fixture.engine.running.clear();
    const oldLink = `/api/issues/${first.id}`;
    assert.equal((await fixture.app.inject({ method: "DELETE", url: oldLink })).statusCode, 204);
    const second = await createIssue(fixture.app, "sequence", "test", "New Issue");
    assert.equal(second.id, String(first.id).replace(/001$/, "002"));
    assert.equal((await fixture.app.inject(oldLink)).statusCode, 404);
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
    const plan = (await json(planResponse)) as { planHash: string; expectedIssueUpdatedAt: string; action: string; repositories: { added: unknown[]; removed: unknown[] } };
    assert.equal(plan.action, "rebind_read_only");
    assert.equal(plan.repositories.added.length, 1);
    assert.equal(plan.repositories.removed.length, 1);

    const stale = await fixture.app.inject({
      method: "POST",
      url: `/api/issues/${issue.id}/scope-transition/apply`,
      payload: { ...target, expectedIssueUpdatedAt: plan.expectedIssueUpdatedAt, expectedPlanHash: `sha256:${"0".repeat(64)}` },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal((await json(stale)).error, "scope_transition_plan_stale");

    const applied = await fixture.app.inject({
      method: "POST",
      url: `/api/issues/${issue.id}/scope-transition/apply`,
      payload: { ...target, expectedIssueUpdatedAt: plan.expectedIssueUpdatedAt, expectedPlanHash: plan.planHash },
    });
    assert.equal(applied.statusCode, 200, applied.body);
    const detail = (await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` }).then((response) => JSON.parse(response.body))) as {
      service: { key: string };
      environmentKey: string;
      repositories: unknown[];
      workspace: { status: string; sourceAvailable: boolean };
      scopeTransitions: Array<{
        action: string;
        planHash: string;
        from: { service: { key: string }; workMode: string };
        to: { service: { key: string }; workMode: string };
        repositories: { added: string[]; removed: string[] };
        actor: { subject: string };
      }>;
    };
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
    assert.equal((await fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/development` })).statusCode, 404);

    fixture.engine.running.clear();
    await createService(fixture.app, "Convertible", ["prod", "dev"]);
    const convertible = await createIssue(fixture.app, "convertible", "prod", "Convert through plan");
    const convertibleId = fixture.engine.enqueued.at(-1)!;
    fixture.engine.running.clear();
    const conversionDatabase = openDatabase(fixture.databaseFile);
    await conversionDatabase.db.insert(issueRepositories).values({ issueId: convertibleId, url: "git@example.test:convertible.git", baseBranch: "main", commitBefore: "b".repeat(40) });
    await conversionDatabase.db.update(issues).set({ status: "pending" }).where(eq(issues.id, convertibleId));
    await conversionDatabase.db.update(issueWorkspaces).set({ status: "ready", runtimeReady: true }).where(eq(issueWorkspaces.issueId, convertibleId));
    await conversionDatabase.close();
    const conversionPlanResponse = await fixture.app.inject({
      method: "POST",
      url: `/api/issues/${convertible.id}/scope-transition/plan`,
      payload: { serviceKey: "convertible", workMode: "development_fix" },
    });
    assert.equal(conversionPlanResponse.statusCode, 200, conversionPlanResponse.body);
    const conversionPlan = (await json(conversionPlanResponse)) as { action: string; branch: string };
    assert.equal(conversionPlan.action, "convert_to_development");
    assert.equal(conversionPlan.branch, `hotfix-${String(convertible.id).toLowerCase()}`);
    const invalidExpectation = await fixture.app.inject({
      method: "POST",
      url: `/api/issues/${convertible.id}/scope-transition/apply`,
      payload: { serviceKey: "convertible", workMode: "development_fix", expectedIssueUpdatedAt: "invalid", expectedPlanHash: "invalid" },
    });
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
    assert.deepEqual(Object.keys(detail.workspace as Record<string, unknown>).sort(), ["lastError", "retryable", "runtimeReady", "sourceAvailable", "status"]);
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
    const body = (await workspaceStatistics(fixture.app)) as { totalBytes: number; policy: Record<string, unknown>; workspaces: Array<Record<string, unknown>> };
    assert.equal(typeof body.totalBytes, "number");
    assert.deepEqual(Object.keys(body.policy).sort(), ["highWaterBytes", "maintenanceIntervalMinutes", "retentionHours", "targetBytes"]);
    assert.equal(
      body.workspaces.some((workspace) => "issueId" in workspace),
      false,
    );
    assert.equal((await fixture.app.inject({ method: "GET", url: "/api/issues/not-an-issue" })).statusCode, 404);
  } finally {
    await fixture.cleanup();
  }
});

test("an unknown or foreign session id is a not-found history entry", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Sessions", ["test"]);
    const issue = await createIssue(fixture.app, "sessions", "test");
    fixture.engine.running.clear();
    for (const sessionId of ["not-a-real-session", ""]) {
      const response = await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}/sessions/${encodeURIComponent(sessionId)}` });
      assert.equal(response.statusCode, 404, `${sessionId}: ${response.body}`);
      assert.equal(JSON.parse(response.body).error, "agent_session_not_found");
    }
  } finally {
    await fixture.cleanup();
  }
});

test("Issue key dates roll over at the configured regional midnight, not UTC midnight", async () => {
  // Asia/Shanghai is UTC+8: its midnight is 16:00 UTC, while UTC midnight falls mid-morning on the same regional day.
  assert.equal(issuePilotConfig.regional.timeZone, "Asia/Shanghai");
  let current = new Date(0);
  const f = await createApiFixture({ now: () => current });
  try {
    await createService(f.app, "Key dates");
    const createdAt = async (at: string) => {
      current = new Date(at);
      const issue = await createIssue(f.app, "key-dates");
      f.engine.running.clear();
      return issue.id;
    };
    assert.equal(await createdAt("2026-11-14T15:59:59.999Z"), "ISSUE-20261114-001");
    assert.equal(await createdAt("2026-11-14T16:00:00.000Z"), "ISSUE-20261115-001");
    assert.equal(await createdAt("2026-11-14T23:59:59.999Z"), "ISSUE-20261115-002");
    assert.equal(await createdAt("2026-11-15T00:00:00.000Z"), "ISSUE-20261115-003");
    assert.equal(await createdAt("2026-11-15T16:00:00.000Z"), "ISSUE-20261116-001");
  } finally {
    await f.cleanup();
  }
});
