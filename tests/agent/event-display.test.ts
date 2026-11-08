import assert from "node:assert/strict";
import test from "node:test";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { agentDisplayEvent, displayToolResult } from "../../src/agent/event-display.ts";
import type { RunEvent } from "../../src/agent/events.ts";

const maximum = issuePilotConfig.web.agentToolOutputCharacters;

for (const type of ["tool_execution_end", "tool_execution_update"] as const) {
  test(`${type} bounds display text without mutating the source or losing metadata`, () => {
    const text = `start:${"中".repeat(maximum * 3)}:end`;
    const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
    const result = {
      content: [{ type: "text" as const, text }, image],
      details: { fullOutputPath: "files/query.txt" },
      nestedCalls: { calls: [] },
    };
    const envelope: RunEvent = {
      id: "event-1",
      issueId: "issue-1",
      createdAt: "2026-11-07T00:00:00.000Z",
      event:
        type === "tool_execution_end"
          ? { type, toolCallId: "tool-1", toolName: "bash", result, isError: false, durationMs: 42 }
          : { type, toolCallId: "tool-1", toolName: "bash", args: {}, partialResult: result },
    };
    const original = JSON.stringify(envelope);
    const projected = agentDisplayEvent(envelope);
    const event = projected.event;
    assert.ok(event.type === "tool_execution_end" || event.type === "tool_execution_update");
    const displayed = event.type === "tool_execution_end" ? event.result : event.partialResult;
    assert.equal(projected.id, envelope.id);
    assert.equal(projected.createdAt, envelope.createdAt);
    assert.equal(projected.issueId, envelope.issueId);
    assert.equal(displayed.displayTruncated, true);
    assert.equal(displayed.content[0]?.type, "text");
    const displayedText = displayed.content[0]?.type === "text" ? displayed.content[0].text : "";
    assert.equal(displayedText.length, maximum);
    assert.ok(displayedText.startsWith("start:"));
    assert.ok(displayedText.endsWith(":end"));
    assert.equal(displayed.content[1], image);
    assert.equal(displayed.details, result.details);
    assert.equal((displayed as typeof result).nestedCalls, result.nestedCalls);
    assert.equal(JSON.stringify(envelope), original);
    assert.deepEqual(agentDisplayEvent(projected), projected);
    assert.ok(Buffer.byteLength(JSON.stringify(projected)) < Buffer.byteLength(original) / 2);
    if (event.type === "tool_execution_end") {
      assert.equal(event.durationMs, 42);
      assert.equal(event.isError, false);
    }
  });
}

test("display budget applies across text blocks and preserves an existing truncation flag", () => {
  const result = displayToolResult({
    content: [
      { type: "text" as const, text: "a".repeat(maximum) },
      { type: "text" as const, text: "end" },
    ],
  });
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]?.text.length, maximum);
  assert.ok(result.content[0]?.text.endsWith("end"));
  const alreadyTruncated = displayToolResult({ content: [{ type: "text" as const, text: "short" }], displayTruncated: true });
  assert.equal(alreadyTruncated.displayTruncated, true);
});

test("live tool-result messages use the same display budget", () => {
  const envelope: RunEvent = {
    id: "result-1",
    issueId: "issue-1",
    createdAt: "2026-11-07T00:00:00.000Z",
    event: {
      type: "message_end",
      message: { role: "toolResult", toolCallId: "tool-1", toolName: "bash", content: [{ type: "text", text: "x".repeat(maximum * 2) }], isError: false, timestamp: 0 },
    },
  };
  const displayed = agentDisplayEvent(envelope).event;
  assert.ok(displayed.type === "message_end" && displayed.message.role === "toolResult");
  assert.equal(displayed.message.displayTruncated, true);
  assert.equal(displayed.message.content[0]?.type === "text" && displayed.message.content[0].text.length, maximum);
});

test("updates without output remain safe to forward", () => {
  const envelope: RunEvent = {
    id: "update-1",
    issueId: "issue-1",
    createdAt: "2026-11-07T00:00:00.000Z",
    event: { type: "tool_execution_update", toolCallId: "tool-1", toolName: "bash", args: {}, partialResult: null },
  };
  assert.deepEqual(agentDisplayEvent(envelope), envelope);
});

test("small results and non-tool events retain their full content", () => {
  const result = { content: [{ type: "text" as const, text: "x".repeat(maximum) }], details: { count: 1 } };
  assert.deepEqual(displayToolResult(result), result);
  const envelope: RunEvent = { id: "user-1", issueId: "issue-1", createdAt: "2026-11-07T00:00:00.000Z", event: { type: "issue_user", message: "hello" } };
  assert.equal(agentDisplayEvent(envelope), envelope);
});
