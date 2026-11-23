import { AGENT_RUN_STATES, ISSUE_STATUSES, type AgentCostSource, type AgentRunState, type AgentFooterStats, type IssueStatus, type RunEvent } from "../data/client";
import { activityForEvent, ConversationProjection, type AgentActivity, type ConversationEntry } from "./conversation";

interface AgentStreamSnapshot {
  agent: { provider: string; model: string; thinkingLevel: string };
  footer: AgentFooterStats;
  runState: AgentRunState;
  issueStatus: IssueStatus;
  issueRevision: string;
}

const costSources: Record<AgentCostSource, true> = { provider: true, estimated: true, unknown: true, mixed: true };
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isNumber = (value: unknown) => typeof value === "number";

/** The snapshot replaces the whole projection, so every field is required; anything else is a protocol error. */
function parseSnapshot(data: string): AgentStreamSnapshot {
  const value = JSON.parse(data) as unknown;
  if (!isRecord(value)) throw new Error("agent_event_protocol_error");
  const { agent, footer, runState, issueStatus, issueRevision } = value;
  if (!isRecord(agent) || ![agent.provider, agent.model, agent.thinkingLevel].every((field) => typeof field === "string")) throw new Error("agent_event_protocol_error");
  if (
    !isRecord(footer) ||
    ![footer.input, footer.output, footer.cacheRead, footer.cacheWrite, footer.cost, footer.contextWindow].every(isNumber) ||
    ![footer.latestCacheHitRate, footer.contextPercent].every((field) => field === null || isNumber(field)) ||
    typeof footer.autoCompact !== "boolean" ||
    !(footer.costSource === null || (typeof footer.costSource === "string" && Object.hasOwn(costSources, footer.costSource)))
  )
    throw new Error("agent_event_protocol_error");
  if (!AGENT_RUN_STATES.includes(runState as AgentRunState) || !ISSUE_STATUSES.includes(issueStatus as IssueStatus) || typeof issueRevision !== "string") throw new Error("agent_event_protocol_error");
  return value as unknown as AgentStreamSnapshot;
}

interface AgentStreamReplay {
  entries: ConversationEntry[];
  activity: AgentActivity | null;
  queue: { steering: string[]; followUp: string[] };
  agentStarted: boolean;
}

interface AgentStreamCallbacks {
  // A connection is usable only after its validated replay has been applied.
  onConnection(connected: boolean): void;
  onError(error: "" | "agent_event_connection_failed" | "agent_event_protocol_error"): void;
  onSnapshot(snapshot: AgentStreamSnapshot, replay: AgentStreamReplay, generation: number): void;
  onEvent(event: RunEvent, generation: number): void;
}

type EventSourceFactory = (url: string) => EventSource;

/** Upper bound for the reconnect delay; consecutive failures double the configured base up to this cap. */
const maxReconnectMs = 30_000;

/** Exponential backoff with jitter in [ceiling / 2, ceiling], so the first retry never exceeds the configured base. */
export function reconnectDelay(baseMs: number, failures: number, random: () => number = Math.random): number {
  const ceiling = Math.min(Math.max(baseMs, maxReconnectMs), baseMs * 2 ** Math.min(failures, 30));
  return Math.round(ceiling / 2 + (ceiling / 2) * random());
}

export class AgentStreamController {
  private stream: EventSource | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private staleTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private issueId = "";
  private disposed = false;
  private visible = true;
  // Consecutive failures for this Issue since its last accepted snapshot; reconnects keep it, snapshot_ready or another Issue resets it.
  private failures = 0;

  constructor(
    private readonly streamUrl: (issueId: string) => string,
    private readonly reconnectMs: number,
    private readonly staleMs: number,
    private readonly callbacks: AgentStreamCallbacks,
    private readonly createEventSource: EventSourceFactory = (url) => new EventSource(url),
    private readonly random: () => number = Math.random,
  ) {}

  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    if (this.issueId) this.connect(this.issueId);
  }

  connect(issueId: string): void {
    if (this.disposed) return;
    if (this.issueId !== issueId) this.failures = 0;
    this.issueId = issueId;
    const generation = ++this.generation;
    this.closeStream();
    this.clearReconnectTimer();
    this.clearStaleTimer();
    this.callbacks.onConnection(false);
    // Hidden tabs must not occupy the origin's limited HTTP/1 connections, including during backoff.
    if (!this.visible) return;

    let replayComplete = false;
    const replay = new ConversationProjection();
    let replayActivity: AgentActivity | null = null;
    let replayQueue = { steering: [] as string[], followUp: [] as string[] };
    let replayAgentStarted = false;
    const source = this.createEventSource(this.streamUrl(issueId));
    this.stream = source;
    const recover = (reason: "agent_event_connection_failed" | "agent_event_protocol_error" = "agent_event_connection_failed") => {
      if (!this.isCurrent(generation)) return;
      this.generation += 1;
      this.clearStaleTimer();
      this.closeStream(source);
      this.callbacks.onConnection(false);
      this.callbacks.onError(reason);
      const delay = reconnectDelay(this.reconnectMs, this.failures, this.random);
      this.failures += 1;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        if (!this.disposed && this.issueId === issueId) this.connect(issueId);
      }, delay);
    };
    const touch = () => {
      this.clearStaleTimer();
      this.staleTimer = setTimeout(recover, this.staleMs);
    };
    touch();

    source.addEventListener("open", () => {
      if (!this.isCurrent(generation)) return;
      touch();
    });
    source.addEventListener("heartbeat", () => {
      if (this.isCurrent(generation)) touch();
    });
    source.addEventListener("snapshot_ready", (event) => {
      if (!this.isCurrent(generation)) return;
      touch();
      try {
        const snapshot = parseSnapshot(event.data);
        this.callbacks.onSnapshot(snapshot, { entries: replay.snapshot(), activity: replayActivity, queue: replayQueue, agentStarted: replayAgentStarted }, generation);
        replayComplete = true;
        this.failures = 0;
        this.callbacks.onConnection(true);
        this.callbacks.onError("");
      } catch {
        // Without a trustworthy snapshot the stream cannot deliver live events; reconnect for a fresh replay.
        recover("agent_event_protocol_error");
      }
    });
    source.addEventListener("message", (event) => {
      if (!this.isCurrent(generation)) return;
      touch();
      try {
        const parsed = JSON.parse(event.data) as Partial<RunEvent>;
        if (!parsed.event || typeof parsed.event.type !== "string") throw new Error("agent_event_protocol_error");
        const envelope = parsed as RunEvent;
        if (envelope.event.type === "issue_run_state" && !AGENT_RUN_STATES.includes(envelope.event.state)) throw new Error("agent_event_protocol_error");
        if (envelope.event.type === "session_reset") {
          queueMicrotask(() => {
            if (this.isCurrent(generation)) this.connect(issueId);
          });
          return;
        }
        if (!replayComplete) {
          replay.apply(envelope);
          const nextActivity = activityForEvent(envelope.event);
          if (nextActivity !== undefined) replayActivity = nextActivity;
          if (envelope.event.type === "queue_update") replayQueue = { steering: [...envelope.event.steering], followUp: [...envelope.event.followUp] };
          if (envelope.event.type === "agent_start") replayAgentStarted = true;
          return;
        }
        this.callbacks.onEvent(envelope, generation);
        if (envelope.event.type === "compaction_end" && !envelope.event.aborted && !envelope.event.willRetry) {
          queueMicrotask(() => {
            if (this.isCurrent(generation)) this.connect(issueId);
          });
        }
      } catch {
        // Skipping a frame leaves both replay and live projections incomplete; recover from persisted events.
        recover("agent_event_protocol_error");
      }
    });
    source.addEventListener("error", () => recover());
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
    this.clearStaleTimer();
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

  private clearStaleTimer(): void {
    if (!this.staleTimer) return;
    clearTimeout(this.staleTimer);
    this.staleTimer = undefined;
  }
}
