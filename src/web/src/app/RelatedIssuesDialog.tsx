import { createMemo, createSignal, onCleanup, Show } from "solid-js";

import { sharedConfig } from "../../../../issue-pilot.config.ts";
import { Modal } from "../ui";
import { relatedIssueUpdateRefusal, updateIssueRelatedIssues, type IssueDetail } from "../data/client";
import { createLatestTask } from "../data/latest";
import { RelatedIssueSelect } from "./IssueForm";
import { errorText, type ErrorTexts } from "./error-text";
import type { IssueListResource } from "./issue-list";

// Saving relations reserves this Issue and every selected related Issue.
const relatedSaveErrors: ErrorTexts = { issue_already_running: "本工单或所选关联工单正在处理，请等待处理结束后再保存关联。" };

export function RelatedIssuesDialog(props: {
  issue: IssueDetail;
  issueList: IssueListResource;
  open: boolean;
  register: (open: () => void) => void;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [keys, setKeys] = createSignal<string[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const refreshTask = createLatestTask();
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    refreshTask.cancel();
  });

  const close = () => {
    refreshTask.cancel();
    setLoading(false);
    props.onClose();
  };
  // Opening is an event: seed the selection from the Issue and refresh candidates in the background.
  props.register(() => {
    const request = refreshTask.begin();
    setKeys(props.issue.relatedIssues.map(({ id }) => id));
    setError("");
    setLoading(true);
    void props.issueList
      .refresh()
      .then(() => {
        if (request.isCurrent() && props.issueList.error()) setError(errorText(props.issueList.error()));
      })
      .finally(() => {
        if (request.isCurrent()) setLoading(false);
        request.finish();
      });
  });
  const selectable = createMemo(() => props.issueList.items().filter((candidate) => candidate.id !== props.issue.id));

  const save = async () => {
    const currentKeys = new Set(props.issue.relatedIssues.map(({ id }) => id));
    // A failed related context only blocks additions; the user can still detach broken relations.
    const refusal = relatedIssueUpdateRefusal(props.issue, { onlyRemoves: keys().every((id) => currentKeys.has(id)) });
    if (refusal) {
      setError(errorText(refusal, relatedSaveErrors));
      return;
    }
    setSaving(true);
    setError("");
    try {
      await updateIssueRelatedIssues(props.issue.id, keys());
      if (disposed) return;
      await props.onSaved();
      if (!disposed) close();
    } catch (cause) {
      if (!disposed) setError(errorText(cause, relatedSaveErrors));
    } finally {
      if (!disposed) setSaving(false);
    }
  };

  // The dialog reflects one Issue; a switch unmounts it instead of carrying the old selection over.
  return (
    <Modal
      open={props.open}
      title="编辑关联工单"
      okText="保存关联"
      cancelText="取消"
      confirmLoading={saving()}
      cancelButtonProps={{ disabled: saving() }}
      okButtonProps={{ disabled: loading() || keys().length > sharedConfig.limits.relatedIssues }}
      onOk={() => {
        void save();
      }}
      onCancel={() => {
        if (!saving()) close();
      }}
    >
      <div class="create-issue-form related-issue-form">
        <label>
          <span>
            关联工单（{selectable().length} 个可选，最多选择 {sharedConfig.limits.relatedIssues} 个）
          </span>
          <RelatedIssueSelect candidates={selectable()} value={keys()} inputLabel="编辑关联工单" onChange={setKeys} />
        </label>
        <p>保存后将关闭当前会话。下次运行会使用所选工单的资料和可用对话作为只读上下文；有本地开发分支时也会提供代码快照。</p>
        <Show when={error()}>
          <div class="create-error modal-form-error" role="alert">
            {error()}
          </div>
        </Show>
      </div>
    </Modal>
  );
}
