import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Button, Modal, Select } from "../ui";
import { errorMessage, listIssueSessions, readIssueSession, resetIssueSession, type IssueDetail, type IssueSessionSummary } from "../data/client";
import { useApplicationResources } from "./ApplicationResources";
import { applyAgentEvent, type ConversationEntry } from "./conversation";
import { ConversationItem } from "./AgentPanel";

function sessionError(cause: unknown): string {
  const code = errorMessage(cause);
  return ({ issue_already_running: "工单正在处理，请等待结束后重置。", agent_session_changed: "会话已更新，请重新打开编辑工单。", agent_session_not_found: "暂无可重置的会话。", resolved_issue_cannot_reset_session: "请先重开工单。" } as Record<string, string>)[code] ?? code;
}

export function IssueSessionControls(props: { issue: IssueDetail; disabled: boolean; onReset: () => Promise<void> }) {
  const { currentUser } = useApplicationResources();
  const [historyOpen, setHistoryOpen] = createSignal(false, { ownedWrite: true });
  const [sessions, setSessions] = createSignal<IssueSessionSummary[]>([], { ownedWrite: true });
  const [selected, setSelected] = createSignal("", { ownedWrite: true });
  const [entries, setEntries] = createSignal<ConversationEntry[]>([], { ownedWrite: true });
  const [nextOffset, setNextOffset] = createSignal<number | null>(null, { ownedWrite: true });
  const [busy, setBusy] = createSignal(false, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  let generation = 0, controller: AbortController | undefined;
  const closeHistory = () => { generation++; controller?.abort(); setHistoryOpen(false); setBusy(false); setError(""); setEntries([]); setSessions([]); };
  createEffect(() => `${props.issue.id}:${currentUser()?.subject ?? ""}:${currentUser()?.role ?? ""}`, () => closeHistory());
  onCleanup(() => { generation++; controller?.abort(); });
  const begin = () => { controller?.abort(); controller = new AbortController(); return { owner: ++generation, signal: controller.signal }; };
  const loadHistory = async () => {
    const task = begin(); setHistoryOpen(true); setBusy(true); setError("");
    try { const values = await listIssueSessions(props.issue.id, task.signal); if (generation !== task.owner) return; setSessions(values); setSelected(values.find(session => !session.current)?.sessionId ?? values[0]?.sessionId ?? ""); setEntries([]); setNextOffset(null); }
    catch (cause) { if (generation === task.owner) setError(errorMessage(cause)); }
    finally { if (generation === task.owner) setBusy(false); }
  };
  const read = async (id: string, offset = 0) => {
    const task = begin(); setSelected(id); setBusy(true); setError(""); if (!offset) setEntries([]);
    try { const page = await readIssueSession(props.issue.id, id, offset, task.signal); if (generation !== task.owner) return; setEntries(current => page.events.reduce(applyAgentEvent, offset ? current : [])); setNextOffset(page.nextOffset); }
    catch (cause) { if (generation === task.owner) setError(errorMessage(cause)); }
    finally { if (generation === task.owner) setBusy(false); }
  };
  const reset = async () => {
    if (busy() || props.disabled) return;
    const task = begin(); setBusy(true); setError("");
    try { const values = await listIssueSessions(props.issue.id, task.signal); const current = values.find(session => session.current); if (!current) throw new Error("agent_session_not_found"); if (!window.confirm("保留旧会话并创建新会话？新会话不带入旧聊天，工单、代码、附件和工作文件保留。")) return; await resetIssueSession(props.issue.id, current.sessionId); if (generation === task.owner) await props.onReset(); }
    catch (cause) { if (generation === task.owner) setError(sessionError(cause)); }
    finally { if (generation === task.owner) setBusy(false); }
  };
  return <section class="issue-session-controls">
    <Button size="small" danger disabled={props.disabled || busy() || currentUser()?.role !== "developer"} loading={busy()} onClick={() => { void reset(); }}>重置会话</Button>
    <Button size="small" type="text" disabled={busy()} onClick={() => { void loadHistory(); }}>查看历史</Button>
    <Show when={error()}><div class="workspace-error" role="alert">{error()}</div></Show>
    <Modal open={historyOpen()} title="历史会话" width={900} onCancel={closeHistory} onOk={closeHistory} footer={<Button onClick={closeHistory}>关闭</Button>}>
      <p>历史会话只读，新会话不会自动带入旧聊天。</p>
      <Show when={sessions().length} fallback={<Show when={!busy()}>暂无历史会话</Show>}>
        <Select aria-label="选择历史会话" value={selected()} disabled={busy()} options={sessions().filter(session => !session.current).map(session => ({ value: session.sessionId, label: `${new Date(session.createdAt).toLocaleString()} · ${session.sessionId.slice(0, 8)}` }))} onChange={id => { if (typeof id === "string") void read(id); }} />
        <Button size="small" disabled={busy() || !selected()} onClick={() => { void read(selected()); }}>查看对话</Button>
        <div class="agent-panel session-history"><For each={entries()}>{entry => <ConversationItem issue={props.issue} entry={entry} />}</For></div>
        <Show when={nextOffset() !== null}><Button disabled={busy()} onClick={() => { void read(selected(), nextOffset()!); }}>加载更多</Button></Show>
      </Show>
    </Modal>
  </section>;
}
