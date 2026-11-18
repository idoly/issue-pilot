import { createMemo, createSignal, onCleanup, Show, untrack } from "solid-js";

import { Input, Modal, Select } from "../ui";
import { createIssue, type IssueDetail } from "../data/client";
import { useApplicationResources } from "./ApplicationResources";
import { DescriptionField, selectedChoice } from "./IssueForm";
import { errorText } from "./error-text";
import { servicesForWorkMode } from "./model";

/** A development Issue creates a production-investigation follow-up linked back to it. */
export function FollowUpDialog(props: { issue: IssueDetail; open: boolean; register: (open: () => void) => void; onClose: () => void; onCreated: (issueKey: string) => void }) {
  const { catalog, people } = useApplicationResources();
  const [title, setTitle] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [service, setService] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const productionServices = createMemo(() => servicesForWorkMode(catalog().services, "production_analysis"));

  // Opening is an event: fill the form from the Issue and the current production services.
  props.register(() => {
    setTitle(`【正式跟进】${props.issue.title}`);
    setDescription(props.issue.description);
    setService(untrack(() => (productionServices().some((row) => row.key === props.issue.service.key) ? props.issue.service.key : (productionServices()[0]?.key ?? ""))));
    setError("");
  });

  const create = async () => {
    if (!title().trim() || !service()) return;
    setSaving(true);
    setError("");
    try {
      const created = await createIssue({
        title: title().trim(),
        description: description().trim(),
        priority: props.issue.priority,
        workMode: "production_analysis",
        serviceKey: service(),
        assigneeSubject: people().some(({ subject }) => subject === props.issue.assigneeSubject) ? props.issue.assigneeSubject : null,
        ccSubjects: props.issue.ccRecipients.map(({ subject }) => subject).filter((subject) => people().some((person) => person.subject === subject)),
        relatedIssueKeys: [props.issue.id],
      });
      if (disposed) return;
      props.onClose();
      props.onCreated(created.id);
    } catch (cause) {
      if (!disposed) setError(errorText(cause));
    } finally {
      if (!disposed) setSaving(false);
    }
  };

  return (
    <Modal
      open={props.open}
      title="创建正式跟进工单"
      okText="创建并关联"
      cancelText="取消"
      confirmLoading={saving()}
      okButtonProps={{ disabled: !title().trim() || !service() }}
      onOk={() => {
        void create();
      }}
      onCancel={() => {
        if (!saving()) props.onClose();
      }}
    >
      <div class="create-issue-form compact-issue-form follow-up-form">
        <label>
          <span>处理方式</span>
          <Input aria-label="正式跟进处理方式" value="正式问题调查" disabled />
        </label>
        <label>
          <span>服务</span>
          <Select
            aria-label="正式跟进服务"
            value={service()}
            onChange={(value) => {
              const selected = selectedChoice(
                value,
                productionServices().map((row) => row.key),
              );
              if (selected) setService(selected);
            }}
            options={productionServices().map((row) => ({ value: row.key, label: row.name }))}
          />
        </label>
        <label>
          <span>标题</span>
          <Input aria-label="正式跟进标题" value={title()} onInput={(event) => setTitle(event.currentTarget.value)} />
        </label>
        <DescriptionField value={description} inputLabel="正式跟进描述" expandLabel="放大正式跟进描述" onChange={setDescription} />
        <p>新工单会关联当前开发工单，并读取其已提交分支快照和 Pi 对话；附件不会复制。</p>
        <Show when={error()}>
          <div class="create-error modal-form-error" role="alert">
            {error()}
          </div>
        </Show>
      </div>
    </Modal>
  );
}
