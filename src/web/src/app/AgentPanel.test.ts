import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../data/client";
import { applyAgentEvent, diffLineClass, shellToolOutput, toolLabel, toolLabelParts, type ConversationEntry } from "./AgentPanel";

function event(payload: AgentEvent["event"], id: string = crypto.randomUUID()): AgentEvent {
  return { id, issueId: "ISSUE-1", createdAt: "2026-08-06T00:00:00.000Z", event: payload };
}

describe("Agent conversation state", () => {
  it("assembles Pi streaming events and replaces them with the final message", () => {
    let entries = applyAgentEvent([], event({ type: "message_start", message: { role: "assistant", content: [] } }, "message-1"));
    entries = applyAgentEvent(entries, event({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "检查" } }));
    entries = applyAgentEvent(entries, event({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "完成" } }));
    expect(entries).toEqual([{ id: "message-1", kind: "assistant", blocks: [{ type: "text", value: "检查完成" }], streaming: true }]);

    entries = applyAgentEvent(entries, event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "检查已完成" }] } }));
    expect(entries).toEqual([{ id: "message-1", kind: "assistant", blocks: [{ type: "text", value: "检查已完成" }] }]);
  });

  it("keeps thinking separate from visible answer text", () => {
    const entries = applyAgentEvent([], event({ type: "message_end", message: { role: "assistant", content: [
      { type: "thinking", thinking: "Inspect tests" },
      { type: "text", text: "Tests pass" },
    ] } }, "message-1"));
    expect(entries[0]).toEqual({ id: "message-1", kind: "assistant", blocks: [
      { type: "thinking", value: "Inspect tests" },
      { type: "text", value: "Tests pass" },
    ] });
  });

  it("updates one tool row from Pi start through partial and final result", () => {
    let entries = applyAgentEvent([], event({ type: "tool_execution_start", toolCallId: "call-1", toolName: "db", args: { statement: "SELECT 1" } }));
    entries = applyAgentEvent(entries, event({ type: "tool_execution_update", toolCallId: "call-1", toolName: "db", partialResult: { content: [{ type: "text", text: "running" }] } }));
    entries = applyAgentEvent(entries, event({ type: "tool_execution_end", toolCallId: "call-1", toolName: "db", result: { content: [{ type: "text", text: "done" }] }, isError: false }));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "tool", toolCallId: "call-1", status: "complete", arguments: { statement: "SELECT 1" }, result: { content: [{ text: "done" }] } });
  });

  it("appends visible user messages", () => {
    expect(applyAgentEvent([], event({ type: "issue_user", message: "继续检查" }))).toMatchObject([{ kind: "user", text: "继续检查" }]);
  });

  it("formats consecutive repository reads like Pi CLI", () => {
    const pathsAndRanges = [
      ["/home/idoly/issue-pilot/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/user-message.js", 1, 180],
      ["/home/idoly/issue-pilot/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/assistant-message.js", 1, 260],
      ["/home/idoly/issue-pilot/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/status-indicator.js", 1, 150],
      ["/home/idoly/issue-pilot/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js", 3390, 55],
      ["/home/idoly/issue-pilot/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js", 1, 180],
    ] as const;
    const labels = pathsAndRanges.map(([path, offset, limit], index) => toolLabel({
      id: `tool-${index}`,
      kind: "tool",
      toolCallId: `call-${index}`,
      name: "read",
      status: "complete",
      startedAt: "2026-08-06T00:00:00.000Z",
      arguments: { path, offset, limit },
    } satisfies ConversationEntry));

    expect(labels).toEqual([
      "read ~/issue-pilot/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/user-message.js:1-180",
      "read ~/issue-pilot/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/assistant-message.js:1-260",
      "read ~/issue-pilot/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/status-indicator.js:1-150",
      "read ~/issue-pilot/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:3390-3444",
      "read ~/issue-pilot/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js:1-180",
    ]);
    expect(toolLabelParts(labels[0])).toEqual({
      action: "read",
      target: "~/issue-pilot/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/user-message.js",
      range: ":1-180",
    });
  });

  it("uses the current issue workspace as tilde", () => {
    const entry = {
      id: "tool-1", kind: "tool", toolCallId: "call-1", name: "read", status: "complete",
      startedAt: "2026-08-06T00:00:00.000Z",
      arguments: {
        path: "/home/idoly/issue-pilot/.issue-pilot/workspaces/issue-20260807-001/e8291771-d16d-4161-a70f-2e6c04f4dc45/srm-api-manage/src/PurchaseOrderServiceImpl.java",
        offset: 2940,
        limit: 220,
      },
    } satisfies ConversationEntry;
    expect(toolLabel(entry)).toBe("read ~/srm-api-manage/src/PurchaseOrderServiceImpl.java:2940-3159");
  });

  it("uses Pi read range defaults and only colors display-diff prefixes", () => {
    const entry = {
      id: "tool-1", kind: "tool", toolCallId: "call-1", name: "read", status: "complete",
      startedAt: "2026-08-06T00:00:00.000Z", arguments: { path: "src/index.ts", limit: 20 },
    } satisfies ConversationEntry;
    expect(toolLabel(entry)).toBe("read src/index.ts:1-20");
    expect(diffLineClass("+12 const value = a - b")).toBe("added");
    expect(diffLineClass(" 11 const value = a + b")).toBeUndefined();
    expect(shellToolOutput(entry)).toBeUndefined();
  });

  it("shows only the final output lines for Pi bash tools", () => {
    const entry = {
      id: "tool-1", kind: "tool", toolCallId: "call-1", name: "bash", status: "complete",
      startedAt: "2026-08-06T00:00:00.000Z", durationMs: 3_700,
      arguments: { command: "npm test" },
      result: { content: [{ type: "text", text: Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join("\n") }] },
    } satisfies ConversationEntry;
    expect(toolLabel(entry)).toBe("$ npm test");
    expect(shellToolOutput(entry)).toEqual({
      lines: Array.from({ length: 10 }, (_, index) => `line ${index + 5}`),
      omitted: 4,
    });
  });
});
