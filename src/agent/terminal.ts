import {
  AssistantMessageComponent,
  initTheme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { RunEvent } from "./events.ts";

const MIN_COLUMNS = 40;
const MAX_COLUMNS = 240;
const terminalUi = { requestRender() {} };

initTheme("dark");

export interface TerminalFrame {
  ansi: string;
  text: string;
  lines: number;
  toolCallId?: string;
  replaceTool?: boolean;
}

export interface TerminalFooter {
  ansi: string;
  text: string;
  lines: number;
}

export interface TerminalFooterMetadata {
  workspace: string;
  provider: string;
  model: string;
  thinkingLevel: string;
}

export function terminalColumns(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed >= MIN_COLUMNS && parsed <= MAX_COLUMNS ? parsed : 100;
}

function safeTerminalText(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return value.replace(/\r?\n/g, "\\n");
  if (value === undefined) return "";
  return JSON.stringify(value);
}

export function formatToolOutput(toolName: string, output: string): string {
  if (toolName !== "db") return output;
  let result: Record<string, unknown>;
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return output;
    result = parsed as Record<string, unknown>;
  } catch {
    return output;
  }
  if (result.provider !== "mysql" || !result.connection || typeof result.connection !== "object" || Array.isArray(result.connection)) return output;

  const connection = result.connection as Record<string, unknown>;
  const lines = ["Database connection", `Type: ${displayValue(result.provider)}`];
  if (typeof connection.url === "string") {
    try {
      const url = new URL(connection.url);
      lines.push(`Address: ${url.protocol}//${url.host}${url.pathname}`);
      if (url.searchParams.size) {
        lines.push("Connection parameters:");
        for (const [key, value] of url.searchParams) lines.push(`  ${key}: ${value}`);
      }
    } catch {
      lines.push(`URL: ${connection.url}`);
    }
  }
  for (const [key, value] of Object.entries(connection)) {
    if (key !== "url") lines.push(`${key}: ${displayValue(value)}`);
  }

  const columns = Array.isArray(result.columns) && result.columns.every((column) => typeof column === "string") ? result.columns as string[] : [];
  const rows = Array.isArray(result.rows) ? result.rows : [];
  lines.push("", `Query result (${rows.length} rows)`);
  if (columns.length) {
    lines.push(columns.join(" | "), columns.map(() => "---").join(" | "));
    for (const row of rows) {
      const record = row && typeof row === "object" && !Array.isArray(row) ? row as Record<string, unknown> : {};
      lines.push(columns.map((column) => displayValue(record[column]).replace(/\|/g, "\\|")).join(" | "));
    }
  } else {
    lines.push(displayValue(rows));
  }

  lines.push("", "Execution");
  for (const [key, value] of Object.entries(result)) {
    if (key !== "provider" && key !== "connection" && key !== "columns" && key !== "rows") lines.push(`${key}: ${displayValue(value)}`);
  }
  return lines.join("\n");
}

function assistantMessage(text: string) {
  return {
    role: "assistant" as const,
    api: "openai-responses" as const,
    provider: "managed",
    model: "managed",
    content: [{ type: "text" as const, text }],
    stopReason: "stop" as const,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(),
  };
}

function json(value: unknown): string {
  try { return JSON.stringify(value, null, 2); } catch { return "[unserializable]"; }
}

function resultText(event: RunEvent): string {
  const output = (event.result?.content ?? []).map((content) => content.type === "text"
    ? content.text ?? ""
    : content.type === "image"
      ? `[image: ${content.mimeType ?? "unknown"}]`
      : `[${content.type} content]`).filter(Boolean).join("\n");
  return formatToolOutput(event.toolName ?? "", output || "(no output)");
}

function accessibleText(event: RunEvent): string {
  if (event.kind === "user") return `User: ${safeTerminalText(event.message ?? "")}`;
  if (event.kind === "assistant") return `Agent: ${safeTerminalText(event.message ?? "")}`;
  if (event.kind === "tool_call") return `Tool ${event.toolName}, pending\nArguments:\n${json(event.arguments)}`;
  if (event.kind === "tool_result") return `Tool ${event.toolName}, ${event.isError ? "failed" : "completed"}\nResult:\n${resultText(event)}`;
  return "";
}

function componentLines(event: RunEvent, columns: number, cwd: string): { lines: string[]; text: string; toolCallId?: string; replaceTool?: boolean } {
  if (event.kind === "user") return { lines: new UserMessageComponent(safeTerminalText(event.message ?? "")).render(columns), text: accessibleText(event) };
  if (event.kind === "assistant") return { lines: new AssistantMessageComponent(assistantMessage(safeTerminalText(event.message ?? ""))).render(columns), text: accessibleText(event) };
  if ((event.kind === "tool_call" || event.kind === "tool_result") && event.toolName && event.toolCallId) {
    if (event.toolName === "complete_issue") return { lines: [], text: "" };
    const component = new ToolExecutionComponent(event.toolName, event.toolCallId, event.arguments ?? {}, { showImages: false }, undefined, terminalUi as never, cwd);
    component.setExpanded(true);
    component.markExecutionStarted();
    if (event.kind === "tool_result") {
      component.setArgsComplete();
      component.updateResult({ content: [{ type: "text", text: resultText(event) }], details: event.result?.details, isError: event.isError ?? false });
    }
    return { lines: component.render(columns), text: accessibleText(event), toolCallId: event.toolCallId, replaceTool: event.kind === "tool_result" };
  }
  return { lines: [], text: "" };
}

export function renderTerminalEvent(event: RunEvent, columnsValue: unknown, cwd: string): TerminalFrame {
  const columns = terminalColumns(columnsValue);
  const rendered = componentLines(event, columns, cwd);
  return {
    ansi: rendered.lines.join("\r\n"),
    text: rendered.text,
    lines: rendered.lines.length,
    ...(rendered.toolCallId ? { toolCallId: rendered.toolCallId } : {}),
    ...(rendered.replaceTool ? { replaceTool: true } : {}),
  };
}

export function renderTerminalFooter(metadata: TerminalFooterMetadata, columnsValue: unknown): TerminalFooter {
  const columns = terminalColumns(columnsValue);
  const dim = (text: string) => `\x1b[38;2;128;128;128m${text}\x1b[39m`;
  const safe = (text: string) => text.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  const workspace = truncateToWidth(safe(metadata.workspace), columns, "...");
  const model = `model ${safe(metadata.provider)}/${safe(metadata.model)} | thinking ${safe(metadata.thinkingLevel)}`;
  const combinedWidth = visibleWidth(workspace) + 2 + visibleWidth(model);
  const lines = combinedWidth <= columns
    ? [dim(`${workspace}${" ".repeat(columns - visibleWidth(workspace) - visibleWidth(model))}${model}`)]
    : [dim(truncateToWidth(workspace, columns, "...")), dim(truncateToWidth(model, columns, "..."))];
  return { ansi: lines.join("\r\n"), text: `${workspace} ${model}`, lines: lines.length };
}
