import { Button } from "@idoly/ant-design-solid";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import type { FitAddon as XtermFitAddon } from "@xterm/addon-fit";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";

import { requestTerminalTicket, terminalUrl, type IssueDetail } from "../data/client";
import { Maximize2, Minimize2, TerminalSquare } from "../ui/icons";

export function PiTerminal(props: { issue: IssueDetail; expanded: boolean; onToggleExpanded: () => void; onRefresh: (issueId: string) => Promise<IssueDetail> }) {
  type TerminalStatus = "waiting" | "connecting" | "open" | "closed" | "error";
  const fixtureTerminal = import.meta.env.MODE === "test";
  const [status, setStatus] = createSignal<TerminalStatus>(fixtureTerminal ? "open" : "waiting", { ownedWrite: true });
  const [terminalError, setTerminalError] = createSignal("", { ownedWrite: true });
  let terminalElement: HTMLDivElement | undefined;
  let terminal: XtermTerminal | undefined;
  let fitAddon: XtermFitAddon | undefined;
  let socket: WebSocket | undefined;
  let terminalHeartbeat: number | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let connectionSequence = 0;
  let mounted = false;
  let disposed = false;

  const runIsActive = () => props.issue.workspace.status === "preparing" || props.issue.workspace.status === "running";
  const statusText = () => {
    if (status() === "open") return "实时会话";
    if (status() === "connecting") return "连接中";
    if (status() === "error") return "连接失败";
    if (status() === "closed") return "已退出";
    return runIsActive() ? "等待当前处理完成" : props.issue.terminalTranscript?.data ? "历史记录" : "Session 未运行";
  };
  const closeSocket = () => {
    connectionSequence += 1;
    if (terminalHeartbeat !== undefined) window.clearInterval(terminalHeartbeat);
    terminalHeartbeat = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "view changed");
    socket = undefined;
  };
  const snapshot = () => ({ issueId: props.issue.id, runActive: runIsActive(), sessionReady: Boolean(props.issue.agentSession) });
  const snapshotKey = () => `${props.issue.id}\u0000${props.issue.agentSession ? "ready" : "waiting"}\u0000${props.issue.workspace.status}\u0000${props.issue.terminalTranscript?.data.length ?? 0}`;
  const connect = async (current = snapshot()) => {
    if (!mounted || fixtureTerminal || !terminal) return;
    closeSocket();
    terminal.reset();
    setTerminalError("");
    if (!current.sessionReady) {
      const transcript = props.issue.terminalTranscript;
      if (transcript?.data) {
        terminal.resize(transcript.columns, transcript.rows);
        terminal.write(transcript.data);
      }
      setStatus("waiting");
      return;
    }
    const sequence = ++connectionSequence;
    setStatus("connecting");
    try {
      const ticket = await requestTerminalTicket(current.issueId);
      if (sequence !== connectionSequence) return;
      const nextSocket = new WebSocket(terminalUrl(current.issueId, ticket.ticket));
      socket = nextSocket;
      nextSocket.addEventListener("open", () => {
        if (sequence !== connectionSequence) return;
        setStatus("open");
        fitAddon?.fit();
        nextSocket.send(JSON.stringify({ type: "resize", cols: terminal!.cols, rows: terminal!.rows }));
        terminalHeartbeat = window.setInterval(() => {
          if (nextSocket.readyState === WebSocket.OPEN) nextSocket.send(JSON.stringify({ type: "heartbeat" }));
        }, 5_000);
        terminal!.focus();
      });
      nextSocket.addEventListener("message", (event) => {
        if (sequence !== connectionSequence) return;
        try {
          const message = JSON.parse(String(event.data)) as { type: "output"; data: string } | { type: "exit"; exitCode: number } | { type: "error"; error: string };
          if (message.type === "output") terminal!.write(message.data);
          else if (message.type === "exit") setStatus("closed");
          else { setStatus("error"); setTerminalError(message.error); }
        } catch {
          setStatus("error");
          setTerminalError("terminal_protocol_error");
        }
      });
      nextSocket.addEventListener("close", () => {
        if (terminalHeartbeat !== undefined) window.clearInterval(terminalHeartbeat);
        terminalHeartbeat = undefined;
        if (sequence === connectionSequence && status() === "open") setStatus("closed");
      });
      nextSocket.addEventListener("error", () => {
        if (sequence !== connectionSequence) return;
        setStatus("error");
        setTerminalError("terminal_connection_failed");
      });
    } catch (error) {
      if (sequence !== connectionSequence) return;
      const message = error instanceof Error ? error.message : "terminal_connection_failed";
      const waiting = message === "pi_session_running" || message === "pi_session_not_ready" || message === "pi_terminal_not_running";
      setStatus(waiting ? "waiting" : "error");
      setTerminalError(waiting ? "" : message);
    }
  };

  createEffect(snapshotKey, () => {
    const current = snapshot();
    if (fixtureTerminal) setStatus(!current.sessionReady ? "waiting" : "open");
    else if (mounted) void connect(current);
  });
  queueMicrotask(() => { void (async () => {
    if (disposed) return;
    mounted = true;
    if (fixtureTerminal) return;
    const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
      import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/addon-web-links"),
    ]);
    if (disposed) return;
    terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: '"SFMono-Regular", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      letterSpacing: 0,
      lineHeight: 1.18,
      scrollback: 10_000,
      theme: { background: "#111714", foreground: "#d8e1dc", cursor: "#69d3ad", selectionBackground: "#315346", black: "#17201d", brightBlack: "#65736d", green: "#69d3ad", brightGreen: "#8be6c4", yellow: "#e0c36a", brightYellow: "#f0d883", blue: "#6ba8d9", brightBlue: "#8bc4ef", cyan: "#65c7c0", brightCyan: "#86ddd6", red: "#dd746c", brightRed: "#f08b83", magenta: "#bd8bd1", brightMagenta: "#d5a4e5", white: "#d8e1dc", brightWhite: "#f4f7f5" },
    });
    fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(terminalElement!);
    terminal.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data }));
    });
    resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(() => {
        if (!fitAddon || !terminal || !props.issue.agentSession) return;
        fitAddon.fit();
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      });
    });
    resizeObserver.observe(terminalElement!);
    void connect();
  })(); });
  const statusPoll = window.setInterval(() => {
    if (!runIsActive() || status() === "open" || status() === "connecting") return;
    void props.onRefresh(props.issue.id).then((issue) => {
      const runActive = issue.workspace.status === "preparing" || issue.workspace.status === "running";
      if (status() === "waiting" && issue.agentSession && runActive) void connect({ issueId: issue.id, runActive, sessionReady: true });
    }).catch(() => undefined);
  }, 2_000);
  onCleanup(() => {
    disposed = true;
    mounted = false;
    closeSocket();
    window.clearInterval(statusPoll);
    resizeObserver?.disconnect();
    terminal?.dispose();
  });

  return (
    <section class="pi-terminal-panel" aria-label={`${props.issue.id} pi 终端`}>
      <header class="pi-terminal-header">
        <div class="pi-terminal-title"><TerminalSquare size={17} /><span><strong>pi</strong><small>{props.issue.id}</small></span></div>
        <div class="pi-terminal-actions">
          <span class={`pi-terminal-status ${status()}`}><i />{statusText()}</span>
          <Show when={status() === "closed" || status() === "error"}><Button type="text" size="small" onClick={() => { void connect(); }}>重连</Button></Show>
          <Button type="text" shape="circle" icon={props.expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />} title={props.expanded ? "还原终端" : "放大终端"} aria-label={props.expanded ? "还原终端" : "放大终端"} onClick={props.onToggleExpanded} />
        </div>
      </header>
      <Show when={!fixtureTerminal} fallback={<pre class="pi-terminal-fixture" role="log">{props.issue.terminalTranscript?.data ?? ""}</pre>}>
        <div class="pi-terminal" ref={(element) => { terminalElement = element; }} onClick={() => { if (props.issue.agentSession) terminal?.focus(); }} />
      </Show>
      <Show when={terminalError() && status() === "error"}><div class="pi-terminal-error" role="alert">{terminalError()}</div></Show>
    </section>
  );
}
