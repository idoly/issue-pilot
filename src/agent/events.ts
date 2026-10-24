import type { ImageContent } from "@earendil-works/pi-ai";
import { sessionEntryToContextMessages, type JsonAgentSessionEvent, type SessionManager } from "@earendil-works/pi-coding-agent";

type AgentWireEvent = JsonAgentSessionEvent
  | { type: "issue_user"; message: string; images?: ImageContent[] }
  | { type: "issue_status"; status: "complete" | "error" };

export interface RunEvent {
  id: string;
  issueId: string;
  createdAt: string;
  event: AgentWireEvent;
}

type RunEventListener = (event: RunEvent) => void;
type MessageUpdateEvent = Extract<AgentWireEvent, { type: "message_update" }>;

function mergeMessageUpdates(previous: RunEvent, next: RunEvent): RunEvent | undefined {
  if (previous.event.type !== "message_update" || next.event.type !== "message_update") return undefined;
  const previousUpdate = previous.event.assistantMessageEvent;
  const nextUpdate = next.event.assistantMessageEvent;
  if (!("delta" in previousUpdate) || !("delta" in nextUpdate) || typeof previousUpdate.delta !== "string" || typeof nextUpdate.delta !== "string") return undefined;
  if (previousUpdate.type !== nextUpdate.type || previousUpdate.contentIndex !== nextUpdate.contentIndex) return undefined;
  return {
    ...next,
    event: {
      ...next.event,
      assistantMessageEvent: { ...nextUpdate, delta: previousUpdate.delta + nextUpdate.delta },
    } as MessageUpdateEvent,
  };
}

export class AgentEventBus {
  private readonly listeners = new Map<string, Set<RunEventListener>>();
  private readonly replay = new Map<string, RunEvent[]>();
  private readonly onListenerError: (error: unknown) => void;

  constructor(onListenerError: (error: unknown) => void = () => undefined) {
    this.onListenerError = onListenerError;
  }

  publish(event: RunEvent): void {
    this.updateReplay(event);
    const issueListeners = this.listeners.get(event.issueId);
    if (!issueListeners) return;
    for (const listener of [...issueListeners]) if (!this.deliver(listener, event)) issueListeners.delete(listener);
    if (!issueListeners.size && this.listeners.get(event.issueId) === issueListeners) this.listeners.delete(event.issueId);
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

  replayCurrent(issueId: string): RunEvent[] {
    return [...(this.replay.get(issueId) ?? [])];
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
      if (!issueListeners.size && this.listeners.get(issueId) === issueListeners) this.listeners.delete(issueId);
    };
  }

  private updateReplay(envelope: RunEvent): void {
    const event = envelope.event;
    if (event.type === "issue_status") {
      this.replay.delete(envelope.issueId);
      return;
    }
    if (event.type === "agent_start") {
      this.replay.set(envelope.issueId, [envelope]);
      return;
    }
    const current = this.replay.get(envelope.issueId);
    if (!current) return;
    if (event.type === "message_start") {
      this.replay.set(envelope.issueId, [...current.filter(({ event }) => event.type !== "message_start" && event.type !== "message_update"), envelope]);
      return;
    }
    if (event.type === "message_update") {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        const merged = mergeMessageUpdates(current[index]!, envelope);
        if (!merged) continue;
        current[index] = merged;
        return;
      }
      current.push(envelope);
      return;
    }
    if (event.type === "message_end") {
      this.replay.set(envelope.issueId, current.filter(({ event }) => event.type !== "message_start" && event.type !== "message_update"));
      return;
    }
    if (event.type === "tool_execution_start") {
      const toolCallId = event.toolCallId;
      this.replay.set(envelope.issueId, [...current.filter(({ event }) => !("toolCallId" in event) || event.toolCallId !== toolCallId), envelope]);
      return;
    }
    if (event.type === "tool_execution_update") {
      const toolCallId = event.toolCallId;
      this.replay.set(envelope.issueId, [...current.filter(({ event }) => event.type !== "tool_execution_update" || event.toolCallId !== toolCallId), envelope]);
      return;
    }
    if (event.type === "tool_execution_end") {
      const toolCallId = event.toolCallId;
      this.replay.set(envelope.issueId, current.filter(({ event }) => !("toolCallId" in event) || event.toolCallId !== toolCallId));
      return;
    }
    if (event.type === "queue_update") {
      this.replay.set(envelope.issueId, [...current.filter(({ event }) => event.type !== "queue_update"), envelope]);
    }
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
      // Keep events published during replay behind the existing backlog.
      sink = (event) => { pending.push(event); };
      for (const event of pending) {
        if (bus.deliver(nextSink, event)) continue;
        unsubscribe();
        break;
      }
      pending = [];
      sink = nextSink;
    },
    unsubscribe,
  };
}

function timestamp(value: string | undefined): string {
  return value && !Number.isNaN(Date.parse(value)) ? value : new Date().toISOString();
}

export function sessionTranscript(manager: SessionManager, issueId: string): RunEvent[] {
  const events: RunEvent[] = [];
  for (const entry of manager.getBranch()) {
    const createdAt = timestamp(entry.timestamp);
    if (entry.type === "custom") {
      if (entry.customType === "issue-pilot-user") {
        const customData = entry.data as { message?: unknown; images?: unknown } | undefined;
        if (typeof customData?.message === "string") {
          const images = Array.isArray(customData.images) ? customData.images.filter((image): image is ImageContent => Boolean(image && typeof image === "object" && (image as { type?: unknown }).type === "image" && typeof (image as { data?: unknown }).data === "string" && typeof (image as { mimeType?: unknown }).mimeType === "string")) : [];
          events.push({ id: entry.id, issueId, createdAt, event: { type: "issue_user", message: customData.message, ...(images.length ? { images } : {}) } });
        }
      }
      continue;
    }
    const messages = sessionEntryToContextMessages(entry);
    for (const [index, message] of messages.entries()) {
      if (message.role === "user" || message.role === "system") continue;
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
            ...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
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
