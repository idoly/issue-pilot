import { Button } from "../ui";
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch, untrack } from "solid-js";
import type { ImageContent } from "@earendil-works/pi-ai";

import { issuePilotConfig } from "../../../../issue-pilot.config.ts";
import {
  ISSUE_STATUSES,
  agentStreamUrl,
  abortAgent,
  createAgentMessageId,
  sendAgentMessage,
  agentMessageReceipt,
  type AgentCostSource,
  type AgentFooterStats,
  type IssueDetail,
  type IssueStatus,
  type AgentRunState,
  type RunEvent,
} from "../data/client";
import { contextTokens, mergeFooterUsage, validAssistantUsage } from "../../../agent/usage.ts";
import { ArrowDown, ChevronRight } from "../ui/icons";
import { IssueMarkdown, resolveIssueFileLink } from "./IssueMarkdown";
import { QueryResult } from "./QueryResult";
import {
  activityForEvent,
  ConversationProjection,
  assistantNotice,
  diffLineClass,
  duration,
  panelError,
  resultText,
  toolNestedCalls,
  toolLabel,
  toolLabelParts,
  type AgentActivity,
  type ConversationEntry,
} from "./conversation";
import { AgentStreamController } from "./agent-stream";
import { PasteEditorModel, type PasteEditResult } from "./paste-editor";
import type { AgentDraftImage, SubmittedAgentMessage, AgentDraftStore } from "./agent-drafts";

function ToolEntry(props: { issue: IssueDetail; entry: Extract<ConversationEntry, { kind: "tool" }>; userSubject?: string }) {
  const [expanded, setExpanded] = createSignal(false, { ownedWrite: true });
  const label = createMemo(() => toolLabel(props.entry, props.issue.workingDirectory));
  const labelParts = createMemo(() => toolLabelParts(label()));
  const diff = createMemo(() => {
    if (props.entry.name !== "edit" || !props.entry.result?.details || typeof props.entry.result.details !== "object") return [];
    const diffText = (props.entry.result.details as Record<string, unknown>).diff;
    return typeof diffText === "string" ? diffText.split("\n") : [];
  });
  const text = createMemo(() => resultText(props.entry));
  const calls = createMemo(() => toolNestedCalls(props.entry));
  const outputFile = () => {
    const details = props.entry.result?.details;
    if (!details || typeof details !== "object" || !("fullOutputPath" in details) || typeof details.fullOutputPath !== "string") return undefined;
    return resolveIssueFileLink(details.fullOutputPath, props.issue);
  };
  const images = () => props.entry.result?.content.filter((part): part is ImageContent => part.type === "image") ?? [];
  return (
    <details class={`agent-tool ${props.entry.status}`} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary class="agent-tool-head" aria-label={`工具 ${label()}`}>
        <ChevronRight size={14} />
        <code title={label()}>
          <b>{labelParts().action}</b>
          <Show when={labelParts().target}>
            <span>{labelParts().target}</span>
          </Show>
          <Show when={labelParts().range}>
            <em>{labelParts().range}</em>
          </Show>
        </code>
        <span class="agent-tool-state">{{ running: "执行中", complete: "完成", error: "失败" }[props.entry.status]}</span>
        <Show when={props.entry.parentToolCallId}>
          <span class="agent-tool-timing">子查询</span>
        </Show>
        <Show when={props.entry.result?.displayTruncated}>
          <span class="agent-tool-timing" title="页面只保留输出开头和结尾，未修改会话原始记录">
            显示已截断
          </span>
        </Show>
        <Show when={props.entry.durationMs !== undefined}>
          <span class="agent-tool-timing">{duration(props.entry.durationMs)}</span>
        </Show>
      </summary>
      <Show when={expanded()}>
        <Show when={diff().length}>
          <pre class="agent-tool-diff">
            <For each={diff()}>
              {(line) => (
                <span class={diffLineClass(line)}>
                  {line}
                  {"\n"}
                </span>
              )}
            </For>
          </pre>
        </Show>
        <For each={calls()}>
          {(call) => (
            <div class={`agent-nested-call ${call.status}`}>
              <code>{call.name}</code>
              <span>{{ running: "执行中", ok: "完成", error: "失败", cancelled: "已取消", unfinished: "未完成" }[call.status]}</span>
              <Show when={call.durationMs !== undefined}>
                <span>{duration(call.durationMs)}</span>
              </Show>
              <Show when={call.error}>
                <span>{call.error}</span>
              </Show>
            </div>
          )}
        </For>
        <Show when={props.entry.result?.nestedCalls?.complete === false}>
          <div class="agent-tool-timing">嵌套调用记录不完整</div>
        </Show>
        <Show when={text()}>
          <QueryResult entry={props.entry} text={text()} issueKey={props.issue.id} userSubject={props.userSubject} />
        </Show>
        <Show when={outputFile()}>
          {(href) => (
            <a class="agent-tool-file" href={href()} download>
              输出文件
            </a>
          )}
        </Show>
        <For each={images()}>{(image) => <img class="agent-inline-image" src={`data:${image.mimeType};base64,${image.data}`} alt="Tool output" />}</For>
        <Show when={!text() && !diff().length && !calls().length && !images().length}>
          <div class="agent-tool-timing">{props.entry.status === "running" ? "等待工具结果…" : "无文本输出"}</div>
        </Show>
      </Show>
    </details>
  );
}

function SessionSummaryEntry(props: { issue: IssueDetail; entry: Extract<ConversationEntry, { kind: "summary" }> }) {
  const [expanded, setExpanded] = createSignal(false, { ownedWrite: true });
  const label = () => (props.entry.summaryType === "compaction" ? "compaction" : "branch");
  const description = () => (props.entry.summaryType === "compaction" ? `已压缩 ${(props.entry.tokensBefore ?? 0).toLocaleString()} tokens` : "分支摘要");
  return (
    <section class="agent-summary">
      <button type="button" aria-expanded={expanded() ? "true" : "false"} onClick={() => setExpanded((value) => !value)}>
        <strong>[{label()}]</strong>
        <span>{description()}</span>
        <ChevronRight class={expanded() ? "expanded" : ""} size={14} />
      </button>
      <Show when={expanded()}>
        <div class="agent-summary-content">
          <IssueMarkdown issue={props.issue} source={props.entry.summary} />
        </div>
      </Show>
    </section>
  );
}

function CustomMessageEntry(props: { issue: IssueDetail; entry: Extract<ConversationEntry, { kind: "custom" }> }) {
  return (
    <section class="agent-custom-message">
      <strong>[{props.entry.label}]</strong>
      <For each={props.entry.blocks}>
        {(block) =>
          block.type === "text" ? (
            <IssueMarkdown issue={props.issue} source={block.value} />
          ) : (
            <img class="agent-inline-image" src={`data:${block.mimeType};base64,${block.data}`} alt="Custom message" />
          )
        }
      </For>
    </section>
  );
}

function BashMessageEntry(props: { entry: Extract<ConversationEntry, { kind: "bash" }> }) {
  const failed = () => props.entry.cancelled || (props.entry.exitCode !== undefined && props.entry.exitCode !== 0);
  return (
    <section class={`agent-tool ${failed() ? "error" : "complete"}`}>
      <strong class="agent-bash-command">$ {props.entry.command}</strong>
      <Show when={props.entry.output}>
        <pre class="agent-tool-output">{props.entry.output}</pre>
      </Show>
      <Show when={props.entry.truncated}>
        <div class="agent-tool-timing">输出已截断</div>
      </Show>
    </section>
  );
}

function AssistantBlock(props: { issue: IssueDetail; block: Extract<ConversationEntry, { kind: "assistant" }>["blocks"][number]; streaming: boolean }) {
  // Keep streaming as text; completed answers and thinking render inline as Markdown.
  return (
    <Show
      when={props.streaming}
      fallback={
        <div class={{ "agent-thinking": props.block.type === "thinking" }}>
          <IssueMarkdown issue={props.issue} source={props.block.value} />
        </div>
      }
    >
      <div class={{ "agent-thinking": props.block.type === "thinking" }}>
        <div class="agent-streaming-block">{props.block.value}</div>
      </div>
    </Show>
  );
}

export function ConversationItem(props: { issue: IssueDetail; entry: ConversationEntry; userSubject?: string }) {
  // Match render callbacks take an argument; zero-argument functions are accessors that can recreate DOM.
  return (
    <Switch>
      <Match when={props.entry.kind === "user"}>
        {(_matched) => {
          const entry = () => props.entry as Extract<ConversationEntry, { kind: "user" }>;
          return (
            <div class="agent-message user">
              <IssueMarkdown issue={props.issue} source={entry().text} />
              <For each={entry().images ?? []}>{(image) => <img class="agent-inline-image" src={`data:${image.mimeType};base64,${image.data}`} alt="用户粘贴的图片" />}</For>
            </div>
          );
        }}
      </Match>
      <Match when={props.entry.kind === "assistant"}>
        {(_matched) => {
          const entry = () => props.entry as Extract<ConversationEntry, { kind: "assistant" }>;
          return (
            <div class="agent-message assistant">
              <For each={entry().blocks} keyed={(block) => block.contentIndex}>
                {(block) => <AssistantBlock issue={props.issue} block={block()} streaming={entry().streaming === true} />}
              </For>
              <Show when={assistantNotice(entry())}>{(notice) => <div class="agent-message-notice">{notice()}</div>}</Show>
            </div>
          );
        }}
      </Match>
      <Match when={props.entry.kind === "tool"}>
        <ToolEntry issue={props.issue} entry={props.entry as Extract<ConversationEntry, { kind: "tool" }>} userSubject={props.userSubject} />
      </Match>
      <Match when={props.entry.kind === "summary"}>
        <SessionSummaryEntry issue={props.issue} entry={props.entry as Extract<ConversationEntry, { kind: "summary" }>} />
      </Match>
      <Match when={props.entry.kind === "custom"}>
        <CustomMessageEntry issue={props.issue} entry={props.entry as Extract<ConversationEntry, { kind: "custom" }>} />
      </Match>
      <Match when={props.entry.kind === "bash"}>
        <BashMessageEntry entry={props.entry as Extract<ConversationEntry, { kind: "bash" }>} />
      </Match>
    </Switch>
  );
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  if (tokens < 10_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  return `${Math.round(tokens / 1_000_000)}M`;
}

const emptyFooter = (): AgentFooterStats => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  costSource: null,
  latestCacheHitRate: null,
  contextPercent: null,
  contextWindow: 0,
  autoCompact: true,
});

function footerAfterEvent(current: AgentFooterStats, event: RunEvent["event"]): AgentFooterStats {
  const message = event.type === "message_end" && typeof event.message === "object" ? event.message : undefined;
  const usage =
    event.type === "entry_appended" && (event.entry.type === "usage" || event.entry.type === "compaction" || event.entry.type === "branch_summary")
      ? event.entry.usage
      : message?.role === "assistant" || message?.role === "toolResult"
        ? message.usage
        : undefined;
  if (!usage) return current;
  const next = mergeFooterUsage(current, usage);
  if (message?.role !== "assistant") return next;
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  // Shared with the server snapshot: failed or empty requests cannot replace the last context estimate.
  const validContext = validAssistantUsage(message);
  return {
    ...next,
    latestCacheHitRate: promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : null,
    contextPercent: validContext && current.contextWindow > 0 ? (contextTokens(usage) / current.contextWindow) * 100 : current.contextPercent,
  };
}

const costSourceLabels: Record<AgentCostSource, string> = { provider: "供应商报告", estimated: "估算", unknown: "来源未标明", mixed: "混合来源" };

function footerMetrics(footer: AgentFooterStats) {
  const contextPercent = footer.contextPercent === null ? "?" : `${footer.contextPercent.toFixed(1)}%`;
  return [
    { text: footer.input ? `↑${formatTokens(footer.input)}` : "", title: "输入 Token（会话累计）", tone: "tokens" },
    { text: footer.output ? `↓${formatTokens(footer.output)}` : "", title: "输出 Token（会话累计）", tone: "tokens" },
    { text: footer.cacheRead ? `R${formatTokens(footer.cacheRead)}` : "", title: "缓存读取 Token（会话累计）", tone: "cache" },
    { text: footer.cacheWrite ? `W${formatTokens(footer.cacheWrite)}` : "", title: "缓存写入 Token（会话累计）", tone: "cache" },
    {
      text: footer.latestCacheHitRate !== null && (footer.cacheRead > 0 || footer.cacheWrite > 0) ? `CH${footer.latestCacheHitRate.toFixed(1)}%` : "",
      title: "最近一次主模型请求的缓存命中率",
      tone: "cache",
    },
    {
      text: footer.cost ? `$${footer.cost.toFixed(3)}${footer.costSource === null ? "" : ` (${costSourceLabels[footer.costSource]})`}` : "",
      title: "会话累计费用；记录来源不等于最终账单",
      tone: "cost",
    },
    {
      text: footer.contextWindow > 0 ? `上下文 ${contextPercent}/${formatTokens(footer.contextWindow)}${footer.autoCompact ? " (auto)" : ""}` : "",
      title: `当前上下文占用 / 模型上下文上限；自动压缩${footer.autoCompact ? "已开启" : "已关闭"}`,
      tone: "context",
    },
  ].filter((metric) => metric.text);
}

export function AgentPanel(props: { issue: IssueDetail; hidden?: boolean; onRefresh: (issueKey: string) => Promise<unknown>; drafts: AgentDraftStore; userSubject?: string }) {
  const [snapshotReady, setSnapshotReady] = createSignal(false, { ownedWrite: true });
  const [sending, setSending] = createSignal(false, { ownedWrite: true });
  const [runState, setRunState] = createSignal<AgentRunState | undefined>(undefined, { ownedWrite: true });
  const processing = () => (runState() === undefined ? props.issue.agentRunning === true : runState() !== "idle");
  const [issueStatus, setIssueStatus] = createSignal<IssueStatus>(
    untrack(() => props.issue.status),
    { ownedWrite: true },
  );
  const [error, setError] = createSignal("", { ownedWrite: true });
  const draftStore = props.drafts;
  let draftRecord = untrack(() => draftStore.get(props.issue.id));
  const [submitted, setSubmitted] = createSignal<SubmittedAgentMessage | undefined>(draftRecord.submitted, { ownedWrite: true });
  const [draft, setDraftValue] = createSignal(draftRecord.text, { ownedWrite: true });
  const [images, setImagesValue] = createSignal<AgentDraftImage[]>(draftRecord.images, { ownedWrite: true });
  const setDraft = (value: string) => {
    draftRecord.text = value;
    setDraftValue(value);
  };
  const setImages = (value: AgentDraftImage[] | ((current: AgentDraftImage[]) => AgentDraftImage[])) => {
    const next = typeof value === "function" ? value(draftRecord.images) : value;
    draftRecord.images = next;
    setImagesValue(next);
  };
  const loadDraft = (issueId: string) => {
    draftRecord = draftStore.get(issueId);
    setDraftValue(draftRecord.text);
    setImagesValue(draftRecord.images);
    setError(draftRecord.error);
    setSending(draftRecord.sending);
    setSubmitted(draftRecord.submitted);
  };
  const [entries, setEntries] = createSignal<ConversationEntry[]>([], { ownedWrite: true });
  let projection = new ConversationProjection();
  const [unread, setUnread] = createSignal(0, { ownedWrite: true });
  const [atLatest, setAtLatest] = createSignal(true, { ownedWrite: true });
  const [activity, setActivity] = createSignal<AgentActivity | null>(null, { ownedWrite: true });
  const [queue, setQueue] = createSignal<{ steering: string[]; followUp: string[] }>({ steering: [], followUp: [] }, { ownedWrite: true });
  const [agent, setAgent] = createSignal({ provider: "", model: "", thinkingLevel: "" }, { ownedWrite: true });
  const [footer, setFooter] = createSignal<AgentFooterStats>(emptyFooter(), { ownedWrite: true });
  let panel: HTMLElement | undefined;
  let transcript!: HTMLDivElement;
  let conversation!: HTMLDivElement;
  let editor: HTMLTextAreaElement | undefined;
  let followLatest = true;
  let followedTop = 0;
  let issueGeneration = 0;
  let issueRefreshId = 0;
  const unreadEntryIds = new Set<string>();
  let messageUpdateFrame: number | undefined;
  let pendingMessageUpdates: Array<{ envelope: RunEvent; deltas: string[] | null }> = [];
  createEffect(
    () => ({ revision: draftStore.revision(), issueId: props.issue.id }),
    ({ issueId }) => loadDraft(issueId),
  );

  const canSend = () => issueStatus() !== "resolved";
  const canInterrupt = processing;
  const canSubmit = () => canSend() && !sending() && !submitted() && (images().length > 0 || /\S/.test(draft()));
  const usageMetrics = () => footerMetrics(footer());
  const codeRoot = () => props.issue.workingDirectory;
  const developmentRepositoriesPending = () => props.issue.environmentKey === "dev" && (!props.issue.repositories.length || props.issue.repositories.some((repository) => !repository.workingBranch));
  const clearUnread = () => {
    unreadEntryIds.clear();
    setUnread(0);
  };
  const setFollowLatest = (value: boolean) => {
    followLatest = value;
    setAtLatest(value);
  };
  const keepLatest = () => {
    if (!followLatest || props.hidden) return;
    followedTop = Math.max(0, transcript.scrollHeight - transcript.clientHeight);
    transcript.scrollTo({ top: followedTop, behavior: "auto" });
  };
  const scrollLatest = () => {
    setFollowLatest(true);
    keepLatest();
    clearUnread();
  };
  createEffect(
    () => props.hidden,
    (hidden) => {
      if (hidden) return;
      // Observe viewport changes and content growth, including late images and expanded details.
      const observer = new ResizeObserver(keepLatest);
      observer.observe(transcript);
      observer.observe(conversation);
      return () => observer.disconnect();
    },
  );
  const focusConversation = (event: MouseEvent & { currentTarget: HTMLDivElement }) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest("a, button, summary, input, textarea, select, [contenteditable='true']")) return;
    if (window.getSelection()?.isCollapsed === false) return;
    panel?.focus({ preventScroll: true });
  };
  let aborting = false;
  const handlePanelKeyDown = (event: KeyboardEvent & { currentTarget: HTMLElement }) => {
    // Portal events can reach the panel even though the native dialog owns keyboard interaction.
    if (event.target instanceof Element && event.target.closest("dialog[open]")) return;
    if (event.key === "Escape") {
      if (props.hidden || event.defaultPrevented || event.isComposing || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (!canInterrupt()) return;
      event.preventDefault();
      event.stopPropagation();
      if (aborting) return;
      aborting = true;
      const key = props.issue.id;
      const generation = issueGeneration;
      const record = draftRecord;
      void abortAgent(key)
        .then(async () => {
          if (generation === issueGeneration && draftStore.isCurrent(key, record)) await props.onRefresh(key);
        })
        .catch((failure: unknown) => {
          if (generation === issueGeneration && draftStore.isCurrent(key, record)) {
            record.error = failure instanceof Error ? failure.message : "agent_abort_failed";
            setError(record.error);
          }
        })
        .finally(() => {
          aborting = false;
        });
      return;
    }
    if (event.key !== "Enter" || event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    scrollLatest();
  };
  const discardImages = (items: Array<{ file: File; url: string }>) => {
    for (const image of items) URL.revokeObjectURL(image.url);
  };
  const removeImage = (url: string) =>
    setImages((current) => {
      const removed = current.find((image) => image.url === url);
      if (removed) URL.revokeObjectURL(removed.url);
      return current.filter((image) => image.url !== url);
    });
  const updateConversation = (events: RunEvent[]) => {
    for (const event of events) projection.apply(event);
    const next = projection.snapshot();
    if (followLatest) {
      setEntries(next);
      return;
    }
    let added: ConversationEntry[] = [];
    const generation = issueGeneration;
    setEntries((current) => {
      // Live events replace entries in place or append them. Reconnect snapshots have their own path.
      if (next.length > current.length) added = next.slice(current.length);
      return next;
    });
    queueMicrotask(() => {
      if (generation !== issueGeneration || followLatest || !added.length) return;
      for (const { id } of added) unreadEntryIds.add(id);
      setUnread(unreadEntryIds.size);
    });
  };
  const applyPendingMessageUpdates = () => {
    const pending = pendingMessageUpdates;
    pendingMessageUpdates = [];
    if (!pending.length) return;
    const updates = pending.map(({ envelope, deltas }) => {
      if (!deltas || envelope.event.type !== "message_update") return envelope;
      const update = envelope.event.assistantMessageEvent;
      if (!update || !("delta" in update) || typeof update.delta !== "string") return envelope;
      return { ...envelope, event: { ...envelope.event, assistantMessageEvent: { ...update, delta: deltas.join("") } } } as RunEvent;
    });
    updateConversation(updates);
  };
  const flushMessageUpdates = () => {
    if (messageUpdateFrame !== undefined) window.cancelAnimationFrame(messageUpdateFrame);
    messageUpdateFrame = undefined;
    applyPendingMessageUpdates();
  };
  const discardMessageUpdates = () => {
    if (messageUpdateFrame !== undefined) window.cancelAnimationFrame(messageUpdateFrame);
    messageUpdateFrame = undefined;
    pendingMessageUpdates = [];
  };
  const queueMessageUpdate = (envelope: RunEvent) => {
    if (envelope.event.type !== "message_update") {
      pendingMessageUpdates.push({ envelope, deltas: null });
      return;
    }
    const update = envelope.event.assistantMessageEvent;
    const isDelta = update && "delta" in update && typeof update.delta === "string";
    const previousPending = pendingMessageUpdates[pendingMessageUpdates.length - 1];
    const previousEvent = previousPending?.envelope.event;
    const previous = previousEvent?.type === "message_update" ? previousEvent.assistantMessageEvent : undefined;
    if (isDelta && previousPending?.deltas && previous && "delta" in previous && update.type === previous.type && update.contentIndex === previous.contentIndex) {
      previousPending.envelope = envelope;
      previousPending.deltas.push(update.delta);
      return;
    }
    pendingMessageUpdates.push({ envelope, deltas: isDelta ? [update.delta] : null });
  };
  const append = (event: RunEvent) => {
    if (event.event.type === "message_update") {
      queueMessageUpdate(event);
      if (messageUpdateFrame === undefined)
        messageUpdateFrame = window.requestAnimationFrame(() => {
          messageUpdateFrame = undefined;
          applyPendingMessageUpdates();
        });
      return;
    }
    flushMessageUpdates();
    updateConversation([event]);
    setFooter((current) => footerAfterEvent(current, event.event));
    const type = event.event.type;
    if (event.event.type === "issue_run_state") setRunState(event.event.state);
    const nextActivity = activityForEvent(event.event);
    if (nextActivity !== undefined) setActivity(nextActivity);
    if (type === "queue_update") setQueue({ steering: [...event.event.steering], followUp: [...event.event.followUp] });
    if (type === "issue_status") setIssueStatus(event.event.status === "complete" ? "pending" : "open");
  };
  const refreshIssue = (issueKey: string, connectionGeneration: number) => {
    const currentRefresh = ++issueRefreshId;
    void Promise.resolve()
      .then(() => props.onRefresh(issueKey))
      .then(() => {
        if (streamController.isCurrent(connectionGeneration) && currentRefresh === issueRefreshId && error() === "issue_refresh_failed") setError("");
      })
      .catch(() => {
        if (streamController.isCurrent(connectionGeneration) && currentRefresh === issueRefreshId) setError("issue_refresh_failed");
      });
  };
  const streamController = new AgentStreamController(agentStreamUrl, issuePilotConfig.web.agentStreamReconnectMs, issuePilotConfig.web.agentStreamStaleMs, {
    onConnection: setSnapshotReady,
    onError: (streamError) => {
      if (!streamError && ["agent_event_connection_failed", "agent_event_protocol_error"].includes(error())) setError("");
      else if (streamError) setError(streamError);
    },
    onSnapshot: (payload, replay, generation) => {
      // The snapshot is authoritative; deltas queued by the previous connection must not replay over it.
      discardMessageUpdates();
      projection = new ConversationProjection(replay.entries);
      setEntries(replay.entries);
      setFooter(payload.footer ?? emptyFooter());
      // A reconnect must not yank a reader who scrolled back through history.
      if (followLatest) clearUnread();
      setActivity(payload.runState === "queued" || payload.runState === "idle" ? (activityForEvent({ type: "issue_run_state", state: payload.runState }) ?? null) : replay.activity);
      setQueue(replay.queue);
      setAgent(payload.agent ?? { provider: "", model: "", thinkingLevel: "" });
      const statusChanged = Boolean(payload.issueStatus && ISSUE_STATUSES.includes(payload.issueStatus) && payload.issueStatus !== props.issue.status);
      if (payload.issueStatus && ISSUE_STATUSES.includes(payload.issueStatus)) setIssueStatus(payload.issueStatus);
      setRunState(payload.runState);
      const executionChanged = (payload.runState !== "idle") !== Boolean(props.issue.agentRunning);
      const revisionChanged = Boolean(payload.issueRevision && payload.issueRevision !== props.issue.revision);
      if (statusChanged || executionChanged || revisionChanged || (replay.agentStarted && developmentRepositoriesPending())) refreshIssue(props.issue.id, generation);
      queueMicrotask(keepLatest);
    },
    onEvent: (envelope, generation) => {
      append(envelope);
      if (
        envelope.event.type === "issue_status" ||
        envelope.event.type === "issue_run_state" ||
        envelope.event.type === "agent_start" ||
        (envelope.event.type === "tool_execution_end" && envelope.event.toolName === "workspace")
      )
        refreshIssue(props.issue.id, generation);
    },
  });
  const connect = (issueId: string, resetForIssue = false) => {
    if (resetForIssue) {
      // A new Issue always opens at its latest message, whatever the previous transcript's scroll was.
      setFollowLatest(true);
      followedTop = 0;
      discardMessageUpdates();
      projection = new ConversationProjection();
      setEntries([]);
      setFooter(emptyFooter());
      clearUnread();
      setError("");
      setSnapshotReady(false);
      setRunState(undefined);
      setActivity(null);
      setQueue({ steering: [], followUp: [] });
      setAgent({ provider: "", model: "", thinkingLevel: "" });
      loadDraft(issueId);
    }
    streamController.connect(issueId);
  };
  const submit = async () => {
    const issueId = props.issue.id;
    const record = draftRecord;
    if (record.submitted || !canSend() || !draftStore.isCurrent(issueId, record)) return;
    const editorText = record.text;
    const pendingImages = record.images;
    const message = record.pasteEditor.expand(editorText).trim() || (pendingImages.length ? "请分析这些图片。" : "");
    if (!message) return;
    if (message.length > issuePilotConfig.limits.agentMessageChars) {
      const failureMessage = `消息共 ${message.length.toLocaleString()} 字符，超过 ${issuePilotConfig.limits.agentMessageChars.toLocaleString()} 字符上限，请分段发送。`;
      record.error = failureMessage;
      setError(failureMessage);
      return;
    }
    const submitGeneration = issueGeneration;
    const submission = { id: createAgentMessageId(), text: editorText, message, images: pendingImages, pasteEditor: record.pasteEditor };
    record.submitted = submission;
    setSubmitted(submission);
    record.text = "";
    record.images = [];
    record.error = "";
    record.sending = true;
    // The submitted message owns its snapshot; new typing never competes with failure recovery.
    record.pasteEditor = new PasteEditorModel();
    setDraftValue("");
    setImagesValue([]);
    setSending(true);
    setError("");
    scrollLatest();
    const submitCurrent = () => submitGeneration === issueGeneration && draftRecord === record && draftStore.isCurrent(issueId, record);
    try {
      await sendAgentMessage(
        issueId,
        message,
        pendingImages.map(({ file }) => file),
        submission.id,
      );
      if (draftStore.isCurrent(issueId, record)) {
        discardImages(pendingImages);
        record.submitted = undefined;
      }
    } catch (cause) {
      if (!draftStore.isCurrent(issueId, record)) return;
      let failureMessage = cause instanceof Error ? cause.message : "agent_message_failed";
      if (failureMessage === "agent_message_too_long") failureMessage = `消息超过 ${issuePilotConfig.limits.agentMessageChars.toLocaleString()} 字符上限，请分段发送。`;
      else if (failureMessage === "invalid_agent_message") failureMessage = "消息内容无效，请输入文字后重新发送。";
      else if (failureMessage === "agent_message_outcome_unknown") failureMessage = "会话已切换，无法确认这条消息是否已执行。请先查看对话和结果，再决定是否重发。";
      else if (failureMessage === "agent_session_file_incomplete") failureMessage = "会话文件不完整，消息未接收。请保留草稿并联系管理员检查会话文件。";
      else if (failureMessage === "agent_session_file_missing") failureMessage = "会话文件缺失，消息未接收。请保留草稿并联系管理员检查会话绑定。";
      else if (failureMessage === "issue_root_missing") failureMessage = "工单目录缺失，消息未接收。请保留草稿并联系管理员恢复原目录。";
      else if (failureMessage === "invalid_issue_root") failureMessage = "工单目录异常，消息未接收。请保留草稿并联系管理员检查目录。";
      else if (failureMessage === "issue_already_running") failureMessage = "工单正在被其他操作处理，请稍后重试。";
      else if (failureMessage === "resolved_issue_cannot_run_agent") {
        failureMessage = "工单已解决，请先重开后再发送。";
        // The panel may already show another Issue; never mark that one resolved.
        if (props.issue.id === issueId) setIssueStatus("resolved");
      }
      record.error = failureMessage;
      if (submitCurrent()) {
        setDraftValue(record.text);
        setImagesValue(record.images);
        setError(failureMessage);
      }
    } finally {
      record.sending = false;
      if (submitCurrent()) {
        setSending(false);
        queueMicrotask(() => {
          if (submitCurrent()) editor?.focus({ preventScroll: true });
        });
      }
      // A remounted panel for this Issue reloads the record's outcome.
      if (draftStore.isCurrent(issueId, record)) draftStore.touch();
    }
  };
  const checkSubmission = async () => {
    const issueId = props.issue.id;
    const record = draftRecord;
    if (record.sending || !record.submitted) return;
    const value = record.submitted;
    record.sending = true;
    draftStore.touch();
    try {
      const receipt = await agentMessageReceipt(issueId, value.id);
      if (!draftStore.isCurrent(issueId, record)) return;
      if (receipt.state === "queued" || receipt.state === "started") {
        discardImages(value.images);
        record.submitted = undefined;
        record.error = "消息已接收，请查看会话中的处理进度。";
      } else record.error = receipt.state === "rejected" ? "消息已接收后取消，请查看会话再决定是否重新发送。" : "暂时无法确认接收结果。原消息已保留，请查看会话后再决定是否重新发送。";
    } catch {
      if (draftStore.isCurrent(issueId, record)) record.error = "接收状态查询失败，原消息仍保留。";
    } finally {
      record.sending = false;
      if (draftStore.isCurrent(issueId, record)) draftStore.touch();
    }
  };
  const releaseSubmission = (restore: boolean) => {
    const value = draftRecord.submitted;
    if (!value || draftRecord.sending || (restore && (draftRecord.text || draftRecord.images.length))) return;
    if (restore) {
      draftRecord.text = value.text;
      draftRecord.images = value.images;
      draftRecord.pasteEditor = value.pasteEditor;
    } else discardImages(value.images);
    draftRecord.submitted = undefined;
    draftRecord.error = "";
    draftStore.touch();
  };
  const applyEditorResult = (textarea: HTMLTextAreaElement, edit: PasteEditResult) => {
    setDraft(edit.value);
    queueMicrotask(() => {
      textarea.focus();
      textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
    });
  };
  const handlePaste = (event: ClipboardEvent & { currentTarget: HTMLTextAreaElement }) => {
    const textarea = event.currentTarget;
    const clipboard = event.clipboardData;
    const pastedImages = [...(clipboard?.files ?? [])].filter((file) => file.type.startsWith("image/"));
    if (pastedImages.length) {
      event.preventDefault();
      const limits = issuePilotConfig.limits.agentImage;
      const current = images();
      const accepted = pastedImages.filter((file) => ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type));
      if (
        accepted.length !== pastedImages.length ||
        current.length + accepted.length > limits.files ||
        accepted.some((file) => file.size > limits.fileBytes) ||
        [...current.map(({ file }) => file), ...accepted].reduce((total, file) => total + file.size, 0) > limits.requestBytes
      ) {
        setError("agent_image_limit_exceeded");
        return;
      }
      setImages([...current, ...accepted.map((file) => ({ file, url: URL.createObjectURL(file) }))]);
    }
    const edit = draftRecord.pasteEditor.insert(draft(), textarea.selectionStart ?? draft().length, textarea.selectionEnd ?? draft().length, clipboard?.getData("text/plain") ?? "");
    if (!edit) return;
    event.preventDefault();
    applyEditorResult(textarea, edit);
  };
  const handleEditorInput = (event: InputEvent & { currentTarget: HTMLTextAreaElement }) => {
    const textarea = event.currentTarget;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const edit = draftRecord.pasteEditor.reconcile(textarea.value, start, end);
    if (edit.value === textarea.value && edit.selectionStart === start && edit.selectionEnd === end) {
      setDraft(edit.value);
      return;
    }
    applyEditorResult(textarea, edit);
  };
  const protectPasteSelection = (event: Event & { currentTarget: HTMLTextAreaElement }) => {
    const textarea = event.currentTarget;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? start;
    if (start === end) {
      const cursor = draftRecord.pasteEditor.snapCursor(draft(), start, "nearest");
      if (cursor !== start) textarea.setSelectionRange(cursor, cursor);
      return;
    }
    const selection = draftRecord.pasteEditor.expandSelection(draft(), start, end);
    if (selection.start !== start || selection.end !== end) textarea.setSelectionRange(selection.start, selection.end);
  };
  const handleEditorKeyDown = (event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) => {
    if (event.isComposing) return;
    const textarea = event.currentTarget;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? start;
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !event.shiftKey && start === end) {
      const cursor = draftRecord.pasteEditor.snapCursor(draft(), start, event.key === "ArrowLeft" ? "backward" : "forward");
      if (cursor !== start) {
        event.preventDefault();
        textarea.setSelectionRange(cursor, cursor);
      }
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      const edit = draftRecord.pasteEditor.delete(draft(), start, end, event.key === "Backspace" ? "backward" : "forward");
      if (edit) {
        event.preventDefault();
        applyEditorResult(textarea, edit);
      }
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };
  createEffect(
    () => ({ id: props.issue.id, status: props.issue.status }),
    ({ id, status }, previous) => {
      setIssueStatus(status);
      if (previous?.id === id) {
        if (previous.status === "resolved" && status === "open") connect(id);
        return;
      }
      issueGeneration += 1;
      connect(id, true);
    },
  );
  onCleanup(() => {
    issueGeneration += 1;
    discardMessageUpdates();
    streamController.dispose();
  });

  return (
    <section ref={panel} class="agent-panel" aria-label={`${props.issue.id} Agent 会话`} tabindex={0} hidden={props.hidden} onKeyDown={handlePanelKeyDown}>
      <div class="agent-transcript">
        <div
          ref={transcript}
          class="agent-scroll ip-scrollbar ip-scrollbar-dark"
          onClick={focusConversation}
          onScroll={(event) => {
            const { clientHeight, scrollHeight, scrollTop } = event.currentTarget;
            if (!clientHeight) return;
            const nearLatest = scrollHeight - clientHeight - scrollTop < 32;
            // A queued programmatic scroll can arrive after resize but before the ResizeObserver.
            if (followLatest && !nearLatest && followedTop > 0 && Math.abs(scrollTop - followedTop) < 1) return;
            setFollowLatest(nearLatest);
            if (nearLatest) {
              followedTop = scrollTop;
              clearUnread();
            }
          }}
        >
          <div ref={conversation} class="agent-conversation" role="log" aria-live="polite">
            <For each={entries()} keyed={(entry) => entry.id}>
              {(entry) => <ConversationItem issue={props.issue} entry={entry()} userSubject={props.userSubject} />}
            </For>
            <Show when={!entries().length && (snapshotReady() || !error())}>
              <div class="agent-empty">{snapshotReady() ? "还没有对话" : "正在加载对话…"}</div>
            </Show>
          </div>
        </div>
        <Show when={!atLatest()}>
          <Button class="agent-scroll-latest" shape="round" size="small" icon={<ArrowDown size={14} />} onClick={scrollLatest}>
            {unread() > 0 ? `${unread()} 条新消息` : "回到最新"}
          </Button>
        </Show>
      </div>
      <div class="agent-dock ip-scrollbar ip-scrollbar-dark">
        <Show when={queue().steering.length || queue().followUp.length}>
          <div class="agent-queue">
            <For each={queue().steering}>
              {(message) => (
                <span>
                  <strong>插话：</strong> {message}
                </span>
              )}
            </For>
            <For each={queue().followUp}>
              {(message) => (
                <span>
                  <strong>后续：</strong> {message}
                </span>
              )}
            </For>
          </div>
        </Show>
        <Show when={processing() || activity()}>
          <div class={`agent-working ${activity()?.tone ?? "info"}`} role="status">
            <i />
            {activity()?.text ?? "处理中…"}
          </div>
        </Show>
        <Show when={submitted()}>
          {(value) => (
            <div class="agent-submitted" aria-label="已提交消息">
              <strong>{sending() ? "正在发送" : "发送未确认，原消息已保留"}</strong>
              <details>
                <summary>查看原消息</summary>
                <pre>{value().message}</pre>
                <For each={value().images}>{(image) => <img src={image.url} alt={image.file.name || "已提交图片"} />}</For>
              </details>
              <Show when={!sending()}>
                <Button size="small" onClick={() => void checkSubmission()}>
                  查询接收状态
                </Button>
                <Button size="small" disabled={Boolean(draft() || images().length)} onClick={() => releaseSubmission(true)}>
                  移入空草稿
                </Button>
                <Button size="small" onClick={() => releaseSubmission(false)}>
                  移除记录
                </Button>
              </Show>
            </div>
          )}
        </Show>
        <div class="agent-composer-gutter">
          <div class={`agent-composer thinking-${agent().thinkingLevel || "off"}`}>
            <Show when={images().length}>
              <div class="agent-composer-images">
                <For each={images()}>
                  {(image) => (
                    <figure>
                      <img src={image.url} alt={image.file.name || "待发送图片"} />
                      <button type="button" aria-label={`移除图片 ${image.file.name || "未命名"}`} onClick={() => removeImage(image.url)}>
                        ×
                      </button>
                    </figure>
                  )}
                </For>
              </div>
            </Show>
            <textarea
              ref={editor}
              rows={2}
              aria-label="发送给 Agent"
              placeholder={canSend() ? "补充消息或粘贴图片…" : "工单已解决，重开后可发送"}
              value={draft()}
              disabled={!canSend()}
              onInput={handleEditorInput}
              onPaste={handlePaste}
              onSelect={protectPasteSelection}
              onKeyDown={handleEditorKeyDown}
            />
            <div class="agent-composer-actions">
              <span>
                Enter 发送 · Shift+Enter 换行
                <Show when={canInterrupt()}>
                  <span title="中断当前处理并取消后续排队，保留未发送草稿"> · Esc 中断</span>
                </Show>
              </span>
              <Button type="primary" size="small" aria-label="发送消息" loading={sending()} disabled={!canSubmit()} onClick={() => void submit()}>
                {sending() ? "发送中" : "发送"}
              </Button>
            </div>
          </div>
        </div>
        <Show when={error()}>
          <div class="agent-panel-error" role="alert">
            {panelError(error())}
          </div>
        </Show>
        <footer class="agent-meta">
          <div class="agent-meta-primary">
            <span title={`工作目录：${codeRoot()}`}>{codeRoot()}</span>
          </div>
          <div class="agent-meta-secondary">
            <div class="agent-meta-usage" role="group" aria-label="会话用量">
              <For each={usageMetrics()}>
                {(metric) => (
                  <>
                    <span class={`agent-meta-metric ${metric.tone}`} title={metric.title}>
                      {metric.text}
                    </span>{" "}
                  </>
                )}
              </For>
            </div>
            <span class="agent-meta-model">
              <b title={`模型：${agent().model || "no-model"}`}>{agent().model || "no-model"}</b>
              <Show when={agent().thinkingLevel}>
                <span class="agent-meta-thinking" title="思考级别">
                  · {agent().thinkingLevel}
                </span>
              </Show>
            </span>
          </div>
        </footer>
      </div>
    </section>
  );
}
