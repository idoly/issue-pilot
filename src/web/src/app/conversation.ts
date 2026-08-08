import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";

import type { RunEvent } from "../data/client";

type ToolResult = { content: Array<TextContent | ImageContent>; details?: unknown };
type DisplayBlock = { type: "text"; value: string } | { type: "image"; data: string; mimeType: string };
type CompletedMessage = Extract<RunEvent["event"], { type: "message_end" }>["message"];

export type ConversationEntry =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; blocks: Array<{ type: "text" | "thinking"; value: string }>; streaming?: boolean; stopReason?: string; errorMessage?: string; hasToolCalls?: boolean; usage?: AssistantMessage["usage"] }
  | { id: string; kind: "tool"; toolCallId: string; name: string; status: "running" | "complete" | "error"; startedAt: string; durationMs?: number; arguments?: unknown; result?: ToolResult }
  | { id: string; kind: "summary"; summaryType: "compaction" | "branch"; summary: string; tokensBefore?: number }
  | { id: string; kind: "custom"; label: string; blocks: DisplayBlock[] }
  | { id: string; kind: "bash"; command: string; output: string; exitCode?: number; cancelled: boolean; truncated: boolean };

type AssistantBlock = { type: "text" | "thinking"; value: string };

function assistantBlocks(content: AssistantMessage["content"] | undefined, fallback = ""): AssistantBlock[] {
  const blocks: AssistantBlock[] = [];
  for (const part of content ?? []) {
    if (part.type === "text") blocks.push({ type: "text", value: part.text });
    else if (part.type === "thinking") blocks.push({ type: "thinking", value: part.thinking });
  }
  return blocks.length ? blocks : fallback ? [{ type: "text", value: fallback }] : [];
}

function streamingAssistantIndex(entries: ConversationEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === "assistant" && entry.streaming) return index;
  }
  return -1;
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

function applyCompletedMessage(entries: ConversationEntry[], envelope: RunEvent, message: CompletedMessage): ConversationEntry[] {
  if (message.role === "assistant") {
    const content = message.content ?? [];
    const index = streamingAssistantIndex(entries);
    const next = [...entries];
    const assistant: ConversationEntry = {
      id: index >= 0 ? next[index]!.id : envelope.id,
      kind: "assistant",
      blocks: assistantBlocks(content),
      ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
      ...(typeof message.errorMessage === "string" ? { errorMessage: message.errorMessage } : {}),
      ...(content.some((part) => part.type === "toolCall") ? { hasToolCalls: true } : {}),
      ...(message.usage ? { usage: message.usage } : {}),
    };
    const completed = assistant as Extract<ConversationEntry, { kind: "assistant" }>;
    if (index >= 0) next[index] = assistant; else if (completed.blocks.length || completed.errorMessage || completed.stopReason) next.push(assistant);
    for (const part of content) {
      if (part.type !== "toolCall" || !part.id || !part.name || next.some((entry) => entry.kind === "tool" && entry.toolCallId === part.id)) continue;
      next.push({ id: `${envelope.id}:${part.id}`, kind: "tool", toolCallId: part.id, name: part.name, status: "running", startedAt: envelope.createdAt, arguments: part.arguments });
    }
    return next;
  }
  if (message.role === "compactionSummary") return [...entries, { id: envelope.id, kind: "summary", summaryType: "compaction", summary: message.summary, tokensBefore: message.tokensBefore }];
  if (message.role === "branchSummary") return [...entries, { id: envelope.id, kind: "summary", summaryType: "branch", summary: message.summary }];
  if (message.role === "custom" && message.display) return [...entries, { id: envelope.id, kind: "custom", label: message.customType, blocks: displayBlocks(message.content) }];
  if (message.role === "bashExecution") return [...entries, { id: envelope.id, kind: "bash", command: message.command, output: message.output, ...(message.exitCode !== undefined ? { exitCode: message.exitCode } : {}), cancelled: message.cancelled, truncated: message.truncated }];
  return entries;
}

export function applyAgentEvent(entries: ConversationEntry[], envelope: RunEvent): ConversationEntry[] {
  const event = envelope.event;
  if (event.type === "issue_user" && typeof event.message === "string") return [...entries, { id: envelope.id, kind: "user", text: event.message }];
  if (event.type === "message_start" && typeof event.message === "object" && event.message?.role === "assistant") {
    return [...entries, { id: envelope.id, kind: "assistant", blocks: [], streaming: true }];
  }
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (!update) return entries;
    const index = streamingAssistantIndex(entries);
    const next = [...entries];
    const current = index >= 0 ? next[index] as Extract<ConversationEntry, { kind: "assistant" }> : { id: envelope.id, kind: "assistant" as const, blocks: [], streaming: true };
    if (!("delta" in update) || typeof update.delta !== "string" || (update.type !== "text_delta" && update.type !== "thinking_delta")) return entries;
    const blockType = update.type === "thinking_delta" ? "thinking" as const : "text" as const;
    const blockIndex = update.contentIndex ?? 0;
    const blocks = [...current.blocks];
    const existing = blocks[blockIndex];
    blocks[blockIndex] = existing && existing.type === blockType ? { ...existing, value: existing.value + update.delta } : { type: blockType, value: update.delta };
    const updated = { ...current, blocks };
    if (index >= 0) next[index] = updated; else next.push(updated);
    return next;
  }
  if (event.type === "message_end" && typeof event.message === "object") return applyCompletedMessage(entries, envelope, event.message);
  if (event.type === "entry_appended") {
    const entry = event.entry;
    if (entry.type === "branch_summary") return [...entries, { id: entry.id, kind: "summary", summaryType: "branch", summary: entry.summary }];
    if (entry.type === "custom_message" && entry.display) return [...entries, { id: entry.id, kind: "custom", label: entry.customType, blocks: displayBlocks(entry.content) }];
  }
  if ((event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") && event.toolCallId && event.toolName) {
    const index = entries.findIndex((entry) => entry.kind === "tool" && entry.toolCallId === event.toolCallId);
    const previous = index >= 0 ? entries[index] as Extract<ConversationEntry, { kind: "tool" }> : undefined;
    const result = event.type === "tool_execution_update" ? event.partialResult : event.type === "tool_execution_end" ? event.result : previous?.result;
    const entry: ConversationEntry = {
      id: previous?.id ?? envelope.id,
      kind: "tool",
      toolCallId: event.toolCallId,
      name: event.toolName,
      status: event.type === "tool_execution_end" ? event.isError ? "error" : "complete" : "running",
      startedAt: previous?.startedAt ?? envelope.createdAt,
      ...(event.type === "tool_execution_end" && previous ? { durationMs: Math.max(0, Date.parse(envelope.createdAt) - Date.parse(previous.startedAt)) } : {}),
      ...("args" in event ? { arguments: event.args } : previous?.arguments !== undefined ? { arguments: previous.arguments } : {}),
      ...(result ? { result } : previous?.result ? { result: previous.result } : {}),
    };
    if (index < 0) return [...entries, entry];
    const next = [...entries]; next[index] = entry; return next;
  }
  return entries;
}

export function panelError(error: string): string {
  const messages: Record<string, string> = {
    agent_event_connection_failed: "事件连接中断，正在自动重连",
    agent_event_protocol_error: "收到无法识别的 Agent 事件",
    agent_message_failed: "消息发送失败，请重试",
    agent_abort_failed: "无法中止当前处理",
  };
  return messages[error] ?? error;
}

export interface AgentActivity {
  text: string;
  tone: "info" | "warning" | "error";
}

export function processingAfterEvent(current: boolean, event: RunEvent["event"]): boolean {
  if (event.type === "agent_start") return true;
  if (event.type === "agent_settled" || event.type === "issue_status") return false;
  return current;
}

export function activityForEvent(event: RunEvent["event"]): AgentActivity | null | undefined {
  if (event.type === "agent_start" || event.type === "compaction_end" || event.type === "summarization_retry_finished") return null;
  if (event.type === "compaction_start") return { text: "Compacting context...", tone: "info" };
  if (event.type === "auto_retry_start") return { text: `Retrying ${event.attempt}/${event.maxAttempts} in ${duration(event.delayMs)}...`, tone: "warning" };
  if (event.type === "auto_retry_end") return event.success ? null : { text: "Retry failed", tone: "error" };
  if (event.type === "summarization_retry_scheduled") {
    return { text: `Retrying context summary ${event.attempt}/${event.maxAttempts}...`, tone: "warning" };
  }
  if (event.type === "summarization_retry_attempt_start") return { text: "Rebuilding context summary...", tone: "info" };
  return undefined;
}

function compactPath(value: string): string {
  const workspaceRelative = value.replace(/^.*\/\.issue-pilot\/workspaces\/[^/]+\/[^/]+(?=\/|$)/, "~");
  return workspaceRelative.replace(/^\/home\/[^/]+(?=\/)/, "~");
}

export function toolLabel(entry: Extract<ConversationEntry, { kind: "tool" }>): string {
  const input = entry.arguments && typeof entry.arguments === "object" ? entry.arguments as Record<string, unknown> : {};
  const value = (key: string) => typeof input[key] === "string" ? input[key] as string : "";
  const path = () => compactPath(value("path"));
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
  const labels: Record<string, string> = { playwright: "browser", nacos: "config", sls: "logs" };
  return labels[name] ?? name;
}

export function duration(value: number | undefined): string {
  if (value === undefined) return "";
  return value < 1_000 ? `${value}ms` : `${(value / 1_000).toFixed(1)}s`;
}

export function resultText(entry: Extract<ConversationEntry, { kind: "tool" }>): string {
  return entry.result?.content.filter((part): part is TextContent => part.type === "text").map((part) => part.text).join("\n") ?? "";
}

export function shellToolOutput(entry: Extract<ConversationEntry, { kind: "tool" }>): { lines: string[]; omitted: number } | undefined {
  if (entry.name !== "bash") return undefined;
  const output = resultText(entry).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").split("\n");
  while (output.length && !output[output.length - 1]?.trim()) output.pop();
  const limit = 5;
  return { lines: output.slice(-limit), omitted: Math.max(0, output.length - limit) };
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
