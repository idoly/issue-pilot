import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ServerResponse } from "node:http";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

import { eq } from "drizzle-orm";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { AgentEventBus, type RunEvent } from "../../src/agent/events.ts";
import { openDatabase } from "../../src/db/client.ts";
import { PiSessionRuntime, createPrivateSessionManager } from "../../src/agent/pi-session.ts";
import { agentSessions, issues, issueWorkspaces } from "../../src/db/schema.ts";
import { issueRoot } from "../../src/workspace/state.ts";
import type { AgentFooterStats, AgentRuntimeConfiguration } from "../../src/domain/contracts.ts";
import { buildApi } from "../../src/http/api.ts";
import { createApiFixture, createIssue, createService, json, modelCatalog, TestAgentController, testAgent } from "./fixture.ts";

for (const withSession of [false, true]) test(`reports configured automatic compaction ${withSession ? "with" : "without"} a persisted session`, async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Footer");
    const issue = await createIssue(fixture.app, "footer");
    const issueId = fixture.engine.enqueued[0]!, key = String(issue.id);
    fixture.engine.running.clear();
    if (withSession) {
      const work = issueRoot(fixture.root, key), directory = issueRoot(fixture.root, key);
      await mkdir(work, { recursive: true }); await mkdir(directory, { recursive: true });
      const manager = await createPrivateSessionManager(work, directory);
      manager.appendMessage(fauxAssistantMessage("Synthetic completed answer."));
      const database = openDatabase(fixture.databaseFile);
      try { await database.db.insert(agentSessions).values({ issueId, sessionFile: manager.getSessionFile()!, workspacePath: work }); }
      finally { database.close(); }
    }
    const address = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    const configurations: AgentRuntimeConfiguration[] = [{ settings: { compaction: { enabled: false } } }, { settings: { compaction: { enabled: true } } }, {}];
    for (const runtime of configurations) {
      const saved = await fixture.app.inject({ method: "PUT", url: "/api/config/agent", payload: { ...testAgent, runtime } });
      assert.equal(saved.statusCode, 200, saved.body);
      const response = await fetch(`${address}/api/issues/${key}/agent-stream`);
      assert.equal(response.status, 200);
      const decoder = new TextDecoder(); let payload = "", snapshot: { footer: AgentFooterStats } | undefined;
      for await (const chunk of response.body!) {
        payload += decoder.decode(chunk, { stream: true });
        const block = payload.split("\n\n").slice(0, -1).find(block => block.startsWith("event: snapshot_ready\n"));
        if (!block) continue;
        const data = block.split("\n").find(line => line.startsWith("data: ")); assert.ok(data);
        snapshot = JSON.parse(data.slice(6)); break;
      }
      assert.ok(snapshot);
      assert.equal(snapshot.footer.autoCompact, SettingsManager.inMemory(runtime.settings).getCompactionEnabled());
      assert.equal(snapshot.footer.contextWindow, 32_000);
      if (!withSession) assert.equal(snapshot.footer.contextPercent, 0);
    }
  } finally { await fixture.cleanup(); }
});

test("counts usage in the snapshot once and deduplicates live notifications by Pi entry ID", { timeout: 5_000 }, async context => {
  const events = new AgentEventBus(), fixture = await createApiFixture({ events });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    await createService(fixture.app, "Usage");
    const issue = await createIssue(fixture.app, "usage"), issueId = fixture.engine.enqueued[0]!, key = String(issue.id);
    fixture.engine.running.clear();
    const work = issueRoot(fixture.root, key), directory = issueRoot(fixture.root, key);
    await mkdir(work, { recursive: true }); await mkdir(directory, { recursive: true });
    const manager = await createPrivateSessionManager(work, directory);
    manager.appendMessage(fauxAssistantMessage("Synthetic completed answer."));
    const database = openDatabase(fixture.databaseFile);
    try { await database.db.insert(agentSessions).values({ issueId, sessionFile: manager.getSessionFile()!, workspacePath: work }); }
    finally { database.close(); }
    const publish = (id: string, event: RunEvent["event"]) => events.publish({ id, issueId, createdAt: new Date().toISOString(), event });
    const appendUsage = (kind: string) => {
      return manager.appendUsage(kind, "test", "model", { input: 0, output: 0, cacheRead: 100, cacheWrite: 0, totalTokens: 100, cost: { input: 0, output: 0, cacheRead: 0.01, cacheWrite: 0, total: 0.01 } });
    };
    const subscribe = events.subscribe.bind(events);
    events.subscribe = (id, listener) => {
      const unsubscribe = subscribe(id, listener);
      publish("already-in-snapshot", { type: "entry_appended", entry: appendUsage("cache_warm") });
      publish("snapshot-barrier", { type: "queue_update", steering: [], followUp: [] });
      return unsubscribe;
    };
    const address = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/api/issues/${key}/agent-stream`, { signal: context.signal });
    assert.equal(response.status, 200); reader = response.body!.getReader();
    const decoder = new TextDecoder(); let payload = "";
    const readThrough = async (id: string) => {
      while (!payload.includes(`id: ${id}\n`)) {
        const { done, value } = await reader!.read(); assert.equal(done, false);
        payload += decoder.decode(value, { stream: true });
      }
    };
    await readThrough("snapshot-barrier");
    const block = payload.split("\n\n").find(block => block.startsWith("event: snapshot_ready\n")); assert.ok(block);
    const data = block.split("\n").find(line => line.startsWith("data: ")); assert.ok(data);
    const snapshot = JSON.parse(data.slice(6)) as { footer: AgentFooterStats };
    assert.equal(snapshot.footer.cacheRead, 100); assert.equal(snapshot.footer.cost, 0.01);
    assert.equal(payload.includes("already-in-snapshot"), false);
    const entry = appendUsage("native_auxiliary");
    publish("new-usage", { type: "entry_appended", entry });
    publish("duplicate-usage", { type: "entry_appended", entry });
    publish("live-barrier", { type: "queue_update", steering: [], followUp: [] });
    await readThrough("live-barrier");
    assert.equal(payload.includes("new-usage"), true); assert.equal(payload.includes("duplicate-usage"), false);
  } finally { await reader?.cancel().catch(() => undefined); await fixture.cleanup(); }
});

test("keeps SDK completions and merged deltas produced during snapshot preparation exactly once", { timeout: 10_000 }, async context => {
  const events = new AgentEventBus(), fixture = await createApiFixture({ events });
  const connection = openDatabase(fixture.databaseFile);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, runtime: PiSessionRuntime | undefined, managed;
  try {
    await createService(fixture.app, "Snapshot race");
    const issue = await createIssue(fixture.app, "snapshot-race"), issueId = fixture.engine.enqueued[0]!, key = String(issue.id);
    fixture.engine.running.clear();
    const work = issueRoot(fixture.root, key), directory = issueRoot(fixture.root, key);
    await mkdir(work, { recursive: true }); await mkdir(directory, { recursive: true });
    await writeFile(path.join(work, "evidence.txt"), "Synthetic tool result.");
    const manager = await createPrivateSessionManager(work, directory);
    const models = await ModelRuntime.create({ authPath: path.join(fixture.root, "auth.json"), modelsPath: null, modelsStorePath: path.join(fixture.root, "models.json"), refreshOnCreate: false });
    const faux = fauxProvider({ provider: "stream-fixture", models: [{ id: "model", contextWindow: 32_000 }], tokensPerSecond: 100_000 });
    models.registerNativeProvider(faux.provider);
    await models.refresh({ allowNetwork: false });
    runtime = new PiSessionRuntime({ load: async () => models, close: async () => {} });
    let sequence = 0;
    const publish = (event: RunEvent["event"], id = `live-${++sequence}`) => events.publish({ id, issueId, createdAt: new Date().toISOString(), event });
    managed = await runtime.start({ manager, agentDirectory: fixture.root, workspaceRoot: work, context: { issueKey: key, serviceKey: "snapshot-race", environmentKey: "test", model: { provider: "stream-fixture", modelId: "model", thinkingLevel: "off" }, codemode: "off", capabilities: [], canModifyCode: false }, deploymentConfig: {}, systemPrompt: "Use the native read tool.", onEvent: publish });
    const session = managed;
    const repeated = fauxAssistantMessage("Same reply.", { timestamp: Date.now() });
    faux.setResponses([fauxAssistantMessage(fauxToolCall("read", { path: "evidence.txt" }, { id: "snapshot-read" }), { stopReason: "toolUse" }), repeated, repeated]);
    await connection.db.insert(agentSessions).values({ issueId, sessionFile: manager.getSessionFile()!, workspacePath: work });
    let duringRead: (() => Promise<void>) | undefined;
    const prototype = Object.getPrototypeOf(connection.client) as { execute: typeof connection.client.execute }, execute = prototype.execute;
    context.mock.method(prototype, "execute", async function(this: typeof connection.client, ...args: Parameters<typeof execute>) {
      const run = duringRead; duringRead = undefined;
      if (run) await run();
      return execute.apply(this, args);
    });
    const subscribe = events.subscribe.bind(events);
    events.subscribe = (id, listener) => {
      const unsubscribe = subscribe(id, listener);
      duringRead = async () => {
        await session.prompt("Read the evidence."); await session.prompt("Repeat the reply.");
        publish({ type: "agent_start" });
        publish({ type: "message_start", message: fauxAssistantMessage("") });
        for (const delta of ["alpha", "beta"]) publish({ type: "message_update", usage: repeated.usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } }, `partial-${delta}`);
        publish({ type: "queue_update", steering: [], followUp: [] }, "snapshot-barrier");
      };
      return unsubscribe;
    };
    const address = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/api/issues/${key}/agent-stream`, { signal: context.signal });
    assert.equal(response.status, 200); reader = response.body!.getReader();
    const decoder = new TextDecoder(); let payload = "";
    while (!payload.split("\n\n").slice(0, -1).some(block => block.startsWith("id: snapshot-barrier\n"))) {
      const { done, value } = await reader.read(); assert.equal(done, false);
      payload += decoder.decode(value, { stream: true });
    }
    const blocks = payload.split("\n\n"), ready = blocks.find(block => block.startsWith("event: snapshot_ready\n")); assert.ok(ready);
    const snapshot = JSON.parse(ready.split("\n").find(line => line.startsWith("data: "))!.slice(6)) as { footer: AgentFooterStats };
    const delivered = blocks.filter(block => block.startsWith("id: ")).map(block => JSON.parse(block.split("\n").find(line => line.startsWith("data: "))!.slice(6)) as RunEvent);
    const completions = delivered.filter(envelope => envelope.event.type === "message_end");
    assert.deepEqual({
      assistants: completions.filter(({ event }) => event.type === "message_end" && event.message.role === "assistant").length,
      identicalReplies: completions.filter(({ event }) => event.type === "message_end" && event.message.role === "assistant" && event.message.content.some(part => part.type === "text" && part.text === "Same reply.")).length,
      toolEnds: delivered.filter(({ event }) => event.type === "tool_execution_end").length,
      toolMessages: completions.filter(({ event }) => event.type === "message_end" && event.message.role === "toolResult").length,
      partial: delivered.filter(({ id }) => id.startsWith("partial-")).map(({ event }) => event.type === "message_update" && "delta" in event.assistantMessageEvent ? event.assistantMessageEvent.delta : "").join(""),
      snapshotInput: snapshot.footer.input,
      snapshotCost: snapshot.footer.cost,
    }, { assistants: 3, identicalReplies: 2, toolEnds: 1, toolMessages: 1, partial: "alphabeta", snapshotInput: 0, snapshotCost: 0 });
  } finally {
    context.mock.restoreAll(); await reader?.cancel().catch(() => undefined);
    await managed?.stop(); await runtime?.close(); connection.close(); await fixture.cleanup();
  }
});

for (const stage of ["model discovery", "snapshot read"] as const) test(`releases an Agent stream disconnected during ${stage} and accepts a new connection`, { timeout: 5_000 }, async context => {
  const events = new AgentEventBus(), fixture = await createApiFixture({ events }), connection = openDatabase(fixture.databaseFile);
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController();
  try {
    await createService(fixture.app, "Disconnect");
    const issue = await createIssue(fixture.app, "disconnect"), key = String(issue.id);
    fixture.engine.running.clear();
    let subscriptions = 0, unsubscriptions = 0, paused = false, holdRead = false;
    const subscribe = events.subscribe.bind(events);
    events.subscribe = (id, listener) => {
      subscriptions += 1;
      const unsubscribe = subscribe(id, listener);
      if (stage === "snapshot read" && !paused) { paused = true; holdRead = true; }
      return () => { unsubscriptions += 1; unsubscribe(); };
    };
    if (stage === "model discovery") {
      const list = modelCatalog.list.bind(modelCatalog);
      context.mock.method(modelCatalog, "list", async () => {
        if (!paused) { paused = true; entered(); await gate; }
        return list();
      });
    } else {
      const prototype = Object.getPrototypeOf(connection.client) as { execute: typeof connection.client.execute }, execute = prototype.execute;
      context.mock.method(prototype, "execute", async function(this: typeof connection.client, ...args: Parameters<typeof execute>) {
        if (holdRead) { holdRead = false; entered(); await gate; }
        return execute.apply(this, args);
      });
    }
    let abandoned: ServerResponse | undefined;
    const disconnected = new Promise<void>(resolve => fixture.app.server.once("request", (_request, response) => {
      abandoned = response; response.once("close", resolve);
    }));
    const address = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    const pending = fetch(`${address}/api/issues/${key}/agent-stream`, { signal: AbortSignal.any([controller.signal, context.signal]) });
    const rejected = assert.rejects(pending, { name: "AbortError" });
    await ready; controller.abort(); await rejected; await disconnected;
    assert.equal(subscriptions, stage === "snapshot read" ? 1 : 0);
    assert.equal(unsubscriptions, subscriptions);
    release(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(subscriptions, stage === "snapshot read" ? 1 : 0);
    assert.equal(unsubscriptions, subscriptions);
    assert.ok(abandoned); assert.equal(abandoned.headersSent, false);
    const before = subscriptions;
    const closed = new Promise<void>(resolve => fixture.app.server.once("request", (_request, response) => response.once("close", resolve)));
    const response = await fetch(`${address}/api/issues/${key}/agent-stream`, { signal: context.signal });
    assert.equal(response.status, 200);
    const decoder = new TextDecoder(); let payload = "";
    for await (const chunk of response.body!) {
      payload += decoder.decode(chunk, { stream: true });
      if (payload.includes("event: snapshot_ready\n")) break;
    }
    assert.match(payload, /event: snapshot_ready\n/);
    await closed;
    assert.equal(subscriptions, before + 1); assert.equal(unsubscriptions, subscriptions);
  } finally {
    release(); controller.abort();
    await new Promise<void>(resolve => setImmediate(resolve)); context.mock.restoreAll(); connection.close(); await fixture.cleanup();
  }
});

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

async function readStreamUntil(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string): Promise<string> {
  const decoder = new TextDecoder();
  let payload = "";
  while (!payload.includes(marker)) {
    const { done, value } = await reader.read();
    assert.equal(done, false, "Agent stream ended before the expected marker");
    payload += decoder.decode(value, { stream: true });
  }
  return payload;
}

test("keeps durable entry deduplication and recent transient duplicates after the live window rolls over", { timeout: 10_000 }, async (context) => {
  const events = new AgentEventBus();
  const fixture = await createApiFixture({ events });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    await createService(fixture.app, "StreamWindow");
    const issue = await createIssue(fixture.app, "streamwindow");
    const issueId = fixture.engine.enqueued[0]!;
    const work = issueRoot(fixture.root, String(issue.id));
    await mkdir(work, { recursive: true });
    const manager = await createPrivateSessionManager(work, work);
    manager.appendMessage(fauxAssistantMessage("Historical durable answer."));
    const historical = manager.getEntries().at(-1)!;
    const database = openDatabase(fixture.databaseFile);
    try { await database.db.insert(agentSessions).values({ issueId, sessionFile: manager.getSessionFile()!, workspacePath: work }); }
    finally { await database.close(); }
    const address = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/api/issues/${issue.id}/agent-stream`, { signal: context.signal });
    reader = response.body!.getReader();
    let payload = await readStreamUntil(reader, "event: snapshot_ready\n");
    const publish = (id: string, event: RunEvent["event"]) => events.publish({ id, issueId, createdAt: "2026-10-23T00:00:00.000Z", event });
    manager.appendMessage(fauxAssistantMessage("New durable answer."));
    const current = manager.getEntries().at(-1)!;
    publish("new-durable", { type: "entry_appended", entry: current });
    const update: RunEvent["event"] = { type: "message_update", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } };
    const count = issuePilotConfig.http.sseRecentEventIds * 2 + 17;
    for (let index = 0; index < count; index++) publish(`live-${index}`, update);
    publish(`live-${count - 1}`, update);
    publish("historical-duplicate", { type: "entry_appended", entry: historical });
    publish("current-duplicate", { type: "entry_appended", entry: current });
    publish("window-finished", { type: "issue_status", status: "complete" });
    payload += await readStreamUntil(reader, "id: window-finished\n");
    assert.equal(payload.match(/id: new-durable\n/g)?.length, 1);
    assert.doesNotMatch(payload, /id: historical-duplicate\n|id: current-duplicate\n/);
    assert.equal(payload.split(`id: live-${count - 1}\n`).length - 1, 1);
    assert.equal(payload.match(/id: live-\d+\n/g)?.length, count);
  } finally {
    await reader?.cancel();
    reader?.releaseLock();
    await fixture.cleanup();
  }
});

test("deduplicates the entire buffered replay before applying the smaller live ID window", { timeout: 10_000 }, async (context) => {
  const events = new AgentEventBus();
  const fixture = await createApiFixture({ events });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    await createService(fixture.app, "ReplayWindow");
    const issue = await createIssue(fixture.app, "replaywindow");
    const issueId = fixture.engine.enqueued[0]!;
    const publish = (id: string, event: RunEvent["event"]) => events.publish({ id, issueId, createdAt: "2026-10-23T00:00:00.000Z", event });
    const update: RunEvent["event"] = { type: "message_update", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "cached" } };
    publish("replay-start", { type: "agent_start" });
    publish("replay-edge", update);
    let injected = false;
    const write = ServerResponse.prototype.write;
    const count = issuePilotConfig.http.sseRecentEventIds + 17;
    context.mock.method(ServerResponse.prototype, "write", function (this: ServerResponse, chunk: unknown, ...args: unknown[]) {
      const accepted = Reflect.apply(write, this, [chunk, ...args]);
      if (!injected && typeof chunk === "string" && chunk.startsWith("id: replay-edge\n")) {
        injected = true;
        for (let index = 0; index < count; index++) publish(`buffer-${index}`, { ...update, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } });
        publish("replay-edge", update);
      }
      return accepted;
    });
    const address = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/api/issues/${issue.id}/agent-stream`, { signal: context.signal });
    reader = response.body!.getReader();
    let payload = await readStreamUntil(reader, "event: snapshot_ready\n");
    publish("replay-window-finished", { type: "issue_status", status: "complete" });
    payload += await readStreamUntil(reader, "id: replay-window-finished\n");
    assert.equal(injected, true);
    assert.equal(payload.match(/id: replay-edge\n/g)?.length, 1);
    assert.equal(payload.match(/id: buffer-\d+\n/g)?.length, count);
  } finally {
    await reader?.cancel();
    reader?.releaseLock();
    context.mock.restoreAll();
    await fixture.cleanup();
  }
});

test("closes a live Agent stream when an event cannot be serialized and allows a fresh connection", { timeout: 5_000 }, async (context) => {
  const events = new AgentEventBus();
  const fixture = await createApiFixture({ events });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    await createService(fixture.app, "BrokenStream");
    const issue = await createIssue(fixture.app, "brokenstream");
    const issueId = fixture.engine.enqueued[0]!;
    const address = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/api/issues/${issue.id}/agent-stream`, { signal: context.signal });
    reader = response.body!.getReader();
    await readStreamUntil(reader, "event: snapshot_ready\n");
    const details: Record<string, unknown> = {};
    details.self = details;
    const closed = reader.read().then(result => result.done === true, () => true);
    events.publish({ id: "circular-result", issueId, createdAt: "2026-10-23T00:00:00.000Z", event: { type: "tool_execution_end", toolCallId: "circular", toolName: "fixture", result: { content: [{ type: "text", text: "Synthetic result" }], details }, isError: false } });
    const disconnected = await Promise.race([closed, new Promise<false>(resolve => { guard = setTimeout(() => resolve(false), 500); })]);
    clearTimeout(guard);
    assert.equal(disconnected, true, "a failed subscription must not leave a heartbeat-only connection open");
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    reader = undefined;
    const next = await fetch(`${address}/api/issues/${issue.id}/agent-stream`, { signal: context.signal });
    reader = next.body!.getReader();
    assert.match(await readStreamUntil(reader, "event: snapshot_ready\n"), /event: snapshot_ready/);
  } finally {
    clearTimeout(guard);
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
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

test("reports oversized Agent text distinctly for JSON and multipart requests", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Long messages", ["dev"]);
    const issue = await createIssue(fixture.app, "long-messages", "dev");
    fixture.engine.running.clear();
    const initialMessageCount = fixture.engine.messages.length;
    const message = "a".repeat(issuePilotConfig.limits.agentMessageChars + 1);
    const boundary = "long-agent-message";
    for (const input of [
      { payload: { message } },
      { headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: `--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\n${message}\r\n--${boundary}--\r\n` },
    ]) {
      const response = await fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/agent-messages`, ...input });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(JSON.parse(response.body), { error: "agent_message_too_long" });
    }
    assert.equal(fixture.engine.messages.length, initialMessageCount);
  } finally { await fixture.cleanup(); }
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
