import { Badge, Button, Input, Modal, Select, Skeleton, Tag } from "../ui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";

import { ChevronRight, Pin, Plus, Search } from "../ui/icons";
import { canUseIssueWorkMode, createIssue, errorMessage, issueScopeForWorkMode, listIssuePins, listIssues, setIssuePinned, type IssuePriority, type IssueWorkMode } from "../data/client";
import { useApplicationResources } from "./ApplicationResources";
import { AttachmentPicker, DescriptionField, RelatedIssueSelect, selectedChoice } from "./IssueForm";
import { priorityColor, priorityOptions, issueCreationDate, relativeTime, statusBadge, statusLabel, workModeOptions } from "./model";

type QueueStatusFilter = "active" | "pending" | "resolved" | "all";

export function IssueQueue(props: {
  selectedId: string;
  userSubject: string;
  refreshToken: number;
  hidden?: boolean;
  keepExternalSelection?: boolean;
  onSelect: (id: string) => void;
}) {
  const { catalog, people, currentUser, catalogError, peopleError } = useApplicationResources();
  const [issues, setIssues] = createSignal<Awaited<ReturnType<typeof listIssues>>>([], { ownedWrite: true });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [loadError, setLoadError] = createSignal("", { ownedWrite: true });
  const [pinError, setPinError] = createSignal("", { ownedWrite: true });
  const [pinnedIssueKeys, setPinnedIssueKeys] = createSignal<string[]>([], { ownedWrite: true });
  const [pinningIssueKeys, setPinningIssueKeys] = createSignal<string[]>([], { ownedWrite: true });
  const [query, setQuery] = createSignal("", { ownedWrite: true });
  const [status, setStatus] = createSignal<QueueStatusFilter>("all", { ownedWrite: true });
  const [environmentFilter, setEnvironmentFilter] = createSignal("all", { ownedWrite: true });
  const [serviceFilter, setServiceFilter] = createSignal("all", { ownedWrite: true });
  const environmentLabel = (key: string) => catalog().environments.find((environment) => environment.key === key)?.name ?? key;
  const filtered = createMemo(() => {
    const subject = props.userSubject;
    if (!subject) return [];
    const term = query().trim().toLowerCase();
    const pinned = new Set(pinnedIssueKeys());
    return issues().filter((issue) => {
      const assigneeMatch = issue.assigneeSubject === subject;
      const statusMatch = status() === "all" || (status() === "active" && issue.status !== "resolved") || issue.status === status();
      const environmentMatch = environmentFilter() === "all" || issue.environmentKey === environmentFilter();
      const serviceMatch = serviceFilter() === "all" || issue.service.key === serviceFilter();
      const searchMatch = !term || `${issue.id} ${issue.title} ${issue.service.key} ${issue.service.name} ${issue.environmentKey}`.toLowerCase().includes(term);
      return assigneeMatch && statusMatch && environmentMatch && serviceMatch && searchMatch;
    }).sort((left, right) => Number(pinned.has(right.id)) - Number(pinned.has(left.id)));
  });
  const togglePinned = async (issueKey: string) => {
    if (pinningIssueKeys().includes(issueKey)) return;
    const pinned = pinnedIssueKeys().includes(issueKey), owner = pinRequest;
    setPinningIssueKeys(current => [...current, issueKey]);
    setPinError("");
    try {
      await setIssuePinned(issueKey, !pinned);
      if (owner !== pinRequest) return;
      setPinnedIssueKeys((current) => pinned ? current.filter((key) => key !== issueKey) : [...current, issueKey]);
    } catch (error) {
      if (owner === pinRequest) setPinError(errorMessage(error));
    } finally {
      if (owner === pinRequest) setPinningIssueKeys(current => current.filter(key => key !== issueKey));
    }
  };
  let listRequest = 0;
  const loadIssues = () => {
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
  };
  createEffect(() => props.refreshToken, () => loadIssues());
  let pinRequest = 0;
  createEffect(() => props.userSubject, (subject) => {
    const currentRequest = ++pinRequest;
    setPinError("");
    setPinnedIssueKeys([]); setPinningIssueKeys([]);
    if (!subject) return;
    void listIssuePins().then((pinned) => {
      if (currentRequest === pinRequest) setPinnedIssueKeys(pinned);
    }).catch((error) => {
      if (currentRequest !== pinRequest) return;
      setPinnedIssueKeys([]);
      setPinError(errorMessage(error));
    });
  });
  createEffect(
    () => ({ loading: loading(), selectedId: props.selectedId, visible: filtered(), keepExternalSelection: props.keepExternalSelection }),
    ({ loading, selectedId, visible, keepExternalSelection }) => {
      if (!loading && !keepExternalSelection && !visible.some((issue) => issue.id === selectedId)) props.onSelect(visible[0]?.id ?? "");
    },
  );
  const [createOpen, setCreateOpen] = createSignal(false, { ownedWrite: true });
  const [title, setTitle] = createSignal("", { ownedWrite: true });
  const [description, setDescription] = createSignal("", { ownedWrite: true });
  const [service, setService] = createSignal("", { ownedWrite: true });
  const [workMode, setWorkMode] = createSignal<IssueWorkMode>("production_analysis", { ownedWrite: true });
  const [priority, setPriority] = createSignal<IssuePriority>("p2", { ownedWrite: true });
  const [assigneeSubject, setAssigneeSubject] = createSignal<string | null>(null, { ownedWrite: true });
  const [ccSubjects, setCcSubjects] = createSignal<string[]>([], { ownedWrite: true });
  const [relatedIssueKeys, setRelatedIssueKeys] = createSignal<string[]>([], { ownedWrite: true });
  const [relatedCandidates, setRelatedCandidates] = createSignal<Awaited<ReturnType<typeof listIssues>>>([], { ownedWrite: true });
  const [relatedLoading, setRelatedLoading] = createSignal(false, { ownedWrite: true });
  createEffect(
    () => ({ createOpen: createOpen(), subject: props.userSubject }),
    ({ createOpen, subject }) => { if (subject && !createOpen) setAssigneeSubject(subject); },
  );
  const [attachments, setAttachments] = createSignal<File[]>([], { ownedWrite: true });
  const [saving, setSaving] = createSignal(false, { ownedWrite: true });
  const [createError, setCreateError] = createSignal("", { ownedWrite: true });
  let contextGeneration = 0, relatedRequest = 0;
  onCleanup(() => { contextGeneration++; listRequest++; pinRequest++; relatedRequest++; });
  const closeCreateIssue = () => { relatedRequest++; setCreateOpen(false); setRelatedLoading(false); };
  createEffect(() => ({ subject: props.userSubject, role: currentUser()?.role }), (context, previous) => {
    if (!previous || context.subject === previous.subject && context.role === previous.role) return;
    contextGeneration++;
    closeCreateIssue(); setSaving(false); setCreateError("");
    setTitle(""); setDescription(""); setPriority("p2"); setAssigneeSubject(context.subject || null); setCcSubjects([]);
    setAttachments([]); setRelatedIssueKeys([]); setRelatedCandidates([]);
  });
  const availableWorkModes = createMemo(() => workModeOptions.filter((option) => {
    if (!canUseIssueWorkMode(currentUser()?.role ?? "product", option.value)) return false;
    const environmentKind = issueScopeForWorkMode(option.value).environmentKind;
    return catalog().services.some((candidate) => candidate.deployments.some((deployment) => deployment.environmentKey === environmentKind));
  }));
  const availableServices = createMemo(() => {
    const environmentKind = issueScopeForWorkMode(workMode()).environmentKind;
    return catalog().services.filter((candidate) => candidate.deployments.some((deployment) => deployment.environmentKey === environmentKind));
  });
  const relatedIssues = createMemo(() => relatedCandidates());
  const openCreateIssue = () => {
    if (!props.userSubject || saving()) return;
    const owner = contextGeneration, request = ++relatedRequest;
    setCreateError("");
    setCreateOpen(true);
    setRelatedLoading(true);
    void listIssues().then(value => { if (owner === contextGeneration && request === relatedRequest) setRelatedCandidates(value); })
      .catch((error) => { if (owner === contextGeneration && request === relatedRequest) setCreateError(errorMessage(error)); })
      .finally(() => { if (owner === contextGeneration && request === relatedRequest) setRelatedLoading(false); });
  };
  createEffect(
    () => ({ currentMode: workMode(), modes: availableWorkModes(), services: catalog().services }),
    ({ currentMode, modes, services }) => {
      const selectedMode = modes.some(({ value }) => value === currentMode) ? currentMode : modes[0]?.value ?? "production_analysis";
      if (selectedMode !== currentMode) setWorkMode(selectedMode);
      const compatibleServices = services.filter((candidate) => candidate.deployments.some((deployment) => deployment.environmentKey === issueScopeForWorkMode(selectedMode).environmentKind));
      setService((current) => compatibleServices.some((candidate) => candidate.key === current) ? current : compatibleServices[0]?.key ?? "");
    },
  );
  const submitIssue = async () => {
    if (!props.userSubject || saving() || !title().trim() || !service()) return;
    const owner = contextGeneration;
    setSaving(true);
    setCreateError("");
    try {
      const issue = await createIssue({
        title: title().trim(),
        description: description().trim(),
        priority: priority(),
        workMode: workMode(),
        assigneeSubject: assigneeSubject(),
        ccSubjects: ccSubjects(),
        serviceKey: service(),
        relatedIssueKeys: relatedIssueKeys(),
      }, attachments());
      if (owner !== contextGeneration) return;
      loadIssues();
      setIssues((current) => [issue, ...current.filter((item) => item.id !== issue.id)]);
      props.onSelect(issue.id);
      closeCreateIssue();
      setTitle("");
      setDescription("");
      setAttachments([]);
      setRelatedIssueKeys([]);
    } catch (error) {
      if (owner === contextGeneration) setCreateError(errorMessage(error));
    } finally {
      if (owner === contextGeneration) setSaving(false);
    }
  };
  return (
    <aside class="issue-queue" aria-label="工单队列" hidden={props.hidden}>
      <div class="queue-toolbar">
        <Input
          aria-label="搜索工单"
          placeholder="搜索工单"
          allowClear
          prefix={<Search size={15} />}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <Button class="icon-button" type="primary" shape="circle" icon={<Plus size={16} />} title="新建工单" aria-label="新建工单" disabled={!props.userSubject} onClick={openCreateIssue} />
      </div>
      <div class="queue-filter">
        <div class="queue-filter-controls">
          <Select
            aria-label="按状态筛选"
            value={status()}
            onChange={(value) => { const selected = selectedChoice(value, ["active", "pending", "resolved", "all"] as const); if (selected) setStatus(selected); }}
            options={[
              { value: "active", label: "未解决" },
              { value: "pending", label: statusLabel.pending },
              { value: "resolved", label: statusLabel.resolved },
              { value: "all", label: "全部工单" },
            ]}
          />
          <Select
            aria-label="按服务筛选"
            value={serviceFilter()}
            onChange={(value) => { const selected = selectedChoice(value, ["all", ...catalog().services.map((item) => item.key)]); if (selected) setServiceFilter(selected); }}
            options={[{ value: "all", label: "全部服务" }, ...catalog().services.map((item) => ({ value: item.key, label: item.name }))]}
          />
          <Select
            aria-label="按环境筛选"
            value={environmentFilter()}
            onChange={(value) => { const selected = selectedChoice(value, ["all", ...catalog().environments.map((item) => item.key)]); if (selected) setEnvironmentFilter(selected); }}
            options={[{ value: "all", label: "全部环境" }, ...catalog().environments.map((item) => ({ value: item.key, label: item.name }))]}
          />
        </div>
      </div>
      <div class="queue-list" role="list">
        <Show when={!loading()} fallback={<div class="queue-loading"><Skeleton active paragraph={{ rows: 5 }} /></div>}>
          <Show when={!loadError() && !catalogError()} fallback={<div class="queue-error" role="alert">{loadError() || catalogError()}</div>}>
          <Show when={pinError()}><div class="queue-action-error" role="alert">{pinError()}</div></Show>
          <For each={filtered()} fallback={<div class="queue-empty">没有匹配的工单</div>}>
            {(issue) => {
              const pinned = () => pinnedIssueKeys().includes(issue.id);
              return (
                <div
                  role="listitem"
                  tabindex={0}
                  class={`queue-item${issue.id === props.selectedId ? " selected" : ""}${pinned() ? " pinned" : ""}`}
                  aria-current={issue.id === props.selectedId ? "true" : undefined}
                  onClick={() => props.onSelect(issue.id)}
                  onKeyDown={(event) => { if (event.target === event.currentTarget && ["Enter", " "].includes(event.key)) { event.preventDefault(); props.onSelect(issue.id); } }}
                >
                  <span class="queue-item-topline">
                    <span class="issue-key">{issue.id}</span>
                    <Tag color={priorityColor[issue.priority]}>{issue.priority.toUpperCase()}</Tag>
                    <span class="queue-time" title={issueCreationDate(issue.createdAt, true)}>{relativeTime(issue.updatedAt)}</span>
                  </span>
                  <span class="queue-title" title={issue.title}>{issue.title}</span>
                  <span class="queue-item-meta">
                    <span class="queue-status"><Badge status={statusBadge[issue.status]} text={statusLabel[issue.status]} /></span>
                    <span class="queue-scope" title={`${issue.service.name} / ${environmentLabel(issue.environmentKey)}`}>
                      <strong>{issue.service.name}</strong><span aria-hidden="true">/</span><span>{environmentLabel(issue.environmentKey)}</span>
                    </span>
                  </span>
                  <button
                    type="button"
                    class={`queue-pin${pinned() ? " pinned" : ""}`}
                    aria-label={`${pinned() ? "取消固定" : "固定"} ${issue.id}`}
                    title={pinned() ? "取消固定" : "固定到顶部"}
                    disabled={pinningIssueKeys().includes(issue.id)}
                    onClick={(event) => { event.stopPropagation(); void togglePinned(issue.id); }}
                  ><Pin size={14} aria-hidden="true" /></button>
                  <ChevronRight class="queue-chevron" size={16} aria-hidden="true" />
                </div>
              );
            }}
          </For>
          </Show>
        </Show>
      </div>
      <Modal open={createOpen()} title="新建工单" okText="创建" cancelText="取消" onOk={() => { void submitIssue(); }} onCancel={closeCreateIssue} confirmLoading={saving()} okButtonProps={{ disabled: !title().trim() || !service() }}>
        <div class="create-issue-form compact-issue-form new-issue-form">
          <label><span>处理方式</span><Select aria-label="工单处理方式" value={workMode()} onChange={(value) => { const selected = selectedChoice(value, availableWorkModes().map((option) => option.value)); if (selected) setWorkMode(selected); }} options={availableWorkModes()} /></label>
          <label><span>入口服务</span><Select aria-label="工单服务" value={service()} onChange={(value) => { const selected = selectedChoice(value, availableServices().map((item) => item.key)); if (selected) setService(selected); }} options={availableServices().map((item) => ({ value: item.key, label: item.name }))} /></label>
          <label><span>优先级</span><Select aria-label="工单优先级" value={priority()} onChange={(value) => { const selected = selectedChoice(value, priorityOptions.map((option) => option.value)); if (selected) setPriority(selected); }} options={priorityOptions} /></label>
          <label><span>处理人</span><Select aria-label="工单处理人" value={assigneeSubject() ?? undefined} allowClear onClear={() => setAssigneeSubject(null)} onChange={(value) => { if (typeof value === "string" && value) setAssigneeSubject(value); }} options={people().filter((person) => canUseIssueWorkMode(person.role, workMode())).map((person) => ({ value: person.subject, label: `${person.name}${person.email ? ` · ${person.email}` : ""}` }))} /></label>
          <label><span>抄送人（可多选）</span><div class="multi-select-trigger"><Select mode="multiple" aria-label="工单抄送人" value={ccSubjects()} onChange={setCcSubjects} options={people().filter((person) => person.subject !== assigneeSubject()).map((person) => ({ value: person.subject, label: `${person.name}${person.email ? ` · ${person.email}` : ""}` }))} /></div></label>
          <label><span>关联工单（可多选，共 {relatedIssues().length} 个）</span><RelatedIssueSelect candidates={relatedIssues()} value={relatedIssueKeys()} loading={relatedLoading()} inputLabel="关联工单" onChange={setRelatedIssueKeys} /></label>
          <label><span>标题</span><Input aria-label="工单标题" value={title()} onInput={(event) => setTitle(event.currentTarget.value)} /></label>
          <DescriptionField value={description} inputLabel="工单描述" expandLabel="放大工单描述" onChange={(value) => setDescription(value)} />
          <AttachmentPicker files={attachments} inputLabel="选择附件" onFilesChange={(files) => setAttachments(files)} onError={(message) => setCreateError(message)} />
          <Show when={createError() || peopleError()}><div class="create-error" role="alert">{createError() || peopleError()}</div></Show>
        </div>
      </Modal>
    </aside>
  );
}
