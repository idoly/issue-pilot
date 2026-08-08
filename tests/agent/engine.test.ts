import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentEngine } from "../../src/agent/engine.ts";
import type { RunEvent } from "../../src/agent/events.ts";
import { MAX_AGENT_MESSAGE_CHARS } from "../../src/domain/contracts.ts";

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition_not_met");
}

test("rejects oversized Agent messages at the engine boundary", async () => {
  const engine = new AgentEngine({} as never);
  await assert.rejects(engine.send("issue", "x".repeat(MAX_AGENT_MESSAGE_CHARS + 1)), /invalid_agent_message/);
});

test("a failed Agent operation revokes the session and removes its runtime token", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-engine-"));
  const runtimeConfigFile = join(root, "session.runtime.json");
  await writeFile(runtimeConfigFile, "{}", { mode: 0o600 });
  let aborted = false;
  let unsubscribed = false;
  const published: RunEvent[] = [];
  const transaction = { update: () => ({ set: () => ({ where: async () => undefined }) }) };
  const database = { transaction: async (operation: (value: typeof transaction) => Promise<void>) => operation(transaction) };
  const engine = new AgentEngine(database as never, root, (event) => published.push(event));
  const internal = engine as unknown as {
    sessions: Map<string, unknown>;
    schedule(issueId: string, operation: () => Promise<void>): void;
  };
  internal.sessions.set("issue-1", {
    client: {
      async abort() { aborted = true; },
      async stop() { throw new Error("rpc_stop_failed"); },
    },
    streaming: true,
    runtimeConfigFile,
    unsubscribe: () => { unsubscribed = true; },
  });

  try {
    internal.schedule("issue-1", async () => { throw new Error("agent_failed"); });
    await waitFor(() => published.some((event) => event.event.type === "issue_status" && event.event.status === "error"));
    assert.equal(internal.sessions.has("issue-1"), false);
    assert.equal(aborted, true);
    assert.equal(unsubscribed, true);
    await assert.rejects(access(runtimeConfigFile));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
