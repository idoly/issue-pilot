import assert from "node:assert/strict";
import { test } from "node:test";

import { eq } from "drizzle-orm";

import { openDatabase } from "../../src/db/client.ts";
import { issues, issueWorkspaces } from "../../src/db/schema.ts";
import { buildApi } from "../../src/http/api.ts";
import { createApiFixture, createIssue, createService, json, modelCatalog, TestAgentController } from "./fixture.ts";

test("uses snapshot_ready as the versioned Agent stream handshake", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Beta", ["dev"]);
    const issue = await createIssue(fixture.app, "beta", "dev");
    fixture.engine.running.clear();
    const address = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/api/issues/${issue.id}/agent-stream`);
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let handshake = "";
    while (!handshake) {
      const { done, value } = await reader.read();
      assert.equal(done, false);
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      handshake = blocks.find((block) => block.startsWith("event: snapshot_ready\n")) ?? "";
    }
    await reader.cancel();
    assert.match(handshake, /^event: snapshot_ready\n/);
    assert.doesNotMatch(handshake, /^event: ready\n/);
  } finally {
    await fixture.cleanup();
  }
});

test("recovers interrupted Agent state after an API restart", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Alpha");
    const issue = await createIssue(fixture.app, "alpha");
    const issueId = fixture.engine.enqueued[0]!;
    fixture.engine.running.clear();
    const database = openDatabase(fixture.databaseFile);
    await database.db.transaction(async (transaction) => {
      await transaction.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
      await transaction.update(issueWorkspaces).set({ status: "running", lastError: null }).where(eq(issueWorkspaces.issueId, issueId));
    });
    await database.close();
    await fixture.stop();

    const restarted = await buildApi({ databaseFile: fixture.databaseFile, stateRoot: fixture.root, engine: new TestAgentController(), modelCatalog, logger: false });
    try {
      const recovered = await restarted.inject({ method: "GET", url: `/api/issues/${issue.id}` }).then((response) => JSON.parse(response.body)) as { status: string; workspace: { status: string; lastError: string | null } };
      assert.equal(recovered.status, "open");
      assert.equal(recovered.workspace.status, "failed");
      assert.equal(recovered.workspace.lastError, "agent_interrupted_by_api_restart");
      assert.equal((await json(await restarted.inject({ method: "GET", url: "/health" }))).ok, true);
    } finally {
      await restarted.close();
    }
  } finally {
    await fixture.cleanup();
  }
});
