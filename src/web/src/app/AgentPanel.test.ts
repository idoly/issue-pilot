import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";

import { issuePilotConfig } from "../../../../issue-pilot.config";
import type { IssueDetail, RunEvent } from "../data/client";
import { EventSourceMock } from "../test-setup";
import { AgentPanel } from "./AgentPanel";
import { activityForEvent, applyAgentEvent, boundedText, diffLineClass, processingAfterEvent, shellToolOutput, toolLabel, toolLabelParts, type ConversationEntry } from "./conversation";

function event(payload: RunEvent["event"], id: string = crypto.randomUUID()): RunEvent {
  return { id, issueId: "63ccbb08-d769-47b6-87a6-e93acea184f7", createdAt: "2026-08-06T00:00:00.000Z", event: payload };
}

const usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return { role: "assistant", content, api: "openai-responses", provider: "test", model: "test-model", usage, stopReason, timestamp: Date.now() };
}

describe("Agent conversation state", () => {
  it("bounds large tool output before storing it in UI state without changing the source result", () => {
    const source = `${"a".repeat(30_000)}${"b".repeat(30_000)}`;
    const entries = applyAgentEvent([], event({ type: "tool_execution_end", toolCallId: "call-large", toolName: "sls", result: { content: [{ type: "text", text: source }] }, isError: false }));
    const displayed = entries[0]?.kind === "tool" ? entries[0].result?.content[0] : undefined;
    expect(displayed?.type).toBe("text");
    const displayedText = displayed?.type === "text" ? displayed.text : "";
    expect(displayedText.length).toBe(issuePilotConfig.web.agentToolOutputCharacters);
    expect(displayedText.startsWith("a".repeat(100))).toBe(true);
    expect(displayedText.endsWith("b".repeat(100))).toBe(true);
    expect(displayedText).toContain("20,000 characters omitted from display");
    expect(boundedText(source, 40_000)).toBe(displayedText);
    expect(source).toHaveLength(60_000);
  });

  it("assembles Pi streaming events and replaces them with the final message", () => {
    let entries = applyAgentEvent([], event({ type: "message_start", message: assistant([], "pending") }, "message-1"));
    entries = applyAgentEvent(entries, event({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "检查" } }));
    entries = applyAgentEvent(entries, event({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "完成" } }));
    expect(entries).toEqual([{ id: "message-1", kind: "assistant", blocks: [{ type: "text", value: "检查完成" }], streaming: true }]);

    entries = applyAgentEvent(entries, event({ type: "message_end", message: assistant([{ type: "text", text: "检查已完成" }], "stop") }));
    expect(entries).toEqual([{ id: "message-1", kind: "assistant", blocks: [{ type: "text", value: "检查已完成" }], stopReason: "stop", usage }]);
  });

  it("keeps thinking separate from visible answer text", () => {
    const entries = applyAgentEvent([], event({ type: "message_end", message: assistant([
      { type: "thinking", thinking: "Inspect tests" },
      { type: "text", text: "Tests pass" },
    ], "stop") }, "message-1"));
    expect(entries[0]).toEqual({ id: "message-1", kind: "assistant", blocks: [
      { type: "thinking", value: "Inspect tests" },
      { type: "text", value: "Tests pass" },
    ], stopReason: "stop", usage });
  });

  it("keeps Pi retry lifecycle active until agent_settled", () => {
    expect(processingAfterEvent(true, event({ type: "agent_end", messages: [], willRetry: true }).event)).toBe(true);
    expect(processingAfterEvent(false, event({ type: "agent_start" }).event)).toBe(true);
    expect(processingAfterEvent(true, event({ type: "agent_settled" }).event)).toBe(false);
    expect(activityForEvent(event({ type: "compaction_start", reason: "threshold" }).event)).toEqual({ text: "Compacting context...", tone: "info" });
    expect(activityForEvent(event({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 2_000, errorMessage: "overloaded" }).event)).toEqual({ text: "Retrying 2/3 in 2.0s...", tone: "warning" });
    expect(activityForEvent(event({ type: "auto_retry_end", success: true, attempt: 2 }).event)).toBeNull();
  });

  it("updates one tool row from Pi start through partial and final result", () => {
    let entries = applyAgentEvent([], event({ type: "tool_execution_start", toolCallId: "call-1", toolName: "db", args: { statement: "SELECT 1" } }));
    entries = applyAgentEvent(entries, event({ type: "tool_execution_update", toolCallId: "call-1", toolName: "db", args: { statement: "SELECT 1" }, partialResult: { content: [{ type: "text", text: "running" }] } }));
    entries = applyAgentEvent(entries, event({ type: "tool_execution_end", toolCallId: "call-1", toolName: "db", result: { content: [{ type: "text", text: "done" }] }, isError: false }));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "tool", toolCallId: "call-1", status: "complete", arguments: { statement: "SELECT 1" }, result: { content: [{ text: "done" }] } });
  });

  it("appends visible user messages", () => {
    expect(applyAgentEvent([], event({ type: "issue_user", message: "继续检查" }))).toMatchObject([{ kind: "user", text: "继续检查" }]);
  });

  it("projects official compaction, branch, custom, and bash session messages", () => {
    let entries = applyAgentEvent([], event({ type: "message_end", message: { role: "compactionSummary", summary: "Earlier context", tokensBefore: 42_000, timestamp: Date.now() } }));
    entries = applyAgentEvent(entries, event({ type: "message_end", message: { role: "branchSummary", summary: "Alternate approach", fromId: "branch-1", timestamp: Date.now() } }));
    entries = applyAgentEvent(entries, event({ type: "message_end", message: { role: "custom", customType: "notice", content: "Injected context", display: true, timestamp: Date.now() } }));
    entries = applyAgentEvent(entries, event({ type: "message_end", message: { role: "bashExecution", command: "npm test", output: "passed", exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now() } }));
    expect(entries).toMatchObject([
      { kind: "summary", summaryType: "compaction", summary: "Earlier context", tokensBefore: 42_000 },
      { kind: "summary", summaryType: "branch", summary: "Alternate approach" },
      { kind: "custom", label: "notice", blocks: [{ type: "text", value: "Injected context" }] },
      { kind: "bash", command: "npm test", output: "passed", exitCode: 0 },
    ]);
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
        path: "/home/idoly/issue-pilot/.issue-pilot/workspaces/issue-20260807-001/srm-api-manage/src/PurchaseOrderServiceImpl.java",
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
      lines: Array.from({ length: 5 }, (_, index) => `line ${index + 10}`),
      omitted: 9,
    });
  });

  it("renders the real EventSource lifecycle and active transcript", async () => {
    EventSourceMock.instances.length = 0;
    const issue = {
      id: "ISSUE-20260810-001", title: "Test", description: "", priority: "p1", type: "defect_fix", status: "in_progress",
      assignee: null, assigneeSubject: null, service: { key: "service", name: "Service" },
      updatedAt: new Date().toISOString(), repositories: [], attachments: [], comments: [], environmentKey: "dev",
      workspace: { status: "running", sourceAvailable: false },
    } satisfies IssueDetail;
    const onRefresh = vi.fn(async () => issue);
    const view = render(() => AgentPanel({ issue, onRefresh }));
    const source = EventSourceMock.instances[0]!;
    expect(source.url).toBe("/api/issues/ISSUE-20260810-001/agent-stream");
    source.emit("open");
    source.emit("message", event({ type: "message_end", message: assistant([{ type: "text", text: "Rendered from Pi" }], "stop") }, "message-live"));
    source.emit("ready", { agent: { provider: "stale", model: "stale-model", thinkingLevel: "high" }, running: false, issueStatus: "resolved" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((screen.getByLabelText("发送给 Agent") as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.getByText("no-model")).toBeTruthy();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(EventSourceMock.instances).toHaveLength(1);
    source.emit("snapshot_ready", {
      agent: { provider: "test", model: "model", thinkingLevel: "medium" },
      footer: { input: 11_000_000, output: 1_300_000, cacheRead: 498_000_000, cacheWrite: 0, cost: 385.206, latestCacheHitRate: 95, contextPercent: 32.9, contextWindow: 272_000, autoCompact: true },
      running: false,
      issueStatus: "in_progress",
    });
    await waitFor(() => expect(screen.getByText("Rendered from Pi")).toBeTruthy());
    expect(onRefresh).not.toHaveBeenCalled();
    expect(EventSourceMock.instances).toHaveLength(1);
    source.emit("message", event({ type: "issue_status", status: "complete" }, "status-live"));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    const panel = screen.getByRole("region", { name: "ISSUE-20260810-001 Agent 会话" });
    const transcript = panel.querySelector(".agent-scroll") as HTMLDivElement;
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });
    fireEvent.scroll(transcript);
    source.emit("message", event({ type: "issue_user", message: "Arrived after scrolling" }, "message-unread"));
    await waitFor(() => expect(screen.getByRole("button", { name: "1 条新消息" })).toBeTruthy());
    expect(screen.getByText("↑11M ↓1.3M R498M CH95.0% $385.206 32.9%/272k (auto)")).toBeTruthy();
    expect(screen.getByText("model")).toBeTruthy();
    const composer = screen.getByLabelText("发送给 Agent") as HTMLTextAreaElement;
    fireEvent.input(composer, { target: { value: "draft survives replay" } });
    source.emit("message", event({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false, result: undefined }, "compaction-reconnect"));
    await waitFor(() => expect(EventSourceMock.instances).toHaveLength(2));
    expect(source.closed).toBe(true);
    expect((screen.getByLabelText("发送给 Agent") as HTMLTextAreaElement).value).toBe("draft survives replay");
    expect(screen.queryByLabelText("中止处理")).toBeNull();
    expect(screen.queryByLabelText("放大 Agent")).toBeNull();
    view.unmount();
    expect(source.closed).toBe(true);

    const resolvedView = render(() => AgentPanel({ issue: { ...issue, status: "resolved" }, onRefresh: async () => issue }));
    expect((screen.getByLabelText("发送给 Agent") as HTMLTextAreaElement).disabled).toBe(true);
    resolvedView.unmount();
  });

  it("reconnects the conversation when a resolved Issue is reopened", async () => {
    EventSourceMock.instances.length = 0;
    const initial = {
      id: "ISSUE-20260810-001", title: "Test", description: "", priority: "p1", type: "defect_fix", status: "resolved",
      assignee: null, assigneeSubject: null, service: { key: "service", name: "Service" },
      updatedAt: new Date().toISOString(), repositories: [], attachments: [], comments: [], environmentKey: "dev",
      workspace: { status: "ready", sourceAvailable: false },
    } satisfies IssueDetail;
    const [issue, setIssue] = createSignal<IssueDetail>(initial);
    const view = render(() => AgentPanel({ get issue() { return issue(); }, onRefresh: async () => issue() }));
    const first = EventSourceMock.instances[0]!;
    first.emit("open");
    first.emit("snapshot_ready", { running: false, issueStatus: "resolved" });
    expect((screen.getByLabelText("发送给 Agent") as HTMLTextAreaElement).disabled).toBe(true);

    setIssue({ ...initial, status: "open" });

    await waitFor(() => expect(EventSourceMock.instances).toHaveLength(2));
    expect(first.closed).toBe(true);
    expect(first.closeCalls).toBe(1);
    expect((screen.getByLabelText("发送给 Agent") as HTMLTextAreaElement).disabled).toBe(false);
    const second = EventSourceMock.instances[1]!;
    expect(second.url).toBe(first.url);
    second.emit("open");
    second.emit("snapshot_ready", { running: false, issueStatus: "open" });
    expect((screen.getByLabelText("发送给 Agent") as HTMLTextAreaElement).disabled).toBe(false);

    view.unmount();
    expect(second.closed).toBe(true);
  });

  it("refreshes development repository details when Agent preparation starts live", async () => {
    EventSourceMock.instances.length = 0;
    const initial = {
      id: "ISSUE-20260810-001", title: "Test", description: "", priority: "p1", type: "defect_fix", status: "open",
      assignee: null, assigneeSubject: null, service: { key: "service", name: "Service" },
      updatedAt: new Date().toISOString(), repositories: [], attachments: [], comments: [], environmentKey: "dev",
      workspace: { status: "preparing", sourceAvailable: false },
    } satisfies IssueDetail;
    const prepared = { ...initial, status: "in_progress" as const, repositories: [{ name: "service", url: "git@example.test:team/service.git", baseBranch: "main", workingBranch: "feature-issue-20260810-001" }], workspace: { status: "running" as const, sourceAvailable: true } };
    const [issue, setIssue] = createSignal<IssueDetail>(initial);
    const onRefresh = vi.fn(async () => { setIssue(prepared); return prepared; });
    const view = render(() => AgentPanel({ get issue() { return issue(); }, onRefresh }));
    const source = EventSourceMock.instances[0]!;
    source.emit("open");
    source.emit("snapshot_ready", { running: true, issueStatus: "open" });
    source.emit("message", event({ type: "agent_start" }, "agent-start-live"));

    await waitFor(() => expect(onRefresh).toHaveBeenCalledWith(initial.id));
    expect(issue().repositories[0]?.workingBranch).toBe("feature-issue-20260810-001");
    view.unmount();
  });

  it("refreshes development repository details when Agent start is replayed", async () => {
    EventSourceMock.instances.length = 0;
    const issue = {
      id: "ISSUE-20260810-001", title: "Test", description: "", priority: "p1", type: "defect_fix", status: "in_progress",
      assignee: null, assigneeSubject: null, service: { key: "service", name: "Service" },
      updatedAt: new Date().toISOString(), repositories: [], attachments: [], comments: [], environmentKey: "dev",
      workspace: { status: "running", sourceAvailable: false },
    } satisfies IssueDetail;
    const onRefresh = vi.fn(async () => issue);
    const view = render(() => AgentPanel({ issue, onRefresh }));
    const source = EventSourceMock.instances[0]!;
    source.emit("open");
    source.emit("message", event({ type: "agent_start" }, "agent-start-replay"));
    expect(onRefresh).not.toHaveBeenCalled();
    source.emit("snapshot_ready", { running: true, issueStatus: "in_progress" });

    await waitFor(() => expect(onRefresh).toHaveBeenCalledWith(issue.id));
    view.unmount();
  });

  it("focuses the conversation and uses Enter to scroll to the latest message", () => {
    EventSourceMock.instances.length = 0;
    const issue = {
      id: "ISSUE-20260810-001", title: "Test", description: "", priority: "p1", type: "defect_fix", status: "pending",
      assignee: null, assigneeSubject: null, service: { key: "service", name: "Service" },
      updatedAt: new Date().toISOString(), repositories: [], attachments: [], comments: [], environmentKey: "prod",
      workspace: { status: "ready", sourceAvailable: false },
    } satisfies IssueDetail;
    const view = render(() => AgentPanel({ issue, onRefresh: async () => issue }));
    const panel = screen.getByRole("region", { name: "ISSUE-20260810-001 Agent 会话" });
    const conversation = panel.querySelector(".agent-conversation") as HTMLDivElement;
    const scroller = panel.querySelector(".agent-scroll") as HTMLDivElement;
    const scrollTo = vi.spyOn(scroller, "scrollTo");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 900 });

    fireEvent.click(conversation);
    expect(document.activeElement).toBe(panel);
    fireEvent.keyDown(panel, { key: " ", code: "Space" });
    expect(scrollTo).not.toHaveBeenCalled();
    fireEvent.keyDown(panel, { key: "Enter", code: "Enter" });
    expect(scrollTo).toHaveBeenCalledWith({ top: 900, behavior: "auto" });

    const editor = screen.getByLabelText("发送给 Agent") as HTMLTextAreaElement;
    editor.focus();
    fireEvent.keyDown(editor, { key: "Enter", code: "Enter" });
    expect(scrollTo).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("batches streaming deltas per frame and flushes them before the final message", async () => {
    EventSourceMock.instances.length = 0;
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameId += 1;
      frames.set(frameId, callback);
      return frameId;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
    const issue = {
      id: "ISSUE-20260810-001", title: "Test", description: "", priority: "p1", type: "defect_fix", status: "in_progress",
      assignee: null, assigneeSubject: null, service: { key: "service", name: "Service" },
      updatedAt: new Date().toISOString(), repositories: [], attachments: [], comments: [], environmentKey: "dev",
      workspace: { status: "running", sourceAvailable: false },
    } satisfies IssueDetail;
    const view = render(() => AgentPanel({ issue, onRefresh: async () => issue }));
    const source = EventSourceMock.instances[0]!;
    source.emit("open");
    source.emit("snapshot_ready", { running: true, issueStatus: "in_progress" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const scroller = view.container.querySelector(".agent-scroll") as HTMLDivElement;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });
    fireEvent.scroll(scroller);
    source.emit("message", event({ type: "message_start", message: assistant([], "pending") }, "stream-start"));
    source.emit("message", event({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "First " } }, "stream-first"));
    source.emit("message", event({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "second" } }, "stream-second"));

    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("First second")).toBeNull();
    const scheduled = frames.get(frameId)!;
    frames.delete(frameId);
    scheduled(performance.now());
    await waitFor(() => expect(screen.getByText("First second")).toBeTruthy());
    expect(screen.getByRole("button", { name: "1 条新消息" })).toBeTruthy();
    expect(view.container.querySelector(".agent-message.assistant .agent-streaming-block")?.textContent).toBe("First second");
    expect(view.container.querySelector(".agent-message.assistant .markdown-body")).toBeNull();

    source.emit("message", event({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " queued" } }, "stream-queued"));
    expect(requestFrame).toHaveBeenCalledTimes(2);
    source.emit("message", event({ type: "message_end", message: assistant([{ type: "text", text: "Final response" }], "stop") }, "stream-final"));
    await waitFor(() => expect(screen.getByText("Final response")).toBeTruthy());
    expect(view.container.querySelector(".agent-message.assistant .agent-streaming-block")).toBeNull();
    expect(view.container.querySelector(".agent-message.assistant .markdown-body")?.textContent).toContain("Final response");
    expect(cancelFrame).toHaveBeenCalledWith(frameId);
    expect(screen.queryByText("First second queued")).toBeNull();
    expect(screen.getByRole("button", { name: "1 条新消息" })).toBeTruthy();
    scroller.scrollTop = 800;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(screen.queryByRole("button", { name: "1 条新消息" })).toBeNull());

    view.unmount();
    requestFrame.mockRestore();
    cancelFrame.mockRestore();
  });

  it("reconnects with one close and atomically replaces the replayed transcript", async () => {
    vi.useFakeTimers();
    try {
      EventSourceMock.instances.length = 0;
      const issue = {
        id: "ISSUE-20260810-001", title: "Test", description: "", priority: "p1", type: "defect_fix", status: "pending",
        assignee: null, assigneeSubject: null, service: { key: "service", name: "Service" },
        updatedAt: new Date().toISOString(), repositories: [], attachments: [], comments: [], environmentKey: "prod",
        workspace: { status: "ready", sourceAvailable: false },
      } satisfies IssueDetail;
      const view = render(() => AgentPanel({ issue, onRefresh: async () => issue }));
      const first = EventSourceMock.instances[0]!;
      first.emit("open");
      first.emit("message", event({ type: "message_end", message: assistant([{ type: "text", text: "Stable before disconnect" }], "stop") }, "message-before"));
      first.emit("snapshot_ready", { running: false, issueStatus: "pending" });
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.getByText("Stable before disconnect")).toBeTruthy();

      first.emit("error");
      first.emit("error");
      expect(first.closeCalls).toBe(1);
      expect(screen.getByText("Stable before disconnect")).toBeTruthy();
      await vi.advanceTimersByTimeAsync(issuePilotConfig.web.agentStreamReconnectMs);
      expect(EventSourceMock.instances).toHaveLength(2);
      expect(first.closeCalls).toBe(1);

      const second = EventSourceMock.instances[1]!;
      second.emit("open");
      second.emit("message", event({ type: "message_end", message: assistant([{ type: "text", text: "Replayed after reconnect" }], "stop") }, "message-after"));
      expect(screen.getByText("Stable before disconnect")).toBeTruthy();
      expect(screen.queryByText("Replayed after reconnect")).toBeNull();
      second.emit("snapshot_ready", { running: false, issueStatus: "pending" });
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.queryByText("Stable before disconnect")).toBeNull();
      expect(screen.getByText("Replayed after reconnect")).toBeTruthy();

      view.unmount();
      expect(first.closeCalls).toBe(1);
      expect(second.closeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a stale Issue refresh failure after a newer refresh succeeds", async () => {
    EventSourceMock.instances.length = 0;
    const issue = {
      id: "ISSUE-20260810-002", title: "Test", description: "", priority: "p1", type: "defect_fix", status: "pending",
      assignee: null, assigneeSubject: null, service: { key: "service", name: "Service" },
      updatedAt: new Date().toISOString(), repositories: [], attachments: [], comments: [], environmentKey: "prod",
      workspace: { status: "ready", sourceAvailable: false },
    } satisfies IssueDetail;
    let rejectFirst!: (error: unknown) => void;
    const firstRefresh = new Promise<IssueDetail>((_resolve, reject) => { rejectFirst = reject; });
    const onRefresh = vi.fn<() => Promise<IssueDetail>>()
      .mockReturnValueOnce(firstRefresh)
      .mockResolvedValue(issue);
    const view = render(() => AgentPanel({ issue, onRefresh }));
    const source = EventSourceMock.instances[0]!;
    source.emit("open");
    source.emit("snapshot_ready", { running: false, issueStatus: "pending" });
    source.emit("message", event({ type: "issue_status", status: "complete" }, "status-old"));
    source.emit("message", event({ type: "issue_status", status: "complete" }, "status-new"));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(2));
    rejectFirst(new Error("stale_network_failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("alert")).toBeNull();
    view.unmount();
  });

  it("contains Issue refresh failures and retries on the next Issue status event", async () => {
    EventSourceMock.instances.length = 0;
    const issue = {
      id: "ISSUE-20260810-002", title: "Test", description: "", priority: "p1", type: "defect_fix", status: "pending",
      assignee: null, assigneeSubject: null, service: { key: "service", name: "Service" },
      updatedAt: new Date().toISOString(), repositories: [], attachments: [], comments: [], environmentKey: "prod",
      workspace: { status: "ready", sourceAvailable: false },
    } satisfies IssueDetail;
    const onRefresh = vi.fn<() => Promise<IssueDetail>>()
      .mockRejectedValueOnce(new Error("network_failed"))
      .mockResolvedValue(issue);
    const view = render(() => AgentPanel({ issue, onRefresh }));
    const source = EventSourceMock.instances[0]!;
    source.emit("open");
    source.emit("snapshot_ready", { running: false, issueStatus: "pending" });
    source.emit("message", event({ type: "issue_status", status: "complete" }, "status-failed"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("工单状态刷新失败"));
    expect(onRefresh).toHaveBeenLastCalledWith(issue.id);
    source.emit("message", event({ type: "issue_status", status: "complete" }, "status-retry"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(onRefresh).toHaveBeenLastCalledWith(issue.id);
    view.unmount();
  });
});
