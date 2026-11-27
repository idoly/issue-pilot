import { createEffect, createSignal, onCleanup, Show, untrack } from "solid-js";

import { Button, Input, Modal, Select } from "../ui";
import { canUseIssueWorkMode } from "../../../domain/contracts";
import { canResetIssueSession, getIssue, isWorkspaceBusy, issueWorkMode, RequestError, updateIssue, type IssueDetail, type IssuePriority } from "../data/client";
import { useApplicationResources } from "./ApplicationResources";
import { AttachmentPicker, DescriptionField, selectedChoice } from "./IssueForm";
import { errorText, type ErrorTexts } from "./error-text";
import { environmentKind, personLabel, priorityOptions } from "./model";

const recoveryNotices = {
  metadata: "工单已被修改，当前草稿仍保留。请复制需要保留的内容，再重新载入最新工单。",
  session: "会话已被重置，当前草稿仍保留。请复制需要保留的内容，再重新载入最新工单。",
  unknown: "无法确认保存结果。草稿仍保留，请先核对工单，不要重复提交。",
};
const editErrors: ErrorTexts = { issue_already_running: "工单正在处理，请等待处理结束后再保存。" };

/** The one Issue edit draft: metadata, recipients, attachments and the optional save-and-reset. */
export function IssueEditDialog(props: {
  issue: IssueDetail;
  open: boolean;
  register: (open: (issue: IssueDetail) => void) => void;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { currentUser, people, peopleError } = useApplicationResources();
  const [base, setBase] = createSignal<IssueDetail | null>(null);
  const [recovery, setRecovery] = createSignal<keyof typeof recoveryNotices>();
  const [title, setTitle] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [priority, setPriority] = createSignal<IssuePriority>("p2");
  const [assignee, setAssignee] = createSignal<string | null>(null);
  const [cc, setCc] = createSignal<string[]>([]);
  const [attachments, setAttachments] = createSignal<File[]>([]);
  const [removedAttachmentIds, setRemovedAttachmentIds] = createSignal<string[]>([]);
  const [saving, setSaving] = createSignal(false);
  const [resetting, setResetting] = createSignal(false);
  const [committed, setCommitted] = createSignal("");
  const [error, setError] = createSignal("");
  const formMessage = () => {
    const reason = recovery();
    return error() || (reason ? recoveryNotices[reason] : peopleError());
  };
  let disposed = false;

  const initialize = (issue: IssueDetail) => {
    setBase(issue);
    setRecovery(undefined);
    setTitle(issue.title);
    setDescription(issue.description);
    setPriority(issue.priority);
    setAssignee(issue.assigneeSubject);
    setCc(issue.ccRecipients.map((person) => person.subject));
    setAttachments([]);
    setRemovedAttachmentIds([]);
    setError("");
  };

  // Opening is an event: the host initializes the draft synchronously so the first render already shows it.
  props.register((issue) => initialize(issue));
  onCleanup(() => {
    disposed = true;
    props.onDirtyChange?.(false);
  });

  const dirty = () => {
    const current = base();
    return Boolean(
      props.open &&
      !committed() &&
      current &&
      (title().trim() !== current.title ||
        description().trim() !== current.description ||
        priority() !== current.priority ||
        assignee() !== current.assigneeSubject ||
        cc().join("\0") !== current.ccRecipients.map((person) => person.subject).join("\0") ||
        attachments().length > 0 ||
        removedAttachmentIds().length > 0),
    );
  };
  // The host may mount this dialog inside its own update; notify only real changes so mount stays read-only.
  let reportedDirty = false;
  createEffect(dirty, (value) => {
    if (value === reportedDirty) return;
    reportedDirty = value;
    untrack(() => props.onDirtyChange?.(value));
  });

  const currentWorkMode = () => {
    const kind = environmentKind(props.issue.environmentKey);
    return kind ? issueWorkMode(kind, props.issue.type) : undefined;
  };
  // Active work conflicts with the edit/reset reservation even when the server's reset rule passes.
  const resetDisabled = () =>
    !base()?.resetVersion ||
    !canResetIssueSession({ actorRole: currentUser()?.role ?? "product", status: props.issue.status, agentRunning: props.issue.agentRunning }) ||
    isWorkspaceBusy(props.issue.workspace.status);

  const close = () => {
    setAttachments([]);
    setRemovedAttachmentIds([]);
    props.onClose();
  };
  // Esc, × and Cancel reopen from the Issue, so dismissing a dirty draft needs explicit consent.
  const dismiss = () => {
    if (saving() || (dirty() && !window.confirm("编辑内容尚未保存，是否放弃这些修改？"))) return;
    close();
  };
  const markCommitted = (message: string) => {
    setCommitted(message);
    setRemovedAttachmentIds([]);
    setAttachments([]);
  };
  const reloadDraft = async () => {
    if (saving()) return;
    setSaving(true);
    try {
      const latest = await getIssue(props.issue.id);
      if (!disposed) initialize(latest);
    } catch (cause) {
      if (!disposed) setError(`读取失败：${errorText(cause)}。草稿仍保留。`);
    } finally {
      if (!disposed) setSaving(false);
    }
  };
  const refreshSaved = async () => {
    setError("");
    try {
      await props.onSaved();
      if (!disposed) {
        close();
        setCommitted("");
      }
    } catch (cause) {
      if (!disposed) setError(`但刷新失败：${errorText(cause)}`);
    }
  };
  const retryRefresh = async () => {
    if (saving() || !committed()) return;
    setSaving(true);
    try {
      await refreshSaved();
    } finally {
      if (!disposed) setSaving(false);
    }
  };
  const save = async (reset = false) => {
    const current = base();
    if (!current || saving() || committed() || recovery() === "unknown" || !title().trim() || (reset && resetDisabled())) return;
    setSaving(true);
    setResetting(reset);
    setError("");
    try {
      // Save and reset are one reservation on the server; sending them separately would queue a metadata round first.
      await updateIssue(
        props.issue.id,
        {
          title: title().trim(),
          description: description().trim(),
          priority: priority(),
          assigneeSubject: assignee(),
          ccSubjects: [...cc()],
          expectedEditVersion: current.editVersion,
        },
        [...removedAttachmentIds()],
        [...attachments()],
        reset ? current.resetVersion : undefined,
      );
      if (disposed) return;
      markCommitted(reset ? "工单已保存并重置" : "工单已保存");
      await refreshSaved();
    } catch (cause) {
      if (disposed) return;
      if (cause instanceof RequestError && cause.outcome === "committed") markCommitted(errorText(cause, undefined, "工单已保存，请重新读取"));
      else if (cause instanceof RequestError && cause.outcome === "unknown") setRecovery("unknown");
      else if (cause instanceof Error && cause.message === "issue_edit_conflict") setRecovery("metadata");
      else if (cause instanceof Error && cause.message === "agent_session_changed") setRecovery("session");
      else setError(errorText(cause, editErrors));
    } finally {
      if (!disposed) {
        setSaving(false);
        setResetting(false);
      }
    }
  };

  return (
    <Modal
      open={props.open}
      title="编辑工单"
      confirmLoading={saving()}
      onOk={() => {
        void save();
      }}
      onCancel={dismiss}
      footer={
        <>
          <Button disabled={saving()} onClick={dismiss}>
            {committed() ? "关闭" : "取消"}
          </Button>
          <Show
            when={committed()}
            fallback={
              <>
                <Button
                  danger
                  disabled={saving() || recovery() === "unknown" || !title().trim() || resetDisabled()}
                  loading={saving() && resetting()}
                  onClick={() => {
                    void save(true);
                  }}
                >
                  重置
                </Button>
                <Button
                  type="primary"
                  disabled={saving() || recovery() === "unknown" || !title().trim()}
                  loading={saving() && !resetting()}
                  onClick={() => {
                    void save();
                  }}
                >
                  保存
                </Button>
              </>
            }
          >
            <Button type="primary" disabled={saving()} loading={saving()} onClick={() => void retryRefresh()}>
              重新读取
            </Button>
          </Show>
        </>
      }
    >
      <Show
        when={!committed()}
        fallback={
          <p role={saving() && !error() ? "status" : "alert"}>
            {committed()}
            {error() ? `，${error()}` : "。"}
          </p>
        }
      >
        <div class="create-issue-form compact-issue-form edit-issue-form">
          <Show when={formMessage()}>
            <div class="create-error modal-form-error" role="alert">
              {formMessage()}
              <Show when={recovery()}>
                <Button size="small" disabled={saving()} onClick={() => void reloadDraft()}>
                  重新载入（放弃草稿）
                </Button>
              </Show>
            </div>
          </Show>
          <label>
            <span>优先级</span>
            <Select
              aria-label="编辑工单优先级"
              value={priority()}
              onChange={(value) => {
                const selected = selectedChoice(
                  value,
                  priorityOptions.map((option) => option.value),
                );
                if (selected) setPriority(selected);
              }}
              options={priorityOptions}
            />
          </label>
          <label>
            <span>处理人</span>
            <Select
              aria-label="编辑工单处理人"
              value={assignee() ?? undefined}
              allowClear
              onClear={() => setAssignee(null)}
              onChange={(value) => {
                if (typeof value === "string" && value) setAssignee(value);
              }}
              options={people()
                .filter((person) => {
                  const mode = currentWorkMode();
                  return !mode || canUseIssueWorkMode(person.role, mode);
                })
                .map((person) => ({ value: person.subject, label: personLabel(person) }))}
            />
          </label>
          <label>
            <span>抄送人</span>
            <div class="multi-select-trigger">
              <Select
                mode="multiple"
                aria-label="编辑工单抄送人"
                value={cc()}
                onChange={setCc}
                options={people()
                  .filter((person) => person.subject !== assignee())
                  .map((person) => ({ value: person.subject, label: personLabel(person) }))}
              />
            </div>
          </label>
          <label>
            <span>标题</span>
            <Input aria-label="编辑工单标题" value={title()} onValueChange={setTitle} />
          </label>
          <DescriptionField value={description} inputLabel="编辑工单描述" expandLabel="放大编辑工单描述" onChange={setDescription} />
          <AttachmentPicker
            files={attachments}
            existingFiles={() => (base()?.attachments ?? []).filter((attachment) => !removedAttachmentIds().includes(attachment.id))}
            inputLabel="编辑工单选择附件"
            onFilesChange={setAttachments}
            onRemoveExisting={(id) => {
              setRemovedAttachmentIds((current) => [...current, id]);
              setError("");
            }}
            onError={setError}
          />
          <p class="edit-issue-reset-hint">重置会保存当前修改并创建新会话，旧对话可在历史中查看；新会话不会带入旧聊天，代码、附件和工作文件保留。</p>
        </div>
      </Show>
    </Modal>
  );
}
