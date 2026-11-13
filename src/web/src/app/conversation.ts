import type { CodemodeToolDetails } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ImageContent, NestedToolCalls, TextContent } from "@earendil-works/pi-ai";

import { displayToolResult } from "../../../agent/event-display";
import type { RunEvent } from "../data/client";
import type { QueryResultReference } from "../../../agent/query-results";

export { boundedText } from "../../../agent/event-display";

type ToolResult = { content: Array<TextContent | ImageContent>; details?: unknown; nestedCalls?: NestedToolCalls; displayTruncated?: boolean; queryResult?: QueryResultReference };
type DisplayBlock = { type: "text"; value: string } | { type: "image"; data: string; mimeType: string };
type CompletedMessage = Extract<RunEvent["event"], { type: "message_end" }>["message"];

export type ConversationEntry =
  | { id: string; kind: "user"; text: string; images?: ImageContent[] }
  | {
      id: string;
      kind: "assistant";
      blocks: Array<{ contentIndex: number; type: "text" | "thinking"; value: string }>;
      streaming?: boolean;
      stopReason?: string;
      errorMessage?: string;
      hasToolCalls?: boolean;
      usage?: AssistantMessage["usage"];
    }
  | {
      id: string;
      kind: "tool";
      toolCallId: string;
      parentToolCallId?: string;
      name: string;
      status: "running" | "complete" | "error";
      startedAt: string;
      durationMs?: number;
      arguments?: unknown;
      result?: ToolResult;
    }
  | { id: string; kind: "summary"; summaryType: "compaction" | "branch"; summary: string; tokensBefore?: number }
  | { id: string; kind: "custom"; label: string; blocks: DisplayBlock[] }
  | { id: string; kind: "bash"; command: string; output: string; exitCode?: number; cancelled: boolean; truncated: boolean };

type AssistantBlock = { contentIndex: number; type: "text" | "thinking"; value: string };

function assistantBlocks(content: AssistantMessage["content"] | undefined, fallback = ""): AssistantBlock[] {
  const blocks: AssistantBlock[] = [];
  for (const [contentIndex, part] of (content ?? []).entries()) {
    if (part.type === "text") blocks.push({ contentIndex, type: "text", value: part.text });
    else if (part.type === "thinking") blocks.push({ contentIndex, type: "thinking", value: part.thinking });
  }
  return blocks.length ? blocks : fallback ? [{ contentIndex: 0, type: "text", value: fallback }] : [];
}

function displayBlocks(content: string | Array<TextContent | ImageContent>): DisplayBlock[] {
  if (typeof content === "string") return content ? [{ type: "text", value: content }] : [];
  const blocks: DisplayBlock[] = [];
  for (const part of content) {
    if (part.type === "text") blocks.push({ type: "text", value: part.text });
    else blocks.push({ type: "image", data: part.data, mimeType: part.mimeType });
  }
  return blocks;
}

/** One event reducer for replay, live batches and history pages. Published snapshots stay immutable. */
export class ConversationProjection {
  private entries: ConversationEntry[];
  private shared = true;
  private readonly tools = new Map<string, number>();
  private readonly streamingAssistants: number[] = [];

  constructor(entries: ConversationEntry[] = []) {
    this.entries = entries;
    for (const [index, entry] of entries.entries()) this.indexEntry(index, entry);
  }

  snapshot(): ConversationEntry[] {
    this.shared = true;
    return this.entries;
  }

  private indexEntry(index: number, entry: ConversationEntry): void {
    if (entry.kind === "tool" && !this.tools.has(entry.toolCallId)) this.tools.set(entry.toolCallId, index);
    if (entry.kind === "assistant" && entry.streaming) this.streamingAssistants.push(index);
  }

  private put(entry: ConversationEntry, index?: number): void {
    // Replay and each UI batch copy at most once, after a snapshot has actually been published.
    if (this.shared) {
      this.entries = [...this.entries];
      this.shared = false;
    }
    if (index === undefined) {
      this.indexEntry(this.entries.length, entry);
      this.entries.push(entry);
    } else {
      this.entries[index] = entry;
      if (entry.kind === "assistant" && !entry.streaming && this.streamingAssistants.at(-1) === index) this.streamingAssistants.pop();
    }
  }

  private completedMessage(envelope: RunEvent, message: CompletedMessage): void {
    if (message.role === "assistant") {
      const content = message.content ?? [];
      const index = this.streamingAssistants.at(-1);
      const assistant: Extract<ConversationEntry, { kind: "assistant" }> = {
        id: index === undefined ? envelope.id : this.entries[index]!.id,
        kind: "assistant",
        blocks: assistantBlocks(content),
        ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
        ...(typeof message.errorMessage === "string" ? { errorMessage: message.errorMessage } : {}),
        ...(content.some((part) => part.type === "toolCall") ? { hasToolCalls: true } : {}),
        ...(message.usage ? { usage: message.usage } : {}),
      };
      if (index !== undefined || assistant.blocks.length || assistant.errorMessage || assistant.stopReason) this.put(assistant, index);
      for (const part of content) {
        if (part.type !== "toolCall" || !part.id || !part.name || this.tools.has(part.id)) continue;
        this.put({ id: `${envelope.id}:${part.id}`, kind: "tool", toolCallId: part.id, name: part.name, status: "running", startedAt: envelope.createdAt, arguments: part.arguments });
      }
      return;
    }
    // Saved results complete running parallel tools and enrich already-completed tools with nested-call metadata.
    if (message.role === "toolResult") {
      const index = this.tools.get(message.toolCallId);
      const previous = index === undefined ? undefined : (this.entries[index] as Extract<ConversationEntry, { kind: "tool" }>);
      if (message.nestedCalls || previous?.status === "running") {
        const durationMs = message.durationMs ?? previous?.durationMs;
        const result = { content: message.content, details: message.details, nestedCalls: message.nestedCalls, displayTruncated: message.displayTruncated };
        this.apply({
          ...envelope,
          event: { type: "tool_execution_end", toolCallId: message.toolCallId, toolName: message.toolName, result, isError: message.isError, ...(durationMs === undefined ? {} : { durationMs }) },
        });
      }
      return;
    }
    if (message.role === "compactionSummary") this.put({ id: envelope.id, kind: "summary", summaryType: "compaction", summary: message.summary, tokensBefore: message.tokensBefore });
    else if (message.role === "branchSummary") this.put({ id: envelope.id, kind: "summary", summaryType: "branch", summary: message.summary });
    else if (message.role === "custom" && message.display) this.put({ id: envelope.id, kind: "custom", label: message.customType, blocks: displayBlocks(message.content) });
    else if (message.role === "bashExecution")
      this.put({
        id: envelope.id,
        kind: "bash",
        command: message.command,
        output: message.output,
        ...(message.exitCode !== undefined ? { exitCode: message.exitCode } : {}),
        cancelled: message.cancelled,
        truncated: message.truncated,
      });
  }

  apply(envelope: RunEvent): void {
    const event = envelope.event;
    if (event.type === "issue_user" && typeof event.message === "string") {
      this.put({ id: envelope.id, kind: "user", text: event.message, ...(event.images?.length ? { images: event.images } : {}) });
      return;
    }
    if (event.type === "message_start" && typeof event.message === "object" && event.message?.role === "assistant") {
      this.put({ id: envelope.id, kind: "assistant", blocks: [], streaming: true });
      return;
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (!update || !("delta" in update) || typeof update.delta !== "string" || (update.type !== "text_delta" && update.type !== "thinking_delta")) return;
      const index = this.streamingAssistants.at(-1);
      const current = index === undefined ? { id: envelope.id, kind: "assistant" as const, blocks: [], streaming: true } : (this.entries[index] as Extract<ConversationEntry, { kind: "assistant" }>);
      const blockType = update.type === "thinking_delta" ? ("thinking" as const) : ("text" as const);
      const contentIndex = update.contentIndex ?? 0;
      const blocks = [...current.blocks];
      const blockIndex = blocks.findIndex((block) => block.contentIndex === contentIndex);
      const existing = blockIndex >= 0 ? blocks[blockIndex] : undefined;
      const block = existing && existing.type === blockType ? { ...existing, value: existing.value + update.delta } : { contentIndex, type: blockType, value: update.delta };
      if (blockIndex >= 0) blocks[blockIndex] = block;
      else blocks.push(block);
      blocks.sort((left, right) => left.contentIndex - right.contentIndex);
      this.put({ ...current, blocks }, index);
      return;
    }
    if (event.type === "message_end" && typeof event.message === "object") {
      this.completedMessage(envelope, event.message);
      return;
    }
    if (event.type === "entry_appended") {
      const entry = event.entry;
      if (entry.type === "branch_summary") this.put({ id: entry.id, kind: "summary", summaryType: "branch", summary: entry.summary });
      if (entry.type === "custom_message" && entry.display) this.put({ id: entry.id, kind: "custom", label: entry.customType, blocks: displayBlocks(entry.content) });
    }
    if ((event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") && event.toolCallId && event.toolName) {
      if (event.parentToolCallId && !(event.type === "tool_execution_end" && event.result.queryResult)) return;
      const index = this.tools.get(event.toolCallId);
      const previous = index === undefined ? undefined : (this.entries[index] as Extract<ConversationEntry, { kind: "tool" }>);
      const rawResult = event.type === "tool_execution_update" ? event.partialResult : event.type === "tool_execution_end" ? event.result : previous?.result;
      const result = rawResult
        ? displayToolResult({ ...rawResult, ...(!("nestedCalls" in rawResult) && previous?.result?.nestedCalls ? { nestedCalls: previous.result.nestedCalls } : {}) })
        : undefined;
      this.put(
        {
          id: previous?.id ?? envelope.id,
          kind: "tool",
          toolCallId: event.toolCallId,
          ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
          name: event.toolName,
          status: event.type === "tool_execution_end" ? (event.isError ? "error" : "complete") : "running",
          startedAt: previous?.startedAt ?? envelope.createdAt,
          ...(event.type === "tool_execution_end" && (event.durationMs !== undefined || previous)
            ? { durationMs: event.durationMs ?? Math.max(0, Date.parse(envelope.createdAt) - Date.parse(previous!.startedAt)) }
            : {}),
          ...("args" in event ? { arguments: event.args } : previous?.arguments !== undefined ? { arguments: previous.arguments } : {}),
          ...(result ? { result } : previous?.result ? { result: previous.result } : {}),
        },
        index,
      );
    }
  }
}

export function panelError(error: string): string {
  const messages: Record<string, string> = {
    agent_event_connection_failed: "事件连接中断，正在自动重连",
    agent_event_protocol_error: "收到无法识别的 Agent 事件",
    agent_message_failed: "消息发送失败，请重试",
    invalid_agent_image: "只能粘贴 PNG、JPEG、GIF 或 WebP 图片",
    agent_image_limit_exceeded: "图片数量或大小超过 multipart 限制",
    issue_refresh_failed: "工单状态刷新失败，等待下次连接重试",
  };
  return messages[error] ?? error;
}

export interface AgentActivity {
  text: string;
  tone: "info" | "warning" | "error";
}

export function activityForEvent(event: RunEvent["event"]): AgentActivity | null | undefined {
  if (event.type === "issue_run_state") return event.state === "queued" ? { text: "排队中，等待执行名额…", tone: "info" } : null;
  if (event.type === "agent_start" || event.type === "compaction_end" || event.type === "summarization_retry_finished") return null;
  if (event.type === "compaction_start") return { text: "正在压缩上下文…", tone: "info" };
  if (event.type === "auto_retry_start") return { text: `第 ${event.attempt}/${event.maxAttempts} 次重试，${duration(event.delayMs)}后进行…`, tone: "warning" };
  if (event.type === "auto_retry_end") return event.success ? null : { text: "重试失败", tone: "error" };
  if (event.type === "summarization_retry_scheduled") {
    return { text: `第 ${event.attempt}/${event.maxAttempts} 次重试上下文摘要…`, tone: "warning" };
  }
  if (event.type === "summarization_retry_attempt_start") return { text: "正在重建上下文摘要…", tone: "info" };
  return undefined;
}

function compactPath(value: string, workspaceRoot?: string): string {
  const workspaceRelative = workspaceRoot && (value === workspaceRoot || value.startsWith(workspaceRoot + "/")) ? "~" + value.slice(workspaceRoot.length) : value;
  return workspaceRelative.replace(/^\/home\/[^/]+(?=\/)/, "~");
}

export function toolLabel(entry: Extract<ConversationEntry, { kind: "tool" }>, workspaceRoot?: string): string {
  const input = entry.arguments && typeof entry.arguments === "object" ? (entry.arguments as Record<string, unknown>) : {};
  const value = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  const path = () => compactPath(value("path"), workspaceRoot);
  const name = entry.name;
  if (name === "bash") return `$ ${value("command")}`.trim();
  if (name === "read") {
    const offset = typeof input.offset === "number" ? input.offset : undefined;
    const limit = typeof input.limit === "number" ? input.limit : undefined;
    const start = offset ?? 1;
    const range = offset !== undefined || limit !== undefined ? `:${start}${limit !== undefined ? `-${start + limit - 1}` : ""}` : "";
    return `read ${path()}${range}`.trim();
  }
  if (name === "grep") return `grep /${value("pattern")}/ in ${path() || "."}`;
  if (name === "find") return `find ${value("pattern") || "*"} in ${path() || "."}`;
  if (name === "ls") return `ls ${path() || "."}`;
  if (name === "edit") return `edit ${path()}`.trim();
  if (name === "write") return `write ${path()}`.trim();
  if (name === "service_query") {
    const details = entry.result?.details as { provider?: string; environment?: string; service?: string } | undefined;
    const capability = value("capability") || (details?.provider === "aliyun-dms-mcp" ? "dms" : details?.provider === "aliyun-sls-cli" ? "sls" : "查询");
    return `${capability} ${value("environment") || details?.environment || ""}/${value("service") || details?.service || ""}`.trim();
  }
  const labels: Record<string, string> = { nacos: "config", sls: "logs" };
  return labels[name] ?? name;
}

export function codemodeCalls(entry: Extract<ConversationEntry, { kind: "tool" }>): CodemodeToolDetails["calls"] {
  if (entry.name !== "codemode" || !entry.result?.details || typeof entry.result.details !== "object") return [];
  const calls = (entry.result.details as Partial<CodemodeToolDetails>).calls;
  return Array.isArray(calls) ? calls.filter((call) => call && typeof call.name === "string" && typeof call.status === "string") : [];
}

export function toolNestedCalls(entry: Extract<ConversationEntry, { kind: "tool" }>) {
  return entry.result?.nestedCalls?.calls ?? codemodeCalls(entry);
}

export function duration(value: number | undefined): string {
  if (value === undefined) return "";
  return value < 1_000 ? `${value}ms` : `${(value / 1_000).toFixed(1)}s`;
}

export function resultText(entry: Extract<ConversationEntry, { kind: "tool" }>): string {
  const text =
    entry.result?.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("\n") ?? "";
  return entry.name === "bash" ? text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "") : text;
}

export function assistantNotice(entry: Extract<ConversationEntry, { kind: "assistant" }>): string {
  if (entry.stopReason === "length") return "Response was truncated before completion.";
  if (entry.hasToolCalls) return "";
  if (entry.stopReason === "aborted") return entry.errorMessage && entry.errorMessage !== "Request was aborted" ? entry.errorMessage : "Operation aborted";
  if (entry.stopReason === "error") return `Error: ${entry.errorMessage || "Unknown error"}`;
  return "";
}

export function toolLabelParts(label: string): { action: string; target: string; range: string } {
  if (label.startsWith("$ ")) return { action: "$", target: label.slice(2), range: "" };
  const separator = label.indexOf(" ");
  if (separator < 0) return { action: label, target: "", range: "" };
  const action = label.slice(0, separator);
  const rawTarget = label.slice(separator + 1);
  const range = rawTarget.match(/:\d+(?:-\d+)?$/)?.[0] ?? "";
  return { action, target: range ? rawTarget.slice(0, -range.length) : rawTarget, range };
}

export function diffLineClass(line: string): "added" | "removed" | undefined {
  if (/^\+\s*\d* /.test(line)) return "added";
  if (/^-\s*\d* /.test(line)) return "removed";
  return undefined;
}
