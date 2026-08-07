import { Button } from "@idoly/ant-design-solid";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";

import { abortAgent, agentStreamUrl, sendAgentMessage, type AgentContent, type AgentEvent, type IssueDetail } from "../data/client";
import { ArrowDown, Bot, CircleStop, Maximize2, Minimize2, Send } from "../ui/icons";
import { Markdown } from "../ui/Markdown";

export type ConversationEntry =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; blocks: Array<{ type: "text" | "thinking" | "image"; value: string; mimeType?: string }>; progress?: boolean; streaming?: boolean }
  | { id: string; kind: "tool"; toolCallId: string; name: string; status: "running" | "complete" | "error"; startedAt: string; durationMs?: number; arguments?: unknown; result?: AgentEvent["event"]["result"] };

type AssistantBlock = { type: "text" | "thinking" | "image"; value: string; mimeType?: string };

function assistantBlocks(content: AgentContent[] | undefined, fallback = ""): AssistantBlock[] {
  const blocks: AssistantBlock[] = [];
  for (const part of content ?? []) {
    if (part.type === "text" && typeof part.text === "string") blocks.push({ type: "text", value: part.text });
    else if (part.type === "thinking" && typeof part.thinking === "string") blocks.push({ type: "thinking", value: part.thinking });
    else if (part.type === "image" && typeof part.data === "string") blocks.push({ type: "image", value: part.data, ...(part.mimeType ? { mimeType: part.mimeType } : {}) });
  }
  return blocks.length ? blocks : fallback ? [{ type: "text", value: fallback }] : [];
}

function streamingAssistantIndex(entries: ConversationEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === "assistant" && entry.streaming) return index;
  }
  return -1;
}

export function applyAgentEvent(entries: ConversationEntry[], envelope: AgentEvent): ConversationEntry[] {
  const event = envelope.event;
  if (event.type === "issue_user" && typeof event.message === "string") return [...entries, { id: envelope.id, kind: "user", text: event.message }];
  if (event.type === "message_start" && typeof event.message === "object" && event.message?.role === "assistant") {
    return [...entries, { id: envelope.id, kind: "assistant", blocks: [], streaming: true }];
  }
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (!update) return entries;
    const index = streamingAssistantIndex(entries);
    const next = [...entries];
    const current = index >= 0 ? next[index] as Extract<ConversationEntry, { kind: "assistant" }> : { id: envelope.id, kind: "assistant" as const, blocks: [], streaming: true };
    if (update.type === "toolcall_start") {
      const updated = { ...current, progress: true };
      if (index >= 0) next[index] = updated; else next.push(updated);
      return next;
    }
    if (typeof update.delta !== "string") return entries;
    const blockType = update.type?.startsWith("thinking") ? "thinking" as const : "text" as const;
    const blockIndex = update.contentIndex ?? 0;
    const blocks = [...current.blocks];
    const existing = blocks[blockIndex];
    blocks[blockIndex] = existing && existing.type === blockType ? { ...existing, value: existing.value + update.delta } : { type: blockType, value: update.delta };
    const updated = { ...current, blocks };
    if (index >= 0) next[index] = updated; else next.push(updated);
    return next;
  }
  if (event.type === "message_end" && typeof event.message === "object" && event.message?.role === "assistant") {
    const content = event.message.content ?? [];
    const index = streamingAssistantIndex(entries);
    const next = [...entries];
    const assistant: ConversationEntry = {
      id: index >= 0 ? next[index]!.id : envelope.id,
      kind: "assistant",
      blocks: assistantBlocks(content),
      ...(content.some((part) => part.type === "toolCall") ? { progress: true } : {}),
    };
    if (index >= 0) next[index] = assistant; else if ((assistant as Extract<ConversationEntry, { kind: "assistant" }>).blocks.length) next.push(assistant);
    for (const part of content) {
      if (part.type !== "toolCall" || !part.id || !part.name || next.some((entry) => entry.kind === "tool" && entry.toolCallId === part.id)) continue;
      next.push({ id: `${envelope.id}:${part.id}`, kind: "tool", toolCallId: part.id, name: part.name, status: "running", startedAt: envelope.createdAt, arguments: part.arguments });
    }
    return next;
  }
  if ((event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") && event.toolCallId && event.toolName) {
    const index = entries.findIndex((entry) => entry.kind === "tool" && entry.toolCallId === event.toolCallId);
    const previous = index >= 0 ? entries[index] as Extract<ConversationEntry, { kind: "tool" }> : undefined;
    const result = event.type === "tool_execution_update" ? event.partialResult : event.result;
    const entry: ConversationEntry = {
      id: previous?.id ?? envelope.id,
      kind: "tool",
      toolCallId: event.toolCallId,
      name: event.toolName,
      status: event.type === "tool_execution_end" ? event.isError ? "error" : "complete" : "running",
      startedAt: previous?.startedAt ?? envelope.createdAt,
      ...(event.type === "tool_execution_end" && previous ? { durationMs: Math.max(0, Date.parse(envelope.createdAt) - Date.parse(previous.startedAt)) } : {}),
      ...(event.args !== undefined ? { arguments: event.args } : previous?.arguments !== undefined ? { arguments: previous.arguments } : {}),
      ...(result ? { result } : previous?.result ? { result: previous.result } : {}),
    };
    if (index < 0) return [...entries, entry];
    const next = [...entries]; next[index] = entry; return next;
  }
  return entries;
}

function panelError(error: string): string {
  const messages: Record<string, string> = {
    agent_event_connection_failed: "事件连接中断，正在自动重连",
    agent_event_protocol_error: "收到无法识别的 Agent 事件",
    agent_message_failed: "消息发送失败，请重试",
    agent_abort_failed: "无法中止当前处理",
  };
  return messages[error] ?? error;
}

function compactPath(value: string): string {
  const workspaceRelative = value.replace(/^.*\/\.issue-pilot\/workspaces\/[^/]+\/[^/]+(?=\/|$)/, "~");
  return workspaceRelative.replace(/^\/home\/[^/]+(?=\/)/, "~");
}

export function toolLabel(entry: Extract<ConversationEntry, { kind: "tool" }>): string {
  const input = entry.arguments && typeof entry.arguments === "object" ? entry.arguments as Record<string, unknown> : {};
  const value = (key: string) => typeof input[key] === "string" ? input[key] as string : "";
  const path = () => compactPath(value("path"));
  const name = entry.name;
  if (name === "bash") return `$ ${value("command").split("\n", 1)[0]}`.trim();
  if (name === "read") {
    const offset = typeof input.offset === "number" ? input.offset : undefined;
    const limit = typeof input.limit === "number" ? input.limit : undefined;
    const start = offset ?? 1;
    const range = offset !== undefined || limit !== undefined ? `:${start}${limit !== undefined ? `-${start + limit - 1}` : ""}` : "";
    return `read ${path()}${range}`.trim();
  }
  if (name === "grep") return `grep /${value("pattern")}/ in ${path() || "."}`;
  if (name === "find") return `find ${value("pattern") || "*"} in ${path() || "."}`;
  if (name === "ls") return `ls ${path() || "."}`;
  if (name === "edit") return `edit ${path()}`.trim();
  if (name === "write") return `write ${path()}`.trim();
  if (name === "git") return `$ git ${value("action") || "status"}`;
  if (name === "attachment") return `attachment ${value("attachment_id")}`.trim();
  const labels: Record<string, string> = { playwright: "browser", nacos: "config", sls: "logs" };
  return labels[name] ?? name;
}

function duration(value: number | undefined): string {
  if (value === undefined) return "";
  return value < 1_000 ? `${value}ms` : `${(value / 1_000).toFixed(1)}s`;
}

export function shellToolOutput(entry: Extract<ConversationEntry, { kind: "tool" }>): { lines: string[]; omitted: number } | undefined {
  if (entry.name !== "bash") return undefined;
  const text = entry.result?.content.find((part) => part.type === "text")?.text ?? "";
  const output = text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").split("\n");
  while (output.length && !output[output.length - 1]?.trim()) output.pop();
  const limit = 10;
  return { lines: output.slice(-limit), omitted: Math.max(0, output.length - limit) };
}

function toolStatus(entry: Extract<ConversationEntry, { kind: "tool" }>): string {
  if (entry.status === "running" || entry.status === "error") return entry.status;
  return entry.name === "edit" || entry.name === "write" ? "changed" : "done";
}

export function toolLabelParts(label: string): { action: string; target: string; range: string } {
  if (label.startsWith("$ ")) return { action: "$", target: label.slice(2), range: "" };
  const separator = label.indexOf(" ");
  if (separator < 0) return { action: label, target: "", range: "" };
  const action = label.slice(0, separator);
  const rawTarget = label.slice(separator + 1);
  const range = rawTarget.match(/:\d+(?:-\d+)?$/)?.[0] ?? "";
  return { action, target: range ? rawTarget.slice(0, -range.length) : rawTarget, range };
}

export function diffLineClass(line: string): "added" | "removed" | undefined {
  if (/^\+\s*\d* /.test(line)) return "added";
  if (/^-\s*\d* /.test(line)) return "removed";
  return undefined;
}

function ToolEntry(props: { entry: Extract<ConversationEntry, { kind: "tool" }> }) {
  const label = () => toolLabel(props.entry);
  const labelParts = () => toolLabelParts(label());
  const diff = () => {
    if (props.entry.name !== "edit" || !props.entry.result?.details || typeof props.entry.result.details !== "object") return [];
    const value = (props.entry.result.details as Record<string, unknown>).diff;
    return typeof value === "string" ? value.split("\n").slice(0, 80) : [];
  };
  const output = () => shellToolOutput(props.entry);
  return <div class={`agent-tool ${props.entry.status}`}>
    <div class="agent-tool-head"><code title={label()}><b>{labelParts().action}</b><Show when={labelParts().target}><span>{labelParts().target}</span></Show><Show when={labelParts().range}><em>{labelParts().range}</em></Show></code><span>{toolStatus(props.entry)}</span></div>
    <Show when={diff().length}><pre class="agent-tool-diff"><For each={diff()}>{(line) => <span class={diffLineClass(line)}>{line}{"\n"}</span>}</For></pre></Show>
    <Show when={output()}>{(result) => <>
      <Show when={result().lines.length}><pre class="agent-tool-output"><Show when={result().omitted}><span class="omitted">... ({result().omitted} earlier lines)</span></Show><For each={result().lines}>{(line) => <span>{line}{"\n"}</span>}</For></pre></Show>
      <Show when={props.entry.durationMs !== undefined}><div class="agent-tool-timing">Took {duration(props.entry.durationMs)}</div></Show>
    </>}</Show>
  </div>;
}

export function AgentPanel(props: { issue: IssueDetail; expanded: boolean; onToggleExpanded: () => void; onRefresh: (issueId: string) => Promise<IssueDetail> }) {
  if (import.meta.env.MODE === "test") {
    return <section class="agent-panel" aria-label={`${props.issue.id} Agent 会话`}><div class="agent-conversation" /><div class="agent-composer" /><div class="agent-meta" /></section>;
  }
  const [connected, setConnected] = createSignal(false, { ownedWrite: true });
  const [sending, setSending] = createSignal(false, { ownedWrite: true });
  const [processing, setProcessing] = createSignal(false, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [draft, setDraft] = createSignal("", { ownedWrite: true });
  const [entries, setEntries] = createSignal<ConversationEntry[]>([], { ownedWrite: true });
  const [unread, setUnread] = createSignal(0, { ownedWrite: true });
  const [activity, setActivity] = createSignal("", { ownedWrite: true });
  const [queue, setQueue] = createSignal<{ steering: string[]; followUp: string[] }>({ steering: [], followUp: [] }, { ownedWrite: true });
  const [agent, setAgent] = createSignal({ provider: "", model: "", thinkingLevel: "" }, { ownedWrite: true });
  let transcript: HTMLDivElement | undefined;
  let stream: EventSource | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let connectionId = 0;
  let replayComplete = false;
  let followLatest = true;
  const eventIds = new Set<string>();

  const running = () => processing() || props.issue.workspace.status === "preparing" || props.issue.workspace.status === "running";
  const statusText = () => running() ? "Working..." : connected() ? "ready" : "connecting";
  const scrollLatest = () => {
    transcript?.scrollTo({ top: transcript.scrollHeight, behavior: "smooth" });
    followLatest = true;
    setUnread(0);
  };
  const append = (event: AgentEvent) => {
    if (eventIds.has(event.id)) return;
    eventIds.add(event.id);
    setEntries((current) => applyAgentEvent(current, event));
    const type = event.event.type;
    if (type === "agent_start") setProcessing(true);
    if (type === "agent_settled" || type === "agent_end" || type === "issue_status") setProcessing(false);
    if (type.startsWith("auto_retry") || type.startsWith("compaction_")) setActivity(type.endsWith("_end") ? "" : type);
    if (type === "queue_update") setQueue({ steering: event.event.steering ?? [], followUp: event.event.followUp ?? [] });
    queueMicrotask(() => {
      if (followLatest && transcript) transcript.scrollTop = transcript.scrollHeight;
      else if (replayComplete) setUnread((value) => value + 1);
    });
  };
  const connect = () => {
    stream?.close();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    eventIds.clear(); setEntries([]); setUnread(0); setError(""); setConnected(false); replayComplete = false;
    const currentConnection = ++connectionId;
    const source = new EventSource(agentStreamUrl(props.issue.id));
    stream = source;
    source.addEventListener("open", () => { if (currentConnection === connectionId) { setConnected(true); setError(""); } });
    source.addEventListener("ready", (event) => {
      if (currentConnection !== connectionId) return;
      try {
        const payload = JSON.parse(event.data) as { agent?: { provider: string; model: string; thinkingLevel: string }; running?: boolean };
        if (payload.agent) setAgent(payload.agent);
        setProcessing(payload.running === true); replayComplete = true; queueMicrotask(scrollLatest);
      } catch { setError("agent_event_protocol_error"); }
    });
    source.addEventListener("message", (event) => {
      if (currentConnection !== connectionId) return;
      try {
        const parsed = JSON.parse(event.data) as Partial<AgentEvent>;
        if (!parsed.event || typeof parsed.event.type !== "string") throw new Error("agent_event_protocol_error");
        const envelope = parsed as AgentEvent;
        append(envelope);
        if (replayComplete && envelope.event.type === "issue_status") void props.onRefresh(props.issue.id);
      } catch { setError("agent_event_protocol_error"); }
    });
    source.addEventListener("error", () => {
      if (currentConnection !== connectionId) return;
      source.close(); setConnected(false); setError("agent_event_connection_failed");
      reconnectTimer = setTimeout(connect, 1_000);
    });
  };
  const submit = async () => {
    const message = draft().trim();
    if (!message || sending()) return;
    setDraft(""); setSending(true); setError(""); scrollLatest();
    try { await sendAgentMessage(props.issue.id, message); setProcessing(true); }
    catch (cause) { setDraft(message); setError(cause instanceof Error ? cause.message : "agent_message_failed"); }
    finally { setSending(false); }
  };
  const abort = async () => {
    setError("");
    try { await abortAgent(props.issue.id); setProcessing(false); await props.onRefresh(props.issue.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "agent_abort_failed"); }
  };

  createEffect(() => props.issue.id, () => connect());
  onCleanup(() => { connectionId += 1; stream?.close(); if (reconnectTimer) clearTimeout(reconnectTimer); });

  return <section class="agent-panel" aria-label={`${props.issue.id} Agent 会话`}>
    <header class="agent-panel-header">
      <div class="agent-panel-title"><Bot size={15} /><span><strong>Agent</strong><small>{props.issue.id}</small></span></div>
      <div class="agent-panel-actions">
        <span class={`agent-panel-status${running() ? " running" : ""}`}><i />{statusText()}</span>
        <Show when={running()}><Button type="text" shape="circle" size="small" icon={<CircleStop size={16} />} title="中止处理" aria-label="中止处理" onClick={() => void abort()} /></Show>
        <Button type="text" shape="circle" icon={props.expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />} title={props.expanded ? "还原 Agent" : "放大 Agent"} aria-label={props.expanded ? "还原 Agent" : "放大 Agent"} onClick={props.onToggleExpanded} />
      </div>
    </header>
    <div ref={transcript} class="agent-conversation" role="log" aria-live="polite" onScroll={(event) => { const element = event.currentTarget; followLatest = element.scrollHeight - element.scrollTop - element.clientHeight < 32; if (followLatest) setUnread(0); }}>
      <For each={entries()}>{(entry) => <Show when={entry.kind !== "user"} fallback={<div class="agent-message user">{(entry as Extract<ConversationEntry, { kind: "user" }>).text}</div>}>
        <Show when={entry.kind !== "assistant"} fallback={<div class={`agent-message assistant${(entry as Extract<ConversationEntry, { kind: "assistant" }>).progress ? " progress" : ""}`}><For each={(entry as Extract<ConversationEntry, { kind: "assistant" }>).blocks}>{(block) => block.type === "text" ? <Markdown source={block.value} /> : block.type === "thinking" ? <div class="agent-thinking"><Markdown source={block.value} /></div> : <img class="agent-inline-image" src={`data:${block.mimeType ?? "image/png"};base64,${block.value}`} alt="Agent output" />}</For></div>}>
          <ToolEntry entry={entry as Extract<ConversationEntry, { kind: "tool" }>} />
        </Show>
      </Show>}</For>
      <Show when={!entries().length && connected()}><div class="agent-empty">No conversation yet</div></Show>
    </div>
    <Show when={unread() > 0}><Button class="agent-scroll-latest" shape="round" size="small" icon={<ArrowDown size={14} />} onClick={scrollLatest}>{unread()} 条新消息</Button></Show>
    <Show when={queue().steering.length || queue().followUp.length}><div class="agent-queue"><For each={queue().steering}>{(message) => <span><strong>Steering:</strong> {message}</span>}</For><For each={queue().followUp}>{(message) => <span><strong>Follow-up:</strong> {message}</span>}</For></div></Show>
    <Show when={running() || activity()}><div class="agent-working" role="status"><i />{activity() || "Working..."}</div></Show>
    <div class="agent-composer">
      <textarea aria-label="发送给 Agent" value={draft()} disabled={sending()} onInput={(event) => setDraft(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} />
      <Button type="primary" shape="circle" icon={<Send size={16} />} title={running() ? "发送 steer" : "发送"} aria-label={running() ? "发送 steer" : "发送"} disabled={!draft().trim() || sending()} onClick={() => void submit()} />
    </div>
    <Show when={error()}><div class="agent-panel-error" role="alert">{panelError(error())}</div></Show>
    <footer class="agent-meta"><span>{agent().provider}/{agent().model}</span><span>thinking {agent().thinkingLevel}</span></footer>
  </section>;
}
