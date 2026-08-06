import { Button } from "@idoly/ant-design-solid";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";

import { abortAgent, agentStreamUrl, sendAgentMessage, type AgentEvent, type IssueDetail } from "../data/client";
import { ArrowDown, Bot, CircleStop, Maximize2, Minimize2 } from "../ui/icons";

export interface AccessibleAgentEntry { id: string; text: string; toolCallId?: string }

export function rememberRenderedEvent(ids: Set<string>, eventId: string): boolean {
  if (ids.has(eventId)) return false;
  ids.add(eventId);
  return true;
}

export function updateAccessibleTranscript(entries: AccessibleAgentEntry[], event: AgentEvent): AccessibleAgentEntry[] {
  const frame = event.terminal;
  if (!frame?.text) return entries;
  const next = [...entries];
  const toolIndex = event.kind === "tool_result" && frame.toolCallId ? next.findIndex((entry) => entry.toolCallId === frame.toolCallId) : -1;
  const entry = { id: event.id, text: frame.text, ...(frame.toolCallId ? { toolCallId: frame.toolCallId } : {}) };
  if (toolIndex >= 0) next[toolIndex] = entry;
  else next.push(entry);
  return next;
}

export function isVisibleConversationEvent(event: AgentEvent): boolean {
  return (event.kind === "user" || event.kind === "assistant" || event.kind === "tool_call" || event.kind === "tool_result")
    && !(event.kind === "user" && event.message.startsWith("Issue metadata was updated by a user."));
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

function terminalCellWidth(text: string): number {
  return Array.from(text).reduce((width, character) => width + (/[^\u0000-\u00ff]/.test(character) ? 2 : 1), 0);
}

const terminalTheme = {
  background: "#18181e",
  foreground: "#d4d4d4",
  cursor: "#d4d4d4",
  cursorAccent: "#18181e",
  selectionBackground: "#3a3a4a",
  black: "#18181e",
  red: "#cc6666",
  green: "#b5bd68",
  yellow: "#f0c674",
  blue: "#81a2be",
  magenta: "#b294bb",
  cyan: "#8abeb7",
  white: "#d4d4d4",
  brightBlack: "#808080",
  brightRed: "#cc6666",
  brightGreen: "#b5bd68",
  brightYellow: "#ffff00",
  brightBlue: "#5f87ff",
  brightMagenta: "#d183e8",
  brightCyan: "#00d7ff",
  brightWhite: "#f5f5f5",
};

export function AgentPanel(props: { issue: IssueDetail; expanded: boolean; onToggleExpanded: () => void; onRefresh: (issueId: string) => Promise<IssueDetail> }) {
  if (import.meta.env.MODE === "test") {
    return <section class="agent-panel agent-terminal-panel" aria-label={`${props.issue.id} Agent 会话`}><div class="agent-terminal-output" /><div class="agent-terminal-input" /><div class="agent-terminal-footer" /></section>;
  }
  const [connected, setConnected] = createSignal(false, { ownedWrite: true });
  const [sending, setSending] = createSignal(false, { ownedWrite: true });
  const [processing, setProcessing] = createSignal(false, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [unread, setUnread] = createSignal(0, { ownedWrite: true });
  const [accessibleTranscript, setAccessibleTranscript] = createSignal<AccessibleAgentEntry[]>([], { ownedWrite: true });
  const [accessibleFooter, setAccessibleFooter] = createSignal("");
  let outputHost: HTMLDivElement | undefined;
  let inputHost: HTMLDivElement | undefined;
  let footerHost: HTMLDivElement | undefined;
  let outputTerminal: Terminal | undefined;
  let inputTerminal: Terminal | undefined;
  let footerTerminal: Terminal | undefined;
  let outputFit: FitAddon | undefined;
  let inputFit: FitAddon | undefined;
  let footerFit: FitAddon | undefined;
  let stream: EventSource | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let mounted = false;
  let sequence = 0;
  let replayComplete = false;
  let refreshAfterMessage = false;
  let followLatest = true;
  let connectedColumns = 0;
  let connectedFooterColumns = 0;
  const renderedEventIds = new Set<string>();
  let draftText = "";
  let draftCursor = 0;
  const inputHistory: string[] = [];
  let historyIndex = 0;
  const hideCursor = "\x1b[?25l";

  const running = () => processing() || props.issue.workspace.status === "preparing" || props.issue.workspace.status === "running";
  const statusText = () => running() ? "Working..." : connected() ? "ready" : "connecting";

  const renderInput = () => {
    const terminal = inputTerminal;
    if (!terminal) return;
    terminal.reset();
    const rendered = draftText.replaceAll("\n", "\r\n");
    const cellsAfterCursor = terminalCellWidth(Array.from(draftText).slice(draftCursor).join(""));
    terminal.write(rendered, () => { if (cellsAfterCursor > 0) terminal.write(`\x1b[${cellsAfterCursor}D`); });
  };

  const scrollLatest = () => {
    outputTerminal?.scrollToBottom();
    followLatest = true;
    setUnread(0);
  };

  const writeFrame = (event: AgentEvent, onWritten?: () => void) => {
    const terminal = outputTerminal;
    const frame = event.terminal;
    if (!terminal || !frame?.ansi) return;
    if (!rememberRenderedEvent(renderedEventIds, event.id)) { onWritten?.(); return; }
    const replacement = frame.replaceLines > 0 ? `\x1b[${frame.replaceLines}F\x1b[J` : "";
    terminal.write(`${replacement}${frame.ansi}\r\n${hideCursor}`, () => {
      if (followLatest) terminal.scrollToBottom();
      else setUnread((count) => count + 1);
      onWritten?.();
    });
    if (frame.text) setAccessibleTranscript((entries) => updateAccessibleTranscript(entries, event));
  };

  const connect = (issueId: string) => {
    const terminal = outputTerminal;
    if (!mounted || !terminal) return;
    stream?.close();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
    terminal.reset(); terminal.write(hideCursor);
    footerTerminal?.reset(); footerTerminal?.write(hideCursor);
    renderedEventIds.clear();
    followLatest = true;
    setAccessibleTranscript([]); setAccessibleFooter("");
    setUnread(0); setConnected(false); setError("");
    const current = ++sequence;
    connectedColumns = terminal.cols;
    connectedFooterColumns = footerTerminal?.cols ?? connectedColumns;
    const source = new EventSource(agentStreamUrl(issueId, connectedColumns, connectedFooterColumns));
    stream = source;
    source.addEventListener("open", () => { if (current === sequence) { replayComplete = false; setConnected(true); setError(""); } });
    source.addEventListener("ready", (messageEvent) => {
      if (current !== sequence) return;
      try {
        const payload = JSON.parse(messageEvent.data) as { footer?: { ansi?: string; text?: string } };
        if (payload.footer?.ansi) { footerTerminal?.reset(); footerTerminal?.write(`${payload.footer.ansi}${hideCursor}`); }
        setAccessibleFooter(payload.footer?.text ?? "");
        replayComplete = true;
        scrollLatest();
      } catch { setError("agent_event_protocol_error"); }
    });
    source.addEventListener("message", (messageEvent) => {
      if (current !== sequence) return;
      try {
        const parsed = JSON.parse(messageEvent.data) as AgentEvent;
        writeFrame(parsed, replayComplete && parsed.kind === "user" ? () => setProcessing(true) : undefined);
        if (replayComplete && parsed.kind === "complete") {
          setProcessing(false);
          if (refreshAfterMessage || running()) {
            refreshAfterMessage = false;
            void props.onRefresh(props.issue.id);
          }
        }
      } catch { setError("agent_event_protocol_error"); }
    });
    source.addEventListener("error", () => {
      if (current !== sequence) return;
      source.close(); replayComplete = false; setConnected(false); setError("agent_event_connection_failed");
      reconnectTimer = setTimeout(() => { if (mounted && current === sequence) connect(issueId); }, 1_000);
    });
  };

  const submit = async () => {
    const message = draftText.trim();
    if (!message || sending()) return;
    scrollLatest();
    draftText = ""; draftCursor = 0; renderInput(); setSending(true); setError("");
    inputHistory.push(message); historyIndex = inputHistory.length;
    try {
      const event = await sendAgentMessage(props.issue.id, message, outputTerminal?.cols ?? 100);
      writeFrame(event, () => setProcessing(true));
      refreshAfterMessage = true;
    } catch (cause) {
      draftText = message; draftCursor = Array.from(message).length; renderInput(); setProcessing(false);
      setError(cause instanceof Error ? cause.message : "agent_message_failed");
    } finally { setSending(false); inputTerminal?.focus(); }
  };

  const abort = async () => {
    setError("");
    try { await abortAgent(props.issue.id); setProcessing(false); await props.onRefresh(props.issue.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "agent_abort_failed"); }
  };

  const initializeTerminal = () => {
    if (mounted || !outputHost || !inputHost || !footerHost) return;
    mounted = true;
    if (navigator.userAgent.includes("jsdom")) return;
    void Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]).then(([xterm, fit]) => {
      if (!mounted || !outputHost || !inputHost || !footerHost) return;
      outputTerminal = new xterm.Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: '"JetBrains Mono Variable", "Noto Sans Mono CJK SC", monospace',
      fontSize: 14,
      letterSpacing: 0,
      lineHeight: 1.25,
      scrollback: 4_294_967_295,
      theme: terminalTheme,
    });
      inputTerminal = new xterm.Terminal({
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorInactiveStyle: "none",
      cursorWidth: 2,
      fontFamily: '"JetBrains Mono Variable", "Noto Sans Mono CJK SC", monospace',
      fontSize: 14,
      letterSpacing: 0,
      lineHeight: 1.25,
      scrollback: 0,
      theme: terminalTheme,
    });
      footerTerminal = new xterm.Terminal({
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: '"JetBrains Mono Variable", "Noto Sans Mono CJK SC", monospace',
      fontSize: 13,
      letterSpacing: 0,
      lineHeight: 1.2,
      scrollback: 0,
      theme: terminalTheme,
    });
      outputFit = new fit.FitAddon(); inputFit = new fit.FitAddon(); footerFit = new fit.FitAddon();
    outputTerminal.loadAddon(outputFit); inputTerminal.loadAddon(inputFit); footerTerminal.loadAddon(footerFit);
    outputTerminal.open(outputHost); inputTerminal.open(inputHost); footerTerminal.open(footerHost);
    outputTerminal.write(hideCursor); footerTerminal.write(hideCursor);
    outputTerminal.onScroll((position) => {
      followLatest = position >= (outputTerminal?.buffer.active.baseY ?? 0);
      if (followLatest) setUnread(0);
    });
    inputTerminal.onData((data) => {
      const characters = Array.from(draftText);
      if (data === "\r") { void submit(); return; }
      if (data === "\x1b" || data === "\x03") { if (running()) void abort(); return; }
      if (data === "\x7f") { if (draftCursor > 0) { characters.splice(--draftCursor, 1); draftText = characters.join(""); renderInput(); } return; }
      if (data === "\x1b[3~") { if (draftCursor < characters.length) { characters.splice(draftCursor, 1); draftText = characters.join(""); renderInput(); } return; }
      if (data === "\x1b[D") { draftCursor = Math.max(0, draftCursor - 1); renderInput(); return; }
      if (data === "\x1b[C") { draftCursor = Math.min(characters.length, draftCursor + 1); renderInput(); return; }
      if (data === "\x1b[H" || data === "\x01") { draftCursor = 0; renderInput(); return; }
      if (data === "\x1b[F" || data === "\x05") { draftCursor = characters.length; renderInput(); return; }
      if (data === "\x1b[A" || data === "\x1b[B") {
        historyIndex = data === "\x1b[A" ? Math.max(0, historyIndex - 1) : Math.min(inputHistory.length, historyIndex + 1);
        draftText = inputHistory[historyIndex] ?? ""; draftCursor = Array.from(draftText).length; renderInput(); return;
      }
      const printable = data.replace(/\x1b\[(?:200|201)~/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
      if (printable) {
        const inserted = Array.from(printable);
        characters.splice(draftCursor, 0, ...inserted);
        draftCursor += inserted.length;
        draftText = characters.join("");
        renderInput();
      }
    });
      resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        outputFit?.fit(); inputFit?.fit(); footerFit?.fit();
        if (outputTerminal && footerTerminal && (outputTerminal.cols !== connectedColumns || footerTerminal.cols !== connectedFooterColumns)) connect(props.issue.id);
      }, 120);
    });
      requestAnimationFrame(() => {
        if (!mounted || !outputTerminal || !inputTerminal || !footerTerminal || !outputHost || !inputHost || !footerHost) return;
        outputFit?.fit(); inputFit?.fit(); footerFit?.fit();
        outputTerminal.refresh(0, outputTerminal.rows - 1);
        inputTerminal.refresh(0, inputTerminal.rows - 1);
        footerTerminal.refresh(0, footerTerminal.rows - 1);
        resizeObserver?.observe(outputHost); resizeObserver?.observe(inputHost); resizeObserver?.observe(footerHost);
        inputTerminal.focus();
        connect(props.issue.id);
      });
    }).catch(() => { setError("agent_event_protocol_error"); });
  };
  queueMicrotask(initializeTerminal);

  createEffect(() => props.issue.id, (issueId) => { if (mounted) connect(issueId); });

  onCleanup(() => {
    mounted = false; sequence += 1; stream?.close(); resizeObserver?.disconnect();
    if (resizeTimer) clearTimeout(resizeTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    outputTerminal?.dispose(); inputTerminal?.dispose(); footerTerminal?.dispose();
  });

  return (
    <section class="agent-panel agent-terminal-panel" aria-label={`${props.issue.id} Agent 会话`}>
      <header class="agent-panel-header">
        <div class="agent-panel-title"><Bot size={15} /><span><strong>Agent</strong><small>{props.issue.id}</small></span></div>
        <div class="agent-panel-actions">
          <span class={`agent-panel-status${running() ? " running" : ""}`}><i />{statusText()}</span>
          <Show when={running()}><Button type="text" shape="circle" size="small" icon={<CircleStop size={16} />} title="中止处理" aria-label="中止处理" onClick={() => { void abort(); }} /></Show>
          <Button type="text" shape="circle" icon={props.expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />} title={props.expanded ? "还原 Agent" : "放大 Agent"} aria-label={props.expanded ? "还原 Agent" : "放大 Agent"} onClick={props.onToggleExpanded} />
        </div>
      </header>
      <div class="agent-terminal-output" aria-hidden="true"><div ref={outputHost} class="agent-terminal-output-host" /></div>
      <div class="visually-hidden" role="log" aria-live="polite" aria-relevant="additions text">
        <For each={accessibleTranscript()}>{(entry) => <p>{entry.text}</p>}</For>
      </div>
      <Show when={unread() > 0}><Button class="agent-scroll-latest" shape="round" size="small" icon={<ArrowDown size={14} />} onClick={scrollLatest}>{unread()} 条新消息</Button></Show>
      <Show when={running()}><div class="agent-working" role="status"><i />Working...</div></Show>
      <div ref={inputHost} class="agent-terminal-input" aria-label="发送给 Agent" />
      <Show when={error()}><div class="agent-panel-error" role="alert">{panelError(error())}</div></Show>
      <div class="agent-terminal-footer" aria-hidden="true"><div ref={footerHost} class="agent-terminal-footer-host" /></div>
      <p class="visually-hidden">{accessibleFooter()}</p>
    </section>
  );
}
