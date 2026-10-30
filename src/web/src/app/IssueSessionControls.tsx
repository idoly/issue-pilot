import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Button, Modal, Select } from "../ui";
import { errorMessage, listIssueSessions, readIssueSession, resetIssueSession, type IssueDetail, type IssueSessionSummary } from "../data/client";
import { useApplicationResources } from "./ApplicationResources";
import { applyAgentEvent, type ConversationEntry } from "./conversation";
import { ConversationItem } from "./AgentPanel";

export function IssueSessionControls(props: { issue: IssueDetail; disabled: boolean; onReset: () => Promise<void> }) {
  const { currentUser } = useApplicationResources();
  const [open, setOpen] = createSignal(false, { ownedWrite: true });
  const [sessions, setSessions] = createSignal<IssueSessionSummary[]>([], { ownedWrite: true });
  const [selected, setSelected] = createSignal("", { ownedWrite: true });
  const [entries, setEntries] = createSignal<ConversationEntry[]>([], { ownedWrite: true });
  const [nextOffset, setNextOffset] = createSignal<number | null>(null, { ownedWrite: true });
  const [busy, setBusy] = createSignal(false, { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  let generation = 0, controller: AbortController | undefined;
  const close = () => { generation++; controller?.abort(); setOpen(false); setBusy(false); setError(""); setEntries([]); setSessions([]); };
  createEffect(() => `${props.issue.id}:${currentUser()?.subject ?? ""}:${currentUser()?.role ?? ""}`, () => close());
  onCleanup(() => { generation++; controller?.abort(); });
  const begin = () => { controller?.abort(); controller = new AbortController(); return { owner: ++generation, signal: controller.signal }; };
  const show = async () => {
    const task = begin(); setOpen(true); setBusy(true); setError("");
    try {
      const values = await listIssueSessions(props.issue.id, task.signal);
      if (generation !== task.owner) return;
      setSessions(values); setSelected(values[0]?.sessionId ?? ""); setEntries([]); setNextOffset(null);
    } catch (cause) { if (generation === task.owner) setError(errorMessage(cause)); }
    finally { if (generation === task.owner) setBusy(false); }
  };
  const read = async (id: string, offset = 0) => {
    const task = begin(); setSelected(id); setBusy(true); setError("");
    if (!offset) setEntries([]);
    try {
      const page = await readIssueSession(props.issue.id, id, offset, task.signal);
      if (generation !== task.owner) return;
      setEntries(current => page.events.reduce(applyAgentEvent, offset ? current : [])); setNextOffset(page.nextOffset);
    } catch (cause) { if (generation === task.owner) setError(errorMessage(cause)); }
    finally { if (generation === task.owner) setBusy(false); }
  };
  const reset = async () => {
    const current = sessions().find(session => session.current);
    if (!current || busy() || props.disabled) return;
    if (!window.confirm("保留旧会话并创建新会话？新会话不带入旧聊天，工单、代码、附件和工作文件保留。尚未保存的工单修改不会生效。")) return;
    const task = begin(); setBusy(true); setError("");
    try {
      await resetIssueSession(props.issue.id, current.sessionId);
      if (generation !== task.owner) return;
      await props.onReset();
      if (generation === task.owner) close();
    } catch (cause) {
      if (generation === task.owner) setError(errorMessage(cause));
    } finally { if (generation === task.owner) setBusy(false); }
  };
  return <section class="issue-session-controls">
    <Button size="small" disabled={props.disabled} onClick={() => { void show(); }}>{currentUser()?.role === "developer" ? "重置会话" : "查看历史会话"}</Button>
    <Modal open={open()} title="工单会话" width={900} onCancel={close} onOk={() => { void reset(); }} confirmLoading={busy()} footer={<><Button disabled={busy()} onClick={close}>关闭</Button><Show when={currentUser()?.role === "developer" && props.issue.status !== "resolved"}><Button danger disabled={busy() || props.disabled || !sessions().length} onClick={() => { void reset(); }}>重置会话</Button></Show></>}>
      <p>旧会话只读保留。重置后发送新消息开始处理，不会自动重放旧消息。</p>
      <Show when={error()}><div class="form-error" role="alert">{error()}</div></Show>
      <Show when={sessions().length} fallback={<Show when={!busy()}>暂无会话</Show>}>
        <Select aria-label="选择工单会话" value={selected()} disabled={busy()} options={sessions().map(session => ({ value: session.sessionId, label: `${session.current ? "当前" : "历史"} · ${new Date(session.createdAt).toLocaleString()} · ${session.sessionId.slice(0, 8)}` }))} onChange={id => { if (typeof id === "string") void read(id); }} />
        <Button size="small" disabled={busy() || !selected()} onClick={() => { void read(selected()); }}>查看对话</Button>
        <div class="agent-panel session-history"><For each={entries()}>{entry => <ConversationItem issue={props.issue} entry={entry} />}</For></div>
        <Show when={nextOffset() !== null}><Button disabled={busy()} onClick={() => { void read(selected(), nextOffset()!); }}>加载更多</Button></Show>
      </Show>
    </Modal>
  </section>;
}
