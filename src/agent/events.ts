import type { JsonAgentSessionEvent, SessionManager } from "@earendil-works/pi-coding-agent";

export type AgentWireEvent = JsonAgentSessionEvent
  | { type: "issue_user"; message: string }
  | { type: "issue_status"; status: "complete" | "error" };

export interface RunEvent {
  id: string;
  issueId: string;
  createdAt: string;
  event: AgentWireEvent;
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
      if (typeof data?.message === "string") events.push({ id: entry.id, issueId, createdAt, event: { type: "issue_user", message: data.message } });
      continue;
    }
    if (entry.type !== "message") continue;
    if (entry.message.role === "assistant") {
      events.push({ id: entry.id, issueId, createdAt, event: { type: "message_end", message: entry.message } });
    } else if (entry.message.role === "toolResult") {
      events.push({
        id: entry.id,
        issueId,
        createdAt,
        event: {
          type: "tool_execution_end",
          toolCallId: entry.message.toolCallId,
          toolName: entry.message.toolName,
          result: { content: entry.message.content, details: entry.message.details },
          isError: entry.message.isError,
        },
      });
    }
  }
  return events;
}
