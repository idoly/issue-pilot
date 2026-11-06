import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AgentEngine } from "../../src/agent/engine.ts";
import { pendingAgentMessages } from "../../src/agent/message-delivery.ts";
import { openDatabase } from "../../src/db/client.ts";
import { agentSessions, issues } from "../../src/db/schema.ts";
import { createApiFixture, createIssue, createService } from "../http/fixture.ts";

async function waitFor(check: () => boolean) {
  for (let n = 0; n < 200; n++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition_not_met");
}

test("cancels queued rounds without waiting for another Issue's slot, keeps input history and does not replay it", async () => {
  const f = await createApiFixture();
  const db = openDatabase(f.databaseFile);
  const engine = new AgentEngine(
    db.db,
    f.root,
    undefined,
    (error) => {
      throw error;
    },
    undefined,
    1,
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: string[] = [];
  const internal = engine as unknown as { run(id: string): Promise<void> };
  internal.run = async (id) => {
    started.push(id);
    await gate;
  };
  try {
    await createService(f.app, "Cancel");
    await createIssue(f.app, "cancel", "test");
    await createIssue(f.app, "cancel", "test");
    const [first, second] = await db.db.select().from(issues);
    engine.enqueue(first!.id);
    await waitFor(() => started.length === 1);
    await engine.send(second!.id, "Keep this message in the conversation");
    assert.equal(engine.getRunState(second!.id), "queued");
    await engine.abort(second!.id);
    assert.equal(engine.getRunState(second!.id), "idle");
    assert.equal(engine.getRunState(first!.id), "running");
    assert.deepEqual(started, [first!.id]);
    const [binding] = await db.db.select().from(agentSessions).where(eq(agentSessions.issueId, second!.id));
    const manager = SessionManager.open(binding!.sessionFile);
    assert.deepEqual(pendingAgentMessages(manager), []);
    assert.ok(manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "issue-pilot-user"));
    await engine.abort(second!.id);
    release();
    engine.enqueue(second!.id);
    await waitFor(() => started.includes(second!.id));
  } finally {
    release();
    await engine.close();
    db.close();
    await f.cleanup();
  }
});

test("cancellation state-write failure is reported to the caller and releases the stopping reservation", async () => {
  const f = await createApiFixture();
  const db = openDatabase(f.databaseFile);
  const errors: unknown[] = [];
  const engine = new AgentEngine(db.db, f.root, undefined, (error) => errors.push(error));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const internal = engine as unknown as { run(id: string): Promise<void>; roundSignal(id: string): AbortSignal };
  let started = false;
  internal.run = async (id) => {
    started = true;
    await gate;
    internal.roundSignal(id);
  };
  try {
    await createService(f.app, "Statefailure");
    await createIssue(f.app, "statefailure", "test");
    const [issue] = await db.db.select().from(issues);
    await db.client.execute("CREATE TRIGGER refuse_cancel BEFORE UPDATE ON issues BEGIN SELECT RAISE(ABORT, 'injected_failure'); END");
    engine.enqueue(issue!.id);
    await waitFor(() => started);
    const stopping = engine.abort(issue!.id);
    await new Promise((resolve) => setImmediate(resolve));
    assert.throws(() => engine.enqueue(issue!.id), /issue_already_running/);
    release();
    await assert.rejects(stopping, /agent_abort_failed/);
    assert.equal(engine.getRunState(issue!.id), "idle");
    assert.equal(errors.length, 1);
    await db.client.execute("DROP TRIGGER refuse_cancel");
    await engine.runExclusive([issue!.id], async () => undefined);
    await engine.abort(issue!.id);
  } finally {
    release();
    await engine.close();
    db.close();
    await f.cleanup();
  }
});

test("running cancellation calls Pi abort, preserves the live session, drains before accepting new work and reauthorizes", async () => {
  const f = await createApiFixture();
  const db = openDatabase(f.databaseFile);
  const errors: unknown[] = [];
  const engine = new AgentEngine(db.db, f.root, undefined, (error) => errors.push(error));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let aborted = 0,
    stopped = 0;
  const internal = engine as unknown as { sessions: Map<string, unknown>; run(id: string): Promise<void>; roundSignal(id: string): AbortSignal };
  let started = false;
  internal.run = async (id) => {
    started = true;
    await gate;
    internal.roundSignal(id);
  };
  try {
    await createService(f.app, "Running");
    await createIssue(f.app, "running", "test");
    const [issue] = await db.db.select().from(issues);
    const managed = {
      session: {
        clearQueue() {},
        async abort() {
          aborted++;
          release();
        },
      },
      async stop() {
        stopped++;
      },
    };
    internal.sessions.set(issue!.id, managed);
    engine.enqueue(issue!.id);
    await waitFor(() => started);
    await assert.rejects(
      engine.abort(issue!.id, async () => {
        throw new Error("inactive");
      }),
      /inactive/,
    );
    assert.equal(aborted, 0);
    await engine.abort(issue!.id);
    assert.equal(aborted, 1);
    assert.equal(stopped, 0);
    assert.equal(internal.sessions.get(issue!.id), managed);
    assert.equal(engine.getRunState(issue!.id), "idle");
    assert.deepEqual(errors, []);
    const [current] = await db.db.select().from(issues).where(eq(issues.id, issue!.id));
    assert.equal(current!.status, "open");
    await engine.runExclusive([issue!.id], async () => undefined);
  } finally {
    release();
    await engine.close();
    db.close();
    await f.cleanup();
  }
});
