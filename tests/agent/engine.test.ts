import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { AgentEngine, repositoryPreparationPlan } from "../../src/agent/engine.ts";
import type { RunEvent } from "../../src/agent/events.ts";

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition_not_met");
}

test("selects shared snapshots and configured dev branch modes", () => {
  assert.deepEqual(repositoryPreparationPlan({ environmentKind: "prod", issueType: "smart_analysis", deploymentBaseBranch: "prod" }), { mode: "shared", baseBranch: "prod" });
  assert.deepEqual(repositoryPreparationPlan({ environmentKind: "test", issueType: "smart_analysis", deploymentBaseBranch: "test" }), { mode: "shared", baseBranch: "test" });
  assert.deepEqual(repositoryPreparationPlan({ environmentKind: "dev", issueType: "defect_fix", deploymentBaseBranch: "release" }), { mode: "hotfix", baseBranch: "release" });
  assert.deepEqual(repositoryPreparationPlan({ environmentKind: "dev", issueType: "feature_development", deploymentBaseBranch: "develop" }), { mode: "feature", baseBranch: "develop" });
});

test("rejects oversized Agent messages at the engine boundary", async () => {
  const engine = new AgentEngine({} as never);
  await assert.rejects(engine.send("issue", "x".repeat(issuePilotConfig.limits.agentMessageChars + 1)), /invalid_agent_message/);
});

test("a failed Agent operation disposes and revokes its SDK session", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-engine-"));
  let stopped = false;
  const published: RunEvent[] = [];
  const transaction = { update: () => ({ set: () => ({ where: async () => undefined }) }) };
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
