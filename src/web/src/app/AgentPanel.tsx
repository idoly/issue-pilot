import { Button } from "@idoly/ant-design-solid";
import { createEffect, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import type { ImageContent } from "@earendil-works/pi-ai";

import { agentStreamUrl, sendAgentMessage, type AgentFooterStats, type IssueDetail, type RunEvent } from "../data/client";
import { ArrowDown, ChevronRight } from "../ui/icons";
import { Markdown } from "../ui/Markdown";
import { activityForEvent, applyAgentEvent, assistantNotice, diffLineClass, duration, panelError, processingAfterEvent, resultText, shellToolOutput, toolLabel, toolLabelParts, type AgentActivity, type ConversationEntry } from "./conversation";
import { PasteEditorModel, type PasteEditResult } from "./paste-editor";
import { piDarkThemeStyle } from "./pi-theme";

function ToolEntry(props: { entry: Extract<ConversationEntry, { kind: "tool" }> }) {
  const label = () => toolLabel(props.entry);
  const labelParts = () => toolLabelParts(label());
  const diff = () => {
    if (props.entry.name !== "edit" || !props.entry.result?.details || typeof props.entry.result.details !== "object") return [];
    const value = (props.entry.result.details as Record<string, unknown>).diff;
    return typeof value === "string" ? value.split("\n") : [];
  };
  const output = () => shellToolOutput(props.entry);
  const genericOutput = () => ["bash", "edit", "write", "read", "grep", "find", "ls"].includes(props.entry.name) ? "" : resultText(props.entry);
  const images = () => props.entry.result?.content.filter((part): part is ImageContent => part.type === "image") ?? [];
  return <div class={`agent-tool ${props.entry.status}`}>
    <div class="agent-tool-head"><code title={label()}><b>{labelParts().action}</b><Show when={labelParts().target}><span>{labelParts().target}</span></Show><Show when={labelParts().range}><em>{labelParts().range}</em></Show></code></div>
    <Show when={diff().length}><pre class="agent-tool-diff"><For each={diff()}>{(line) => <span class={diffLineClass(line)}>{line}{"\n"}</span>}</For></pre></Show>
    <Show when={output()}>{(result) => <>
      <Show when={result().lines.length}><pre class="agent-tool-output"><Show when={result().omitted}><span class="omitted">... ({result().omitted} earlier lines)</span></Show><For each={result().lines}>{(line) => <span>{line}{"\n"}</span>}</For></pre></Show>
      <Show when={props.entry.durationMs !== undefined}><div class="agent-tool-timing">Took {duration(props.entry.durationMs)}</div></Show>
    </>}</Show>
    <Show when={genericOutput()}>{(text) => <pre class="agent-tool-output">{text()}</pre>}</Show>
    <For each={images()}>{(image) => <img class="agent-inline-image" src={`data:${image.mimeType};base64,${image.data}`} alt="Tool output" />}</For>
  </div>;
}

function SessionSummaryEntry(props: { entry: Extract<ConversationEntry, { kind: "summary" }> }) {
  const [expanded, setExpanded] = createSignal(false, { ownedWrite: true });
  const label = () => props.entry.summaryType === "compaction" ? "compaction" : "branch";
  const description = () => props.entry.summaryType === "compaction"
    ? `Compacted from ${(props.entry.tokensBefore ?? 0).toLocaleString()} tokens`
    : "Branch summary";
  return <section class="agent-summary">
    <button type="button" aria-expanded={expanded() ? "true" : "false"} onClick={() => setExpanded((value) => !value)}>
      <strong>[{label()}]</strong><span>{description()}</span><ChevronRight class={expanded() ? "expanded" : ""} size={14} />
    </button>
    <Show when={expanded()}><div class="agent-summary-content"><Markdown source={props.entry.summary} /></div></Show>
  </section>;
}

function CustomMessageEntry(props: { entry: Extract<ConversationEntry, { kind: "custom" }> }) {
  return <section class="agent-custom-message"><strong>[{props.entry.label}]</strong><For each={props.entry.blocks}>{(block) => block.type === "text"
    ? <Markdown source={block.value} />
    : <img class="agent-inline-image" src={`data:${block.mimeType};base64,${block.data}`} alt="Custom message" />}</For></section>;
}

function BashMessageEntry(props: { entry: Extract<ConversationEntry, { kind: "bash" }> }) {
  const failed = () => props.entry.cancelled || (props.entry.exitCode !== undefined && props.entry.exitCode !== 0);
  return <section class={`agent-tool ${failed() ? "error" : "complete"}`}><strong class="agent-bash-command">$ {props.entry.command}</strong><Show when={props.entry.output}><pre class="agent-tool-output">{props.entry.output}</pre></Show><Show when={props.entry.truncated}><div class="agent-tool-timing">Output truncated</div></Show></section>;
}

function ConversationItem(props: { entry: ConversationEntry }) {
  return <Switch>
    <Match when={props.entry.kind === "user"}><div class="agent-message user"><Markdown source={(props.entry as Extract<ConversationEntry, { kind: "user" }>).text} /></div></Match>
    <Match when={props.entry.kind === "assistant"}><div class="agent-message assistant"><For each={(props.entry as Extract<ConversationEntry, { kind: "assistant" }>).blocks}>{(block) => block.type === "text" ? <Markdown source={block.value} /> : <div class="agent-thinking"><Markdown source={block.value} /></div>}</For><Show when={assistantNotice(props.entry as Extract<ConversationEntry, { kind: "assistant" }>)}>{(notice) => <div class="agent-message-notice">{notice()}</div>}</Show></div></Match>
    <Match when={props.entry.kind === "tool"}><ToolEntry entry={props.entry as Extract<ConversationEntry, { kind: "tool" }>} /></Match>
    <Match when={props.entry.kind === "summary"}><SessionSummaryEntry entry={props.entry as Extract<ConversationEntry, { kind: "summary" }>} /></Match>
    <Match when={props.entry.kind === "custom"}><CustomMessageEntry entry={props.entry as Extract<ConversationEntry, { kind: "custom" }>} /></Match>
    <Match when={props.entry.kind === "bash"}><BashMessageEntry entry={props.entry as Extract<ConversationEntry, { kind: "bash" }>} /></Match>
  </Switch>;
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

const emptyFooter = (): AgentFooterStats => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
  latestCacheHitRate: null, contextPercent: null, contextWindow: 0, autoCompact: true,
});

function footerAfterEvent(current: AgentFooterStats, event: RunEvent["event"]): AgentFooterStats {
  if (event.type !== "message_end" || typeof event.message !== "object") return current;
  const message = event.message;
  const usage = message.role === "assistant" || message.role === "toolResult" ? message.usage : undefined;
  if (!usage) return current;
  const next = {
    ...current,
    input: current.input + usage.input,
    output: current.output + usage.output,
    cacheRead: current.cacheRead + usage.cacheRead,
    cacheWrite: current.cacheWrite + usage.cacheWrite,
    cost: current.cost + usage.cost.total,
  };
  if (message.role !== "assistant") return next;
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  const contextTokens = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return {
    ...next,
    latestCacheHitRate: promptTokens > 0 ? (usage.cacheRead / promptTokens) * 100 : null,
    contextPercent: current.contextWindow > 0 ? (contextTokens / current.contextWindow) * 100 : null,
  };
}

function footerText(value: AgentFooterStats): string {
  const contextPercent = value.contextPercent === null ? "?" : `${value.contextPercent.toFixed(1)}%`;
  const context = value.contextWindow > 0
    ? `${contextPercent}/${formatTokens(value.contextWindow)}${value.autoCompact ? " (auto)" : ""}`
    : "";
  return [
    value.input ? `↑${formatTokens(value.input)}` : "",
    value.output ? `↓${formatTokens(value.output)}` : "",
    value.cacheRead ? `R${formatTokens(value.cacheRead)}` : "",
    value.cacheWrite ? `W${formatTokens(value.cacheWrite)}` : "",
    value.latestCacheHitRate !== null && (value.cacheRead > 0 || value.cacheWrite > 0) ? `CH${value.latestCacheHitRate.toFixed(1)}%` : "",
    value.cost ? `$${value.cost.toFixed(3)}` : "",
    context,
  ].filter(Boolean).join(" ");
}

export function AgentPanel(props: { issue: IssueDetail; onRefresh: (issueId: string) => Promise<IssueDetail> }) {
  const [connected, setConnected] = createSignal(false, { ownedWrite: true });
  const [sending, setSending] = createSignal(false, { ownedWrite: true });
  const [processing, setProcessing] = createSignal(false, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [draft, setDraft] = createSignal("", { ownedWrite: true });
  const [entries, setEntries] = createSignal<ConversationEntry[]>([], { ownedWrite: true });
  const [unread, setUnread] = createSignal(0, { ownedWrite: true });
  const [activity, setActivity] = createSignal<AgentActivity | null>(null, { ownedWrite: true });
  const [queue, setQueue] = createSignal<{ steering: string[]; followUp: string[] }>({ steering: [], followUp: [] }, { ownedWrite: true });
  const [agent, setAgent] = createSignal({ provider: "", model: "", thinkingLevel: "" }, { ownedWrite: true });
  const [footer, setFooter] = createSignal<AgentFooterStats>(emptyFooter(), { ownedWrite: true });
  let transcript: HTMLElement | undefined;
  let editor: HTMLTextAreaElement | undefined;
  let stream: EventSource | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let connectionId = 0;
  let replayComplete = false;
  let followLatest = true;
  const eventIds = new Set<string>();
  const pasteEditor = new PasteEditorModel();

  const running = () => processing() || props.issue.workspace.status === "preparing" || props.issue.workspace.status === "running";
  const canSend = () => props.issue.status !== "resolved";
  const usageText = () => footerText(footer());
  const executionRoot = () => props.issue.environmentKey === "dev"
    ? `~/.issue-pilot/workspaces/${props.issue.id.toLowerCase()}`
    : `~/.issue-pilot/sessions/${props.issue.id.toLowerCase()}/runtime`;
  const scrollLatest = () => {
    transcript?.scrollTo({ top: transcript.scrollHeight, behavior: "smooth" });
    followLatest = true;
    setUnread(0);
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
  const append = (event: RunEvent) => {
    if (eventIds.has(event.id)) return;
    eventIds.add(event.id);
    setEntries((current) => applyAgentEvent(current, event));
    if (replayComplete) setFooter((current) => footerAfterEvent(current, event.event));
    const type = event.event.type;
    setProcessing((current) => processingAfterEvent(current, event.event));
    const nextActivity = activityForEvent(event.event);
    if (nextActivity !== undefined) setActivity(nextActivity);
    if (type === "queue_update") setQueue({ steering: [...event.event.steering], followUp: [...event.event.followUp] });
    queueMicrotask(() => {
      if (followLatest && transcript) transcript.scrollTop = transcript.scrollHeight;
      else if (replayComplete) setUnread((value) => value + 1);
    });
  };
  const connect = (issueId: string) => {
    stream?.close();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    eventIds.clear(); pasteEditor.reset(); setEditorDraft(""); setEntries([]); setFooter(emptyFooter()); setUnread(0); setError("");
    setConnected(false); setSending(false); setProcessing(false); setActivity(null); setQueue({ steering: [], followUp: [] }); setAgent({ provider: "", model: "", thinkingLevel: "" }); replayComplete = false;
    const currentConnection = ++connectionId;
    const source = new EventSource(agentStreamUrl(issueId));
    stream = source;
    source.addEventListener("open", () => { if (currentConnection === connectionId) { setConnected(true); setError(""); } });
    source.addEventListener("ready", (event) => {
      if (currentConnection !== connectionId) return;
      try {
        const payload = JSON.parse(event.data) as { agent?: { provider: string; model: string; thinkingLevel: string }; footer?: AgentFooterStats; running?: boolean };
        if (payload.agent) setAgent(payload.agent);
        if (payload.footer) setFooter(payload.footer);
        setProcessing(payload.running === true); replayComplete = true; queueMicrotask(scrollLatest);
      } catch { setError("agent_event_protocol_error"); }
    });
    source.addEventListener("message", (event) => {
      if (currentConnection !== connectionId) return;
      try {
        const parsed = JSON.parse(event.data) as Partial<RunEvent>;
        if (!parsed.event || typeof parsed.event.type !== "string") throw new Error("agent_event_protocol_error");
        const envelope = parsed as RunEvent;
        append(envelope);
        if (envelope.event.type === "compaction_end" && !envelope.event.aborted && !envelope.event.willRetry) {
          queueMicrotask(() => connect(issueId));
          return;
        }
        if (replayComplete && envelope.event.type === "issue_status") void props.onRefresh(issueId);
      } catch { setError("agent_event_protocol_error"); }
    });
    source.addEventListener("error", () => {
      if (currentConnection !== connectionId) return;
      source.close(); setConnected(false); setError("agent_event_connection_failed");
      reconnectTimer = setTimeout(() => connect(issueId), 1_000);
    });
  };
  const submit = async () => {
    const editorText = draft();
    const message = pasteEditor.expand(editorText).trim();
    if (!message || sending() || !canSend()) return;
    const issueId = props.issue.id;
    const submitConnection = connectionId;
    setEditorDraft(""); setSending(true); setError(""); scrollLatest();
    try {
      await sendAgentMessage(issueId, message);
      if (submitConnection !== connectionId) return;
      pasteEditor.reset(); setProcessing(true);
    } catch (cause) {
      if (submitConnection !== connectionId) return;
      setEditorDraft(editorText); setError(cause instanceof Error ? cause.message : "agent_message_failed");
    } finally { if (submitConnection === connectionId) setSending(false); }
  };
  const applyEditorResult = (textarea: HTMLTextAreaElement, result: PasteEditResult) => {
    setEditorDraft(result.value);
    queueMicrotask(() => {
      textarea.focus(); textarea.setSelectionRange(result.selectionStart, result.selectionEnd);
    });
  };
  const handlePaste = (event: ClipboardEvent & { currentTarget: HTMLTextAreaElement }) => {
    const textarea = event.currentTarget;
    const result = pasteEditor.insert(draft(), textarea.selectionStart ?? draft().length, textarea.selectionEnd ?? draft().length, event.clipboardData?.getData("text/plain") ?? "");
    if (!result) return;
    event.preventDefault();
    applyEditorResult(textarea, result);
  };
  const handleEditorInput = (event: InputEvent & { currentTarget: HTMLTextAreaElement }) => {
    const textarea = event.currentTarget;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? textarea.value.length;
    const result = pasteEditor.reconcile(textarea.value, start, end);
    if (result.value === textarea.value && result.selectionStart === start && result.selectionEnd === end) {
      setEditorDraft(result.value);
      return;
    }
    applyEditorResult(textarea, result);
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
      const result = pasteEditor.delete(draft(), start, end, event.key === "Backspace" ? "backward" : "forward");
      if (result) {
        event.preventDefault(); applyEditorResult(textarea, result);
      }
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault(); void submit();
    }
  };
  createEffect(() => props.issue.id, (issueId) => connect(issueId));
  onCleanup(() => { connectionId += 1; stream?.close(); if (reconnectTimer) clearTimeout(reconnectTimer); });

  return <section ref={transcript} class="agent-panel" style={piDarkThemeStyle} aria-label={`${props.issue.id} Agent 会话`} onScroll={(event) => { const element = event.currentTarget; followLatest = element.scrollHeight - element.scrollTop - element.clientHeight < 32; if (followLatest) setUnread(0); }}>
    <div class="agent-conversation" role="log" aria-live="polite">
      <For each={entries()}>{(entry) => <ConversationItem entry={entry} />}</For>
      <Show when={!entries().length && connected()}><div class="agent-empty">No conversation yet</div></Show>
    </div>
    <Show when={unread() > 0}><Button class="agent-scroll-latest" shape="round" size="small" icon={<ArrowDown size={14} />} onClick={scrollLatest}>{unread()} 条新消息</Button></Show>
    <Show when={queue().steering.length || queue().followUp.length}><div class="agent-queue"><For each={queue().steering}>{(message) => <span><strong>Steering:</strong> {message}</span>}</For><For each={queue().followUp}>{(message) => <span><strong>Follow-up:</strong> {message}</span>}</For></div></Show>
    <Show when={running() || activity()}><div class={`agent-working ${activity()?.tone ?? "info"}`} role="status"><i />{activity()?.text ?? "Working..."}</div></Show>
    <div class="agent-composer-gutter">
      <div class={`agent-composer thinking-${agent().thinkingLevel || "off"}`}>
        <textarea ref={editor} rows={1} aria-label="发送给 Agent" value={draft()} disabled={sending() || !canSend()} onInput={handleEditorInput} onPaste={handlePaste} onSelect={protectPasteSelection} onKeyDown={handleEditorKeyDown} />
      </div>
    </div>
    <Show when={error()}><div class="agent-panel-error" role="alert">{panelError(error())}</div></Show>
    <footer class="agent-meta">
      <div class="agent-meta-primary"><span title={executionRoot()}>{executionRoot()}</span></div>
      <div class="agent-meta-secondary"><span>{usageText()}</span><span><b>{agent().model || "no-model"}</b>{agent().thinkingLevel ? ` • ${agent().thinkingLevel}` : ""}</span></div>
    </footer>
  </section>;
}
