import { Badge, Button, Input, Modal, Select, Skeleton, Tag } from "../ui";
import { createEffect, createMemo, createSignal, createUniqueId, For, onCleanup, Show, untrack } from "solid-js";

import { ChevronRight, Pin, Plus, Search } from "../ui/icons";
import { canUseIssueWorkMode, createIssue, listIssuePins, setIssuePinned, type IssuePriority, type IssueWorkMode } from "../data/client";
import { createLatestTask } from "../data/latest";
import { errorText } from "./error-text";
import { useApplicationResources } from "./ApplicationResources";
import { AttachmentPicker, DescriptionField, RelatedIssueSelect, selectedChoice } from "./IssueForm";
import {
  availableWorkModes as workModesFor,
  environmentName,
  executionBadge,
  executionState,
  localDateTime,
  personLabel,
  priorityColor,
  priorityOptions,
  relativeTime,
  servicesForWorkMode,
  statusLabel,
} from "./model";
import { sharedConfig } from "../../../../issue-pilot.config.ts";

import { inQueueScope, QUEUE_SCOPES, queueScopeContaining, type IssueListResource, type QueueMembership, type QueueScope } from "./issue-list";

type QueueStatusFilter = "active" | "pending" | "resolved" | "all";

const queueScopeLabels: Record<QueueScope, string> = { assigned: "分配给我", reported: "我报告的", cc: "抄送我的", all: "全部" };

export function IssueQueue(props: {
  selectedId: string;
  userSubject: string;
  issueList: IssueListResource;
  /** Application-owned so the scope survives remounting the Issue view. */
  scope: QueueScope;
  onScopeChange: (scope: QueueScope) => void;
  hidden?: boolean;
  keepExternalSelection?: boolean;
  reveal?: { key: string; subject: string; issue: QueueMembership };
  onSelect: (id: string) => void;
}) {
  const { catalog, people, currentUser, catalogError, peopleError, refreshCatalog } = useApplicationResources();
  const { items: issues, error: loadError, refresh: loadIssues } = props.issueList;
  const loading = () => props.issueList.loading() || props.issueList.refreshing();
  const openHintId = createUniqueId();
  const [pinError, setPinError] = createSignal("", { ownedWrite: true });
  const [pinsLoading, setPinsLoading] = createSignal(false, { ownedWrite: true });
  const [pinnedIssueKeys, setPinnedIssueKeys] = createSignal<string[]>([], { ownedWrite: true });
  const [pinningIssueKeys, setPinningIssueKeys] = createSignal<string[]>([], { ownedWrite: true });
  const [query, setQuery] = createSignal("", { ownedWrite: true });
  const scope = () => props.scope;
  const [status, setStatus] = createSignal<QueueStatusFilter>("all", { ownedWrite: true });
  const [environmentFilter, setEnvironmentFilter] = createSignal("all", { ownedWrite: true });
  const [serviceFilter, setServiceFilter] = createSignal("all", { ownedWrite: true });
  // A reveal published before identity loaded (empty subject) applies once the identity is known.
  let appliedReveal: typeof props.reveal;
  createEffect(
    () => {
      const reveal = props.reveal,
        subject = props.userSubject;
      return reveal && subject && (!reveal.subject || reveal.subject === subject) ? { reveal, subject } : undefined;
    },
    (pending) => {
      if (!pending || pending.reveal === appliedReveal) return;
      const { reveal, subject } = pending;
      appliedReveal = reveal;
      // Opening an Issue from elsewhere widens the queue scope instead of switching identity.
      props.onScopeChange(queueScopeContaining(reveal.issue, subject, untrack(scope)));
      setQuery("");
      setStatus("all");
      setEnvironmentFilter("all");
      setServiceFilter("all");
    },
  );
  const filtered = createMemo(() => {
    const subject = props.userSubject;
    if (!subject) return [];
    const term = query().trim().toLowerCase();
    const pinned = new Set(pinnedIssueKeys());
    const matching = issues().filter((issue) => {
      const scopeMatch = inQueueScope(issue, scope(), subject);
      const statusMatch = status() === "all" || (status() === "active" && issue.status !== "resolved") || issue.status === status();
      const environmentMatch = environmentFilter() === "all" || issue.environmentKey === environmentFilter();
      const serviceMatch = serviceFilter() === "all" || issue.service.key === serviceFilter();
      const searchMatch = !term || `${issue.id} ${issue.title} ${issue.service.key} ${issue.service.name} ${issue.environmentKey}`.toLowerCase().includes(term);
      return scopeMatch && statusMatch && environmentMatch && serviceMatch && searchMatch;
    });
    // Only two ranks exist: retain server order inside each group without comparison sorting.
    const pinnedItems: typeof matching = [],
      ordinaryItems: typeof matching = [];
    for (const issue of matching) (pinned.has(issue.id) ? pinnedItems : ordinaryItems).push(issue);
    return pinnedItems.concat(ordinaryItems);
  });
  const togglePinned = async (issueKey: string) => {
    if (pinsLoading() || pinningIssueKeys().includes(issueKey)) return;
    // Pin writes for different Issues run in parallel; each belongs to the identity that started it.
    const pinned = pinnedIssueKeys().includes(issueKey),
      subject = props.userSubject,
      current = () => !disposed && props.userSubject === subject;
    setPinningIssueKeys((keys) => [...keys, issueKey]);
    setPinError("");
    try {
      await setIssuePinned(issueKey, !pinned);
      if (!current()) return;
      setPinnedIssueKeys((keys) => (pinned ? keys.filter((key) => key !== issueKey) : [...keys, issueKey]));
    } catch (error) {
      if (current()) setPinError(errorText(error));
    } finally {
      if (current()) setPinningIssueKeys((keys) => keys.filter((key) => key !== issueKey));
    }
  };
  let disposed = false;
  const pinsTask = createLatestTask();
  createEffect(
    () => props.userSubject,
    (subject) => {
      pinsTask.cancel();
      setPinError("");
      setPinnedIssueKeys([]);
      setPinningIssueKeys([]);
      // A delayed initial snapshot must settle before a write can update these preferences.
      setPinsLoading(Boolean(subject));
      if (!subject) return;
      const request = pinsTask.begin();
      void listIssuePins(request.signal)
        .then((pinned) => {
          if (request.isCurrent()) setPinnedIssueKeys(pinned);
        })
        .catch((error) => {
          if (!request.isCurrent()) return;
          setPinnedIssueKeys([]);
          setPinError(errorText(error));
        })
        .finally(() => {
          if (request.isCurrent()) setPinsLoading(false);
          request.finish();
        });
    },
  );
  // oxlint-disable-next-line no-unassigned-vars -- Solid assigns this binding through the JSX ref attribute.
  let list: HTMLDivElement | undefined;
  let revealed: typeof props.reveal;
  createEffect(
    () => {
      const reveal = props.reveal;
      if (!reveal || reveal === revealed || props.hidden || pinsLoading() || reveal.key !== props.selectedId || (reveal.subject && reveal.subject !== props.userSubject)) return;
      if (filtered().some((issue) => issue.id === reveal.key)) return reveal;
    },
    (reveal) => {
      if (!reveal) return;
      // Wait for the row and its pinned position to render. Only the queue should scroll.
      const frame = window.requestAnimationFrame(() => {
        const row = list?.querySelector('.queue-item[aria-current="true"]');
        if (!list || !row) return;
        list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - list.clientTop;
        revealed = reveal;
      });
      return () => window.cancelAnimationFrame(frame);
    },
  );
  let appliedFilter: string | undefined;
  createEffect(
    () => ({
      loading: loading(),
      selectedId: props.selectedId,
      visible: filtered(),
      items: issues(),
      filter: JSON.stringify([props.userSubject, scope(), query().trim().toLowerCase(), status(), environmentFilter(), serviceFilter()]),
      keepExternalSelection: props.keepExternalSelection,
      loadError: loadError(),
    }),
    ({ loading, selectedId, visible, items, filter, keepExternalSelection, loadError }) => {
      if (loading || loadError) return;
      const filterChanged = filter !== appliedFilter;
      appliedFilter = filter;
      // Background changes update rows, not navigation. Explicit filters and actual removal may select another Issue.
      if (!keepExternalSelection && !visible.some((issue) => issue.id === selectedId) && (filterChanged || !items.some((issue) => issue.id === selectedId))) {
        const next = visible[0]?.id ?? "";
        if (next !== selectedId) props.onSelect(next);
      }
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
  const relatedCandidates = props.issueList.items;
  const [relatedLoading, setRelatedLoading] = createSignal(false, { ownedWrite: true });
  createEffect(
    () => ({ createOpen: createOpen(), subject: props.userSubject }),
    ({ createOpen, subject }) => {
      if (subject && !createOpen) setAssigneeSubject(subject);
    },
  );
  const [attachments, setAttachments] = createSignal<File[]>([], { ownedWrite: true });
  const [saving, setSaving] = createSignal(false, { ownedWrite: true });
  const [createError, setCreateError] = createSignal("", { ownedWrite: true });
  let contextGeneration = 0;
  const relatedTask = createLatestTask();
  onCleanup(() => {
    disposed = true;
    contextGeneration++;
    pinsTask.cancel();
    relatedTask.cancel();
  });
  const closeCreateIssue = () => {
    relatedTask.cancel();
    setCreateOpen(false);
    setRelatedLoading(false);
  };
  createEffect(
    () => ({ subject: props.userSubject, role: currentUser()?.role }),
    (context, previous) => {
      if (!previous || (context.subject === previous.subject && context.role === previous.role)) return;
      contextGeneration++;
      closeCreateIssue();
      setSaving(false);
      setCreateError("");
      setTitle("");
      setDescription("");
      setPriority("p2");
      setAssigneeSubject(context.subject || null);
      setCcSubjects([]);
      setAttachments([]);
      setRelatedIssueKeys([]);
    },
  );
  const availableWorkModes = createMemo(() => workModesFor(currentUser()?.role, catalog().services));
  const availableServices = createMemo(() => servicesForWorkMode(catalog().services, workMode()));
  // Related-Issue candidates come from the shared list; opening the dialog refreshes it.
  const openCreateIssue = () => {
    if (!props.userSubject || saving()) return;
    const request = relatedTask.begin();
    setCreateError("");
    setCreateOpen(true);
    setRelatedLoading(true);
    void props.issueList.refresh().finally(() => {
      if (request.isCurrent()) {
        if (props.issueList.error()) setCreateError(errorText(props.issueList.error()));
        setRelatedLoading(false);
      }
      request.finish();
    });
  };
  createEffect(
    () => ({ currentMode: workMode(), modes: availableWorkModes(), services: catalog().services, people: people() }),
    ({ currentMode, modes, services, people }) => {
      const selectedMode = modes.some(({ value }) => value === currentMode) ? currentMode : (modes[0]?.value ?? "production_analysis");
      if (selectedMode !== currentMode) setWorkMode(selectedMode);
      // The assignee list is filtered by work mode; drop a selection the new mode no longer allows.
      const assignee = people.find((person) => person.subject === untrack(assigneeSubject));
      if (assignee && !canUseIssueWorkMode(assignee.role, selectedMode)) setAssigneeSubject(null);
      const compatibleServices = servicesForWorkMode(services, selectedMode);
      setService((current) => (compatibleServices.some((candidate) => candidate.key === current) ? current : (compatibleServices[0]?.key ?? "")));
    },
  );
  const submitIssue = async () => {
    if (!props.userSubject || saving() || !title().trim() || !service()) return;
    const owner = contextGeneration;
    setSaving(true);
    setCreateError("");
    try {
      const issue = await createIssue(
        {
          title: title().trim(),
          description: description().trim(),
          priority: priority(),
          workMode: workMode(),
          assigneeSubject: assigneeSubject(),
          ccSubjects: ccSubjects(),
          serviceKey: service(),
          relatedIssueKeys: relatedIssueKeys(),
        },
        attachments(),
      );
      if (owner !== contextGeneration) return;
      props.issueList.created(issue);
      props.onSelect(issue.id);
      closeCreateIssue();
      setTitle("");
      setDescription("");
      setAttachments([]);
      setRelatedIssueKeys([]);
    } catch (error) {
      if (owner === contextGeneration) setCreateError(errorText(error));
    } finally {
      if (owner === contextGeneration) setSaving(false);
    }
  };
  return (
    <aside class="issue-queue" aria-label="工单队列" hidden={props.hidden}>
      <div class="queue-toolbar">
        <Input aria-label="搜索工单" placeholder="搜索工单" allowClear prefix={<Search size={15} />} value={query()} onInput={(event) => setQuery(event.currentTarget.value)} />
        <Button class="icon-button" type="primary" shape="circle" icon={<Plus size={16} />} title="新建工单" aria-label="新建工单" disabled={!props.userSubject} onClick={openCreateIssue} />
      </div>
      <div class="queue-filter">
        <div class="queue-filter-controls">
          <Select
            aria-label="按范围筛选"
            value={scope()}
            onChange={(value) => {
              const selected = selectedChoice(value, QUEUE_SCOPES);
              if (selected) props.onScopeChange(selected);
            }}
            options={QUEUE_SCOPES.map((value) => ({ value, label: queueScopeLabels[value] }))}
          />
          <Select
            aria-label="按状态筛选"
            value={status()}
            onChange={(value) => {
              const selected = selectedChoice(value, ["active", "pending", "resolved", "all"] as const);
              if (selected) setStatus(selected);
            }}
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
            onChange={(value) => {
              const selected = selectedChoice(value, ["all", ...catalog().services.map((item) => item.key)]);
              if (selected) setServiceFilter(selected);
            }}
            options={[{ value: "all", label: "全部服务" }, ...catalog().services.map((item) => ({ value: item.key, label: item.name }))]}
          />
          <Select
            aria-label="按环境筛选"
            value={environmentFilter()}
            onChange={(value) => {
              const selected = selectedChoice(value, ["all", ...catalog().environments.map((item) => item.key)]);
              if (selected) setEnvironmentFilter(selected);
            }}
            options={[{ value: "all", label: "全部环境" }, ...catalog().environments.map((item) => ({ value: item.key, label: item.name }))]}
          />
        </div>
      </div>
      {/* Rows keep the list role so the pin stays a separate control; the description announces activation. */}
      <span id={openHintId} class="visually-hidden">
        按 Enter 或空格打开工单
      </span>
      <div class="queue-list" role="list" ref={list}>
        <Show
          when={!loading() || issues().length > 0}
          fallback={
            <div class="queue-loading">
              <Skeleton active paragraph={{ rows: 5 }} />
            </div>
          }
        >
          <Show when={loadError() || catalogError()}>
            <div class="queue-error" role="alert">
              {loadError() || catalogError()}
              <Button
                size="small"
                onClick={() => {
                  void loadIssues();
                  void refreshCatalog().catch(() => undefined);
                }}
              >
                重试
              </Button>
            </div>
          </Show>
          <Show when={issues().length > 0 || (!loadError() && !catalogError())}>
            <Show when={pinError()}>
              <div class="queue-action-error" role="alert">
                {pinError()}
              </div>
            </Show>
            <Show when={peopleError()}>
              <div class="queue-action-error" role="alert">
                用户加载失败：{peopleError()}
              </div>
            </Show>
            <For each={filtered()} keyed={(row) => row.id} fallback={<div class="queue-empty">没有匹配的工单</div>}>
              {(issue) => {
                const pinned = () => pinnedIssueKeys().includes(issue().id);
                const state = () => executionState(issue());
                return (
                  <div
                    role="listitem"
                    tabindex={0}
                    aria-describedby={openHintId}
                    class={`queue-item${issue().id === props.selectedId ? " selected" : ""}${pinned() ? " pinned" : ""}`}
                    aria-current={issue().id === props.selectedId ? "true" : undefined}
                    onClick={() => props.onSelect(issue().id)}
                    onKeyDown={(event) => {
                      if (event.target === event.currentTarget && ["Enter", " "].includes(event.key)) {
                        event.preventDefault();
                        props.onSelect(issue().id);
                      }
                    }}
                  >
                    <span class="queue-item-topline">
                      <span class="issue-key">{issue().id}</span>
                      <Tag color={priorityColor[issue().priority]}>{issue().priority.toUpperCase()}</Tag>
                      <span class="queue-time" title={localDateTime(issue().createdAt)}>
                        {relativeTime(issue().updatedAt)}
                      </span>
                    </span>
                    <span class="queue-title" title={issue().title}>
                      {issue().title}
                    </span>
                    <span class="queue-item-meta">
                      <span class="queue-status">
                        <Badge status={executionBadge[state().key]} text={state().label} />
                      </span>
                      <span class="queue-scope" title={`${issue().service.name} / ${environmentName(catalog().environments, issue().environmentKey)}`}>
                        <strong>{issue().service.name}</strong>
                        <span aria-hidden="true">/</span>
                        <span>{environmentName(catalog().environments, issue().environmentKey)}</span>
                      </span>
                    </span>
                    <Show when={issue().assigneeSubject === props.userSubject}>
                      <button
                        type="button"
                        class={`queue-pin${pinned() ? " pinned" : ""}`}
                        aria-label={`${pinned() ? "取消固定" : "固定"} ${issue().id}`}
                        title={pinned() ? "取消固定" : "固定到顶部"}
                        disabled={pinsLoading() || pinningIssueKeys().includes(issue().id)}
                        onClick={(event) => {
                          event.stopPropagation();
                          void togglePinned(issue().id);
                        }}
                      >
                        <Pin size={14} aria-hidden="true" />
                      </button>
                    </Show>
                    <ChevronRight class="queue-chevron" size={16} aria-hidden="true" />
                  </div>
                );
              }}
            </For>
          </Show>
        </Show>
      </div>
      <Modal
        open={createOpen()}
        title="新建工单"
        okText="创建"
        cancelText="取消"
        onOk={() => {
          void submitIssue();
        }}
        onCancel={closeCreateIssue}
        confirmLoading={saving()}
        okButtonProps={{ disabled: !title().trim() || !service() }}
      >
        <div class="create-issue-form compact-issue-form new-issue-form">
          <label>
            <span>处理方式</span>
            <Select
              aria-label="工单处理方式"
              value={workMode()}
              onChange={(value) => {
                const selected = selectedChoice(
                  value,
                  availableWorkModes().map((option) => option.value),
                );
                if (selected) setWorkMode(selected);
              }}
              options={availableWorkModes()}
            />
          </label>
          <label>
            <span>入口服务</span>
            <Select
              aria-label="工单服务"
              value={service()}
              onChange={(value) => {
                const selected = selectedChoice(
                  value,
                  availableServices().map((item) => item.key),
                );
                if (selected) setService(selected);
              }}
              options={availableServices().map((item) => ({ value: item.key, label: item.name }))}
            />
          </label>
          <label>
            <span>优先级</span>
            <Select
              aria-label="工单优先级"
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
              aria-label="工单处理人"
              value={assigneeSubject() ?? undefined}
              allowClear
              onClear={() => setAssigneeSubject(null)}
              onChange={(value) => {
                if (typeof value === "string" && value) setAssigneeSubject(value);
              }}
              options={people()
                .filter((person) => canUseIssueWorkMode(person.role, workMode()))
                .map((person) => ({ value: person.subject, label: personLabel(person) }))}
            />
          </label>
          <label>
            <span>抄送人</span>
            <div class="multi-select-trigger">
              <Select
                mode="multiple"
                aria-label="工单抄送人"
                value={ccSubjects()}
                onChange={setCcSubjects}
                options={people()
                  .filter((person) => person.subject !== assigneeSubject())
                  .map((person) => ({ value: person.subject, label: personLabel(person) }))}
              />
            </div>
          </label>
          <label>
            <span>关联工单（{relatedCandidates().length} 个）</span>
            <RelatedIssueSelect
              candidates={relatedCandidates()}
              value={relatedIssueKeys()}
              loading={relatedLoading()}
              inputLabel="关联工单"
              onChange={(keys) => {
                if (keys.length > sharedConfig.limits.relatedIssues) {
                  setCreateError(`关联工单最多 ${sharedConfig.limits.relatedIssues} 个。`);
                  return;
                }
                setRelatedIssueKeys(keys);
              }}
            />
          </label>
          <label>
            <span>标题</span>
            <Input aria-label="工单标题" value={title()} onInput={(event) => setTitle(event.currentTarget.value)} />
          </label>
          <DescriptionField value={description} inputLabel="工单描述" expandLabel="放大工单描述" onChange={(value) => setDescription(value)} />
          <AttachmentPicker files={attachments} inputLabel="选择附件" onFilesChange={(files) => setAttachments(files)} onError={(message) => setCreateError(message)} />
          <Show when={createError() || peopleError()}>
            <div class="create-error" role="alert">
              {createError() || peopleError()}
            </div>
          </Show>
        </div>
      </Modal>
    </aside>
  );
}
