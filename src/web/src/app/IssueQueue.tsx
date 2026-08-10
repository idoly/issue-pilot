import { Badge, Button, Input, Modal, Select, Skeleton, Tag } from "@idoly/ant-design-solid";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

import { ChevronRight, ListFilter, Plus, Search } from "../ui/icons";
import { createIssue, errorMessage, ISSUE_STATUSES, listIssues, type IssuePriority, type IssueType } from "../data/client";
import { useApplicationResources } from "./ApplicationResources";
import { AttachmentPicker, DescriptionField, bindMultipleSelectBlankToggle, issueTypesForEnvironment, selectedChoice, selectedStrings } from "./IssueForm";
import { priorityColor, priorityOptions, relativeTime, statusBadge, statusLabel, typeLabel } from "./model";

export function IssueQueue(props: {
  selectedId: string;
  userSubject: string;
  refreshToken: number;
  onSelect: (id: string) => void;
}) {
  const { configuration, people, configurationError, peopleError } = useApplicationResources();
  const [issues, setIssues] = createSignal<Awaited<ReturnType<typeof listIssues>>>([], { ownedWrite: true });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [loadError, setLoadError] = createSignal("", { ownedWrite: true });
  const [query, setQuery] = createSignal("", { ownedWrite: true });
  const [status, setStatus] = createSignal<string>("active", { ownedWrite: true });
  const filtered = createMemo(() => {
    const term = query().trim().toLowerCase();
    return issues().filter((issue) => {
      const statusMatch = status() === "all" || (status() === "active" && issue.status !== "resolved") || issue.status === status();
      return statusMatch && (!term || `${issue.id} ${issue.title} ${issue.service.key} ${issue.service.name}`.toLowerCase().includes(term));
    });
  });
  let listRequest = 0;
  createEffect(() => props.refreshToken, () => {
    const currentRequest = ++listRequest;
    setLoading(true);
    setLoadError("");
    void listIssues().then((loaded) => {
      if (currentRequest === listRequest) setIssues(loaded);
    }).catch((error) => {
      if (currentRequest !== listRequest) return;
      setIssues([]);
      setLoadError(error instanceof Error ? error.message : "工单加载失败");
    }).finally(() => {
      if (currentRequest === listRequest) setLoading(false);
    });
  });
  createEffect(
    () => ({ loading: loading(), selectedId: props.selectedId, visible: filtered() }),
    ({ loading, selectedId, visible }) => {
      if (!loading && !visible.some((issue) => issue.id === selectedId)) props.onSelect(visible[0]?.id ?? "");
    },
  );
  const [createOpen, setCreateOpen] = createSignal(false, { ownedWrite: true });
  const [title, setTitle] = createSignal("", { ownedWrite: true });
  const [description, setDescription] = createSignal("", { ownedWrite: true });
  const [service, setService] = createSignal("", { ownedWrite: true });
  const [environment, setEnvironment] = createSignal("", { ownedWrite: true });
  const [priority, setPriority] = createSignal<IssuePriority>("p2", { ownedWrite: true });
  const [issueType, setIssueType] = createSignal<IssueType>("smart_analysis", { ownedWrite: true });
  const [assigneeSubject, setAssigneeSubject] = createSignal<string | null>(null, { ownedWrite: true });
  const [ccSubjects, setCcSubjects] = createSignal<string[]>([], { ownedWrite: true });
  createEffect(
    () => ({ assignee: assigneeSubject(), createOpen: createOpen(), subject: props.userSubject }),
    ({ assignee, createOpen, subject }) => { if (subject && !createOpen && assignee === null) setAssigneeSubject(subject); },
  );
  const [ccOpen, setCcOpen] = createSignal(false);
  const [attachments, setAttachments] = createSignal<File[]>([], { ownedWrite: true });
  const [saving, setSaving] = createSignal(false, { ownedWrite: true });
  const [createError, setCreateError] = createSignal("", { ownedWrite: true });
  const availableIssueTypes = createMemo(() => issueTypesForEnvironment(environment()));
  const changeEnvironment = (value: unknown) => {
    const environmentKey = selectedChoice(value, configuration().environments.map((environment) => environment.key));
    if (!environmentKey) return;
    const allowedTypes = issueTypesForEnvironment(environmentKey);
    setEnvironment(environmentKey);
    setService("");
    if (!allowedTypes.includes(issueType())) setIssueType(allowedTypes[0] ?? "smart_analysis");
  };
  createEffect(() => ({ currentEnvironment: environment(), configuration: configuration() }), ({ currentEnvironment, configuration }) => {
    const selectedEnvironment = configuration.environments.some((environment) => environment.key === currentEnvironment) ? currentEnvironment : configuration.environments[0]?.key ?? "";
    setEnvironment(selectedEnvironment);
    const allowedTypes = issueTypesForEnvironment(selectedEnvironment);
    setIssueType((current) => allowedTypes.includes(current) ? current : allowedTypes[0] ?? "smart_analysis");
    const availableServices = configuration.services.filter((service) => service.deployments.some((deployment) => deployment.environmentKey === selectedEnvironment));
    setService((current) => availableServices.some((service) => service.key === current) ? current : availableServices[0]?.key ?? "");
  });
  const submitIssue = async () => {
    if (!title().trim() || !service()) return;
    setSaving(true);
    setCreateError("");
    try {
      const issue = await createIssue({
        title: title().trim(),
        description: description().trim(),
        priority: priority(),
        type: issueType(),
        assigneeSubject: assigneeSubject(),
        ccSubjects: ccSubjects(),
        serviceKey: service(),
        environmentKey: environment(),
      }, attachments());
      setIssues((current) => [issue, ...current.filter((item) => item.id !== issue.id)]);
      props.onSelect(issue.id);
      setCcOpen(false);
      setCreateOpen(false);
      setTitle("");
      setDescription("");
      setAttachments([]);
    } catch (error) {
      setCreateError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <aside class="issue-queue" aria-label="工单队列">
      <div class="queue-toolbar">
        <Input
          aria-label="搜索工单"
          placeholder="搜索工单"
          allowClear
          prefix={<Search size={15} />}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <Button type="primary" shape="circle" icon={<Plus size={16} />} title="新建工单" aria-label="新建工单" onClick={() => setCreateOpen(true)} />
      </div>
      <div class="queue-filter">
        <ListFilter size={14} aria-hidden="true" />
        <Select
          aria-label="按状态筛选"
          value={status()}
          onChange={(value) => { const selected = selectedChoice(value, ["active", ...ISSUE_STATUSES, "all"] as const); if (selected) setStatus(selected); }}
          options={[
            { value: "active", label: "未解决" },
            ...Object.entries(statusLabel).map(([value, label]) => ({ value, label })),
            { value: "all", label: "全部工单" },
          ]}
        />
        <span class="queue-count">{filtered().length}</span>
      </div>
      <div class="queue-list" role="list">
        <Show when={!loading()} fallback={<div class="queue-loading"><Skeleton active paragraph={{ rows: 5 }} /></div>}>
          <Show when={!loadError() && !configurationError()} fallback={<div class="queue-error" role="alert">{loadError() || configurationError()}</div>}>
          <For each={filtered()} fallback={<div class="queue-empty">没有匹配的工单</div>}>
            {(issue) => (
              <button
                type="button"
                role="listitem"
                class={`queue-item${issue.id === props.selectedId ? " selected" : ""}`}
                onClick={() => props.onSelect(issue.id)}
              >
                <span class="queue-item-topline">
                  <span class="issue-key">{issue.id}</span>
                  <Tag color={priorityColor[issue.priority]}>{issue.priority.toUpperCase()}</Tag>
                  <span class="queue-time">{relativeTime(issue.updatedAt)}</span>
                </span>
                <span class="queue-title">{issue.title}</span>
                <span class="queue-item-meta">
                  <Badge status={statusBadge[issue.status]} text={statusLabel[issue.status]} />
                  <span>{issue.assignee ?? "未分配"}</span>
                </span>
                <ChevronRight class="queue-chevron" size={16} aria-hidden="true" />
              </button>
            )}
          </For>
          </Show>
        </Show>
      </div>
      <Modal open={createOpen()} title="新建工单" okText="创建" cancelText="取消" onOk={() => { void submitIssue(); }} onCancel={() => { setCcOpen(false); setCreateOpen(false); }} confirmLoading={saving()} okButtonProps={{ disabled: !title().trim() || !service() }}>
        <div class="create-issue-form compact-issue-form new-issue-form">
          <label><span>环境</span><Select aria-label="工单环境" value={environment()} onChange={changeEnvironment} options={configuration().environments.map((item) => ({ value: item.key, label: item.name }))} /></label>
          <label><span>服务</span><Select aria-label="工单服务" value={service()} onChange={(value) => { const selected = selectedChoice(value, configuration().services.map((item) => item.key)); if (selected) setService(selected); }} options={configuration().services.filter((item) => item.deployments.some((deployment) => deployment.environmentKey === environment())).map((item) => ({ value: item.key, label: item.name }))} /></label>
          <label><span>优先级</span><Select aria-label="工单优先级" value={priority()} onChange={(value) => { const selected = selectedChoice(value, priorityOptions.map((option) => option.value)); if (selected) setPriority(selected); }} options={priorityOptions} /></label>
          <label><span>类型</span><Select aria-label="工单类型" value={issueType()} onChange={(value) => { const selected = selectedChoice(value, availableIssueTypes()); if (selected) setIssueType(selected); }} options={availableIssueTypes().map((value) => ({ value, label: typeLabel[value] }))} /></label>
          <label><span>处理人</span><Select aria-label="工单处理人" value={assigneeSubject() ?? undefined} allowClear onClear={() => setAssigneeSubject(null)} onChange={(value) => { if (typeof value === "string" && value) setAssigneeSubject(value); }} options={people().map((person) => ({ value: person.subject, label: `${person.name}${person.email ? ` · ${person.email}` : ""}` }))} /></label>
          <label><span>抄送人（可多选）</span><div class="multi-select-trigger" ref={(element) => bindMultipleSelectBlankToggle(element, setCcOpen)}><Select mode="multiple" aria-label="工单抄送人" value={ccSubjects()} open={ccOpen()} onOpenChange={setCcOpen} onChange={(value) => setCcSubjects(selectedStrings(value, ccSubjects()))} options={people().filter((person) => person.subject !== assigneeSubject()).map((person) => ({ value: person.subject, label: `${person.name}${person.email ? ` · ${person.email}` : ""}` }))} /></div></label>
          <label><span>标题</span><Input aria-label="工单标题" value={title()} onInput={(event) => setTitle(event.currentTarget.value)} /></label>
          <DescriptionField value={description} inputLabel="工单描述" expandLabel="放大工单描述" onChange={(value) => setDescription(value)} />
          <AttachmentPicker files={attachments} inputLabel="选择附件" onFilesChange={(files) => setAttachments(files)} onError={(message) => setCreateError(message)} />
          <Show when={createError() || peopleError()}><div class="create-error" role="alert">{createError() || peopleError()}</div></Show>
        </div>
      </Modal>
    </aside>
  );
}
