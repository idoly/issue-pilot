import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { AgentEngine, repositoryPreparationMode, type AgentReservation } from "../../src/agent/engine.ts";
import type { RunEvent } from "../../src/agent/events.ts";

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition_not_met");
}

test("selects repository preparation modes from environment and issue type", () => {
  assert.equal(repositoryPreparationMode("prod", "smart_analysis"), "shared");
  assert.equal(repositoryPreparationMode("test", "smart_analysis"), "shared");
  assert.equal(repositoryPreparationMode("dev", "defect_fix"), "hotfix");
  assert.equal(repositoryPreparationMode("dev", "feature_development"), "feature");
});

test("rejects oversized Agent messages at the engine boundary", async () => {
  const engine = new AgentEngine({} as never);
  await assert.rejects(engine.send("issue", "x".repeat(issuePilotConfig.limits.agentMessageChars + 1)), /invalid_agent_message/);
});

test("reserves issues against concurrent Agent activity and always releases reservations", async () => {
  const engine = new AgentEngine({} as never);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const exclusive = engine.runExclusive(["issue-1"], async () => {
    assert.equal(engine.isRunning("issue-1"), false);
    assert.throws(() => engine.enqueue("issue-1"), /issue_already_running/);
    await assert.rejects(engine.send("issue-1", "message"), /issue_already_running/);
    await blocked;
    throw new Error("operation_failed");
  });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(engine.runExclusive(["issue-1"], async () => undefined), /issue_already_running/);
  release();
  await assert.rejects(exclusive, /operation_failed/);
  let expiredReservation: AgentReservation | undefined;
  await engine.runExclusive(["issue-1"], async (reservation) => { expiredReservation = reservation; });
  assert.throws(() => expiredReservation!.enqueue("issue-1"), /issue_not_reserved/);
  await assert.rejects(expiredReservation!.closeSession("issue-1"), /issue_not_reserved/);
});

test("drains active reservations before closing and rejects new activity", async () => {
  const engine = new AgentEngine({} as never);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const reservation = engine.runExclusive(["issue-1"], async () => { await gate; });
  await new Promise((resolve) => setImmediate(resolve));
  let closed = false;
  const closing = engine.close().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  assert.throws(() => engine.enqueue("issue-2"), /agent_engine_closing/);
  await assert.rejects(engine.send("issue-2", "message"), /agent_engine_closing/);
  await assert.rejects(engine.runExclusive(["issue-2"], async () => undefined), /agent_engine_closing/);
  release();
  await reservation;
  await closing;
  assert.equal(closed, true);
});

test("attempts to stop every session when closing", async () => {
  const engine = new AgentEngine({} as never);
  const stopped: string[] = [];
  const internal = engine as unknown as { sessions: Map<string, unknown> };
  internal.sessions.set("issue-1", { async stop() { stopped.push("issue-1"); throw new Error("stop_failed"); } });
  internal.sessions.set("issue-2", { async stop() { stopped.push("issue-2"); } });
  await assert.rejects(engine.close(), /agent_close_failed/);
  assert.deepEqual(stopped, ["issue-1", "issue-2"]);
});

test("does not record queued user messages after an issue becomes resolved", async () => {
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
          returning: async () => status === "open" || status === "pending" ? [{ id: "issue-1" }] : [],
          then: (resolve: (value: undefined) => void) => { workspaceUpdates += 1; resolve(undefined); },
        }),
      }),
    }),
  };
  const database = {
    select: () => issueSelect,
    transaction: async (operation: (value: typeof transaction) => Promise<void>) => operation(transaction),
  };
  const engine = new AgentEngine(database as never, ".issue-pilot", (event) => published.push(event));
  const internal = engine as unknown as { sessions: Map<string, unknown>; issueQueue: { run<T>(key: string, operation: () => Promise<T>): Promise<T> } };
  internal.sessions.set("issue-1", {
    streaming: false,
    session: {
      sessionManager: { appendCustomEntry() { recorded += 1; } },
      async prompt() { prompted += 1; },
    },
    async prompt() { prompted += 1; },
    async stop() {},
  });
  await internal.issueQueue.run("issue-1", async () => {
    await engine.send("issue-1", "queued message");
    status = "resolved";
  });
  await waitFor(() => !engine.isRunning("issue-1"));
  assert.equal(recorded, 0);
  assert.equal(prompted, 0);
  assert.equal(workspaceUpdates, 0);
  assert.equal(published.length, 0);
});

test("serializes streaming messages and records only accepted steering", async () => {
  const records: string[] = [];
  const steers: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const database = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ status: "in_progress" }] }) }) }) };
  const engine = new AgentEngine(database as never);
  const internal = engine as unknown as { sessions: Map<string, unknown> };
  let call = 0;
  internal.sessions.set("issue-1", {
    streaming: true,
    session: {
      sessionManager: { appendCustomEntry(_type: string, value: { message: string }) { records.push(value.message); } },
      async steer(message: string) {
        steers.push(message);
        call += 1;
        if (call === 1) await firstGate;
        if (call === 2) throw new Error("steer_failed");
      },
    },
    async stop() {},
  });

  const first = engine.send("issue-1", "first");
  const second = engine.send("issue-1", "second");
  await waitFor(() => steers.length === 1);
  assert.equal(steers[0]?.includes("first"), true);
  assert.equal(records.length, 0);
  releaseFirst();
  await first;
  await assert.rejects(second, /steer_failed/);
  assert.equal(steers[1]?.includes("second"), true);
  assert.deepEqual(records, ["first"]);
  assert.equal(engine.isRunning("issue-1"), false);
});

test("closes a streaming session when an accepted steer cannot be recorded", async () => {
  let stopped = false;
  const database = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ status: "in_progress" }] }) }) }) };
  const engine = new AgentEngine(database as never);
  const internal = engine as unknown as { sessions: Map<string, unknown> };
  internal.sessions.set("issue-1", {
    streaming: true,
    session: {
      sessionManager: { appendCustomEntry() { throw new Error("record_failed"); } },
      async steer() {},
    },
    async stop() { stopped = true; },
  });

  await assert.rejects(engine.send("issue-1", "accepted but not recorded"), /record_failed/);
  assert.equal(stopped, true);
  assert.equal(internal.sessions.has("issue-1"), false);
  assert.equal(engine.isRunning("issue-1"), false);
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
    async stop() { stopped = true; },
  });

  try {
    internal.schedule("issue-1", async () => { throw new Error("agent_failed"); });
    await waitFor(() => published.some((event) => event.event.type === "issue_status" && event.event.status === "error"));
    assert.equal(internal.sessions.has("issue-1"), false);
    assert.equal(stopped, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
