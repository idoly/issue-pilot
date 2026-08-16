import { sessionEntryToContextMessages, type JsonAgentSessionEvent, type SessionManager } from "@earendil-works/pi-coding-agent";

type AgentWireEvent = JsonAgentSessionEvent
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
  private readonly onListenerError: (error: unknown) => void;

  constructor(onListenerError: (error: unknown) => void = () => undefined) {
    this.onListenerError = onListenerError;
  }

  publish(event: RunEvent): void {
    const issueListeners = this.listeners.get(event.issueId);
    if (!issueListeners) return;
    for (const listener of [...issueListeners]) if (!this.deliver(listener, event)) issueListeners.delete(listener);
    if (!issueListeners.size) this.listeners.delete(event.issueId);
  }

  deliver(listener: RunEventListener, event: RunEvent): boolean {
    try {
      listener(event);
      return true;
    } catch (error) {
      try { this.onListenerError(error); } catch {
        // Event observers cannot affect Agent execution or other observers.
      }
      return false;
    }
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

// Buffer events between the replay snapshot and live activation so SSE preserves one ordered stream.
export function subscribeBufferedAgentEvents(bus: AgentEventBus, issueId: string) {
  let pending: RunEvent[] = [];
  let sink: RunEventListener | undefined;
  const unsubscribe = bus.subscribe(issueId, (event) => sink ? sink(event) : pending.push(event));
  return {
    activate(nextSink: RunEventListener): void {
      if (sink) throw new Error("agent_event_subscription_already_active");
      sink = nextSink;
      const buffered = pending;
      pending = [];
      for (const event of buffered) {
        if (bus.deliver(nextSink, event)) continue;
        unsubscribe();
        break;
      }
    },
    unsubscribe,
  };
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
        const customData = entry.data as { message?: unknown } | undefined;
        if (typeof customData?.message === "string") events.push({ id: entry.id, issueId, createdAt, event: { type: "issue_user", message: customData.message } });
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
