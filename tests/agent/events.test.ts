import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { AgentEventBus, sessionTranscript, subscribeBufferedAgentDisplayEvents, type RunEvent } from "../../src/agent/events.ts";
import { sessionFooterStats } from "../../src/agent/footer.ts";
import { agentDisplayEvent } from "../../src/agent/event-display.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("publishes issue-scoped events until the subscription is revoked", () => {
  const bus = new AgentEventBus();
  const received: string[] = [];
  const event = (id: string, issueId: string): RunEvent => ({ id, issueId, createdAt: "2026-08-08T00:00:00.000Z", event: { type: "agent_start" } });
  const unsubscribe = bus.subscribe("issue-1", ({ id }) => received.push(id));
  bus.publish(event("one", "issue-1"));
  bus.publish(event("other", "issue-2"));
  unsubscribe();
  unsubscribe();
  bus.publish(event("two", "issue-1"));
  assert.deepEqual(received, ["one"]);
});

test("uses a listener snapshot for each event publication", () => {
  const bus = new AgentEventBus();
  const received: string[] = [];
  let unsubscribeSecond: () => void = () => undefined;
  bus.subscribe("issue-1", () => {
    received.push("first");
    unsubscribeSecond();
  });
  unsubscribeSecond = bus.subscribe("issue-1", () => received.push("second"));
  bus.publish({ id: "event", issueId: "issue-1", createdAt: "2026-08-08T00:00:00.000Z", event: { type: "agent_start" } });
  assert.deepEqual(received, ["first", "second"]);
});

test("an old failed subscription cannot remove a replacement listener", () => {
  const bus = new AgentEventBus();
  const received: string[] = [];
  const event: RunEvent = { id: "first", issueId: "issue-1", createdAt: "2026-08-08T00:00:00.000Z", event: { type: "agent_start" } };
  const unsubscribeFailed = bus.subscribe("issue-1", () => {
    throw new Error("listener_failed");
  });
  bus.publish(event);
  const unsubscribeCurrent = bus.subscribe("issue-1", ({ id }) => {
    received.push(id);
  });
  unsubscribeFailed();
  unsubscribeFailed();
  bus.publish({ ...event, id: "replacement" });
  assert.deepEqual(received, ["replacement"]);
  unsubscribeCurrent();
  bus.publish({ ...event, id: "after-close" });
  assert.deepEqual(received, ["replacement"]);
});

test("preserves subscriptions installed while the previous last listener is removed", () => {
  const bus = new AgentEventBus();
  const received: string[] = [];
  const event: RunEvent = { id: "first", issueId: "issue-1", createdAt: "2026-08-08T00:00:00.000Z", event: { type: "agent_start" } };
  let unsubscribePrevious = () => {};
  unsubscribePrevious = bus.subscribe("issue-1", () => {
    unsubscribePrevious();
    bus.subscribe("issue-1", ({ id }) => {
      received.push(id);
    });
  });
  bus.publish(event);
  bus.publish({ ...event, id: "replacement" });
  assert.deepEqual(received, ["replacement"]);
});

test("isolates listener and error-handler failures from other observers", () => {
  const errors: unknown[] = [];
  const bus = new AgentEventBus((error) => {
    errors.push(error);
    throw new Error("logger_failed");
  });
  const received: string[] = [];
  bus.subscribe("issue-1", () => {
    throw new Error("listener_failed");
  });
  bus.subscribe("issue-1", ({ id }) => received.push(id));
  assert.doesNotThrow(() => bus.publish({ id: "event", issueId: "issue-1", createdAt: "2026-08-08T00:00:00.000Z", event: { type: "agent_start" } }));
  bus.publish({ id: "next", issueId: "issue-1", createdAt: "2026-08-08T00:00:01.000Z", event: { type: "agent_start" } });
  assert.deepEqual(received, ["event", "next"]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /listener_failed/);
});

test("buffers live events until session replay is ready", () => {
  const errors: unknown[] = [];
  const bus = new AgentEventBus((error) => errors.push(error));
  const received: string[] = [];
  const event = (id: string): RunEvent => ({ id, issueId: "issue-1", createdAt: "2026-08-08T00:00:00.000Z", event: { type: "agent_start" } });
  const subscription = subscribeBufferedAgentDisplayEvents(bus, "issue-1");
  bus.publish(event("during-replay-1"));
  bus.publish(event("during-replay-2"));
  assert.equal(received.length, 0);
  subscription.activate(({ id }) => received.push(id));
  bus.publish(event("live"));
  subscription.unsubscribe();
  bus.publish(event("after-close"));
  assert.deepEqual(received, ["during-replay-1", "during-replay-2", "live"]);
  assert.throws(() => subscription.activate(() => undefined), /agent_event_subscription_already_active/);

  const failing = subscribeBufferedAgentDisplayEvents(bus, "issue-2");
  bus.publish({ ...event("buffered-failure"), issueId: "issue-2" });
  assert.doesNotThrow(() =>
    failing.activate(() => {
      throw new Error("sink_failed");
    }),
  );
  bus.publish({ ...event("live-failure"), issueId: "issue-2" });
  failing.unsubscribe();
  assert.equal(errors.length, 1);
});

test("keeps buffered events ahead of events published while replay is being delivered", () => {
  const bus = new AgentEventBus(),
    received: string[] = [];
  const event = (id: string): RunEvent => ({ id, issueId: "issue-1", createdAt: "2026-08-08T00:00:00.000Z", event: { type: "agent_start" } });
  const subscription = subscribeBufferedAgentDisplayEvents(bus, "issue-1");
  bus.publish(event("first"));
  bus.publish(event("second"));
  subscription.activate((envelope) => {
    received.push(envelope.id);
    if (envelope.id === "first") {
      assert.throws(() => subscription.activate(() => undefined), /agent_event_subscription_already_active/);
      bus.publish(event("third"));
    }
  });
  bus.publish(event("fourth"));
  subscription.unsubscribe();
  bus.publish(event("after-close"));
  assert.deepEqual(received, ["first", "second", "third", "fourth"]);
});

test("bounds live events buffered during slow replay and detaches only the slow subscriber", () => {
  const bus = new AgentEventBus(),
    received: string[] = [],
    failures: unknown[] = [];
  const event = (id: string): RunEvent => ({ id, issueId: "issue-1", createdAt: "2026-08-08T00:00:00.000Z", event: { type: "issue_user", message: "中文" } });
  const bytes = Buffer.byteLength(JSON.stringify(event("first")));
  const slow = subscribeBufferedAgentDisplayEvents(bus, "issue-1", { maxPendingBytes: bytes, onFailure: (error) => failures.push(error) });
  const stop = bus.subscribe("issue-1", ({ id }) => received.push(id));
  bus.publish(event("first"));
  assert.equal(failures.length, 0);
  bus.publish(event("other"));
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /sse_queue_budget_exceeded/);
  slow.activate(() => assert.fail("closed subscription must not deliver its backlog"));
  bus.publish(event("third"));
  assert.deepEqual(received, ["first", "other", "third"]);
  assert.equal(failures.length, 1);
  slow.unsubscribe();
  stop();
});

test("buffer budgets count displayed tool text and retain raw results for other observers", () => {
  const bus = new AgentEventBus();
  const original: RunEvent = {
    id: "large",
    issueId: "issue-1",
    createdAt: "2026-11-09T00:00:00Z",
    event: {
      type: "tool_execution_end",
      toolCallId: "call",
      toolName: "read",
      isError: false,
      result: { content: [{ type: "text", text: "x".repeat(issuePilotConfig.web.agentToolOutputCharacters * 20) }] },
    },
  };
  const expected = agentDisplayEvent(original);
  const failures: unknown[] = [],
    displayed: RunEvent[] = [],
    raw: RunEvent[] = [];
  const stop = bus.subscribe("issue-1", (event) => raw.push(event));
  const subscription = subscribeBufferedAgentDisplayEvents(bus, "issue-1", {
    maxPendingBytes: Buffer.byteLength(JSON.stringify(expected)) * 2,
    onFailure: (error) => failures.push(error),
  });
  bus.publish(original);
  assert.deepEqual(failures, []);
  subscription.activate((event) => displayed.push(event));
  bus.publish({ ...original, id: "live" });
  assert.deepEqual(displayed, [expected, { ...expected, id: "live" }]);
  assert.equal(raw[0], original);
  assert.equal(
    original.event.type === "tool_execution_end" && original.event.result.content[0]?.type === "text" && original.event.result.content[0].text.length,
    issuePilotConfig.web.agentToolOutputCharacters * 20,
  );
  subscription.unsubscribe();
  stop();
});

test("all SDK copies of query output use the display bound without changing model or durable results", () => {
  const text = "x".repeat(issuePilotConfig.web.agentToolOutputCharacters + 1);
  const result = { content: [{ type: "text" as const, text }], details: { provider: "aliyun-sls-cli" }, structuredContent: { records: [{ text }] } };
  const message = { role: "toolResult" as const, toolCallId: "query", toolName: "service_query", isError: false, ...result, timestamp: 1 };
  const assistant = { role: "assistant" as const, api: "openai-responses" as const, provider: "fixture", model: "fixture", content: [], stopReason: "toolUse" as const, usage, timestamp: 1 };
  const events: RunEvent["event"][] = [
    { type: "tool_execution_end", toolCallId: "query", toolName: "service_query", isError: false, result },
    { type: "tool_execution_update", toolCallId: "query", toolName: "service_query", args: {}, partialResult: result },
    { type: "message_start", message },
    { type: "message_end", message },
    { type: "turn_end", message: assistant, toolResults: [message] },
    { type: "agent_end", messages: [assistant, message], willRetry: false },
  ];
  for (const event of events) {
    const displayed = JSON.stringify(agentDisplayEvent({ id: "event", issueId: "issue", createdAt: "2026-11-14T00:00:00Z", event }));
    assert.ok(!displayed.includes(text), event.type);
    assert.ok(!displayed.includes('"structuredContent"'), event.type);
    assert.match(displayed, /"displayTruncated":true/);
  }
  assert.equal(message.content[0]!.text, text);
  assert.equal(result.structuredContent.records[0]!.text, text);
});

test("unbounded tool metadata still consumes the replay buffer budget", () => {
  const bus = new AgentEventBus(),
    failures: unknown[] = [];
  const subscription = subscribeBufferedAgentDisplayEvents(bus, "issue-1", { maxPendingBytes: 1_024, onFailure: (error) => failures.push(error) });
  bus.publish({
    id: "metadata",
    issueId: "issue-1",
    createdAt: "2026-11-09T00:00:00Z",
    event: {
      type: "tool_execution_end",
      toolCallId: "call",
      toolName: "read",
      isError: false,
      result: { content: [], details: { description: "x".repeat(2_048) } },
    },
  });
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /sse_queue_budget_exceeded/);
  subscription.activate(() => assert.fail("overflowed metadata must not be delivered"));
  subscription.unsubscribe();
});

for (const phase of ["replay", "live"] as const)
  test(`a display projection failure closes the ${phase} subscription and reports it once`, () => {
    const bus = new AgentEventBus(),
      failures: unknown[] = [],
      displayed: RunEvent[] = [];
    const subscription = subscribeBufferedAgentDisplayEvents(bus, "issue-1", { maxPendingBytes: 1_024, onFailure: (error) => failures.push(error) });
    if (phase === "live") subscription.activate((event) => displayed.push(event));
    bus.publish({
      id: "invalid",
      issueId: "issue-1",
      createdAt: "2026-11-09T00:00:00Z",
      event: {
        type: "tool_execution_end",
        toolCallId: "call",
        toolName: "read",
        isError: false,
        result: { content: [null] },
      },
    } as unknown as RunEvent);
    assert.equal(failures.length, 1);
    if (phase === "replay") subscription.activate((event) => displayed.push(event));
    bus.publish({ id: "later", issueId: "issue-1", createdAt: "2026-11-09T00:00:00Z", event: { type: "agent_start" } });
    assert.equal(failures.length, 1);
    assert.deepEqual(displayed, []);
    subscription.unsubscribe();
  });

test("unsubscribing before activation discards the buffered events", () => {
  const bus = new AgentEventBus();
  const subscription = subscribeBufferedAgentDisplayEvents(bus, "issue-1");
  bus.publish({ id: "first", issueId: "issue-1", createdAt: "2026-08-08T00:00:00.000Z", event: { type: "agent_start" } });
  subscription.unsubscribe();
  subscription.activate(() => assert.fail("disconnected subscription must not replay"));
});

test("retains only the current non-durable Agent state for reconnecting clients", () => {
  const bus = new AgentEventBus();
  const event = (id: string, wireEvent: RunEvent["event"]): RunEvent => ({ id, issueId: "issue-1", createdAt: "2026-08-08T00:00:00.000Z", event: wireEvent });
  const assistant = {
    role: "assistant" as const,
    api: "openai-responses" as const,
    provider: "test",
    model: "test-model",
    content: [],
    stopReason: "stop" as const,
    usage,
    timestamp: Date.now(),
  };

  bus.publish(event("start", { type: "agent_start" }));
  bus.publish(event("message-start", { type: "message_start", message: assistant }));
  bus.publish(event("message-update-1", { type: "message_update", usage, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Inspecting" } }));
  bus.publish(event("message-update-2", { type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Current answer" } }));
  for (let index = 0; index < 1_000; index += 1) {
    bus.publish(event(`message-update-${index + 3}`, { type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "." } }));
  }
  bus.publish(event("queue-old", { type: "queue_update", steering: ["old"], followUp: [] }));
  bus.publish(event("queue-new", { type: "queue_update", steering: ["new"], followUp: [] }));
  const currentReplay = bus.replayCurrent("issue-1");
  assert.deepEqual(
    currentReplay.map(({ id }) => id),
    ["start", "message-start", "message-update-1", "message-update-1002", "queue-new"],
  );
  const textUpdate = currentReplay[3]!.event;
  assert.equal(textUpdate.type === "message_update" && "delta" in textUpdate.assistantMessageEvent ? textUpdate.assistantMessageEvent.delta : "", `Current answer${".".repeat(1_000)}`);

  bus.publish(event("message-end", { type: "message_end", message: { ...assistant, content: [{ type: "text", text: "Current answer" }] } }));
  bus.publish(event("tool-start", { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "npm test" } }));
  bus.publish(
    event("tool-update-old", { type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", args: { command: "npm test" }, partialResult: { content: [{ type: "text", text: "old" }] } }),
  );
  bus.publish(
    event("tool-update-new", { type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", args: { command: "npm test" }, partialResult: { content: [{ type: "text", text: "new" }] } }),
  );
  assert.deepEqual(
    bus.replayCurrent("issue-1").map(({ id }) => id),
    ["start", "queue-new", "tool-start", "tool-update-new"],
  );

  bus.publish(event("tool-end", { type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { content: [{ type: "text", text: "done" }] }, isError: false }));
  assert.deepEqual(
    bus.replayCurrent("issue-1").map(({ id }) => id),
    ["start", "queue-new"],
  );
  const snapshot = bus.replayCurrent("issue-1");
  snapshot.length = 0;
  assert.equal(bus.replayCurrent("issue-1").length, 2);

  bus.publish(event("complete", { type: "issue_status", status: "complete" }));
  assert.deepEqual(bus.replayCurrent("issue-1"), []);
});

test("replays the visible transcript from the active Pi session branch", () => {
  const manager = SessionManager.inMemory("/workspace");
  manager.appendCustomEntry("issue-pilot-user", { message: "Inspect the database", images: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }] });
  manager.appendMessage({ role: "user", content: "Internal runtime prompt", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    api: "openai-responses",
    provider: "test",
    model: "test-model",
    content: [
      { type: "text", text: "I will inspect it." },
      { type: "toolCall", id: "call-1", name: "db", arguments: { statement: "SELECT 1" } },
    ],
    stopReason: "toolUse",
    usage,
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "db",
    content: [{ type: "text", text: '{"rows":[{"1":1}]}' }],
    details: { runtime: "container" },
    isError: false,
    durationMs: 1234,
    timestamp: Date.now(),
  });

  const transcript = sessionTranscript(manager, "issue-1");
  assert.deepEqual(
    transcript.map(({ event }) => event.type),
    ["issue_user", "message_end", "tool_execution_end"],
  );
  const userEvent = transcript[0]!.event;
  assert.ok("message" in userEvent);
  assert.equal(userEvent.message, "Inspect the database");
  assert.deepEqual("images" in userEvent ? userEvent.images : undefined, [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }]);
  assert.equal(
    transcript.some(({ event }) => JSON.stringify(event).includes("Internal runtime prompt")),
    false,
  );
  const assistantEvent = transcript[1]!.event;
  assert.ok("message" in assistantEvent);
  const assistant = assistantEvent.message as { content?: Array<{ type: string; arguments?: unknown }> };
  assert.deepEqual(assistant.content?.find((part) => part.type === "toolCall")?.arguments, { statement: "SELECT 1" });
  const toolEvent = transcript[2]!.event;
  assert.ok("result" in toolEvent);
  assert.ok("durationMs" in toolEvent);
  assert.equal(toolEvent.durationMs, 1234);
  assert.deepEqual((toolEvent.result as { details?: unknown }).details, { runtime: "container" });
});

test("replays SDK nested-call metadata after reopening without changing the durable session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-nested-calls-"));
  try {
    const manager = SessionManager.create(root, path.join(root, "sessions"));
    manager.appendMessage({
      role: "assistant",
      api: "openai-responses",
      provider: "test",
      model: "test-model",
      content: [{ type: "toolCall", id: "parent", name: "codemode", arguments: { code: "return await tools.read({path:'a'});" } }],
      stopReason: "toolUse",
      usage,
      timestamp: 1,
    });
    const nestedCalls = { calls: [{ id: "parent/1", name: "read", status: "unfinished" as const }], complete: false };
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "parent",
      toolName: "codemode",
      content: [{ type: "text", text: "partial output" }],
      details: { fullOutputPath: path.join(root, "output.log") },
      nestedCalls,
      isError: true,
      durationMs: 42,
      timestamp: 2,
    });
    const file = manager.getSessionFile()!;
    const before = await readFile(file, "utf8");
    const reopened = SessionManager.open(file);
    const replay = sessionTranscript(reopened, "issue-1");
    assert.deepEqual(replay, sessionTranscript(manager, "issue-1"));
    const event = replay.at(-1)!.event;
    assert.ok(event.type === "tool_execution_end");
    assert.deepEqual(event.result.nestedCalls, nestedCalls);
    assert.equal(event.durationMs, 42);
    assert.equal(event.isError, true);
    assert.equal(await readFile(file, "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("calculates Pi footer totals, cache hit rate, and context usage", () => {
  const manager = SessionManager.inMemory("/workspace");
  manager.appendMessage({ role: "user", content: "Inspect the issue", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    api: "openai-responses",
    provider: "test",
    model: "test-model",
    content: [{ type: "text", text: "Inspection complete" }],
    stopReason: "stop",
    usage: {
      input: 500,
      output: 500,
      cacheRead: 9_500,
      cacheWrite: 0,
      totalTokens: 10_500,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.05, cacheWrite: 0, total: 0.35 },
    },
    timestamp: Date.now(),
  });

  assert.deepEqual(sessionFooterStats(manager, 20_000, true), {
    input: 500,
    output: 500,
    cacheRead: 9_500,
    cacheWrite: 0,
    cost: 0.35,
    costSource: "unknown",
    latestCacheHitRate: 95,
    contextPercent: 52.5,
    contextWindow: 20_000,
    autoCompact: true,
  });
});

for (const [flag, expected] of [
  [true, "provider"],
  [false, "estimated"],
  [undefined, "unknown"],
] as const)
  test(`footer preserves ${expected} cost provenance across all SDK usage entry types`, () => {
    const manager = SessionManager.inMemory("/workspace");
    const charged = { ...usage, input: 10, totalTokens: 10, cost: { ...usage.cost, total: 1, ...(flag === undefined ? {} : { totalFromProvider: flag }) } };
    assert.equal(sessionFooterStats(manager, 0, true).costSource, null);
    manager.appendUsage("zero", "test", "model", { ...charged, cost: { ...charged.cost, total: 0 } });
    assert.equal(sessionFooterStats(manager, 0, true).costSource, null);
    const first = manager.appendMessage({ role: "assistant", api: "openai-responses", provider: "test", model: "model", content: [], stopReason: "stop", usage: charged, timestamp: 1 });
    manager.appendMessage({ role: "toolResult", toolCallId: "nested", toolName: "fixture", content: [], isError: false, usage: charged, timestamp: 2 });
    manager.appendUsage("auxiliary", "test", "model", charged);
    manager.appendCompaction("Summary", first, 100, undefined, false, charged);
    manager.branchWithSummary(null, "Branch summary", undefined, false, charged);
    const stats = sessionFooterStats(manager, 0, true);
    assert.equal(stats.cost, 5);
    assert.equal(stats.costSource, expected);
    manager.appendUsage("zero-other-source", "test", "model", { ...charged, cost: { ...charged.cost, total: 0, totalFromProvider: !flag } });
    assert.equal(sessionFooterStats(manager, 0, true).costSource, expected);
    manager.appendUsage("other-source", "test", "model", { ...charged, cost: { ...charged.cost, totalFromProvider: !flag } });
    assert.equal(sessionFooterStats(manager, 0, true).costSource, "mixed");
  });

test("footer cost provenance survives reopening without rewriting historical usage or inventing missing flags", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-cost-provenance-"));
  try {
    const manager = SessionManager.create(root, path.join(root, "sessions"));
    manager.appendMessage({
      role: "assistant",
      api: "openai-responses",
      provider: "test",
      model: "model",
      content: [],
      stopReason: "error",
      usage: { ...usage, cost: { ...usage.cost, total: 1, totalFromProvider: true } },
      timestamp: 1,
    });
    manager.appendUsage("estimated", "test", "model", { ...usage, cost: { ...usage.cost, total: 2, totalFromProvider: false } });
    manager.appendUsage("historical", "test", "model", { ...usage, cost: { ...usage.cost, total: 3 } });
    const file = manager.getSessionFile()!;
    const before = await readFile(file, "utf8");
    const reopened = SessionManager.open(file);
    const stats = sessionFooterStats(reopened, 0, true);
    assert.equal(stats.cost, 6);
    assert.equal(stats.costSource, "mixed");
    assert.deepEqual(stats, sessionFooterStats(manager, 0, true));
    assert.equal(await readFile(file, "utf8"), before);
    const historical = reopened.getEntries().find((entry) => entry.type === "usage" && entry.kind === "historical");
    assert.ok(historical?.type === "usage");
    assert.equal(Object.hasOwn(historical.usage.cost, "totalFromProvider"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("footer reuses the caller's session context without changing its statistics", (context) => {
  const manager = SessionManager.inMemory("/workspace");
  manager.appendMessage({ role: "user", content: "Synthetic trailing input", timestamp: 1 });
  manager.appendMessage({
    role: "assistant",
    api: "openai-responses",
    provider: "fixture",
    model: "fixture-model",
    content: [{ type: "text", text: "Synthetic answer" }],
    stopReason: "stop",
    usage: { ...usage, input: 100, output: 20, totalTokens: 120 },
    timestamp: 2,
  });
  const expected = sessionFooterStats(manager, 20_000, true);
  const snapshot = manager.buildSessionContext();
  const rebuild = context.mock.method(manager, "buildSessionContext", () => {
    throw new Error("unexpected_context_rebuild");
  });
  assert.deepEqual(sessionFooterStats(manager, 20_000, true, snapshot), expected);
  assert.equal(rebuild.mock.callCount(), 0);
  assert.equal(snapshot.messages.length, 2);
});

test("includes SDK usage entries without exposing internal context edits in visible history", () => {
  const manager = SessionManager.inMemory("/workspace");
  const id = manager.appendMessage({
    role: "assistant",
    api: "openai-responses",
    provider: "test",
    model: "test-model",
    content: [{ type: "text", text: "Original visible answer" }],
    stopReason: "stop",
    usage,
    timestamp: Date.now(),
  });
  manager.appendContextEdit(id, null);
  manager.appendUsage("cache_warm", "test", "test-model", {
    ...usage,
    input: 0,
    output: 0,
    cacheRead: 100,
    cacheWrite: 0,
    totalTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0.01, cacheWrite: 0, total: 0.01 },
  });
  const stats = sessionFooterStats(manager, 20000, true);
  assert.deepEqual(sessionFooterStats(manager, 20000, true, manager.buildSessionContext()), stats);
  assert.equal(stats.cacheRead, usage.cacheRead + 100);
  assert.equal(stats.cost, usage.cost.total + 0.01);
  assert.equal(
    manager.buildSessionContext().messages.some((message) => message.role === "assistant"),
    false,
  );
  const replay = sessionTranscript(manager, "issue");
  assert.ok(JSON.stringify(replay).includes("Original visible answer"));
  assert.equal(replay.length, 1);
});

test("keeps the visible active-branch transcript after context compaction", () => {
  const manager = SessionManager.inMemory("/workspace");
  manager.appendCustomEntry("issue-pilot-user", { message: "Earlier visible request" });
  manager.appendMessage({ role: "user", content: "Old internal prompt", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    api: "openai-responses",
    provider: "test",
    model: "test-model",
    content: [{ type: "text", text: "Old answer" }],
    stopReason: "stop",
    usage,
    timestamp: Date.now(),
  });
  const firstKept = manager.appendCustomEntry("issue-pilot-user", { message: "Latest visible request" });
  manager.appendMessage({ role: "user", content: "Runtime-wrapped latest prompt", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    api: "openai-responses",
    provider: "test",
    model: "test-model",
    content: [{ type: "text", text: "Latest answer" }],
    stopReason: "stop",
    usage,
    timestamp: Date.now(),
  });
  manager.appendCompaction("Earlier work summary", firstKept, 42_000);
  assert.deepEqual(sessionFooterStats(manager, 20000, true, manager.buildSessionContext()), sessionFooterStats(manager, 20000, true));

  const transcript = sessionTranscript(manager, "issue-1");
  assert.deepEqual(
    transcript.map(({ event }) => event.type),
    ["issue_user", "message_end", "issue_user", "message_end", "message_end"],
  );
  assert.equal(JSON.stringify(transcript).includes("Earlier visible request"), true);
  assert.equal(JSON.stringify(transcript).includes("Old answer"), true);
  assert.equal(JSON.stringify(transcript).includes("Latest visible request"), true);
  assert.equal(JSON.stringify(transcript).includes("Latest answer"), true);
  assert.equal(JSON.stringify(transcript).includes("Old internal prompt"), false);
  assert.equal(JSON.stringify(transcript).includes("Runtime-wrapped latest prompt"), false);
  const summary = transcript.at(-1)!.event;
  assert.ok("message" in summary && typeof summary.message === "object" && summary.message.role === "compactionSummary");
  if ("message" in summary && typeof summary.message === "object" && summary.message.role === "compactionSummary") assert.equal(summary.message.tokensBefore, 42_000);
});
