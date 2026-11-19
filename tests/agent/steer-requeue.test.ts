import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { AgentEngine } from "../../src/agent/engine.ts";
import { createPrivateSessionManager } from "../../src/agent/pi-session.ts";
import { pendingAgentMessages } from "../../src/agent/message-delivery.ts";
import { claimIssueRoot, issueRoot } from "../../src/workspace/state.ts";

const key = "ISSUE-20261119-001";
let stateRoot: string;

before(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), "issue-pilot-steer-requeue-"));
  await claimIssueRoot(stateRoot, key);
});
after(async () => {
  await rm(stateRoot, { recursive: true, force: true });
});

test("requeues a steer whose session was replaced before Pi received it", { timeout: 10_000 }, async () => {
  const directory = issueRoot(stateRoot, key);
  const manager = await createPrivateSessionManager(directory, directory);
  const transaction = { update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ id: "issue-1" }] }) }) }) };
  const database = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ key, status: "in_progress", serviceId: "svc", environmentId: "env" }] }) }) }),
    transaction: async (operation: (value: typeof transaction) => Promise<unknown>) => operation(transaction),
  };
  const engine = new AgentEngine(database as never, stateRoot);
  const internal = engine as unknown as {
    sessions: Map<string, unknown>;
    schedule(issueId: string, operation: () => Promise<void>): void;
    run(...args: unknown[]): Promise<void>;
    promptExisting(...args: unknown[]): Promise<void>;
  };
  const dispatched: Array<unknown[]> = [];
  internal.run = async (...args) => void dispatched.push(["run", ...args]);
  internal.promptExisting = async (...args) => void dispatched.push(["promptExisting", ...args]);

  let releaseRound!: () => void;
  const roundRunning = new Promise<void>((resolve) => {
    releaseRound = resolve;
  });
  internal.schedule("issue-1", async () => {
    await roundRunning;
    throw new Error("preceding_round_failed");
  });

  let steerCalls = 0;
  const managed = {
    streaming: true,
    scopeChanged: false,
    retireAfterRound: false,
    session: {
      sessionManager: manager,
      getSteeringMessages: () => [],
      async steer() {
        steerCalls += 1;
      },
    },
    async stop() {},
  };
  internal.sessions.set("issue-1", managed);
  const replacement = { ...managed, session: { ...managed.session, sessionManager: manager } };
  const originalAppend = manager.appendCustomEntry.bind(manager);
  manager.appendCustomEntry = ((type: string, data: unknown) => {
    const id = originalAppend(type, data);
    // The admission is persisted as started; the running round fails and replaces the session before Pi
    // can accept the steer. The replacement reads the same file, so the entry is visible.
    if (type === "issue-pilot-user") internal.sessions.set("issue-1", replacement);
    return id;
  }) as typeof manager.appendCustomEntry;

  await engine.send("issue-1", "please also check the logs");
  releaseRound();
  // close drains the failed round's cleanup and its queued successor.
  await engine.close();

  const delivery = manager
    .getBranch()
    .filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "issue-pilot-user-delivery")
    .map((entry) => (entry as unknown as { data: { state: string } }).data.state);
  assert.equal(steerCalls, 0, "Pi never received the steer");
  assert.deepEqual(delivery, ["queued"], "the admitted input returns to the queue");
  assert.equal(pendingAgentMessages(manager).length, 1);
  assert.ok(
    dispatched.some(([kind, , message]) => (kind === "promptExisting" || kind === "run") && message === "please also check the logs"),
    "a round is scheduled to deliver the requeued input",
  );
});
