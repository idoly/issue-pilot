import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AgentEngine, type AgentReservation } from "../../src/agent/engine.ts";
import { repositoryPreparationMode } from "../../src/workspace/project.ts";
import type { RunEvent } from "../../src/agent/events.ts";

// Never the checkout's real .issue-pilot state; these engines run fake sessions only.
const unusedStateRoot = join(tmpdir(), `issue-pilot-engine-unused-${process.pid}`);

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition_not_met");
}

test("bounds concurrent Issue rounds while retaining reservations and draining queued work on close", async () => {
  const published: RunEvent[] = [];
  const engine = new AgentEngine({} as never, unusedStateRoot, (event) => published.push(event), undefined, undefined, 1);
  let releaseFirst!: () => void, releaseSecond!: () => void;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const second = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const started: string[] = [];
  (engine as unknown as { run(id: string): Promise<void> }).run = async (id) => {
    started.push(id);
    await (id === "first" ? first : second);
  };
  try {
    assert.equal(engine.getRunState("second"), "idle");
    engine.enqueue("first");
    engine.enqueue("second");
    await waitFor(() => started.length === 1);
    assert.deepEqual(started, ["first"]);
    assert.equal(engine.getRunState("first"), "running");
    assert.equal(engine.getRunState("second"), "queued");
    assert.equal(engine.isRunning("second"), true);
    await assert.rejects(
      engine.runExclusive(["second"], async () => undefined),
      /issue_already_running/,
    );
    let closed = false;
    const closing = engine.close().then(() => {
      closed = true;
    });
    releaseFirst();
    await waitFor(() => started.length === 2);
    assert.equal(engine.getRunState("first"), "idle");
    assert.equal(engine.getRunState("second"), "running");
    assert.equal(closed, false);
    releaseSecond();
    await closing;
    assert.equal(engine.isRunning("second"), false);
    assert.equal(engine.getRunState("second"), "idle");
    assert.equal(closed, true);
    assert.deepEqual(
      published.filter((event) => event.issueId === "second" && event.event.type === "issue_run_state").map((event) => event.event.type === "issue_run_state" && event.event.state),
      ["queued", "running", "idle"],
    );
  } finally {
    releaseFirst();
    releaseSecond();
    await engine.close();
  }
});

test("selects repository preparation modes from environment and issue type", () => {
  assert.equal(repositoryPreparationMode("prod", "smart_analysis"), "shared");
  assert.equal(repositoryPreparationMode("test", "smart_analysis"), "shared");
  assert.equal(repositoryPreparationMode("dev", "defect_fix"), "hotfix");
  assert.equal(repositoryPreparationMode("dev", "feature_development"), "feature");
});

test("reserves issues against concurrent Agent activity and always releases reservations", async () => {
  const engine = new AgentEngine({} as never);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const exclusive = engine.runExclusive(["issue-1"], async () => {
    assert.equal(engine.isRunning("issue-1"), false);
    assert.throws(() => engine.enqueue("issue-1"), /issue_already_running/);
    await assert.rejects(engine.send("issue-1", "message"), /issue_already_running/);
    await blocked;
    throw new Error("operation_failed");
  });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    engine.runExclusive(["issue-1"], async () => undefined),
    /issue_already_running/,
  );
  release();
  await assert.rejects(exclusive, /operation_failed/);
  let expiredReservation: AgentReservation | undefined;
  await engine.runExclusive(["issue-1"], async (reservation) => {
    expiredReservation = reservation;
  });
  assert.throws(() => expiredReservation!.enqueue("issue-1"), /issue_not_reserved/);
  await assert.rejects(expiredReservation!.closeSession("issue-1"), /issue_not_reserved/);
});

test("drains active reservations before closing and rejects new activity", async () => {
  const engine = new AgentEngine({} as never);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reservation = engine.runExclusive(["issue-1"], async () => {
    await gate;
  });
  await new Promise((resolve) => setImmediate(resolve));
  let closed = false;
  const closing = engine.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  assert.throws(() => engine.enqueue("issue-2"), /agent_engine_closing/);
  await assert.rejects(engine.send("issue-2", "message"), /agent_engine_closing/);
  await assert.rejects(
    engine.runExclusive(["issue-2"], async () => undefined),
    /agent_engine_closing/,
  );
  release();
  await reservation;
  await closing;
  assert.equal(closed, true);
});

test("attempts to stop every session when closing", async () => {
  const engine = new AgentEngine({} as never);
  const stopped: string[] = [];
  const internal = engine as unknown as { sessions: Map<string, unknown> };
  internal.sessions.set("issue-1", {
    async stop() {
      stopped.push("issue-1");
      throw new Error("stop_failed");
    },
  });
  internal.sessions.set("issue-2", {
    async stop() {
      stopped.push("issue-2");
    },
  });
  await assert.rejects(engine.close(), /agent_close_failed/);
  assert.deepEqual(stopped, ["issue-1", "issue-2"]);
});

for (const [sessionFails, gitFails] of [
  [true, true],
  [true, false],
  [false, true],
])
  test(`retains session and Git cleanup failures (${sessionFails}, ${gitFails})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "issue-pilot-engine-cleanup-"));
    const engine = new AgentEngine({} as never, root);
    const internal = engine as unknown as { sessions: Map<string, unknown>; personalGit: Map<string, unknown> };
    const sessionError = new Error("fixture_session_stop_failed"),
      gitError = new Error("fixture_git_cleanup_failed");
    const calls: string[] = [];
    internal.sessions.set("issue-1", {
      async stop() {
        calls.push("session");
        if (sessionFails) throw sessionError;
      },
    });
    internal.personalGit.set("issue-1", {
      env: {},
      async close() {
        calls.push("git");
        if (gitFails) throw gitError;
      },
    });
    try {
      await assert.rejects(
        engine.runExclusive(["issue-1"], (reservation) => reservation.closeSession("issue-1")),
        (error) => {
          if (sessionFails && gitFails) {
            assert(error instanceof AggregateError);
            assert.equal(error.message, "agent_session_close_failed");
            assert.deepEqual(error.errors, [sessionError, gitError]);
          } else assert.equal(error, sessionFails ? sessionError : gitError);
          return true;
        },
      );
      assert.deepEqual(calls, ["session", "git"]);
      assert.equal(internal.sessions.has("issue-1"), false);
      assert.equal(internal.personalGit.has("issue-1"), false);
      await engine.runExclusive(["issue-1"], (reservation) => reservation.closeSession("issue-1"));
      assert.deepEqual(calls, ["session", "git"]);
    } finally {
      await engine.close();
      await rm(root, { recursive: true, force: true });
    }
  });

test("retains an accepted message without dispatching it after the Issue becomes resolved", async () => {
  let status = "pending";
  let recorded = 0;
  let prompted = 0;
  let workspaceUpdates = 0;
  const published: RunEvent[] = [];
  const issueSelect = { from: () => ({ where: () => ({ limit: async () => [{ status }] }) }) };
  const transaction = {
    update: (_table: unknown) => ({
      set: () => ({
        where: () => ({
          returning: async () => (status === "open" || status === "pending" ? [{ id: "issue-1" }] : []),
          then: (resolve: (value: undefined) => void) => {
            workspaceUpdates += 1;
            resolve(undefined);
          },
        }),
      }),
    }),
  };
  const database = {
    select: () => issueSelect,
    transaction: async (operation: (value: typeof transaction) => Promise<void>) => operation(transaction),
  };
  const engine = new AgentEngine(database as never, unusedStateRoot, (event) => published.push(event));
  const internal = engine as unknown as { sessions: Map<string, unknown>; issueQueue: { run<T>(key: string, operation: () => Promise<T>): Promise<T> } };
  internal.sessions.set("issue-1", {
    streaming: false,
    session: {
      sessionManager: {
        getBranch: () => [],
        appendCustomEntry() {
          recorded += 1;
        },
      },
      async prompt() {
        prompted += 1;
      },
    },
    async prompt() {
      prompted += 1;
    },
    async stop() {},
  });
  await internal.issueQueue.run("issue-1", async () => {
    await engine.send("issue-1", "queued message");
    status = "resolved";
  });
  await waitFor(() => !engine.isRunning("issue-1"));
  assert.equal(recorded, 1);
  assert.equal(prompted, 0);
  assert.equal(workspaceUpdates, 0);
  assert.deepEqual(
    published.filter((event) => event.event.type !== "issue_run_state").map((event) => event.event.type),
    ["issue_user"],
  );
});

test("serializes streaming messages and records only accepted steering", async () => {
  const records: string[] = [];
  const steers: string[] = [];
  const steeredImages: unknown[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const database = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ status: "in_progress" }] }) }) }) };
  const engine = new AgentEngine(database as never);
  const internal = engine as unknown as { sessions: Map<string, unknown> };
  let call = 0;
  internal.sessions.set("issue-1", {
    streaming: true,
    session: {
      sessionManager: {
        getBranch: () => [],
        appendCustomEntry(_type: string, value: { message: string }) {
          records.push(value.message);
        },
      },
      getSteeringMessages: () => [],
      async steer(message: string, images?: unknown[]) {
        steers.push(message);
        steeredImages.push(images);
        call += 1;
        if (call === 1) await firstGate;
        if (call === 2) throw new Error("steer_failed");
      },
    },
    async stop() {},
  });

  const first = engine.send("issue-1", "first", undefined, [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }]);
  const second = engine.send("issue-1", "second");
  await waitFor(() => steers.length === 1);
  assert.equal(steers[0]?.includes("first"), true);
  assert.deepEqual(steeredImages[0], [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }]);
  assert.equal(records.length, 0);
  releaseFirst();
  await first;
  await assert.rejects(second, /steer_failed/);
  assert.equal(steers[1]?.includes("second"), true);
  assert.deepEqual(records, ["first"]);
  assert.equal(engine.isRunning("issue-1"), false);
});

test("does not steer a new message past an earlier message still queued for the next round", async () => {
  const database = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ key: "ISSUE-20261103-001", status: "in_progress", serviceId: "service", environmentId: "environment" }] }) }) }),
  };
  const engine = new AgentEngine(database as never, unusedStateRoot);
  const internal = engine as unknown as { sessions: Map<string, unknown>; schedule(issueId: string, operation: () => Promise<void>): void };
  const steers: string[] = [];
  const records: string[] = [];
  const scheduled: Array<() => Promise<void>> = [];
  internal.schedule = (_issueId, operation) => {
    scheduled.push(operation);
  };
  // A message accepted while the round was preparing waits as a queued entry in the live session.
  const queued = {
    type: "custom",
    customType: "issue-pilot-user",
    id: "queued-first",
    data: { message: "first", delivery: { version: 1, state: "queued", serviceId: "service", environmentId: "environment" } },
  };
  internal.sessions.set("issue-1", {
    streaming: true,
    session: {
      sessionManager: {
        getBranch: () => [queued],
        appendCustomEntry(_type: string, data: { message: string }) {
          records.push(data.message);
          return "queued-second";
        },
      },
      getSteeringMessages: () => [],
      async steer(message: string) {
        steers.push(message);
      },
    },
    async stop() {},
  });
  await engine.send("issue-1", "second");
  assert.deepEqual(steers, []);
  assert.deepEqual(records, ["second"]);
  assert.equal(scheduled.length, 1);
});

test("a steer left undelivered when the round ends is taken back and queued instead of reported as sent", async () => {
  const database = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ key: "ISSUE-20261103-002", status: "in_progress", serviceId: "service", environmentId: "environment" }] }) }) }),
  };
  const engine = new AgentEngine(database as never, unusedStateRoot);
  const internal = engine as unknown as { sessions: Map<string, unknown>; schedule(issueId: string, operation: () => Promise<void>): void };
  const scheduled: Array<() => Promise<void>> = [];
  internal.schedule = (_issueId, operation) => {
    scheduled.push(operation);
  };
  const records: Array<{ message: string; queued: boolean }> = [];
  let streaming = true;
  let steering: string[] = [];
  let cleared = 0;
  internal.sessions.set("issue-1", {
    get streaming() {
      return streaming;
    },
    session: {
      sessionManager: {
        getBranch: () => [],
        appendCustomEntry(_type: string, data: { message: string; delivery?: unknown }) {
          records.push({ message: data.message, queued: data.delivery !== undefined });
          return `entry-${records.length}`;
        },
      },
      getSteeringMessages: () => steering,
      clearQueue() {
        cleared += 1;
        steering = [];
        return { steering: [], followUp: [] };
      },
      async steer() {
        // The round settles while Pi is still admitting this input, so it stays in Pi's queue
        // (as Pi's expanded text, which need not equal what was sent).
        steering = ["expanded by a Pi skill or template"];
        streaming = false;
      },
    },
    async stop() {},
  });
  await engine.send("issue-1", "/skill:late");
  assert.equal(cleared, 1);
  assert.deepEqual(records, [{ message: "/skill:late", queued: true }]);
  assert.equal(scheduled.length, 1);
});

test("does not clear another message from Pi's queue when taking back an undelivered steer", async () => {
  const database = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ key: "ISSUE-20261103-003", status: "in_progress", serviceId: "service", environmentId: "environment" }] }) }) }),
  };
  const engine = new AgentEngine(database as never, unusedStateRoot);
  const internal = engine as unknown as { sessions: Map<string, unknown>; schedule(issueId: string, operation: () => Promise<void>): void };
  internal.schedule = () => undefined;
  let streaming = true;
  let steering = ["earlier stranded steer"];
  let cleared = 0;
  internal.sessions.set("issue-1", {
    get streaming() {
      return streaming;
    },
    session: {
      sessionManager: { getBranch: () => [], appendCustomEntry: () => "entry" },
      getSteeringMessages: () => steering,
      clearQueue() {
        cleared += 1;
        steering = [];
        return { steering: [], followUp: [] };
      },
      async steer(message: string) {
        steering = [...steering, message];
        streaming = false;
      },
    },
    async stop() {},
  });
  await engine.send("issue-1", "late");
  assert.equal(cleared, 0);
  assert.equal(steering[0], "earlier stranded steer");
});

test("a round whose session was stopped by another failure path is not finalized as complete", async () => {
  const statusWrites: string[] = [];
  const transaction = {
    update: () => ({
      set: (values: { status?: string }) => ({
        where: () => ({
          returning: async () => {
            if (values.status) statusWrites.push(values.status);
            return [{ id: "issue-1", issueId: "issue-1" }];
          },
        }),
      }),
    }),
  };
  const database = { transaction: async (operation: (value: typeof transaction) => Promise<unknown>) => operation(transaction) };
  const engine = new AgentEngine(database as never, unusedStateRoot);
  const internal = engine as unknown as {
    sessions: Map<string, unknown>;
    promptExisting(issueId: string, managed: unknown, message: string): Promise<void>;
  };
  const managed = {
    streaming: true,
    session: { sessionManager: { getBranch: () => [] } },
    async prompt() {
      // A failed admission elsewhere stops the live session; Pi then resolves the aborted prompt normally.
      internal.sessions.delete("issue-1");
    },
    async stop() {},
  };
  internal.sessions.set("issue-1", managed);
  await assert.rejects(internal.promptExisting("issue-1", managed, "work"), /agent_session_changed/);
  // markRunning wrote in_progress/running; finalizeRun (ready/pending) never ran.
  assert.deepEqual(statusWrites, ["in_progress", "running"]);
});

test("queues a waiting steering message when the preceding turn becomes idle", { timeout: 5_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-steer-idle-"));
  const database = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ status: "in_progress" }] }) }) }) };
  const engine = new AgentEngine(database as never, root);
  const internal = engine as unknown as {
    sessions: Map<string, unknown>;
    promptExisting(issueId: string, managed: unknown, message: string, images: unknown[]): Promise<void>;
  };
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const steering = new Promise<void>((resolve) => {
    started = resolve;
  });
  let streaming = true;
  const records: string[] = [];
  const prompts: Array<{ message: string; images: unknown[] }> = [];
  const images = [{ type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" }];
  internal.sessions.set("issue-1", {
    get streaming() {
      return streaming;
    },
    session: {
      sessionManager: {
        getBranch: () => [],
        appendCustomEntry(_type: string, data: { message: string }) {
          records.push(data.message);
        },
      },
      getSteeringMessages: () => [],
      async steer() {
        started();
        await gate;
        streaming = false;
      },
    },
    async stop() {},
  });
  internal.promptExisting = async (_issueId, _managed, message, acceptedImages) => {
    prompts.push({ message, images: acceptedImages });
  };
  const first = engine.send("issue-1", "first");
  await steering;
  const second = engine.send("issue-1", "second", undefined, images);
  const accepted = Promise.all([first, second]);
  let closed = false;
  const closing = engine.close().then(() => {
    closed = true;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    release();
    await accepted;
    await closing;
    assert.equal(closed, true);
    assert.deepEqual(records, ["first", "second"]);
    assert.deepEqual(prompts, [{ message: "second", images }]);
  } finally {
    release();
    await accepted.catch(() => undefined);
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("does not record or replay an uncertain steer after failed-round cleanup replaces its session", { timeout: 5_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-steer-replaced-"));
  const transaction = { update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: "issue-1" }] }) }) }) };
  const database = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ status: "in_progress" }] }) }) }),
    transaction: async (operation: (value: typeof transaction) => Promise<void>) => operation(transaction),
  };
  const engine = new AgentEngine(database as never, root);
  const internal = engine as unknown as {
    sessions: Map<string, unknown>;
    schedule(issueId: string, operation: () => Promise<void>): void;
    run(issueId: string, message?: string): Promise<void>;
  };
  let fail!: () => void;
  let releaseSteer!: () => void;
  let started!: () => void;
  let replaced!: () => void;
  const failure = new Promise<void>((resolve) => {
    fail = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseSteer = resolve;
  });
  const steering = new Promise<void>((resolve) => {
    started = resolve;
  });
  const replacementReady = new Promise<void>((resolve) => {
    replaced = resolve;
  });
  const records: string[] = [];
  let oldStops = 0;
  let newStops = 0;
  const dispatched: Array<string | undefined> = [];
  const newRecords: string[] = [];
  const replacement = {
    streaming: false,
    session: {
      sessionManager: {
        getBranch: () => [],
        appendCustomEntry(_type: string, data: { message: string }) {
          newRecords.push(data.message);
        },
      },
    },
    async stop() {
      newStops += 1;
    },
  };
  internal.run = async (_issueId, message) => {
    dispatched.push(message);
  };
  internal.sessions.set("issue-1", {
    streaming: true,
    session: {
      sessionManager: {
        getBranch: () => [],
        appendCustomEntry(_type: string, data: { message: string }) {
          records.push(data.message);
        },
      },
      getSteeringMessages: () => [],
      async steer() {
        started();
        await gate;
      },
    },
    async stop() {
      oldStops += 1;
    },
  });
  internal.schedule("issue-1", async () => {
    await failure;
    throw new Error("preceding_round_failed");
  });
  internal.schedule("issue-1", async () => {
    internal.sessions.set("issue-1", replacement);
    replaced();
  });
  const sending = engine.send("issue-1", "uncertain");
  const rejected = assert.rejects(sending, /agent_message_outcome_unknown/);
  let next: Promise<void> | undefined;
  try {
    await steering;
    next = engine.send("issue-1", "not dispatched yet");
    fail();
    await replacementReady;
    releaseSteer();
    await rejected;
    await next;
    await waitFor(() => !engine.isRunning("issue-1"));
    assert.deepEqual(records, []);
    assert.equal(oldStops, 1);
    assert.equal(newStops, 0);
    assert.deepEqual(dispatched, ["not dispatched yet"]);
    assert.deepEqual(newRecords, ["not dispatched yet"]);
    assert.equal(internal.sessions.get("issue-1"), replacement);
  } finally {
    fail();
    releaseSteer();
    await rejected.catch(() => undefined);
    await next?.catch(() => undefined);
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("isolates publisher failures after recording a streaming message", async () => {
  const reported: unknown[] = [];
  let recorded = 0;
  const database = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ status: "in_progress" }] }) }) }) };
  const engine = new AgentEngine(
    database as never,
    unusedStateRoot,
    () => {
      throw new Error("publisher_failed");
    },
    (error) => reported.push(error),
  );
  const internal = engine as unknown as { sessions: Map<string, unknown> };
  internal.sessions.set("issue-1", {
    streaming: true,
    session: {
      sessionManager: {
        getBranch: () => [],
        appendCustomEntry() {
          recorded += 1;
        },
      },
      getSteeringMessages: () => [],
      async steer() {},
    },
    async stop() {},
  });

  await engine.send("issue-1", "record despite observer failure");
  assert.equal(recorded, 1);
  assert.match(String(reported[0]), /publisher_failed/);
  assert.equal(internal.sessions.has("issue-1"), true);
});

test("closes a streaming session when an accepted steer cannot be recorded", async () => {
  let stopped = false;
  const database = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ status: "in_progress" }] }) }) }) };
  const engine = new AgentEngine(database as never);
  const internal = engine as unknown as { sessions: Map<string, unknown> };
  internal.sessions.set("issue-1", {
    streaming: true,
    session: {
      sessionManager: {
        getBranch: () => [],
        appendCustomEntry() {
          throw new Error("record_failed");
        },
      },
      getSteeringMessages: () => [],
      async steer() {},
    },
    async stop() {
      stopped = true;
    },
  });

  await assert.rejects(engine.send("issue-1", "accepted but not recorded"), /record_failed/);
  assert.equal(stopped, true);
  assert.equal(internal.sessions.has("issue-1"), false);
  assert.equal(engine.isRunning("issue-1"), false);
});

test("finishes failed run cleanup before starting queued work", { timeout: 5_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-engine-order-"));
  const events: string[] = [],
    states: string[] = [];
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const transaction = { update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: "issue-1" }] }) }) }) };
  const database = { transaction: async (operation: (value: typeof transaction) => Promise<void>) => operation(transaction) };
  const engine = new AgentEngine(database as never, root, (event) => {
    if (event.event.type === "issue_run_state") states.push(event.event.state);
  });
  const internal = engine as unknown as { sessions: Map<string, unknown>; schedule(issueId: string, operation: () => Promise<void>): void };
  internal.sessions.set("issue-1", {
    async stop() {
      events.push("cleanup-start");
      entered();
      await gate;
      events.push("cleanup-end");
    },
  });
  try {
    internal.schedule("issue-1", async () => {
      events.push("first");
      throw new Error("first_run_failed");
    });
    internal.schedule("issue-1", async () => {
      events.push("second");
    });
    await ready;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["first", "cleanup-start"]);
    assert.equal(engine.getRunState("issue-1"), "running", "cleanup still owns the execution slot");
    assert.deepEqual(states, ["queued", "running"]);
    release();
    await waitFor(() => !engine.isRunning("issue-1"));
    assert.deepEqual(events, ["first", "cleanup-start", "cleanup-end", "second"]);
    assert.deepEqual(states, ["queued", "running", "queued", "running", "idle"]);
  } finally {
    release();
    await waitFor(() => !engine.isRunning("issue-1"));
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("reopens a session for a queued message after the preceding round failed", { timeout: 5_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-engine-queued-"));
  let started!: () => void, fail!: () => void, stopping!: () => void, release!: () => void;
  const prompting = new Promise<void>((resolve) => {
      started = resolve;
    }),
    failure = new Promise<void>((resolve) => {
      fail = resolve;
    });
  const stopped = new Promise<void>((resolve) => {
      stopping = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const transaction = { update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: "issue-1" }] }) }) }) };
  const database = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ status: "pending" }] }) }) }),
    transaction: async (operation: (value: typeof transaction) => Promise<void>) => operation(transaction),
  };
  const engine = new AgentEngine(database as never, root),
    recorded: string[] = [],
    reopened: Array<string | undefined> = [];
  const internal = engine as unknown as { sessions: Map<string, unknown>; run(issueId: string, message?: string): Promise<void> };
  internal.run = async (_issueId, message) => {
    reopened.push(message);
  };
  internal.sessions.set("issue-1", {
    streaming: false,
    session: {
      sessionManager: {
        getBranch: () => [],
        appendCustomEntry(_type: string, data: { message: string }) {
          recorded.push(data.message);
        },
      },
    },
    async prompt() {
      started();
      await failure;
      throw new Error("first_round_failed");
    },
    async stop() {
      stopping();
      await gate;
    },
  });
  try {
    await engine.send("issue-1", "first");
    await prompting;
    await engine.send("issue-1", "second");
    fail();
    await stopped;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(reopened, []);
    release();
    await waitFor(() => !engine.isRunning("issue-1"));
    assert.deepEqual(recorded, ["first", "second"]);
    assert.deepEqual(reopened, ["second"]);
  } finally {
    fail();
    release();
    await waitFor(() => !engine.isRunning("issue-1"));
    await engine.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("reports background execution failures even when cleanup and failure persistence succeed", async () => {
  const reported: unknown[] = [],
    updates: Array<{ status?: string; lastError?: string }> = [];
  const transaction = {
    update: () => ({
      set: (values: (typeof updates)[number]) => {
        updates.push(values);
        return { where: () => ({ returning: async () => [{ id: "issue-1" }] }) };
      },
    }),
  };
  const database = { transaction: async (operation: (value: typeof transaction) => Promise<void>) => operation(transaction) };
  const failure = new Error("provider failed at /private/fixture-path");
  const engine = new AgentEngine(database as never, unusedStateRoot, undefined, (error) => {
    reported.push(error);
    throw new Error("logger_failed");
  });
  const internal = engine as unknown as { schedule(issueId: string, operation: () => Promise<void>): void };
  let nextRound = false;
  try {
    internal.schedule("issue-1", async () => {
      throw failure;
    });
    internal.schedule("issue-1", async () => {
      nextRound = true;
    });
    await waitFor(() => !engine.isRunning("issue-1"));
    assert.deepEqual(reported, [failure]);
    assert.equal(updates.find((update) => update.status === "failed")?.lastError, "agent_run_failed");
    assert.equal(nextRound, true);
  } finally {
    await engine.close();
  }
});

test("reports background cleanup failures without leaking logger errors", async () => {
  const reported: unknown[] = [];
  const database = {
    async transaction() {
      throw new Error("reporting_failed");
    },
  };
  const engine = new AgentEngine(database as never, unusedStateRoot, undefined, (error) => {
    reported.push(error);
    throw new Error("logger_failed");
  });
  const internal = engine as unknown as {
    sessions: Map<string, unknown>;
    schedule(issueId: string, operation: () => Promise<void>): void;
  };
  internal.sessions.set("issue-1", {
    async stop() {
      throw new Error("stop_failed");
    },
  });
  internal.schedule("issue-1", async () => {
    throw new Error("agent_failed");
  });
  await waitFor(() => reported.length === 1 && !engine.isRunning("issue-1"));
  const failure = reported[0];
  assert.ok(failure instanceof AggregateError);
  assert.equal(failure.message, "agent_failure_cleanup_failed");
  assert.deepEqual(failure.errors.map(String), ["Error: agent_failed", "Error: stop_failed", "Error: reporting_failed"]);
});

test("a failed Agent operation disposes and revokes its SDK session", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-engine-"));
  let stopped = false;
  const published: RunEvent[] = [];
  const transaction = { update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: "issue-1" }], then: (resolve: (value: undefined) => void) => resolve(undefined) }) }) }) };
  const database = { transaction: async (operation: (value: typeof transaction) => Promise<void>) => operation(transaction) };
  const engine = new AgentEngine(database as never, root, (event) => published.push(event));
  const internal = engine as unknown as {
    sessions: Map<string, unknown>;
    schedule(issueId: string, operation: () => Promise<void>): void;
  };
  internal.sessions.set("issue-1", {
    streaming: true,
    async stop() {
      stopped = true;
    },
  });

  try {
    internal.schedule("issue-1", async () => {
      throw new Error("agent_failed");
    });
    await waitFor(() => published.some((event) => event.event.type === "issue_status" && event.event.status === "error"));
    assert.equal(internal.sessions.has("issue-1"), false);
    assert.equal(stopped, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
