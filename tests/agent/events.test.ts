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
  assert.deepEqual(transcript.map((event) => event.kind), ["user", "assistant", "tool_call", "tool_result"]);
  assert.equal(transcript[0]?.message, "Inspect the database");
  assert.equal(transcript.some((event) => event.message === "Internal runtime prompt"), false);
  assert.deepEqual(transcript[2]?.arguments, { statement: "SELECT 1" });
  assert.deepEqual(transcript[3]?.result?.details, { runtime: "container" });
});
