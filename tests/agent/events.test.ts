import assert from "node:assert/strict";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { sessionTranscript } from "../../src/agent/events.ts";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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
