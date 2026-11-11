import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { eq } from "drizzle-orm";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { AgentEngine, type AgentReservation } from "../../src/agent/engine.ts";
import { sessionTranscript } from "../../src/agent/events.ts";
import type { GitCommitIdentity, ManagedPiSession } from "../../src/agent/pi-session.ts";
import { openDatabase } from "../../src/db/client.ts";
import { agentSessions, issues, issueWorkspaces, subjects } from "../../src/db/schema.ts";
import { ApiError } from "../../src/http/input.ts";
import { registerSourceBrowserRoutes } from "../../src/http/source-browser-routes.ts";
import type { KeyedSerialQueue } from "../../src/serial.ts";
import { WorkspaceLifecycleManager } from "../../src/workspace/lifecycle.ts";
import { createApiFixture, createIssue, createService } from "./fixture.ts";

for (const mode of ["queued", "steering", "steering-to-queued"] as const)
  for (const explicit of [false, true])
    test(`${mode} messages reauthorize the ${explicit ? "explicit" : "default"} sender after admission waits`, { timeout: 5_000 }, async (context) => {
      const f = await createApiFixture();
      const database = openDatabase(f.databaseFile);
      const engine = new AgentEngine(database.db, f.root);
      const internal = engine as unknown as {
        sessionQueue: KeyedSerialQueue;
        steerQueue: KeyedSerialQueue;
        sessions: Map<string, ManagedPiSession>;
        run(issueId: string, message?: string): Promise<void>;
      };
      const dispatched: Array<string | undefined> = [];
      const steered: string[] = [];
      const identities: GitCommitIdentity[] = [];
      const manager = SessionManager.inMemory(f.root);
      internal.run = async (_issueId, message) => {
        dispatched.push(message);
      };
      context.mock.method(f.engine, "send", (...args: Parameters<AgentEngine["send"]>) => engine.send(...args));
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let pending: Promise<unknown> | undefined;
      let blocker: Promise<void> | undefined;
      try {
        await createService(f.app, "MessageIdentity");
        const issue = await createIssue(f.app, "messageidentity");
        const issueId = f.engine.enqueued.at(-1)!;
        f.engine.running.clear();
        const sender = "message-sender@example.test";
        // The sender owns no Issues and is also the deterministic default identity before deactivation.
        await database.db.insert(subjects).values({ subject: sender, role: "product", createdAt: new Date(0) });
        if (mode !== "queued") {
          let streaming = true;
          internal.sessions.set(issueId, {
            get streaming() {
              return streaming;
            },
            session: {
              sessionManager: manager,
              getSteeringMessages: () => [],
              async steer(message: string) {
                steered.push(message);
              },
            },
            setGitIdentity(identity: GitCommitIdentity) {
              identities.push(identity);
            },
            async prompt(message: string) {
              dispatched.push(message);
            },
            async stop() {},
          } as unknown as ManagedPiSession);
          if (mode === "steering-to-queued") {
            const steer = internal.steerQueue.run.bind(internal.steerQueue);
            context.mock.method(internal.steerQueue, "run", <T>(key: string, operation: () => Promise<T>) =>
              steer(key, async () => {
                // The round ends after send chooses steering, before it acquires that queue.
                streaming = false;
                return operation();
              }),
            );
          }
        }
        const queue = mode === "steering" ? internal.steerQueue : internal.sessionQueue;
        blocker = queue.run(issueId, () => gate);
        const run = queue.run.bind(queue);
        context.mock.method(queue, "run", <T>(key: string, operation: () => Promise<T>) => {
          entered();
          return run(key, operation);
        });
        const response = f.app
          .inject({
            method: "POST",
            url: `/api/issues/${issue.id}/agent-messages`,
            ...(explicit ? { headers: { "x-issue-pilot-subject": sender } } : {}),
            payload: { message: "must not be accepted after deactivation" },
          })
          .then((value) => value);
        pending = response;
        await waiting;
        const disabled = await f.app.inject({
          method: "PATCH",
          url: `/api/users/${sender}`,
          headers: { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject },
          payload: { expectedRevision: 0, active: false },
        });
        assert.equal(disabled.statusCode, 200, disabled.body);
        release();
        const denied = await response;
        assert.equal(denied.statusCode, 400, denied.body);
        assert.equal(denied.json().error, "invalid_current_subject");
        assert.deepEqual(dispatched, []);
        assert.deepEqual(steered, []);
        assert.deepEqual(identities, []);
        assert.deepEqual(sessionTranscript(manager, issueId), []);
        assert.deepEqual(await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issueId)), []);
        assert.equal(engine.isRunning(issueId), false);

        // The rejected input must not appear again when another valid sender continues the Issue.
        const accepted = await f.app.inject({
          method: "POST",
          url: `/api/issues/${issue.id}/agent-messages`,
          headers: { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject },
          payload: { message: "accepted continuation" },
        });
        assert.equal(accepted.statusCode, 202, accepted.body);
        await engine.close();
        const [binding] = await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issueId));
        const transcript = sessionTranscript(mode === "queued" ? SessionManager.open(binding!.sessionFile) : manager, issueId);
        assert.deepEqual(
          transcript.map(({ event }) => event),
          [{ type: "issue_user", message: "accepted continuation" }],
        );
        if (mode === "queued") assert.deepEqual(dispatched, ["accepted continuation"]);
        else if (mode === "steering") {
          assert.equal(steered.length, 1);
          assert.match(steered[0]!, /accepted continuation/);
        } else {
          assert.equal(dispatched.length, 1);
          assert.match(dispatched[0]!, /accepted continuation/);
        }
      } finally {
        release();
        await blocker;
        await pending;
        await engine.close();
        database.close();
        await f.cleanup();
      }
    });

for (const kind of ["source", "status", "related", "release"] as const)
  test(`rejects unknown and inactive identities for ${kind} mutations`, async () => {
    const f = await createApiFixture();
    const database = openDatabase(f.databaseFile);
    try {
      await createService(f.app, "Identity");
      const issue = await createIssue(f.app, "identity");
      const issueId = f.engine.enqueued.at(-1)!;
      f.engine.running.clear();
      const disabled = "disabled@example.test";
      await database.db.insert(subjects).values({ subject: disabled, active: false, role: "developer" });
      await database.db.update(issueWorkspaces).set({ status: "ready", runtimeReady: true }).where(eq(issueWorkspaces.issueId, issueId));
      await database.db.update(issues).set({ status: "pending" }).where(eq(issues.id, issueId));
      const base = `/api/issues/${issue.id}`;
      const requests =
        kind === "source"
          ? [
              { method: "PUT", url: `${base}/source/file`, payload: "changed", headers: { "content-type": "text/plain" } },
              { method: "POST", url: `${base}/source/file`, payload: "created", headers: { "content-type": "text/plain" } },
              ...["directory", "rename", "stage", "unstage", "discard", "commit"].map((action) => ({
                method: "POST",
                url: `${base}/source/${action}`,
                payload: { paths: ["file"], message: "change" },
              })),
              { method: "DELETE", url: `${base}/source/path` },
            ]
          : kind === "status"
            ? [
                { method: "PATCH", url: `${base}/status`, payload: { status: "resolved" } },
                { method: "PATCH", url: `${base}/status`, payload: { status: "open" } },
              ]
            : kind === "related"
              ? [{ method: "PUT", url: `${base}/related-issues`, payload: { relatedIssueKeys: [] } }]
              : [{ method: "DELETE", url: `${base}/workspace` }];
      for (const subject of ["unknown@example.test", disabled]) {
        for (const request of requests) {
          const response = await f.app.inject({
            ...request,
            method: request.method as "PUT" | "POST" | "PATCH" | "DELETE",
            headers: { ...("headers" in request ? request.headers : {}), "x-issue-pilot-subject": subject },
          });
          assert.equal(response.statusCode, 400, `${request.method} ${request.url}: ${response.body}`);
          assert.equal(response.json().error, "invalid_current_subject");
        }
      }
      const [unchanged] = await database.db.select().from(issues).where(eq(issues.id, issueId));
      assert.equal(unchanged!.status, "pending");
      assert.equal(f.engine.closedSessions.length, 0);
    } finally {
      database.close();
      await f.cleanup();
    }
  });

test("source mutations reauthorize after reservation and commit with the current person", async () => {
  const f = await createApiFixture();
  const database = openDatabase(f.databaseFile);
  const app = Fastify();
  const owner = issuePilotConfig.bootstrapUser.subject;
  const authors: unknown[] = [];
  const reserve = f.engine.runExclusive.bind(f.engine);
  let deactivate = true;
  registerSourceBrowserRoutes({
    app,
    database,
    engine: f.engine,
    sourceBrowser: {
      async createCommit(_issue: unknown, _repository: unknown, _message: unknown, author: unknown) {
        authors.push(author);
        return { commit: "fixture" };
      },
    } as never,
  });
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof ApiError ? error.statusCode : 500).send({ error: error instanceof Error ? error.message : "internal_error" }));
  try {
    await createService(f.app, "SourceIdentity");
    const issue = await createIssue(f.app, "sourceidentity");
    f.engine.running.clear();
    f.engine.runExclusive = (ids, operation) =>
      reserve(ids, async (reservation) => {
        await database.db
          .update(subjects)
          .set(deactivate ? { active: false } : { displayName: "Updated Author" })
          .where(eq(subjects.subject, owner));
        return operation(reservation);
      });
    const request = {
      method: "POST" as const,
      url: `/api/issues/${issue.id}/source/commit`,
      headers: { "x-issue-pilot-subject": owner, "x-issue-pilot-repository": "application" },
      payload: { message: "commit" },
    };
    const denied = await app.inject(request);
    assert.equal(denied.statusCode, 400, denied.body);
    assert.deepEqual(authors, []);
    await database.db.update(subjects).set({ active: true }).where(eq(subjects.subject, owner));
    deactivate = false;
    const accepted = await app.inject(request);
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.deepEqual(authors, [{ name: "Updated Author", email: issuePilotConfig.bootstrapUser.email }]);
  } finally {
    await app.close();
    database.close();
    await f.cleanup();
  }
});

for (const operation of ["reopen", "release"] as const)
  for (const explicit of [false, true])
    test(`${operation} rechecks ${explicit ? "explicit" : "default"} identity after the lifecycle queue`, async (context) => {
      const f = await createApiFixture();
      const database = openDatabase(f.databaseFile);
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let pending: Promise<unknown> | undefined;
      try {
        await createService(f.app, "LifecycleIdentity");
        const issue = await createIssue(f.app, "lifecycleidentity");
        const issueId = f.engine.enqueued.at(-1)!;
        f.engine.running.clear();
        await database.db.update(issues).set({ status: "resolved", resolvedAt: new Date() }).where(eq(issues.id, issueId));
        await database.db.insert(subjects).values({ subject: "fallback@example.test", active: true, role: "developer", createdAt: new Date(Date.now() + 60_000) });
        const prototype = WorkspaceLifecycleManager.prototype as unknown as { exclusive(operation: () => Promise<unknown>): Promise<unknown> };
        const original = prototype.exclusive;
        context.mock.method(prototype, "exclusive", function (this: WorkspaceLifecycleManager, operation: () => Promise<unknown>) {
          return original.call(this, async () => {
            entered();
            await gate;
            return operation();
          });
        });
        const response = f.app
          .inject({
            method: operation === "reopen" ? "PATCH" : "DELETE",
            url: `/api/issues/${issue.id}/${operation === "reopen" ? "status" : "workspace"}`,
            ...(operation === "reopen" ? { payload: { status: "open" } } : {}),
            ...(explicit ? { headers: { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject } } : {}),
          })
          .then((value) => value);
        pending = response;
        await waiting;
        await database.db.update(subjects).set({ active: false }).where(eq(subjects.subject, issuePilotConfig.bootstrapUser.subject));
        release();
        const denied = await response;
        assert.equal(denied.statusCode, 400, denied.body);
        assert.equal(denied.json().error, "invalid_current_subject");
        const [unchanged] = await database.db.select().from(issues).where(eq(issues.id, issueId));
        assert.equal(unchanged!.status, "resolved");
        assert.equal(f.engine.closedSessions.length, 0);
      } finally {
        release();
        await pending;
        database.close();
        await f.cleanup();
      }
    });

test("lifecycle operations preserve authorization errors before loading or changing Issue state", async () => {
  const f = await createApiFixture();
  const database = openDatabase(f.databaseFile);
  const manager = new WorkspaceLifecycleManager(database.db, f.root, f.engine);
  const denied = new ApiError(403, "developer_role_required");
  let authorizations = 0;
  const authorize = async () => {
    authorizations++;
    throw denied;
  };
  try {
    const operations = [
      () => manager.releaseIssue("missing", authorize),
      () => manager.reopenIssue("missing", authorize),
      () => manager.convertIssueToDevelopment("missing", undefined, undefined, authorize),
      () => manager.migrateDevelopmentIssueScope("missing", { serviceId: "missing", environmentId: "missing" }, "2026-11-04T00:00:00Z", undefined, authorize),
    ];
    for (const operation of operations) await assert.rejects(operation(), (error) => error === denied);
    assert.equal(authorizations, operations.length);
    assert.equal(f.engine.closedSessions.length, 0);
  } finally {
    database.close();
    await f.cleanup();
  }
});

test("scope conversion rechecks the developer role after its lifecycle wait", async (context) => {
  const f = await createApiFixture();
  const database = openDatabase(f.databaseFile);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let pending: Promise<unknown> | undefined;
  try {
    await createService(f.app, "QueuedScope", ["test", "dev"]);
    const issue = await createIssue(f.app, "queuedscope");
    const issueId = f.engine.enqueued.at(-1)!;
    f.engine.running.clear();
    await database.db.update(issueWorkspaces).set({ status: "ready", runtimeReady: true }).where(eq(issueWorkspaces.issueId, issueId));
    const target = { serviceKey: "queuedscope", workMode: "development_fix" };
    const planResponse = await f.app.inject({ method: "POST", url: `/api/issues/${issue.id}/scope-transition/plan`, payload: target });
    assert.equal(planResponse.statusCode, 200, planResponse.body);
    const plan = planResponse.json();
    assert.equal(plan.action, "convert_to_development");
    const prototype = WorkspaceLifecycleManager.prototype as unknown as { exclusive(operation: () => Promise<unknown>): Promise<unknown> };
    const original = prototype.exclusive;
    context.mock.method(prototype, "exclusive", function (this: WorkspaceLifecycleManager, operation: () => Promise<unknown>) {
      return original.call(this, async () => {
        entered();
        await gate;
        return operation();
      });
    });
    const response = f.app
      .inject({ method: "POST", url: `/api/issues/${issue.id}/scope-transition/apply`, payload: { ...target, expectedIssueUpdatedAt: plan.expectedIssueUpdatedAt, expectedPlanHash: plan.planHash } })
      .then((value) => value);
    pending = response;
    await waiting;
    await database.db.update(subjects).set({ role: "product" }).where(eq(subjects.subject, issuePilotConfig.bootstrapUser.subject));
    release();
    const denied = await response;
    assert.equal(denied.statusCode, 403, denied.body);
    assert.equal(denied.json().error, "developer_role_required");
    assert.deepEqual(f.engine.closedSessions, []);
  } finally {
    release();
    await pending;
    database.close();
    await f.cleanup();
  }
});

for (const explicit of [false, true])
  test(`retry rechecks the ${explicit ? "explicit" : "default"} caller before enqueueing`, { timeout: 5_000 }, async (context) => {
    const f = await createApiFixture();
    const database = openDatabase(f.databaseFile);
    const sender = "retry-sender@example.test";
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let pending: Promise<unknown> | undefined;
    try {
      await createService(f.app, "RetryIdentity");
      const issue = await createIssue(f.app, "retryidentity");
      const issueId = f.engine.enqueued.at(-1)!;
      const enqueued = [...f.engine.enqueued];
      f.engine.running.clear();
      // This caller owns no Issues, so disabling them does not reserve the retried Issue.
      await database.db.insert(subjects).values({ subject: sender, role: "product", createdAt: new Date(0) });
      const reserve = f.engine.runExclusive.bind(f.engine);
      context.mock.method(f.engine, "runExclusive", <T>(ids: string[], operation: (reservation: AgentReservation) => Promise<T>) =>
        reserve(ids, async (reservation) => {
          if (ids.includes(issueId)) {
            entered();
            await gate;
          }
          return operation(reservation);
        }),
      );
      const request = {
        method: "POST" as const,
        url: `/api/issues/${issue.id}/retry`,
        ...(explicit ? { headers: { "x-issue-pilot-subject": sender } } : {}),
      };
      const response = f.app.inject(request).then((value) => value);
      pending = response;
      await waiting;
      const disabled = await f.app.inject({
        method: "PATCH",
        url: `/api/users/${sender}`,
        headers: { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject },
        payload: { expectedRevision: 0, active: false },
      });
      assert.equal(disabled.statusCode, 200, disabled.body);
      release();
      const denied = await response;
      assert.equal(denied.statusCode, 400, denied.body);
      assert.equal(denied.json().error, "invalid_current_subject");
      assert.deepEqual(f.engine.enqueued, enqueued);
      assert.equal(f.engine.isRunning(issueId), false);
      assert.equal(f.engine.reservations.size, 0);
      const [unchanged] = await database.db.select().from(issues).where(eq(issues.id, issueId));
      assert.equal(unchanged!.status, "open");

      // Rejection releases the reservation, and a valid caller can explicitly retry later.
      const accepted = await f.app.inject({ ...request, headers: { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject } });
      assert.equal(accepted.statusCode, 202, accepted.body);
      assert.deepEqual(f.engine.enqueued, [...enqueued, issueId]);
      assert.equal(f.engine.reservations.size, 0);
    } finally {
      release();
      await pending;
      database.close();
      await f.cleanup();
    }
  });
