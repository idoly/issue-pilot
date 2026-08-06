import type { SessionManager } from "@earendil-works/pi-coding-agent";

export interface RunEvent {
  id: string;
  issueId: string;
  kind: "user" | "assistant" | "tool_call" | "tool_result" | "status";
  createdAt: string;
  message?: string;
  toolCallId?: string;
  toolName?: string;
  arguments?: unknown;
  result?: {
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    details?: unknown;
  };
  isError?: boolean;
  status?: "running" | "complete" | "error";
}

function timestamp(value: string | undefined): string {
  return value && !Number.isNaN(Date.parse(value)) ? value : new Date().toISOString();
}

export function sessionTranscript(manager: SessionManager, issueId: string): RunEvent[] {
  const events: RunEvent[] = [];
  for (const entry of manager.getBranch()) {
    const createdAt = timestamp(entry.timestamp);
    if (entry.type === "custom" && entry.customType === "issue-pilot-user") {
      const data = entry.data as { message?: unknown } | undefined;
      if (typeof data?.message === "string") events.push({ id: entry.id, issueId, kind: "user", message: data.message, createdAt });
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant") {
      const text = message.content.flatMap((content) => content.type === "text" ? [content.text] : []).join("\n").trim();
      if (text) events.push({ id: `${entry.id}:text`, issueId, kind: "assistant", message: text, createdAt });
      message.content.forEach((content, index) => {
        if (content.type === "toolCall" && content.name !== "complete_issue") {
          events.push({ id: `${entry.id}:tool:${index}`, issueId, kind: "tool_call", toolCallId: content.id, toolName: content.name, arguments: content.arguments, createdAt });
        }
      });
    } else if (message.role === "toolResult" && message.toolName !== "complete_issue") {
      events.push({
        id: entry.id,
        issueId,
        kind: "tool_result",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        result: { content: message.content, details: message.details },
        isError: message.isError,
        createdAt,
      });
    }
  }
  return events;
}
