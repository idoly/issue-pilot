import type { ImageContent, NestedToolCalls } from "@earendil-works/pi-ai";
import type { AgentRunState } from "../domain/contracts.ts";
import { sessionEntryToContextMessages, type JsonAgentSessionEvent, type SessionManager } from "@earendil-works/pi-coding-agent";
import { agentDisplayEvent } from "./event-display.ts";

type ToolCompletionEvent = Extract<JsonAgentSessionEvent, { type: "tool_execution_end" }>;
type ToolUpdateEvent = Extract<JsonAgentSessionEvent, { type: "tool_execution_update" }>;
type MessageEndEvent = Extract<JsonAgentSessionEvent, { type: "message_end" }>;
// Replay carries persisted nested calls; HTTP display projections may bound result text.
type AgentWireEvent =
  | Exclude<JsonAgentSessionEvent, ToolCompletionEvent | ToolUpdateEvent | MessageEndEvent>
  | (MessageEndEvent & { message: MessageEndEvent["message"] & { displayTruncated?: boolean } })
  | (ToolCompletionEvent & { result: ToolCompletionEvent["result"] & { nestedCalls?: NestedToolCalls; displayTruncated?: boolean } })
  | (ToolUpdateEvent & { partialResult: ToolUpdateEvent["partialResult"] & { displayTruncated?: boolean } })
  | { type: "session_reset" }
  | { type: "issue_run_state"; state: AgentRunState }
  | { type: "issue_user"; message: string; images?: ImageContent[] }
  | { type: "issue_status"; status: "complete" | "error" | "cancelled" };

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
      try {
        this.onListenerError(error);
      } catch {
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
    if (event.type === "issue_status" || event.type === "session_reset") {
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
      this.replay.set(
        envelope.issueId,
        current.filter(({ event }) => event.type !== "message_start" && event.type !== "message_update"),
      );
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
      this.replay.set(
        envelope.issueId,
        current.filter(({ event }) => !("toolCallId" in event) || event.toolCallId !== toolCallId),
      );
      return;
    }
    if (event.type === "queue_update") {
      this.replay.set(envelope.issueId, [...current.filter(({ event }) => event.type !== "queue_update"), envelope]);
    }
  }
}

// Buffer display events between replay and live activation; raw model results stay with the event bus.
export function subscribeBufferedAgentDisplayEvents(bus: AgentEventBus, issueId: string, budget?: { maxPendingBytes: number; onFailure: (error: unknown) => void }) {
  let pending: Array<{ event: RunEvent; bytes: number }> = [];
  let pendingBytes = 0;
  let closed = false;
  let sink: RunEventListener | undefined;
  const unsubscribe = () => {
    closed = true;
    pending = [];
    pendingBytes = 0;
    stop();
  };
  const fail = (error: unknown) => {
    if (closed) return;
    unsubscribe();
    if (budget) budget.onFailure(error);
    else throw error;
  };
  const buffer = (event: RunEvent) => {
    if (closed) return;
    let bytes = 0;
    if (budget) {
      try {
        bytes = Buffer.byteLength(JSON.stringify(event));
        pendingBytes += bytes;
        if (pendingBytes > budget.maxPendingBytes) throw new Error("sse_queue_budget_exceeded");
      } catch (error) {
        fail(error);
        return;
      }
    }
    pending.push({ event, bytes });
  };
  const stop = bus.subscribe(issueId, (event) => {
    if (closed) return;
    let displayed: RunEvent;
    try {
      displayed = agentDisplayEvent(event);
    } catch (error) {
      fail(error);
      return;
    }
    if (sink) sink(displayed);
    else buffer(displayed);
  });
  return {
    activate(nextSink: RunEventListener): void {
      if (sink) throw new Error("agent_event_subscription_already_active");
      if (closed) return;
      // Keep events published during replay behind the existing backlog.
      sink = buffer;
      for (const { event, bytes } of pending) {
        if (closed) break;
        pendingBytes -= bytes;
        if (bus.deliver(nextSink, event)) continue;
        unsubscribe();
        break;
      }
      pending = [];
      pendingBytes = 0;
      if (!closed) sink = nextSink;
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
          const images = Array.isArray(customData.images)
            ? customData.images.filter((image): image is ImageContent =>
                Boolean(
                  image &&
                    typeof image === "object" &&
                    (image as { type?: unknown }).type === "image" &&
                    typeof (image as { data?: unknown }).data === "string" &&
                    typeof (image as { mimeType?: unknown }).mimeType === "string",
                ),
              )
            : [];
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
        const result = { content: message.content, details: message.details, ...(message.nestedCalls ? { nestedCalls: message.nestedCalls } : {}) };
        events.push({
          id,
          issueId,
          createdAt,
          event: {
            type: "tool_execution_end",
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            result,
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
