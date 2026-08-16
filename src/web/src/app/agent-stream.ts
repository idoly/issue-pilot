import type { AgentFooterStats, IssueStatus, RunEvent } from "../data/client";
import { activityForEvent, applyAgentEvent, type AgentActivity, type ConversationEntry } from "./conversation";

interface AgentStreamSnapshot {
  agent?: { provider: string; model: string; thinkingLevel: string };
  footer?: AgentFooterStats;
  running?: boolean;
  issueStatus?: IssueStatus;
}

interface AgentStreamReplay {
  entries: ConversationEntry[];
  activity: AgentActivity | null;
  queue: { steering: string[]; followUp: string[] };
}

interface AgentStreamCallbacks {
  onConnection(connected: boolean): void;
  onError(error: "" | "agent_event_connection_failed" | "agent_event_protocol_error"): void;
  onSnapshot(snapshot: AgentStreamSnapshot, replay: AgentStreamReplay): void;
  onEvent(event: RunEvent, generation: number): void;
}

type EventSourceFactory = (url: string) => EventSource;

export class AgentStreamController {
  private stream: EventSource | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private issueId = "";
  private disposed = false;

  constructor(
    private readonly streamUrl: (issueId: string) => string,
    private readonly reconnectMs: number,
    private readonly callbacks: AgentStreamCallbacks,
    private readonly createEventSource: EventSourceFactory = (url) => new EventSource(url),
  ) {}

  connect(issueId: string): void {
    if (this.disposed) return;
    this.issueId = issueId;
    const generation = ++this.generation;
    this.closeStream();
    this.clearReconnectTimer();
    this.callbacks.onConnection(false);

    let replayComplete = false;
    let replayEntries: ConversationEntry[] = [];
    let replayActivity: AgentActivity | null = null;
    let replayQueue = { steering: [] as string[], followUp: [] as string[] };
    const source = this.createEventSource(this.streamUrl(issueId));
    this.stream = source;

    source.addEventListener("open", () => {
      if (!this.isCurrent(generation)) return;
      this.callbacks.onConnection(true);
      this.callbacks.onError("");
    });
    source.addEventListener("snapshot_ready", (event) => {
      if (!this.isCurrent(generation)) return;
      try {
        const parsed = JSON.parse(event.data) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("agent_event_protocol_error");
        this.callbacks.onSnapshot(parsed as AgentStreamSnapshot, { entries: replayEntries, activity: replayActivity, queue: replayQueue });
        replayComplete = true;
      } catch {
        this.callbacks.onError("agent_event_protocol_error");
      }
    });
    source.addEventListener("message", (event) => {
      if (!this.isCurrent(generation)) return;
      try {
        const parsed = JSON.parse(event.data) as Partial<RunEvent>;
        if (!parsed.event || typeof parsed.event.type !== "string") throw new Error("agent_event_protocol_error");
        const envelope = parsed as RunEvent;
        if (!replayComplete) {
          replayEntries = applyAgentEvent(replayEntries, envelope);
          const nextActivity = activityForEvent(envelope.event);
          if (nextActivity !== undefined) replayActivity = nextActivity;
          if (envelope.event.type === "queue_update") replayQueue = { steering: [...envelope.event.steering], followUp: [...envelope.event.followUp] };
          return;
        }
        this.callbacks.onEvent(envelope, generation);
        if (envelope.event.type === "compaction_end" && !envelope.event.aborted && !envelope.event.willRetry) {
          queueMicrotask(() => { if (this.isCurrent(generation)) this.connect(issueId); });
        }
      } catch {
        this.callbacks.onError("agent_event_protocol_error");
      }
    });
    source.addEventListener("error", () => {
      if (!this.isCurrent(generation)) return;
      this.generation += 1;
      this.closeStream(source);
      this.callbacks.onConnection(false);
      this.callbacks.onError("agent_event_connection_failed");
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        if (!this.disposed && this.issueId === issueId) this.connect(issueId);
      }, this.reconnectMs);
    });
  }

  isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.closeStream();
    this.clearReconnectTimer();
  }

  private closeStream(target = this.stream): void {
    if (!target) return;
    if (this.stream === target) this.stream = undefined;
    target.close();
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }
}
