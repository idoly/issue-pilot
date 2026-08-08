import { sessionEntryToContextMessages, type JsonAgentSessionEvent, type SessionManager } from "@earendil-works/pi-coding-agent";

export type AgentWireEvent = JsonAgentSessionEvent
  | { type: "issue_user"; message: string }
  | { type: "issue_status"; status: "complete" | "error" };

export interface RunEvent {
  id: string;
  issueId: string;
  createdAt: string;
  event: AgentWireEvent;
}

type RunEventListener = (event: RunEvent) => void;

export class AgentEventBus {
  private readonly listeners = new Map<string, Set<RunEventListener>>();

  publish(event: RunEvent): void {
    for (const listener of [...(this.listeners.get(event.issueId) ?? [])]) listener(event);
  }

  subscribe(issueId: string, listener: RunEventListener): () => void {
    const issueListeners = this.listeners.get(issueId) ?? new Set<RunEventListener>();
    issueListeners.add(listener);
    this.listeners.set(issueId, issueListeners);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      issueListeners.delete(listener);
      if (!issueListeners.size) this.listeners.delete(issueId);
    };
  }
}

function timestamp(value: string | undefined): string {
  return value && !Number.isNaN(Date.parse(value)) ? value : new Date().toISOString();
}

export function sessionTranscript(manager: SessionManager, issueId: string): RunEvent[] {
  const events: RunEvent[] = [];
  for (const entry of manager.buildContextEntries()) {
    const createdAt = timestamp(entry.timestamp);
    if (entry.type === "custom") {
      if (entry.customType === "issue-pilot-user") {
        const data = entry.data as { message?: unknown } | undefined;
        if (typeof data?.message === "string") events.push({ id: entry.id, issueId, createdAt, event: { type: "issue_user", message: data.message } });
      }
      continue;
    }
    const messages = sessionEntryToContextMessages(entry);
    for (const [index, message] of messages.entries()) {
      if (message.role === "user") continue;
      const id = messages.length === 1 ? entry.id : `${entry.id}:${index}`;
      if (message.role === "toolResult") {
        events.push({
          id,
          issueId,
          createdAt,
          event: {
            type: "tool_execution_end",
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            result: { content: message.content, details: message.details },
            isError: message.isError,
          },
        });
      } else {
        events.push({ id, issueId, createdAt, event: { type: "message_end", message } });
      }
    }
  }
  return events;
}
