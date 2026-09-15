import assert from "node:assert/strict";
import { test } from "node:test";

import { eq } from "drizzle-orm";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { AgentEventBus, type RunEvent } from "../../src/agent/events.ts";
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

test("replays current non-durable Agent output before the stream snapshot", async () => {
  const events = new AgentEventBus();
  const fixture = await createApiFixture({ events });
  try {
    await createService(fixture.app, "Gamma", ["dev"]);
    const issue = await createIssue(fixture.app, "gamma", "dev");
    const issueId = fixture.engine.enqueued[0]!;
    const publish = (id: string, event: RunEvent["event"]) => events.publish({ id, issueId, createdAt: "2026-08-08T00:00:00.000Z", event });
    publish("agent-start", { type: "agent_start" });
    publish("partial-output", {
      type: "message_update",
      usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Still working" },
    });

    const address = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/api/issues/${issue.id}/agent-stream`);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let payload = "";
    while (!payload.includes("event: snapshot_ready\n")) {
      const { done, value } = await reader.read();
      assert.equal(done, false);
      payload += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    assert.ok(payload.indexOf("partial-output") < payload.indexOf("event: snapshot_ready"));
    assert.equal(payload.match(/id: partial-output\n/g)?.length, 1);
    assert.match(payload, /Still working/);
  } finally {
    await fixture.cleanup();
  }
});

test("uses the current user as the Agent Git commit identity", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Delta", ["dev"]);
    const issue = await createIssue(fixture.app, "delta", "dev");
    fixture.engine.running.clear();
    const response = await fixture.app.inject({
      method: "POST",
      url: `/api/issues/${issue.id}/agent-messages`,
      headers: { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject },
      payload: { message: "Commit the reviewed change" },
    });
    assert.equal(response.statusCode, 202, response.body);
    assert.deepEqual(fixture.engine.gitIdentities.at(-1), {
      name: issuePilotConfig.bootstrapUser.name,
      email: issuePilotConfig.bootstrapUser.email,
    });
  } finally {
    await fixture.cleanup();
  }
});

test("accepts clipboard images as bounded Pi image content", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Images", ["dev"]);
    const issue = await createIssue(fixture.app, "images", "dev");
    fixture.engine.running.clear();
    const boundary = "issue-pilot-agent-image";
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\n请检查截图\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="clipboard.png"\r\nContent-Type: image/png\r\n\r\n`),
      image,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/agent-messages`, headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
    assert.equal(response.statusCode, 202, response.body);
    assert.equal(fixture.engine.messages.at(-1), "请检查截图");
    assert.deepEqual(fixture.engine.images.at(-1), [{ type: "image", mimeType: "image/png", data: image.toString("base64") }]);
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
