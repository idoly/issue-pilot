import assert from "node:assert/strict";
import { test } from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { AgentEventBus, sessionTranscript, subscribeBufferedAgentEvents, type RunEvent } from "../../src/agent/events.ts";
import { sessionFooterStats } from "../../src/agent/footer.ts";

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
  bus.subscribe("issue-1", () => { received.push("first"); unsubscribeSecond(); });
  unsubscribeSecond = bus.subscribe("issue-1", () => received.push("second"));
  bus.publish({ id: "event", issueId: "issue-1", createdAt: "2026-08-08T00:00:00.000Z", event: { type: "agent_start" } });
  assert.deepEqual(received, ["first", "second"]);
});

test("isolates listener and error-handler failures from other observers", () => {
  const errors: unknown[] = [];
  const bus = new AgentEventBus((error) => { errors.push(error); throw new Error("logger_failed"); });
  const received: string[] = [];
  bus.subscribe("issue-1", () => { throw new Error("listener_failed"); });
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
  const subscription = subscribeBufferedAgentEvents(bus, "issue-1");
  bus.publish(event("during-replay-1"));
  bus.publish(event("during-replay-2"));
  assert.equal(received.length, 0);
  subscription.activate(({ id }) => received.push(id));
  bus.publish(event("live"));
  subscription.unsubscribe();
  bus.publish(event("after-close"));
  assert.deepEqual(received, ["during-replay-1", "during-replay-2", "live"]);
  assert.throws(() => subscription.activate(() => undefined), /agent_event_subscription_already_active/);

  const failing = subscribeBufferedAgentEvents(bus, "issue-2");
  bus.publish({ ...event("buffered-failure"), issueId: "issue-2" });
  assert.doesNotThrow(() => failing.activate(() => { throw new Error("sink_failed"); }));
  bus.publish({ ...event("live-failure"), issueId: "issue-2" });
  failing.unsubscribe();
  assert.equal(errors.length, 1);
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
  assert.deepEqual(currentReplay.map(({ id }) => id), ["start", "message-start", "message-update-1", "message-update-1002", "queue-new"]);
  const textUpdate = currentReplay[3]!.event;
  assert.equal(textUpdate.type === "message_update" && "delta" in textUpdate.assistantMessageEvent ? textUpdate.assistantMessageEvent.delta : "", `Current answer${".".repeat(1_000)}`);

  bus.publish(event("message-end", { type: "message_end", message: { ...assistant, content: [{ type: "text", text: "Current answer" }] } }));
  bus.publish(event("tool-start", { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "npm test" } }));
  bus.publish(event("tool-update-old", { type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", args: { command: "npm test" }, partialResult: { content: [{ type: "text", text: "old" }] } }));
  bus.publish(event("tool-update-new", { type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", args: { command: "npm test" }, partialResult: { content: [{ type: "text", text: "new" }] } }));
  assert.deepEqual(bus.replayCurrent("issue-1").map(({ id }) => id), ["start", "queue-new", "tool-start", "tool-update-new"]);

  bus.publish(event("tool-end", { type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: { content: [{ type: "text", text: "done" }] }, isError: false }));
  assert.deepEqual(bus.replayCurrent("issue-1").map(({ id }) => id), ["start", "queue-new"]);
  const snapshot = bus.replayCurrent("issue-1");
  snapshot.length = 0;
  assert.equal(bus.replayCurrent("issue-1").length, 2);

  bus.publish(event("complete", { type: "issue_status", status: "complete" }));
  assert.deepEqual(bus.replayCurrent("issue-1"), []);
});

test("replays the visible transcript from the active Pi session branch", () => {
  const manager = SessionManager.inMemory("/workspace");
  manager.appendCustomEntry("issue-pilot-user", { message: "Inspect the database" });
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
    content: [{ type: "text", text: "{\"rows\":[{\"1\":1}]}" }],
    details: { runtime: "container" },
    isError: false,
    timestamp: Date.now(),
  });

  const transcript = sessionTranscript(manager, "issue-1");
  assert.deepEqual(transcript.map(({ event }) => event.type), ["issue_user", "message_end", "tool_execution_end"]);
  const userEvent = transcript[0]!.event;
  assert.ok("message" in userEvent);
  assert.equal(userEvent.message, "Inspect the database");
  assert.equal(transcript.some(({ event }) => JSON.stringify(event).includes("Internal runtime prompt")), false);
  const assistantEvent = transcript[1]!.event;
  assert.ok("message" in assistantEvent);
  const assistant = assistantEvent.message as { content?: Array<{ type: string; arguments?: unknown }> };
  assert.deepEqual(assistant.content?.find((part) => part.type === "toolCall")?.arguments, { statement: "SELECT 1" });
  const toolEvent = transcript[2]!.event;
  assert.ok("result" in toolEvent);
  assert.deepEqual((toolEvent.result as { details?: unknown }).details, { runtime: "container" });
});

test("calculates Pi footer totals, cache hit rate, and context usage", () => {
  const manager = SessionManager.inMemory("/workspace");
  manager.appendMessage({ role: "user", content: "Inspect the issue", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant", api: "openai-responses", provider: "test", model: "test-model",
    content: [{ type: "text", text: "Inspection complete" }], stopReason: "stop",
    usage: {
      input: 500, output: 500, cacheRead: 9_500, cacheWrite: 0, totalTokens: 10_500,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.05, cacheWrite: 0, total: 0.35 },
    },
    timestamp: Date.now(),
  });

  assert.deepEqual(sessionFooterStats(manager, 20_000), {
    input: 500, output: 500, cacheRead: 9_500, cacheWrite: 0, cost: 0.35,
    latestCacheHitRate: 95, contextPercent: 52.5, contextWindow: 20_000, autoCompact: true,
  });
});

test("keeps the visible active-branch transcript after context compaction", () => {
  const manager = SessionManager.inMemory("/workspace");
  manager.appendCustomEntry("issue-pilot-user", { message: "Earlier visible request" });
  manager.appendMessage({ role: "user", content: "Old internal prompt", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant", api: "openai-responses", provider: "test", model: "test-model",
    content: [{ type: "text", text: "Old answer" }], stopReason: "stop", usage, timestamp: Date.now(),
  });
  const firstKept = manager.appendCustomEntry("issue-pilot-user", { message: "Latest visible request" });
  manager.appendMessage({ role: "user", content: "Runtime-wrapped latest prompt", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant", api: "openai-responses", provider: "test", model: "test-model",
    content: [{ type: "text", text: "Latest answer" }], stopReason: "stop", usage, timestamp: Date.now(),
  });
  manager.appendCompaction("Earlier work summary", firstKept, 42_000);

  const transcript = sessionTranscript(manager, "issue-1");
  assert.deepEqual(transcript.map(({ event }) => event.type), ["issue_user", "message_end", "issue_user", "message_end", "message_end"]);
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
