import { Button } from "../ui";
import { createEffect, createSignal, For, Match, onCleanup, Show, Switch, untrack } from "solid-js";
import type { ImageContent } from "@earendil-works/pi-ai";

import { issuePilotConfig } from "../../../../issue-pilot.config.ts";
import { ISSUE_STATUSES, agentStreamUrl, sendAgentMessage, type AgentFooterStats, type IssueDetail, type IssueStatus, type RunEvent } from "../data/client";
import { ArrowDown, ChevronRight } from "../ui/icons";
import { IssueMarkdown } from "./IssueMarkdown";
import { activityForEvent, applyAgentEvent, assistantNotice, codemodeCalls, diffLineClass, duration, panelError, processingAfterEvent, resultText, shellToolOutput, toolLabel, toolLabelParts, type AgentActivity, type ConversationEntry } from "./conversation";
import { AgentStreamController } from "./agent-stream";
import { PasteEditorModel, type PasteEditResult } from "./paste-editor";

function ToolEntry(props: { entry: Extract<ConversationEntry, { kind: "tool" }> }) {
  const label = () => toolLabel(props.entry);
  const labelParts = () => toolLabelParts(label());
  const diff = () => {
    if (props.entry.name !== "edit" || !props.entry.result?.details || typeof props.entry.result.details !== "object") return [];
    const diffText = (props.entry.result.details as Record<string, unknown>).diff;
    return typeof diffText === "string" ? diffText.split("\n") : [];
  };
  const shellOutput = () => shellToolOutput(props.entry);
  const genericOutput = () => ["bash", "edit", "write", "read", "grep", "find", "ls"].includes(props.entry.name) ? "" : resultText(props.entry);
  const images = () => props.entry.result?.content.filter((part): part is ImageContent => part.type === "image") ?? [];
  return <div class={`agent-tool ${props.entry.status}`}>
    <div class="agent-tool-head"><code title={label()}><b>{labelParts().action}</b><Show when={labelParts().target}><span>{labelParts().target}</span></Show><Show when={labelParts().range}><em>{labelParts().range}</em></Show></code></div>
    <Show when={diff().length}><pre class="agent-tool-diff"><For each={diff()}>{(line) => <span class={diffLineClass(line)}>{line}{"\n"}</span>}</For></pre></Show>
    <Show when={shellOutput()}>{(result) => <>
      <Show when={result().lines.length}><pre class="agent-tool-output"><Show when={result().omitted}><span class="omitted">... ({result().omitted} earlier lines)</span></Show><For each={result().lines}>{(line) => <span>{line}{"\n"}</span>}</For></pre></Show>
      <Show when={props.entry.durationMs !== undefined}><div class="agent-tool-timing">Took {duration(props.entry.durationMs)}</div></Show>
    </>}</Show>
    <For each={codemodeCalls(props.entry)}>{call => <div class={`agent-nested-call ${call.status}`}><code>{call.name}</code><span>{({ running: "执行中", ok: "完成", error: "失败", cancelled: "已取消" })[call.status]}</span><Show when={call.durationMs !== undefined}><span>{duration(call.durationMs)}</span></Show><Show when={call.error}><span>{call.error}</span></Show></div>}</For>
    <Show when={genericOutput()}>{(text) => <pre class="agent-tool-output">{text()}</pre>}</Show>
    <For each={images()}>{(image) => <img class="agent-inline-image" src={`data:${image.mimeType};base64,${image.data}`} alt="Tool output" />}</For>
  </div>;
}

function SessionSummaryEntry(props: { issue: IssueDetail; entry: Extract<ConversationEntry, { kind: "summary" }> }) {
  const [expanded, setExpanded] = createSignal(false, { ownedWrite: true });
  const label = () => props.entry.summaryType === "compaction" ? "compaction" : "branch";
  const description = () => props.entry.summaryType === "compaction"
    ? `Compacted from ${(props.entry.tokensBefore ?? 0).toLocaleString()} tokens`
    : "Branch summary";
  return <section class="agent-summary">
    <button type="button" aria-expanded={expanded() ? "true" : "false"} onClick={() => setExpanded((value) => !value)}>
      <strong>[{label()}]</strong><span>{description()}</span><ChevronRight class={expanded() ? "expanded" : ""} size={14} />
    </button>
    <Show when={expanded()}><div class="agent-summary-content"><IssueMarkdown issue={props.issue} source={props.entry.summary} /></div></Show>
  </section>;
}

function CustomMessageEntry(props: { issue: IssueDetail; entry: Extract<ConversationEntry, { kind: "custom" }> }) {
  return <section class="agent-custom-message"><strong>[{props.entry.label}]</strong><For each={props.entry.blocks}>{(block) => block.type === "text"
    ? <IssueMarkdown issue={props.issue} source={block.value} />
    : <img class="agent-inline-image" src={`data:${block.mimeType};base64,${block.data}`} alt="Custom message" />}</For></section>;
}

function BashMessageEntry(props: { entry: Extract<ConversationEntry, { kind: "bash" }> }) {
  const failed = () => props.entry.cancelled || (props.entry.exitCode !== undefined && props.entry.exitCode !== 0);
  return <section class={`agent-tool ${failed() ? "error" : "complete"}`}><strong class="agent-bash-command">$ {props.entry.command}</strong><Show when={props.entry.output}><pre class="agent-tool-output">{props.entry.output}</pre></Show><Show when={props.entry.truncated}><div class="agent-tool-timing">Output truncated</div></Show></section>;
}

function AssistantBlock(props: { issue: IssueDetail; block: Extract<ConversationEntry, { kind: "assistant" }>["blocks"][number]; streaming: boolean }) {
  const content = () => props.streaming ? <div class="agent-streaming-block">{props.block.value}</div> : <IssueMarkdown issue={props.issue} source={props.block.value} />;
  return <Show when={props.block.type === "thinking"} fallback={content()}><div class="agent-thinking">{content()}</div></Show>;
}

function ConversationItem(props: { issue: IssueDetail; entry: ConversationEntry }) {
  return <Switch>
    <Match when={props.entry.kind === "user"}>{() => { const entry = props.entry as Extract<ConversationEntry, { kind: "user" }>; return <div class="agent-message user"><IssueMarkdown issue={props.issue} source={entry.text} /><For each={entry.images ?? []}>{(image) => <img class="agent-inline-image" src={`data:${image.mimeType};base64,${image.data}`} alt="用户粘贴的图片" />}</For></div>; }}</Match>
    <Match when={props.entry.kind === "assistant"}>{() => {
      const entry = props.entry as Extract<ConversationEntry, { kind: "assistant" }>;
      return <div class="agent-message assistant"><For each={entry.blocks}>{(block) => <AssistantBlock issue={props.issue} block={block} streaming={entry.streaming === true} />}</For><Show when={assistantNotice(entry)}>{(notice) => <div class="agent-message-notice">{notice()}</div>}</Show></div>;
    }}</Match>
    <Match when={props.entry.kind === "tool"}><ToolEntry entry={props.entry as Extract<ConversationEntry, { kind: "tool" }>} /></Match>
    <Match when={props.entry.kind === "summary"}><SessionSummaryEntry issue={props.issue} entry={props.entry as Extract<ConversationEntry, { kind: "summary" }>} /></Match>
    <Match when={props.entry.kind === "custom"}><CustomMessageEntry issue={props.issue} entry={props.entry as Extract<ConversationEntry, { kind: "custom" }>} /></Match>
    <Match when={props.entry.kind === "bash"}><BashMessageEntry entry={props.entry as Extract<ConversationEntry, { kind: "bash" }>} /></Match>
  </Switch>;
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  if (tokens < 10_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  return `${Math.round(tokens / 1_000_000)}M`;
}

const emptyFooter = (): AgentFooterStats => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
  latestCacheHitRate: null, contextPercent: null, contextWindow: 0, autoCompact: true,
});

function footerAfterEvent(current: AgentFooterStats, event: RunEvent["event"]): AgentFooterStats {
  const message = event.type === "message_end" && typeof event.message === "object" ? event.message : undefined;
  const usage = event.type === "entry_appended" && event.entry.type === "usage"
    ? event.entry.usage
    : (message?.role === "assistant" || message?.role === "toolResult") ? message.usage : undefined;
  if (!usage) return current;
  const next = {
    ...current,
    input: current.input + usage.input,
    output: current.output + usage.output,
    cacheRead: current.cacheRead + usage.cacheRead,
    cacheWrite: current.cacheWrite + usage.cacheWrite,
    cost: current.cost + usage.cost.total,
  };
  if (message?.role !== "assistant") return next;
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  const contextTokens = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return {
    ...next,
    latestCacheHitRate: promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : null,
    contextPercent: current.contextWindow > 0 ? (contextTokens / current.contextWindow) * 100 : null,
  };
}

function footerText(footer: AgentFooterStats): string {
  const contextPercent = footer.contextPercent === null ? "?" : `${footer.contextPercent.toFixed(1)}%`;
  const context = footer.contextWindow > 0
    ? `${contextPercent}/${formatTokens(footer.contextWindow)}${footer.autoCompact ? " (auto)" : ""}`
    : "";
  return [
    footer.input ? `↑${formatTokens(footer.input)}` : "",
    footer.output ? `↓${formatTokens(footer.output)}` : "",
    footer.cacheRead ? `R${formatTokens(footer.cacheRead)}` : "",
    footer.cacheWrite ? `W${formatTokens(footer.cacheWrite)}` : "",
    footer.latestCacheHitRate !== null && (footer.cacheRead > 0 || footer.cacheWrite > 0) ? `CH${footer.latestCacheHitRate.toFixed(1)}%` : "",
    footer.cost ? `$${footer.cost.toFixed(3)}` : "",
    context,
  ].filter(Boolean).join(" ");
}

export function AgentPanel(props: { issue: IssueDetail; hidden?: boolean; onRefresh: (issueKey: string) => Promise<IssueDetail> }) {
  const [connected, setConnected] = createSignal(false, { ownedWrite: true });
  const [sending, setSending] = createSignal(false, { ownedWrite: true });
  const [processing, setProcessing] = createSignal(false, { ownedWrite: true });
  const [issueStatus, setIssueStatus] = createSignal<IssueStatus>(untrack(() => props.issue.status), { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [draft, setDraft] = createSignal("", { ownedWrite: true });
  const [images, setImages] = createSignal<Array<{ file: File; url: string }>>([], { ownedWrite: true });
  const [entries, setEntries] = createSignal<ConversationEntry[]>([], { ownedWrite: true });
  const [unread, setUnread] = createSignal(0, { ownedWrite: true });
  const [activity, setActivity] = createSignal<AgentActivity | null>(null, { ownedWrite: true });
  const [queue, setQueue] = createSignal<{ steering: string[]; followUp: string[] }>({ steering: [], followUp: [] }, { ownedWrite: true });
  const [agent, setAgent] = createSignal({ provider: "", model: "", thinkingLevel: "" }, { ownedWrite: true });
  const [footer, setFooter] = createSignal<AgentFooterStats>(emptyFooter(), { ownedWrite: true });
  let panel: HTMLElement | undefined;
  let transcript: HTMLDivElement | undefined;
  let transcriptObserver: ResizeObserver | undefined;
  let editor: HTMLTextAreaElement | undefined;
  let issueGeneration = 0;
  let issueRefreshId = 0;
  let followLatest = true;
  const unreadEntryIds = new Set<string>();
  let messageUpdateFrame: number | undefined;
  let pendingMessageUpdates: Array<{ envelope: RunEvent; deltas: string[] | null }> = [];
  const pasteEditor = new PasteEditorModel();

  const running = () => processing();
  const canSend = () => issueStatus() !== "resolved";
  const usageText = () => footerText(footer());
  const codeRoot = () => props.issue.workingDirectory ?? `~/.issue-pilot/workspaces/${props.issue.id.toLowerCase()}`;
  const developmentRepositoriesPending = () => props.issue.environmentKey === "dev"
    && (!props.issue.repositories.length || props.issue.repositories.some((repository) => !repository.workingBranch));
  const clearUnread = () => {
    unreadEntryIds.clear();
    setUnread(0);
  };
  const scrollLatest = () => {
    transcript?.scrollTo({ top: transcript.scrollHeight, behavior: "auto" });
    followLatest = true;
    clearUnread();
  };
  const observeTranscript = (element: HTMLDivElement) => {
    transcript = element;
    transcriptObserver?.disconnect();
    transcriptObserver = new ResizeObserver(() => {
      if (followLatest) element.scrollTop = element.scrollHeight;
    });
    transcriptObserver.observe(element);
  };
  const focusConversation = (event: MouseEvent & { currentTarget: HTMLDivElement }) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest("a, button, input, textarea, select, [contenteditable='true']")) return;
    if (window.getSelection() && !window.getSelection()!.isCollapsed) return;
    panel?.focus({ preventScroll: true });
  };
  const handlePanelKeyDown = (event: KeyboardEvent & { currentTarget: HTMLElement }) => {
    if (event.key !== "Enter" || event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    scrollLatest();
  };
  const resizeEditor = (textarea = editor) => {
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${textarea.scrollHeight}px`;
    queueMicrotask(() => { if (followLatest && transcript) transcript.scrollTop = transcript.scrollHeight; });
  };
  const setEditorDraft = (value: string) => {
    setDraft(value);
    queueMicrotask(() => resizeEditor());
  };
  const discardImages = (items: Array<{ file: File; url: string }>) => {
    for (const image of items) URL.revokeObjectURL(image.url);
  };
  const removeImage = (url: string) => setImages((current) => {
    const removed = current.find((image) => image.url === url);
    if (removed) URL.revokeObjectURL(removed.url);
    return current.filter((image) => image.url !== url);
  });
  const updateConversation = (update: (current: ConversationEntry[]) => ConversationEntry[]) => {
    let addedEntryIds: string[] = [];
    setEntries((current) => {
      const currentIds = new Set(current.map(({ id }) => id));
      const next = update(current);
      addedEntryIds = next.filter(({ id }) => !currentIds.has(id)).map(({ id }) => id);
      return next;
    });
    queueMicrotask(() => {
      if (followLatest && transcript) {
        transcript.scrollTop = transcript.scrollHeight;
        return;
      }
      for (const id of addedEntryIds) unreadEntryIds.add(id);
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
    updateConversation((current) => updates.reduce((next, event) => applyAgentEvent(next, event), current));
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
    if (isDelta && previousPending?.deltas && previous && "delta" in previous
      && update.type === previous.type && update.contentIndex === previous.contentIndex) {
      previousPending.envelope = envelope;
      previousPending.deltas.push(update.delta);
      return;
    }
    pendingMessageUpdates.push({ envelope, deltas: isDelta ? [update.delta] : null });
  };
  const append = (event: RunEvent) => {
    if (event.event.type === "message_update") {
      queueMessageUpdate(event);
      if (messageUpdateFrame === undefined) messageUpdateFrame = window.requestAnimationFrame(() => {
        messageUpdateFrame = undefined;
        applyPendingMessageUpdates();
      });
      return;
    }
    flushMessageUpdates();
    updateConversation((current) => applyAgentEvent(current, event));
    setFooter((current) => footerAfterEvent(current, event.event));
    const type = event.event.type;
    setProcessing((current) => processingAfterEvent(current, event.event));
    const nextActivity = activityForEvent(event.event);
    if (nextActivity !== undefined) setActivity(nextActivity);
    if (type === "queue_update") setQueue({ steering: [...event.event.steering], followUp: [...event.event.followUp] });
    if (type === "issue_status") setIssueStatus(event.event.status === "complete" ? "pending" : "open");
  };
  const refreshIssue = (issueKey: string, connectionGeneration: number) => {
    const currentRefresh = ++issueRefreshId;
    void Promise.resolve().then(() => props.onRefresh(issueKey)).then(() => {
      if (streamController.isCurrent(connectionGeneration) && currentRefresh === issueRefreshId && error() === "issue_refresh_failed") setError("");
    }).catch(() => {
      if (streamController.isCurrent(connectionGeneration) && currentRefresh === issueRefreshId) setError("issue_refresh_failed");
    });
  };
  const streamController = new AgentStreamController(agentStreamUrl, issuePilotConfig.web.agentStreamReconnectMs, issuePilotConfig.web.agentStreamStaleMs, {
    onConnection: setConnected,
    onError: (streamError) => {
      if (!streamError && ["agent_event_connection_failed", "agent_event_protocol_error"].includes(error())) setError("");
      else if (streamError) setError(streamError);
    },
    onSnapshot: (payload, replay, generation) => {
      setEntries(replay.entries); setFooter(payload.footer ?? emptyFooter()); clearUnread();
      setActivity(replay.activity); setQueue(replay.queue); setAgent(payload.agent ?? { provider: "", model: "", thinkingLevel: "" });
      const statusChanged = Boolean(payload.issueStatus && ISSUE_STATUSES.includes(payload.issueStatus) && payload.issueStatus !== props.issue.status);
      if (payload.issueStatus && ISSUE_STATUSES.includes(payload.issueStatus)) setIssueStatus(payload.issueStatus);
      setProcessing(payload.running === true);
      if (statusChanged || (replay.agentStarted && developmentRepositoriesPending())) refreshIssue(props.issue.id, generation);
      queueMicrotask(scrollLatest);
    },
    onEvent: (envelope, generation) => {
      append(envelope);
      if (envelope.event.type === "issue_status" || envelope.event.type === "agent_start" || envelope.event.type === "tool_execution_end" && envelope.event.toolName === "workspace") refreshIssue(props.issue.id, generation);
    },
  });
  const connect = (issueId: string, resetForIssue = false) => {
    if (resetForIssue) {
      discardMessageUpdates();
      setEntries([]); setFooter(emptyFooter()); clearUnread(); setError("");
      setConnected(false); setProcessing(false); setActivity(null); setQueue({ steering: [], followUp: [] }); setAgent({ provider: "", model: "", thinkingLevel: "" });
      pasteEditor.reset(); setEditorDraft(""); discardImages(untrack(images)); setImages([]); setSending(false);
    }
    streamController.connect(issueId);
  };
  const submit = async () => {
    const editorText = draft();
    const pendingImages = images();
    const message = pasteEditor.expand(editorText).trim() || (pendingImages.length ? "请分析这些图片。" : "");
    if (!message || sending() || !canSend()) return;
    if (message.length > issuePilotConfig.limits.agentMessageChars) {
      setError(`消息共 ${message.length.toLocaleString()} 字符，超过 ${issuePilotConfig.limits.agentMessageChars.toLocaleString()} 字符上限，请分段发送。`);
      return;
    }
    const issueId = props.issue.id;
    const submitGeneration = issueGeneration;
    setEditorDraft(""); setImages([]); setSending(true); setError(""); scrollLatest();
    try {
      if (pendingImages.length) await sendAgentMessage(issueId, message, pendingImages.map(({ file }) => file));
      else await sendAgentMessage(issueId, message);
      if (submitGeneration !== issueGeneration) { discardImages(pendingImages); return; }
      discardImages(pendingImages); pasteEditor.reset(); setProcessing(true);
    } catch (cause) {
      if (submitGeneration !== issueGeneration) { discardImages(pendingImages); return; }
      setEditorDraft(editorText); setImages(pendingImages); setError(cause instanceof Error && cause.message === "agent_message_too_long" ? `消息超过 ${issuePilotConfig.limits.agentMessageChars.toLocaleString()} 字符上限，请分段发送。` : cause instanceof Error && cause.message === "invalid_agent_message" ? "消息内容无效，请输入文字后重新发送。" : cause instanceof Error ? cause.message : "agent_message_failed");
    } finally { if (submitGeneration === issueGeneration) setSending(false); }
  };
  const applyEditorResult = (textarea: HTMLTextAreaElement, edit: PasteEditResult) => {
    setEditorDraft(edit.value);
    queueMicrotask(() => {
      textarea.focus(); textarea.setSelectionRange(edit.selectionStart, edit.selectionEnd);
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
      if (accepted.length !== pastedImages.length || current.length + accepted.length > limits.files || accepted.some((file) => file.size > limits.fileBytes) || [...current.map(({ file }) => file), ...accepted].reduce((total, file) => total + file.size, 0) > limits.requestBytes) {
        setError("agent_image_limit_exceeded");
        return;
      }
      setImages([...current, ...accepted.map((file) => ({ file, url: URL.createObjectURL(file) }))]);
    }
    const edit = pasteEditor.insert(draft(), textarea.selectionStart ?? draft().length, textarea.selectionEnd ?? draft().length, clipboard?.getData("text/plain") ?? "");
    if (!edit) return;
    event.preventDefault(); applyEditorResult(textarea, edit);
  };
  const handleEditorInput = (event: InputEvent & { currentTarget: HTMLTextAreaElement }) => {
    const textarea = event.currentTarget;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const edit = pasteEditor.reconcile(textarea.value, start, end);
    if (edit.value === textarea.value && edit.selectionStart === start && edit.selectionEnd === end) {
      setEditorDraft(edit.value);
      return;
    }
    applyEditorResult(textarea, edit);
  };
  const protectPasteSelection = (event: Event & { currentTarget: HTMLTextAreaElement }) => {
    const textarea = event.currentTarget;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? start;
    if (start === end) {
      const cursor = pasteEditor.snapCursor(draft(), start, "nearest");
      if (cursor !== start) textarea.setSelectionRange(cursor, cursor);
      return;
    }
    const selection = pasteEditor.expandSelection(draft(), start, end);
    if (selection.start !== start || selection.end !== end) textarea.setSelectionRange(selection.start, selection.end);
  };
  const handleEditorKeyDown = (event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) => {
    if (event.isComposing) return;
    const textarea = event.currentTarget;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? start;
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !event.shiftKey && start === end) {
      const cursor = pasteEditor.snapCursor(draft(), start, event.key === "ArrowLeft" ? "backward" : "forward");
      if (cursor !== start) {
        event.preventDefault(); textarea.setSelectionRange(cursor, cursor);
      }
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      const edit = pasteEditor.delete(draft(), start, end, event.key === "Backspace" ? "backward" : "forward");
      if (edit) {
        event.preventDefault(); applyEditorResult(textarea, edit);
      }
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault(); void submit();
    }
  };
  createEffect(() => ({ id: props.issue.id, status: props.issue.status }), ({ id, status }, previous) => {
    setIssueStatus(status);
    if (previous?.id === id) {
      if (previous.status === "resolved" && status === "open") connect(id);
      return;
    }
    issueGeneration += 1;
    connect(id, true);
  });
  onCleanup(() => { issueGeneration += 1; transcriptObserver?.disconnect(); discardMessageUpdates(); discardImages(untrack(images)); streamController.dispose(); });

  return <section ref={panel} class="agent-panel" aria-label={`${props.issue.id} Agent 会话`} tabindex={0} hidden={props.hidden} onKeyDown={handlePanelKeyDown}>
    <div ref={observeTranscript} class="agent-scroll ip-scrollbar ip-scrollbar-dark" onClick={focusConversation} onScroll={(event) => { const element = event.currentTarget; followLatest = element.scrollHeight - element.scrollTop - element.clientHeight < 32; if (followLatest) clearUnread(); }}>
      <div class="agent-conversation" role="log" aria-live="polite">
        <For each={entries()}>{(entry) => <ConversationItem issue={props.issue} entry={entry} />}</For>
        <Show when={!entries().length && connected()}><div class="agent-empty">No conversation yet</div></Show>
      </div>
      <Show when={queue().steering.length || queue().followUp.length}><div class="agent-queue"><For each={queue().steering}>{(message) => <span><strong>Steering:</strong> {message}</span>}</For><For each={queue().followUp}>{(message) => <span><strong>Follow-up:</strong> {message}</span>}</For></div></Show>
      <Show when={running() || activity()}><div class={`agent-working ${activity()?.tone ?? "info"}`} role="status"><i />{activity()?.text ?? "Working..."}</div></Show>
      <div class="agent-composer-gutter">
        <div class={`agent-composer thinking-${agent().thinkingLevel || "off"}`}>
          <Show when={images().length}><div class="agent-composer-images"><For each={images()}>{(image) => <figure><img src={image.url} alt={image.file.name || "待发送图片"} /><button type="button" aria-label={`移除图片 ${image.file.name || "未命名"}`} onClick={() => removeImage(image.url)}>×</button></figure>}</For></div></Show>
          <textarea ref={editor} rows={1} aria-label="发送给 Agent" value={draft()} disabled={sending() || !canSend()} onInput={handleEditorInput} onPaste={handlePaste} onSelect={protectPasteSelection} onKeyDown={handleEditorKeyDown} />
        </div>
      </div>
      <Show when={error()}><div class="agent-panel-error" role="alert">{panelError(error())}</div></Show>
      <footer class="agent-meta">
        <div class="agent-meta-primary"><span title={`代码目录：${codeRoot()}`}>{codeRoot()}</span></div>
        <div class="agent-meta-secondary"><span>{usageText()}</span><span><b>{agent().model || "no-model"}</b>{agent().thinkingLevel ? ` • ${agent().thinkingLevel}` : ""}</span></div>
      </footer>
    </div>
    <Show when={unread() > 0}><Button class="agent-scroll-latest" shape="round" size="small" icon={<ArrowDown size={14} />} onClick={scrollLatest}>{unread()} 条新消息</Button></Show>
  </section>;
}
