import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { createSignal, createStore, reconcile } from "solid-js";
import { marked } from "marked";

import { issuePilotConfig } from "../../../../issue-pilot.config";
import type { IssueDetail, RunEvent } from "../data/client";
import { EventSourceMock } from "../test-setup";
import { AgentPanel, ConversationItem } from "./AgentPanel";
import { AgentDraftStore, clearAgentDrafts } from "./agent-drafts";
import {
  activityForEvent,
  applyAgentEvent,
  boundedText,
  codemodeCalls,
  diffLineClass,
  processingAfterEvent,
  resultText,
  toolNestedCalls,
  toolLabel,
  toolLabelParts,
  type ConversationEntry,
} from "./conversation";

function event(payload: RunEvent["event"], id: string = crypto.randomUUID()): RunEvent {
  return { id, issueId: "63ccbb08-d769-47b6-87a6-e93acea184f7", createdAt: "2026-08-06T00:00:00.000Z", event: payload };
}

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return { role: "assistant", content, api: "openai-responses", provider: "test", model: "test-model", usage, stopReason, timestamp: Date.now() };
}

describe("Agent conversation state", () => {
  it("Escape cancels the visible active Issue once without clearing its draft; ignores composition, modifiers and hidden panels", async () => {
    const issue = {
      id: "ISSUE-20260810-099",
      title: "Cancel",
      description: "",
      priority: "p1",
      type: "defect_fix",
      status: "open",
      assignee: null,
      assigneeSubject: null,
      service: { key: "service", name: "Service" },
      updatedAt: new Date().toISOString(),
      repositories: [],
      attachments: [],
      comments: [],
      environmentKey: "dev",
      agentRunning: true,
      workspace: { status: "ready", sourceAvailable: false },
    } satisfies IssueDetail;
    let resolve!: (response: Response) => void;
    const fetchRequest = vi.spyOn(globalThis, "fetch").mockReturnValue(
      new Promise<Response>((done) => {
        resolve = done;
      }),
    );
    const [hidden, setHidden] = createSignal(false);
    const view = render(() =>
      AgentPanel({
        issue,
        get hidden() {
          return hidden();
        },
        onRefresh: async () => issue,
        drafts: new AgentDraftStore(),
      }),
    );
    try {
      const editor = screen.getByLabelText("发送给 Agent") as HTMLTextAreaElement;
      fireEvent.input(editor, { target: { value: "keep this unsent draft" } });
      fireEvent.keyDown(editor, { key: "Escape", isComposing: true });
      fireEvent.keyDown(editor, { key: "Escape", ctrlKey: true });
      fireEvent.keyDown(editor, { key: "Escape", repeat: true });
      expect(fetchRequest).not.toHaveBeenCalled();
      fireEvent.keyDown(editor, { key: "Escape" });
      fireEvent.keyDown(editor, { key: "Escape" });
      expect(fetchRequest).toHaveBeenCalledOnce();
      expect(fetchRequest.mock.calls[0]?.[0]).toBe(`/api/issues/${issue.id}/abort`);
      expect(fetchRequest.mock.calls[0]?.[1]?.method).toBe("POST");
      expect(editor.value).toBe("keep this unsent draft");
      resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      await new Promise((done) => setTimeout(done, 0));
      setHidden(true);
      await waitFor(() => expect(view.container.querySelector(".agent-panel")?.hasAttribute("hidden")).toBe(true));
      fireEvent.keyDown(editor, { key: "Escape" });
      expect(fetchRequest).toHaveBeenCalledOnce();
    } finally {
      resolve(new Response(null, { status: 200 }));
      view.unmount();
      fetchRequest.mockRestore();
    }
  });
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

  it("uses SDK tool duration when replaying a completed tool without a start event", () => {
    const entries = applyAgentEvent(
      [],
      event({ type: "tool_execution_end", toolCallId: "replayed", toolName: "dms", result: { content: [{ type: "text", text: "ok" }] }, isError: false, durationMs: 4500 }),
    );
    expect(entries[0]).toMatchObject({ kind: "tool", durationMs: 4500, status: "complete" });
  });

  it("assembles Pi streaming events and replaces them with the final message", () => {
    let entries = applyAgentEvent([], event({ type: "message_start", message: assistant([], "pending") }, "message-1"));
    entries = applyAgentEvent(entries, event({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "检查" } }));
    entries = applyAgentEvent(entries, event({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "完成" } }));
    expect(entries).toEqual([{ id: "message-1", kind: "assistant", blocks: [{ contentIndex: 0, type: "text", value: "检查完成" }], streaming: true }]);

    entries = applyAgentEvent(entries, event({ type: "message_end", message: assistant([{ type: "text", text: "检查已完成" }], "stop") }));
    expect(entries).toEqual([{ id: "message-1", kind: "assistant", blocks: [{ contentIndex: 0, type: "text", value: "检查已完成" }], stopReason: "stop", usage }]);
  });

  it("keeps sparse Pi content indexes out of the rendered block array", () => {
    let entries = applyAgentEvent([], event({ type: "message_start", message: assistant([], "pending") }, "message-1"));
    entries = applyAgentEvent(entries, event({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 3, delta: "Visible answer" } }));
    entries = applyAgentEvent(entries, event({ type: "message_update", usage, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Inspecting" } }));
    entries = applyAgentEvent(entries, event({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 3, delta: " complete" } }));

    expect(entries).toEqual([
      {
        id: "message-1",
        kind: "assistant",
        blocks: [
          { contentIndex: 0, type: "thinking", value: "Inspecting" },
          { contentIndex: 3, type: "text", value: "Visible answer complete" },
        ],
        streaming: true,
      },
    ]);
  });

  it("keeps thinking separate from visible answer text", () => {
    const entries = applyAgentEvent(
      [],
      event(
        {
          type: "message_end",
          message: assistant(
            [
              { type: "thinking", thinking: "Inspect tests" },
              { type: "text", text: "Tests pass" },
            ],
            "stop",
          ),
        },
        "message-1",
      ),
    );
    expect(entries[0]).toEqual({
      id: "message-1",
      kind: "assistant",
      blocks: [
        { contentIndex: 0, type: "thinking", value: "Inspect tests" },
        { contentIndex: 1, type: "text", value: "Tests pass" },
      ],
      stopReason: "stop",
      usage,
    });
  });

  it("keeps Pi retry lifecycle active until agent_settled", () => {
    expect(processingAfterEvent(true, event({ type: "agent_end", messages: [], willRetry: true }).event)).toBe(true);
    expect(processingAfterEvent(false, event({ type: "agent_start" }).event)).toBe(true);
    expect(processingAfterEvent(true, event({ type: "agent_settled", aborted: false }).event)).toBe(false);
    expect(activityForEvent(event({ type: "compaction_start", reason: "threshold" }).event)).toEqual({ text: "正在压缩上下文…", tone: "info" });
    expect(activityForEvent(event({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 2_000, errorMessage: "overloaded" }).event)).toEqual({
      text: "第 2/3 次重试，2.0s后进行…",
      tone: "warning",
    });
    expect(activityForEvent(event({ type: "auto_retry_end", success: true, attempt: 2 }).event)).toBeNull();
  });

  it("updates one tool row from Pi start through partial and final result", () => {
    let entries = applyAgentEvent([], event({ type: "tool_execution_start", toolCallId: "call-1", toolName: "db", args: { statement: "SELECT 1" } }));
    entries = applyAgentEvent(
      entries,
      event({ type: "tool_execution_update", toolCallId: "call-1", toolName: "db", args: { statement: "SELECT 1" }, partialResult: { content: [{ type: "text", text: "running" }] } }),
    );
    entries = applyAgentEvent(entries, event({ type: "tool_execution_end", toolCallId: "call-1", toolName: "db", result: { content: [{ type: "text", text: "done" }] }, isError: false }));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "tool", toolCallId: "call-1", status: "complete", arguments: { statement: "SELECT 1" }, result: { content: [{ text: "done" }] } });
  });

  it("projects codemode calls from the parent's persisted details without duplicate live rows", () => {
    let entries = applyAgentEvent([], event({ type: "tool_execution_start", toolCallId: "script", toolName: "codemode", args: { code: "return await tools.service_query({});" } }));
    const parent = entries;
    entries = applyAgentEvent(entries, event({ type: "tool_execution_start", parentToolCallId: "script", toolCallId: "script/1", toolName: "service_query", args: {} }));
    entries = applyAgentEvent(
      entries,
      event({
        type: "tool_execution_end",
        parentToolCallId: "script",
        toolCallId: "script/1",
        toolName: "service_query",
        result: { content: [{ type: "text", text: "intermediate data" }], details: undefined },
        isError: false,
      }),
    );
    expect(entries).toBe(parent);
    const calls = [{ id: "script/1", name: "service_query", args: "{}", status: "ok" as const, durationMs: 15 }];
    entries = applyAgentEvent(
      entries,
      event({ type: "tool_execution_end", toolCallId: "script", toolName: "codemode", result: { content: [{ type: "text", text: "Summary" }], details: { calls } }, isError: false }),
    );
    expect(entries).toHaveLength(1);
    expect(codemodeCalls(entries[0] as Extract<ConversationEntry, { kind: "tool" }>)).toEqual(calls);
    expect(JSON.stringify(entries)).not.toContain("intermediate data");
  });

  it("appends visible user messages and images", () => {
    expect(applyAgentEvent([], event({ type: "issue_user", message: "继续检查", images: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }] }))).toMatchObject([
      { kind: "user", text: "继续检查", images: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }] },
    ]);
  });

  it("projects official compaction, branch, custom, and bash session messages", () => {
    let entries = applyAgentEvent([], event({ type: "message_end", message: { role: "compactionSummary", summary: "Earlier context", tokensBefore: 42_000, timestamp: Date.now() } }));
    entries = applyAgentEvent(entries, event({ type: "message_end", message: { role: "branchSummary", summary: "Alternate approach", fromId: "branch-1", timestamp: Date.now() } }));
    entries = applyAgentEvent(entries, event({ type: "message_end", message: { role: "custom", customType: "notice", content: "Injected context", display: true, timestamp: Date.now() } }));
    entries = applyAgentEvent(
      entries,
      event({ type: "message_end", message: { role: "bashExecution", command: "npm test", output: "passed", exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now() } }),
    );
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
    const labels = pathsAndRanges.map(([path, offset, limit], index) =>
      toolLabel({
        id: `tool-${index}`,
        kind: "tool",
        toolCallId: `call-${index}`,
        name: "read",
        status: "complete",
        startedAt: "2026-08-06T00:00:00.000Z",
        arguments: { path, offset, limit },
      } satisfies ConversationEntry),
    );

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
      id: "tool-1",
      kind: "tool",
      toolCallId: "call-1",
      name: "read",
      status: "complete",
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
      id: "tool-1",
      kind: "tool",
      toolCallId: "call-1",
      name: "read",
      status: "complete",
      startedAt: "2026-08-06T00:00:00.000Z",
      arguments: { path: "src/index.ts", limit: 20 },
    } satisfies ConversationEntry;
    expect(toolLabel(entry)).toBe("read src/index.ts:1-20");
    expect(diffLineClass("+12 const value = a - b")).toBe("added");
    expect(diffLineClass(" 11 const value = a + b")).toBeUndefined();
  });

  it("keeps SDK tool cards compact, lazily mounts retained output and preserves expansion across updates", async () => {
    const issue = {
      id: "ISSUE-20260810-001",
      title: "Tool card",
      description: "",
      priority: "p1",
      type: "defect_fix",
      status: "pending",
      assignee: null,
      assigneeSubject: null,
      service: { key: "service", name: "Service" },
      updatedAt: new Date().toISOString(),
      repositories: [],
      attachments: [],
      comments: [],
      environmentKey: "dev",
      workspace: { status: "ready", sourceAvailable: false },
    } satisfies IssueDetail;
    const initial: Extract<ConversationEntry, { kind: "tool" }> = {
      id: "tool-1",
      kind: "tool",
      toolCallId: "call-1",
      name: "bash",
      status: "running",
      startedAt: "2026-08-06T00:00:00.000Z",
      durationMs: 3700,
      arguments: { command: "npm test" },
      result: {
        content: [{ type: "text", text: `\u001b[31m${Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join("\n")}\u001b[0m` }],
        details: { fullOutputPath: "/state/workspaces/issue-20260810-001/full.log" },
        nestedCalls: { calls: [{ id: "nested", name: "service_query", status: "unfinished" }], complete: false },
      },
    };
    const [entry, setEntry] = createStore(initial);
    const view = render(() => ConversationItem({ issue, entry }));
    try {
      const card = view.container.querySelector("details")!;
      expect(card.open).toBe(false);
      expect(view.container.querySelector("pre")).toBeNull();
      expect(view.container.querySelector(".agent-nested-call")).toBeNull();
      card.open = true;
      fireEvent(card, new Event("toggle"));
      await screen.findByText("嵌套调用记录不完整");
      const output = view.container.querySelector("pre")!;
      expect(output.textContent).toContain("line 1\n");
      expect(output.textContent).toContain("line 14");
      expect(output.textContent).not.toContain("\u001b");
      expect(screen.getByText("未完成")).toBeTruthy();
      expect(screen.getByRole("link", { name: "输出文件" }).getAttribute("href")).toBe(`/api/issues/${issue.id}/files/download?path=full.log`);
      setEntry(
        reconcile({
          ...initial,
          status: "error",
          durationMs: 3800,
          result: {
            ...initial.result!,
            details: { fullOutputPath: "https://external.example/private.log" },
            nestedCalls: { calls: [{ id: "nested", name: "service_query", status: "ok" }], complete: true },
          },
        }),
      );
      await screen.findByText("失败");
      expect(view.container.querySelector("details")).toBe(card);
      expect(card.open).toBe(true);
      expect(view.container.querySelector("pre")).toBe(output);
      expect(screen.queryByText("嵌套调用记录不完整")).toBeNull();
      expect(screen.queryByRole("link", { name: "输出文件" })).toBeNull();
      expect(screen.getByText("3.8s")).toBeTruthy();
      card.open = false;
      fireEvent(card, new Event("toggle"));
      await waitFor(() => expect(view.container.querySelector("pre")).toBeNull());
      expect(screen.getByText("失败")).toBeTruthy();
    } finally {
      view.unmount();
    }
  });

  for (const metadataFirst of [false, true])
    it(`retains SDK nested-call metadata ${metadataFirst ? "before" : "after"} the tool completion without duplicate cards`, () => {
      const nestedCalls = { calls: [{ id: "nested", name: "read", status: "unfinished" as const }], complete: false };
      const completion = event({
        type: "tool_execution_end",
        toolCallId: "parent",
        toolName: "custom",
        isError: false,
        durationMs: 123,
        result: { content: [{ type: "text", text: "parent result" }] },
      });
      const metadata = event({
        type: "message_end",
        message: { role: "toolResult", toolCallId: "parent", toolName: "custom", content: [{ type: "text", text: "parent result" }], nestedCalls, isError: false, timestamp: 1, durationMs: 123 },
      });
      const entries = (metadataFirst ? [metadata, completion] : [completion, metadata]).reduce(applyAgentEvent, [] as ConversationEntry[]);
      expect(entries).toHaveLength(1);
      const entry = entries[0] as Extract<ConversationEntry, { kind: "tool" }>;
      expect(toolNestedCalls(entry)).toEqual(nestedCalls.calls);
      expect(entry.result?.nestedCalls?.complete).toBe(false);
      expect(entry.durationMs).toBe(123);
      expect(resultText(entry)).toBe("parent result");
    });

  it("completes a running tool from its saved result when the end event was missed after a reconnect", () => {
    // Parallel tools: the snapshot has the assistant tool call but neither the fast tool's end event nor its result.
    const call = event({ type: "message_end", message: assistant([{ type: "toolCall", id: "fast-read", name: "read", arguments: { path: "a.txt" } }], "toolUse") });
    const result = event({
      type: "message_end",
      message: { role: "toolResult", toolCallId: "fast-read", toolName: "read", content: [{ type: "text", text: "file text" }], isError: false, timestamp: 1 },
    });
    const entries = [call, result].reduce(applyAgentEvent, [] as ConversationEntry[]);
    const tool = entries.find((entry) => entry.kind === "tool") as Extract<ConversationEntry, { kind: "tool" }>;
    expect(tool.status).toBe("complete");
    expect(resultText(tool)).toBe("file text");
    expect(entries.filter((entry) => entry.kind === "tool")).toHaveLength(1);
  });

  it("does not replace a completed tool's recorded result with its saved result message", () => {
    const completion = event({ type: "tool_execution_end", toolCallId: "done", toolName: "read", isError: false, durationMs: 50, result: { content: [{ type: "text", text: "live result" }] } });
    const saved = event({
      type: "message_end",
      message: { role: "toolResult", toolCallId: "done", toolName: "read", content: [{ type: "text", text: "saved result" }], isError: false, timestamp: 1 },
    });
    const entries = [completion, saved].reduce(applyAgentEvent, [] as ConversationEntry[]);
    const tool = entries[0] as Extract<ConversationEntry, { kind: "tool" }>;
    expect(resultText(tool)).toBe("live result");
    expect(tool.durationMs).toBe(50);
  });

  it("checks expanded pasted text before sending and preserves the draft", async () => {
    const issue = {
      id: "ISSUE-20260810-001",
      title: "Test",
      description: "",
      priority: "p1",
      type: "defect_fix",
      status: "open",
      assignee: null,
      assigneeSubject: null,
      service: { key: "service", name: "Service" },
      updatedAt: new Date().toISOString(),
      repositories: [],
      attachments: [],
      comments: [],
      environmentKey: "dev",
      workspace: { status: "ready", sourceAvailable: false },
    } satisfies IssueDetail;
    const fetchRequest = vi.spyOn(globalThis, "fetch");
    const view = render(() => AgentPanel({ issue, onRefresh: async () => issue }));
    const editor = screen.getByLabelText("发送给 Agent") as HTMLTextAreaElement;
    fireEvent.paste(editor, { clipboardData: { files: [], getData: () => "a".repeat(issuePilotConfig.limits.agentMessageChars + 1) } });
    await waitFor(() => expect(editor.value).toContain("[paste #1"));
    fireEvent.keyDown(editor, { key: "Enter", code: "Enter" });
    expect(await screen.findByText(/超过 50,000 字符上限/)).toBeTruthy();
    expect(editor.value).toContain("[paste #1");
    expect(fetchRequest).not.toHaveBeenCalled();
    view.unmount();
  });

  it("previews pasted images and sends multipart input with the button, without sending on composition or Shift+Enter", async () => {
    EventSourceMock.instances.length = 0;
    const issue = {
      id: "ISSUE-20260810-001",
      title: "Test",
      description: "",
      priority: "p1",
      type: "defect_fix",
      status: "open",
      assignee: null,
      assigneeSubject: null,
      service: { key: "service", name: "Service" },
      updatedAt: new Date().toISOString(),
      repositories: [],
      attachments: [],
      comments: [],
      environmentKey: "dev",
      workspace: { status: "ready", sourceAvailable: false },
    } satisfies IssueDetail;
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:clipboard-image");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const fetchRequest = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    const view = render(() => AgentPanel({ issue, onRefresh: async () => issue }));
    const editor = screen.getByLabelText("发送给 Agent") as HTMLTextAreaElement;
    const image = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "clipboard.png", { type: "image/png" });
    fireEvent.paste(editor, { clipboardData: { files: [image], getData: () => "" } });
    expect(await screen.findByAltText("clipboard.png")).toBeTruthy();
    expect(createObjectUrl).toHaveBeenCalledWith(image);
    fireEvent.input(editor, { target: { value: "检查这张图片" } });
    await waitFor(() => expect(editor.value).toBe("检查这张图片"));
    fireEvent.keyDown(editor, { key: "Enter", code: "Enter", isComposing: true });
    fireEvent.keyDown(editor, { key: "Enter", code: "Enter", shiftKey: true });
    expect(fetchRequest).not.toHaveBeenCalled();
    const send = screen.getByRole("button", { name: "发送消息" }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    fireEvent.keyDown(editor, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(fetchRequest).toHaveBeenCalledTimes(1));
    const body = fetchRequest.mock.calls[0]?.[1]?.body;
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get("message")).toBe("检查这张图片");
    expect((body as FormData).getAll("images")).toHaveLength(1);
    await waitFor(() => expect(screen.queryByAltText("clipboard.png")).toBeNull());
    await waitFor(() => expect(revokeObjectUrl).toHaveBeenCalledWith("blob:clipboard-image"));
    view.unmount();
  });

  for (const [code, status, warning] of [
    ["agent_message_outcome_unknown", 409, "会话已切换，无法确认这条消息是否已执行。请先查看对话和结果，再决定是否重发。"],
    ["issue_already_running", 409, "工单正在被其他操作处理，请稍后重试。"],
    ["resolved_issue_cannot_run_agent", 409, "工单已解决，请先重开后再发送。"],
    ["agent_session_file_incomplete", 500, "会话文件不完整，消息未接收。请保留草稿并联系管理员检查会话文件。"],
    ["agent_session_file_missing", 500, "会话文件缺失，消息未接收。请保留草稿并联系管理员检查会话绑定。"],
  ] as const)
    it(`keeps the draft and pasted image after ${code}`, async () => {
      const issue = {
        id: "ISSUE-20260810-001",
        title: "Test",
        description: "",
        priority: "p1",
        type: "defect_fix",
        status: "open",
        assignee: null,
        assigneeSubject: null,
        service: { key: "service", name: "Service" },
        updatedAt: new Date().toISOString(),
        repositories: [],
        attachments: [],
        comments: [],
        environmentKey: "dev",
        workspace: { status: "ready", sourceAvailable: false },
      } satisfies IssueDetail;
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:uncertain-image");
      const fetchRequest = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: code }), { status }));
      const view = render(() => AgentPanel({ issue, onRefresh: async () => issue }));
      try {
        const editor = screen.getByLabelText("发送给 Agent") as HTMLTextAreaElement;
        const image = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "uncertain.png", { type: "image/png" });
        fireEvent.paste(editor, { clipboardData: { files: [image], getData: () => "" } });
        await screen.findByAltText("uncertain.png");
        fireEvent.input(editor, { target: { value: "check the uncertain operation" } });
        await waitFor(() => expect(editor.value).toBe("check the uncertain operation"));
        fireEvent.keyDown(editor, { key: "Enter", code: "Enter" });
        expect(await screen.findByText(warning)).toBeTruthy();
        expect(editor.value).toBe("check the uncertain operation");
        expect(screen.getByAltText("uncertain.png")).toBeTruthy();
        if (code === "resolved_issue_cannot_run_agent") expect((screen.getByLabelText("发送给 Agent") as HTMLTextAreaElement).disabled).toBe(true);
        expect(fetchRequest).toHaveBeenCalledTimes(1);
      } finally {
        view.unmount();
      }
    });

  it("updates auxiliary SDK usage without changing the main context or reconnecting", async () => {
    EventSourceMock.instances.length = 0;
    const issue = {
      id: "ISSUE-20260810-001",
      title: "Test",
      description: "",
      priority: "p1",
      type: "defect_fix",
      status: "pending",
      assignee: null,
      assigneeSubject: null,
      service: { key: "service", name: "Service" },
      updatedAt: new Date().toISOString(),
      repositories: [],
      attachments: [],
      comments: [],
      environmentKey: "dev",
      workspace: { status: "ready", sourceAvailable: false },
    } satisfies IssueDetail;
    const view = render(() => AgentPanel({ issue, onRefresh: async () => issue }));
    const source = EventSourceMock.instances[0]!;
    source.emit("snapshot_ready", {
      agent: { provider: "test", model: "model", thinkingLevel: "medium" },
      footer: { input: 100, output: 10, cacheRead: 900, cacheWrite: 0, cost: 0.1, costSource: "unknown", latestCacheHitRate: 90, contextPercent: 10, contextWindow: 10_000, autoCompact: true },
      running: false,
      issueStatus: "pending",
    });
    await waitFor(() => expect(screen.getByText("↑100 ↓10 R900 CH90.0% $0.100 (来源未标明) 10.0%/10k (auto)")).toBeTruthy());
    const editor = screen.getByLabelText("发送给 Agent") as HTMLTextAreaElement;
    fireEvent.input(editor, { target: { value: "draft survives usage updates" } });
    for (const [index, kind] of ["cache_warm", "native_auxiliary"].entries())
      source.emit(
        "message",
        event(
          {
            type: "entry_appended",
            entry: {
              type: "usage",
              id: `usage-${index}`,
              parentId: null,
              timestamp: new Date().toISOString(),
              kind,
              provider: "test",
              model: "model",
              usage: { ...usage, cacheRead: 100, totalTokens: 100, cost: { ...usage.cost, cacheRead: 0.02, total: 0.02 } },
            },
          },
          `auxiliary-${index}`,
        ),
      );
    await waitFor(() => expect(screen.getByText("↑100 ↓10 R1.1k CH90.0% $0.140 (来源未标明) 10.0%/10k (auto)")).toBeTruthy());
    expect(editor.value).toBe("draft survives usage updates");
    expect(EventSourceMock.instances).toHaveLength(1);
    view.unmount();
  });

  for (const [flag, costSource, label] of [
    [true, "provider", "供应商报告"],
    [false, "estimated", "估算"],
    [undefined, "unknown", "来源未标明"],
  ] as const)
    it(`keeps ${costSource} cost provenance consistent across snapshots, live entry types and reconnect`, async () => {
      EventSourceMock.instances.length = 0;
      const issue = {
        id: "ISSUE-20260810-001",
        title: "Cost source",
        description: "",
        priority: "p1",
        type: "defect_fix",
        status: "pending",
        assignee: null,
        assigneeSubject: null,
        service: { key: "service", name: "Service" },
        updatedAt: new Date().toISOString(),
        repositories: [],
        attachments: [],
        comments: [],
        environmentKey: "dev",
        workspace: { status: "ready", sourceAvailable: false },
      } satisfies IssueDetail;
      const view = render(() => AgentPanel({ issue, onRefresh: async () => issue }));
      try {
        const source = EventSourceMock.instances[0]!;
        const footer = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.1, costSource, latestCacheHitRate: null, contextPercent: null, contextWindow: 0, autoCompact: true };
        const charged = { ...usage, cost: { ...usage.cost, total: 0.1, ...(flag === undefined ? {} : { totalFromProvider: flag }) } };
        const base = { parentId: null, timestamp: new Date().toISOString() };
        source.emit("snapshot_ready", { footer, running: false, issueStatus: "pending" });
        await screen.findByText(`$0.100 (${label})`);
        source.emit("message", event({ type: "entry_appended", entry: { ...base, type: "usage", id: "auxiliary", kind: "auxiliary", provider: "test", model: "model", usage: charged } }));
        source.emit("message", event({ type: "message_end", message: { ...assistant([], "stop"), usage: charged } }));
        source.emit("message", event({ type: "message_end", message: { role: "toolResult", toolCallId: "nested", toolName: "fixture", content: [], isError: false, usage: charged, timestamp: 1 } }));
        source.emit(
          "message",
          event({ type: "entry_appended", entry: { ...base, type: "compaction", id: "compaction", summary: "Summary", firstKeptEntryId: "compaction", tokensBefore: 0, usage: charged } }),
        );
        source.emit("message", event({ type: "entry_appended", entry: { ...base, type: "branch_summary", id: "branch", fromId: "previous", summary: "Branch", usage: charged } }));
        await screen.findByText(`$0.600 (${label})`);
        source.emit(
          "message",
          event({
            type: "entry_appended",
            entry: { ...base, type: "usage", id: "zero", kind: "zero", provider: "test", model: "model", usage: { ...charged, cost: { ...charged.cost, total: 0, totalFromProvider: !flag } } },
          }),
        );
        expect(screen.getByText(`$0.600 (${label})`)).toBeTruthy();
        const mixed = event({
          type: "entry_appended",
          entry: { ...base, type: "usage", id: "mixed", kind: "other", provider: "test", model: "model", usage: { ...charged, cost: { ...charged.cost, totalFromProvider: !flag } } },
        });
        source.emit("message", mixed);
        await screen.findByText("$0.700 (混合来源)");
        source.emit("message", event({ type: "session_reset" }));
        await waitFor(() => expect(EventSourceMock.instances).toHaveLength(2));
        const resumed = EventSourceMock.instances[1]!;
        resumed.emit("message", mixed);
        resumed.emit("snapshot_ready", { footer: { ...footer, cost: 0.7, costSource: "mixed" }, running: false, issueStatus: "pending" });
        await screen.findByText("$0.700 (混合来源)");
        expect(screen.queryByText("$0.800 (混合来源)")).toBeNull();
      } finally {
        view.unmount();
      }
    });

  it("distinguishes a queued Issue from an executing round across reconnect and live transitions", async () => {
    EventSourceMock.instances.length = 0;
    const issue = {
      id: "ISSUE-20260810-001",
      title: "Queued",
      description: "",
      priority: "p1",
      type: "defect_fix",
      status: "pending",
      assignee: null,
      assigneeSubject: null,
      service: { key: "service", name: "Service" },
      updatedAt: new Date().toISOString(),
      repositories: [],
      attachments: [],
      comments: [],
      environmentKey: "dev",
      workspace: { status: "ready", sourceAvailable: false },
    } satisfies IssueDetail;
    const view = render(() => AgentPanel({ issue, onRefresh: async () => issue }));
    try {
      const source = EventSourceMock.instances[0]!;
      source.emit("message", event({ type: "auto_retry_end", success: false, attempt: 3 }));
      source.emit("snapshot_ready", { running: true, runState: "queued", issueStatus: "pending" });
      await screen.findByText("排队中，等待执行名额…");
      expect(screen.queryByText("处理中…")).toBeNull();
      expect(screen.queryByText("重试失败")).toBeNull();
      source.emit("message", event({ type: "issue_run_state", state: "running" }));
      await screen.findByText("处理中…");
      expect(screen.queryByText("排队中，等待执行名额…")).toBeNull();
      source.emit("message", event({ type: "issue_status", status: "complete" }));
      source.emit("message", event({ type: "issue_run_state", state: "queued" }));
      await screen.findByText("排队中，等待执行名额…");
      source.emit("message", event({ type: "issue_run_state", state: "idle" }));
      await waitFor(() => expect(screen.queryByText("排队中，等待执行名额…")).toBeNull());
      expect(screen.queryByText("处理中…")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  it("renders the real EventSource lifecycle and active transcript", async () => {
    EventSourceMock.instances.length = 0;
    const issue = {
      id: "ISSUE-20260810-001",
      title: "Test",
      description: "",
      priority: "p1",
      type: "defect_fix",
      status: "in_progress",
      assignee: null,
      assigneeSubject: null,
      service: { key: "service", name: "Service" },
      updatedAt: new Date().toISOString(),
      repositories: [],
      attachments: [],
      comments: [],
      environmentKey: "dev",
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
      footer: {
        input: 11_000_000,
        output: 1_300_000,
        cacheRead: 498_000_000,
        cacheWrite: 0,
        cost: 385.206,
        costSource: "unknown",
        latestCacheHitRate: 95,
        contextPercent: 32.9,
        contextWindow: 272_000,
        autoCompact: true,
      },
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
    let viewportHeight = 300;
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, get: () => viewportHeight },
      scrollTop: { configurable: true, value: 0, writable: true },
      scrollTo: {
        configurable: true,
        value: ({ top }: ScrollToOptions) => {
          transcript.scrollTop = top!;
        },
      },
    });
    fireEvent.keyDown(panel, { key: "Enter" });
    expect(transcript.scrollTop).toBe(700);
    viewportHeight = 200;
    // A scroll event for the old bottom position reaches the panel before resize observation.
    fireEvent.scroll(transcript);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("button", { name: "回到最新" })).toBeNull();
    transcript.scrollTop = 0;
    fireEvent.scroll(transcript);
    source.emit("message", event({ type: "issue_user", message: "Arrived after scrolling" }, "message-unread"));
    await waitFor(() => expect(screen.getByRole("button", { name: "1 条新消息" })).toBeTruthy());
    expect(screen.getByText("↑11M ↓1.3M R498M CH95.0% $385.206 (来源未标明) 32.9%/272k (auto)")).toBeTruthy();
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
      id: "ISSUE-20260810-001",
      title: "Test",
      description: "",
      priority: "p1",
      type: "defect_fix",
      status: "resolved",
      assignee: null,
      assigneeSubject: null,
      service: { key: "service", name: "Service" },
      updatedAt: new Date().toISOString(),
      repositories: [],
      attachments: [],
      comments: [],
      environmentKey: "dev",
      workspace: { status: "ready", sourceAvailable: false },
    } satisfies IssueDetail;
    const [issue, setIssue] = createSignal<IssueDetail>(initial);
    const view = render(() =>
      AgentPanel({
        get issue() {
          return issue();
        },
        onRefresh: async () => issue(),
      }),
    );
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
      id: "ISSUE-20260810-001",
      title: "Test",
      description: "",
      priority: "p1",
      type: "defect_fix",
      status: "open",
      assignee: null,
      assigneeSubject: null,
      service: { key: "service", name: "Service" },
      updatedAt: new Date().toISOString(),
      repositories: [],
      attachments: [],
      comments: [],
      environmentKey: "dev",
      workspace: { status: "preparing", sourceAvailable: false },
    } satisfies IssueDetail;
    const prepared = {
      ...initial,
      status: "in_progress" as const,
      repositories: [{ name: "service", url: "git@example.test:team/service.git", baseBranch: "main", workingBranch: "feature-issue-20260810-001" }],
      workspace: { status: "running" as const, sourceAvailable: true },
    };
    const [issue, setIssue] = createSignal<IssueDetail>(initial);
    const onRefresh = vi.fn(async () => {
      setIssue(prepared);
      return prepared;
    });
    const view = render(() =>
      AgentPanel({
        get issue() {
          return issue();
        },
        onRefresh,
      }),
    );
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
      id: "ISSUE-20260810-001",
      title: "Test",
      description: "",
      priority: "p1",
      type: "defect_fix",
      status: "in_progress",
      assignee: null,
      assigneeSubject: null,
      service: { key: "service", name: "Service" },
      updatedAt: new Date().toISOString(),
      repositories: [],
      attachments: [],
      comments: [],
      environmentKey: "dev",
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

  it("focuses the conversation without hijacking native tool-card keyboard focus", async () => {
    EventSourceMock.instances.length = 0;
    const issue = {
      id: "ISSUE-20260810-001",
      title: "Test",
      description: "",
      priority: "p1",
      type: "defect_fix",
      status: "pending",
      assignee: null,
      assigneeSubject: null,
      service: { key: "service", name: "Service" },
      updatedAt: new Date().toISOString(),
      repositories: [],
      attachments: [],
      comments: [],
      environmentKey: "prod",
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
    const source = EventSourceMock.instances[0]!;
    source.emit("open");
    source.emit("message", event({ type: "tool_execution_end", toolCallId: "keyboard-tool", toolName: "read", result: { content: [] }, isError: false }));
    source.emit("snapshot_ready", { running: false, issueStatus: "pending" });
    await waitFor(() => expect(panel.querySelector("summary.agent-tool-head")).toBeTruthy());
    const summary = panel.querySelector("summary.agent-tool-head") as HTMLElement;
    scrollTo.mockClear();
    summary.focus();
    fireEvent.click(summary);
    expect(document.activeElement).toBe(summary);
    fireEvent.keyDown(summary, { key: "Enter", code: "Enter" });
    expect(scrollTo).not.toHaveBeenCalled();
    view.unmount();
  });

  it("preserves completed message nodes and selection when another assistant message starts", async ({ onTestFinished }) => {
    EventSourceMock.instances.length = 0;
    const issue = {
      id: "ISSUE-20260810-001",
      title: "Selection fixture",
      description: "",
      priority: "p1",
      type: "defect_fix",
      status: "in_progress",
      assignee: null,
      assigneeSubject: null,
      service: { key: "service", name: "Service" },
      updatedAt: new Date().toISOString(),
      repositories: [],
      attachments: [],
      comments: [],
      environmentKey: "dev",
      workspace: { status: "running", sourceAvailable: false },
    } satisfies IssueDetail;
    const view = render(() => AgentPanel({ issue, onRefresh: async () => issue }));
    onTestFinished(() => {
      window.getSelection()?.removeAllRanges();
      view.unmount();
    });
    const source = EventSourceMock.instances[0]!;
    source.emit("open");
    source.emit("message", event({ type: "message_end", message: assistant([{ type: "text", text: "Stable completed text" }], "stop") }, "completed"));
    source.emit("snapshot_ready", { running: true, issueStatus: "in_progress" });
    const paragraph = await screen.findByText("Stable completed text");
    const text = paragraph.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 6);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    source.emit("message", event({ type: "message_start", message: assistant([], "pending") }, "next-start"));
    source.emit("message", event({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Growing" } }, "next-delta"));
    await screen.findByText("Growing");
    expect(screen.getByText("Stable completed text")).toBe(paragraph);
    expect(paragraph.firstChild).toBe(text);
    expect(window.getSelection()?.toString()).toBe("Stable");
  });

  it("batches streaming deltas per frame and flushes them before the final message", async ({ onTestFinished }) => {
    EventSourceMock.instances.length = 0;
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameId += 1;
      frames.set(frameId, callback);
      return frameId;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    const markdownParse = vi.spyOn(marked, "parse");
    const issue = {
      id: "ISSUE-20260810-001",
      title: "Test",
      description: "",
      priority: "p1",
      type: "defect_fix",
      status: "in_progress",
      assignee: null,
      assigneeSubject: null,
      service: { key: "service", name: "Service" },
      updatedAt: new Date().toISOString(),
      repositories: [],
      attachments: [],
      comments: [],
      environmentKey: "dev",
      workspace: { status: "running", sourceAvailable: false },
    } satisfies IssueDetail;
    const view = render(() => AgentPanel({ issue, onRefresh: async () => issue }));
    onTestFinished(() => {
      view.unmount();
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
      markdownParse.mockRestore();
    });
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
    source.emit("message", event({ type: "message_update", usage, assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "Reasoning" } }, "stream-thinking"));

    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("First second")).toBeNull();
    const scheduled = frames.get(frameId)!;
    frames.delete(frameId);
    scheduled(performance.now());
    await waitFor(() => expect(screen.getByText("First second")).toBeTruthy());
    expect(screen.getByRole("button", { name: "1 条新消息" })).toBeTruthy();
    expect(view.container.querySelector(".agent-message.assistant .agent-streaming-block")?.textContent).toBe("First second");
    expect(view.container.querySelector(".agent-message.assistant .markdown-body")).toBeNull();

    const assistantNode = view.container.querySelector(".agent-message.assistant");
    const block = view.container.querySelector(".agent-streaming-block");
    const thinking = view.container.querySelector(".agent-thinking .agent-streaming-block");
    expect(thinking?.textContent).toBe("Reasoning");
    source.emit("message", event({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " queued" } }, "stream-queued"));
    expect(requestFrame).toHaveBeenCalledTimes(2);
    frames.get(frameId)!(performance.now());
    frames.delete(frameId);
    await screen.findByText("First second queued");
    expect(view.container.querySelector(".agent-message.assistant")).toBe(assistantNode);
    expect(view.container.querySelector(".agent-streaming-block")).toBe(block);
    expect(view.container.querySelector(".agent-thinking .agent-streaming-block")).toBe(thinking);
    expect(markdownParse).not.toHaveBeenCalled();
    for (let index = 0; index < 10; index += 1) {
      source.emit("message", event({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "!" } }, `stream-${index}`));
      frames.get(frameId)!(performance.now());
      frames.delete(frameId);
      await screen.findByText(`First second queued${"!".repeat(index + 1)}`);
      expect(view.container.querySelector(".agent-message.assistant")).toBe(assistantNode);
      expect(view.container.querySelector(".agent-streaming-block")).toBe(block);
      expect(view.container.querySelector(".agent-thinking .agent-streaming-block")).toBe(thinking);
    }
    expect(markdownParse).not.toHaveBeenCalled();
    source.emit("message", event({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " discarded" } }, "stream-discarded"));
    expect(requestFrame).toHaveBeenCalledTimes(13);
    source.emit(
      "message",
      event(
        {
          type: "message_end",
          message: assistant(
            [
              { type: "text", text: 'Final response<img src="x" onerror="alert(1)">' },
              { type: "thinking", thinking: "Final reasoning" },
            ],
            "stop",
          ),
        },
        "stream-final",
      ),
    );
    await waitFor(() => expect(screen.getByText("Final response")).toBeTruthy());
    expect(view.container.querySelector(".agent-message.assistant .agent-streaming-block")).toBeNull();
    expect(view.container.querySelector(".agent-message.assistant .markdown-body")?.textContent).toContain("Final response");
    expect(cancelFrame).toHaveBeenCalledWith(frameId);
    expect(view.container.querySelector(".agent-message.assistant")).toBe(assistantNode);
    await screen.findByText("Final reasoning");
    expect(view.container.querySelector(".agent-thinking details")).toBeNull();
    expect(screen.queryByText("思考过程")).toBeNull();
    expect(markdownParse).toHaveBeenCalledTimes(2);
    expect(view.container.querySelector(".markdown-body img")?.hasAttribute("onerror")).toBe(false);
    expect(screen.queryByText("First second queued")).toBeNull();
    expect(screen.getByRole("button", { name: "1 条新消息" })).toBeTruthy();
    scroller.scrollTop = 800;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(screen.queryByRole("button", { name: "1 条新消息" })).toBeNull());
  });

  it("discards pending streaming deltas when a reconnect snapshot replaces the conversation", async ({ onTestFinished }) => {
    EventSourceMock.instances.length = 0;
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frameId += 1;
      frames.set(frameId, callback);
      return frameId;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    const issue = {
      id: "ISSUE-20260810-001",
      title: "Test",
      description: "",
      priority: "p1",
      type: "defect_fix",
      status: "in_progress",
      assignee: null,
      assigneeSubject: null,
      service: { key: "service", name: "Service" },
      updatedAt: new Date().toISOString(),
      repositories: [],
      attachments: [],
      comments: [],
      environmentKey: "dev",
      workspace: { status: "running", sourceAvailable: false },
    } satisfies IssueDetail;
    const view = render(() => AgentPanel({ issue, onRefresh: async () => issue }));
    onTestFinished(() => {
      view.unmount();
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    });
    const first = EventSourceMock.instances[0]!;
    first.emit("open");
    first.emit("snapshot_ready", { running: true, issueStatus: "in_progress" });
    first.emit("message", event({ type: "message_update", usage, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ghost" } }, "ghost"));
    expect(requestFrame).toHaveBeenCalledTimes(1);
    const staleFrame = frames.get(frameId)!;
    first.emit("message", event({ type: "session_reset" }, "reset"));
    await Promise.resolve();
    const second = EventSourceMock.instances[1]!;
    second.emit("open");
    second.emit("snapshot_ready", { running: true, issueStatus: "in_progress" });
    // Simulate the frame that was already queued in the browser when the snapshot landed.
    staleFrame(performance.now());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("ghost")).toBeNull();
    expect(cancelFrame).toHaveBeenCalledWith(frameId);
  });

  it("keeps unsent drafts across panel remounts and clears them when the identity changes", async ({ onTestFinished }) => {
    EventSourceMock.instances.length = 0;
    const issue = {
      id: "ISSUE-20260810-001",
      title: "Draft fixture",
      description: "",
      priority: "p1",
      type: "defect_fix",
      status: "open",
      assignee: null,
      assigneeSubject: null,
      service: { key: "service", name: "Service" },
      updatedAt: new Date().toISOString(),
      repositories: [],
      attachments: [],
      comments: [],
      environmentKey: "dev",
      workspace: { status: "ready", sourceAvailable: false },
    } satisfies IssueDetail;
    const first = render(() => AgentPanel({ issue, onRefresh: async () => issue }));
    const firstEditor = first.getByLabelText("发送给 Agent") as HTMLTextAreaElement;
    fireEvent.input(firstEditor, { target: { value: "unsent question" } });
    expect(firstEditor.value).toBe("unsent question");
    first.unmount();
    EventSourceMock.instances.length = 0;
    const second = render(() => AgentPanel({ issue, onRefresh: async () => issue }));
    onTestFinished(() => second.unmount());
    const secondEditor = second.getByLabelText("发送给 Agent") as HTMLTextAreaElement;
    expect(secondEditor.value).toBe("unsent question");
    clearAgentDrafts();
    await Promise.resolve();
    expect((second.getByLabelText("发送给 Agent") as HTMLTextAreaElement).value).toBe("");
  });

  it("shows an in-flight send after a remount and surfaces its failure there without another remount", async ({ onTestFinished }) => {
    EventSourceMock.instances.length = 0;
    const issue = {
      id: "ISSUE-20260810-002",
      title: "Pending send fixture",
      description: "",
      priority: "p1",
      type: "defect_fix",
      status: "open",
      assignee: null,
      assigneeSubject: null,
      service: { key: "service", name: "Service" },
      updatedAt: new Date().toISOString(),
      repositories: [],
      attachments: [],
      comments: [],
      environmentKey: "dev",
      workspace: { status: "ready", sourceAvailable: false },
    } satisfies IssueDetail;
    let respond!: (response: Response) => void;
    const fetchRequest = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    onTestFinished(() => fetchRequest.mockRestore());
    const first = render(() => AgentPanel({ issue, onRefresh: async () => issue }));
    const firstEditor = first.getByLabelText("发送给 Agent") as HTMLTextAreaElement;
    fireEvent.input(firstEditor, { target: { value: "slow question" } });
    await waitFor(() => expect(firstEditor.value).toBe("slow question"));
    fireEvent.keyDown(firstEditor, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(fetchRequest).toHaveBeenCalledTimes(1));
    // Navigate away while the message is still in flight, then come back.
    first.unmount();
    EventSourceMock.instances.length = 0;
    const second = render(() => AgentPanel({ issue, onRefresh: async () => issue }));
    onTestFinished(() => second.unmount());
    const secondEditor = second.getByLabelText("发送给 Agent") as HTMLTextAreaElement;
    expect(secondEditor.disabled).toBe(true);
    respond(new Response(JSON.stringify({ error: "agent_session_file_missing" }), { status: 409 }));
    await waitFor(() => expect(secondEditor.value).toBe("slow question"));
    expect(secondEditor.disabled).toBe(false);
    expect(second.getByText("会话文件缺失，消息未接收。请保留草稿并联系管理员检查会话绑定。")).toBeTruthy();
  });

  for (const code of ["agent_session_file_missing", "resolved_issue_cannot_run_agent"])
    it(`discards the old identity's failed send after ${code} without restoring images or disabling the new editor`, async ({ onTestFinished }) => {
      const issue = {
        id: "ISSUE-20260810-003",
        title: "Identity send fixture",
        description: "",
        priority: "p1",
        type: "defect_fix",
        status: "open",
        assignee: null,
        assigneeSubject: null,
        service: { key: "service", name: "Service" },
        updatedAt: new Date().toISOString(),
        repositories: [],
        attachments: [],
        comments: [],
        environmentKey: "dev",
        workspace: { status: "ready", sourceAvailable: false },
      } satisfies IssueDetail;
      const drafts = new AgentDraftStore();
      let respond!: (response: Response) => void;
      const fetchRequest = vi.spyOn(globalThis, "fetch").mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            respond = resolve;
          }),
      );
      const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:old-identity");
      const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
      const view = render(() => AgentPanel({ issue, drafts, onRefresh: async () => issue }));
      onTestFinished(() => {
        view.unmount();
        fetchRequest.mockRestore();
        createUrl.mockRestore();
        revokeUrl.mockRestore();
      });
      const editor = view.getByLabelText("发送给 Agent") as HTMLTextAreaElement;
      const image = new File(["fixture image"], "old.png", { type: "image/png" });
      fireEvent.paste(editor, { clipboardData: { files: [image], getData: () => "" } });
      await view.findByAltText("old.png");
      const old = drafts.get(issue.id);
      fireEvent.input(editor, { target: { value: "old identity's question" } });
      fireEvent.keyDown(editor, { key: "Enter", code: "Enter" });
      await waitFor(() => expect(fetchRequest).toHaveBeenCalledOnce());
      drafts.clearAll();
      await waitFor(() => expect(editor.disabled).toBe(false));
      fireEvent.input(editor, { target: { value: "new identity's draft" } });
      respond(new Response(JSON.stringify({ error: code }), { status: 409 }));
      await waitFor(() => expect(old.sending).toBe(false));
      expect(revokeUrl).toHaveBeenCalledWith("blob:old-identity");
      expect(old.images).toEqual([]);
      expect(editor.disabled).toBe(false);
      expect(editor.value).toBe("new identity's draft");
      expect(drafts.get(issue.id).error).toBe("");
    });

  it("reconnects with one close and atomically replaces the replayed transcript", async () => {
    vi.useFakeTimers();
    try {
      EventSourceMock.instances.length = 0;
      const issue = {
        id: "ISSUE-20260810-001",
        title: "Test",
        description: "",
        priority: "p1",
        type: "defect_fix",
        status: "pending",
        assignee: null,
        assigneeSubject: null,
        service: { key: "service", name: "Service" },
        updatedAt: new Date().toISOString(),
        repositories: [],
        attachments: [],
        comments: [],
        environmentKey: "prod",
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
      id: "ISSUE-20260810-002",
      title: "Test",
      description: "",
      priority: "p1",
      type: "defect_fix",
      status: "pending",
      assignee: null,
      assigneeSubject: null,
      service: { key: "service", name: "Service" },
      updatedAt: new Date().toISOString(),
      repositories: [],
      attachments: [],
      comments: [],
      environmentKey: "prod",
      workspace: { status: "ready", sourceAvailable: false },
    } satisfies IssueDetail;
    let rejectFirst!: (error: unknown) => void;
    const firstRefresh = new Promise<IssueDetail>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const onRefresh = vi.fn<() => Promise<IssueDetail>>().mockReturnValueOnce(firstRefresh).mockResolvedValue(issue);
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
      id: "ISSUE-20260810-002",
      title: "Test",
      description: "",
      priority: "p1",
      type: "defect_fix",
      status: "pending",
      assignee: null,
      assigneeSubject: null,
      service: { key: "service", name: "Service" },
      updatedAt: new Date().toISOString(),
      repositories: [],
      attachments: [],
      comments: [],
      environmentKey: "prod",
      workspace: { status: "ready", sourceAvailable: false },
    } satisfies IssueDetail;
    const onRefresh = vi.fn<() => Promise<IssueDetail>>().mockRejectedValueOnce(new Error("network_failed")).mockResolvedValue(issue);
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
