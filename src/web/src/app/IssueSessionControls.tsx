import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Button, Modal, Select } from "../ui";
import { errorMessage, listIssueSessions, readIssueSession, type IssueDetail, type IssueSessionSummary } from "../data/client";
import { useApplicationResources } from "./ApplicationResources";
import { applyAgentEvent, type ConversationEntry } from "./conversation";
import { ConversationItem } from "./AgentPanel";

export function IssueSessionControls(props: { issue: IssueDetail; disabled: boolean }) {
  const { currentUser } = useApplicationResources();
  const [historyOpen, setHistoryOpen] = createSignal(false, { ownedWrite: true });
  const [sessions, setSessions] = createSignal<IssueSessionSummary[]>([], { ownedWrite: true });
  const [selected, setSelected] = createSignal("", { ownedWrite: true });
  const [entries, setEntries] = createSignal<ConversationEntry[]>([], { ownedWrite: true });
  const [nextOffset, setNextOffset] = createSignal<number | null>(null, { ownedWrite: true });
  const [busy, setBusy] = createSignal(false, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  let generation = 0, controller: AbortController | undefined;
  const closeHistory = () => { generation++; controller?.abort(); setHistoryOpen(false); setBusy(false); setError(""); setEntries([]); setSessions([]); setSelected(""); setNextOffset(null); };
  createEffect(() => `${props.issue.id}:${currentUser()?.subject ?? ""}:${currentUser()?.role ?? ""}`, () => closeHistory());
  onCleanup(() => { generation++; controller?.abort(); });
  const begin = () => { controller?.abort(); controller = new AbortController(); return { owner: ++generation, signal: controller.signal }; };
  const loadHistory = async () => {
    const task = begin(); setHistoryOpen(true); setBusy(true); setError("");
    try {
      const values = await listIssueSessions(props.issue.id, task.signal);
      if (generation !== task.owner) return;
      const history = values.filter(session => !session.current);
      setSessions(history); setEntries([]); setNextOffset(null);
      const first = history[0]?.sessionId ?? "";
      setSelected(first);
      if (first) await read(first);
    }
    catch (cause) { if (generation === task.owner) setError(errorMessage(cause)); }
    finally { if (generation === task.owner) setBusy(false); }
  };
  const read = async (id: string, offset = 0) => {
    const task = begin(); setSelected(id); setBusy(true); setError(""); if (!offset) { setEntries([]); setNextOffset(null); }
    try { const page = await readIssueSession(props.issue.id, id, offset, task.signal); if (generation !== task.owner) return; setEntries(current => page.events.reduce(applyAgentEvent, offset ? current : [])); setNextOffset(page.nextOffset); }
    catch (cause) { if (generation === task.owner) setError(errorMessage(cause)); }
    finally { if (generation === task.owner) setBusy(false); }
  };
  return <section class="issue-session-controls">
    <Button size="small" type="text" disabled={props.disabled || busy()} onClick={() => { void loadHistory(); }}>查看历史</Button>
    <Show when={error() && !historyOpen()}><div class="workspace-error" role="alert">{error()}</div></Show>
    <Modal open={historyOpen()} title="历史会话" width={900} onCancel={closeHistory} onOk={closeHistory} footer={<Button onClick={closeHistory}>关闭</Button>}>
      <div class="session-history-content">
        <p class="session-history-description">历史会话只读，新会话不会自动带入旧聊天。</p>
        <Show when={sessions().length}>
          <div class="session-history-toolbar">
            <Select aria-label="选择历史会话" value={selected()} disabled={busy()} options={sessions().map(session => ({ value: session.sessionId, label: `${new Date(session.createdAt).toLocaleString()} · ${session.sessionId.slice(0, 8)}` }))} onChange={id => { if (typeof id === "string") void read(id); }} />
            <Button disabled={busy() || !selected()} onClick={() => { void read(selected()); }}>查看对话</Button>
          </div>
        </Show>
        <Show when={error()}><div class="workspace-error" role="alert">{error()}</div><Show when={!sessions().length}><Button onClick={() => { void loadHistory(); }}>重新加载</Button></Show></Show>
        <Show when={busy()}><div class="session-history-state" role="status">正在加载历史会话…</div></Show>
        <Show when={!busy() && !error() && !entries().length}><div class="session-history-state" role="status">{sessions().length ? "该会话暂无可显示的对话" : "暂无历史会话"}</div></Show>
        <Show when={entries().length}>
          <div class="agent-panel session-history ip-scrollbar ip-scrollbar-dark" role="region" aria-label="历史对话" aria-busy={busy() ? "true" : "false"} tabindex={0}><For each={entries()}>{entry => <ConversationItem issue={props.issue} entry={entry} />}</For></div>
        </Show>
        <Show when={nextOffset() !== null}><Button disabled={busy()} onClick={() => { void read(selected(), nextOffset()!); }}>加载更多</Button></Show>
      </div>
    </Modal>
  </section>;
}
