import {
  Badge,
  Button,
  ConfigProvider,
  Input,
  TextArea,
  Layout,
  Modal,
  Segmented,
  Select,
  Skeleton,
  Space,
  Tag,
  theme,
} from "@idoly/ant-design-solid";
import {
  CheckCircle2,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Eye,
  GitBranch,
  ListFilter,
  Maximize2,
  MessageSquare,
  Minimize2,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  TerminalSquare,
  Trash2,
  ZoomIn,
  ZoomOut,
} from "../ui/icons";
import { createEffect, createMemo, createSignal, createStore, For, onCleanup, Show } from "solid-js";
import { addIssueComment, attachmentUrl, createIssue, createService, deleteIssueAttachments, deleteService, fetchAttachment, getIssue, ISSUE_STATUSES, ISSUE_TYPES_BY_ENVIRONMENT, listIssues, loadConfig, loadPeople, retryIssue, syncIssueUpdate, updateIssue, updateIssueStatus, updateService, uploadAttachments, type Service, type AgentModelDefinition, type CapabilityName, type Config, type IssueDetail, type IssuePriority, type IssueType, type Person, type ThinkingLevel } from "../data/client";
import { Markdown } from "../ui/Markdown";
import { workspaceUrl, fileSize, typeLabel, priorityColor, relativeTime, statusBadge, statusLabel } from "./model";
import { AgentPanel } from "./AgentPanel";
import { Statistics } from "./Statistics";
import "@idoly/ant-design-solid/base.css";
import "@idoly/ant-design-solid/badge/style.css";
import "@idoly/ant-design-solid/button/style.css";
import "@idoly/ant-design-solid/config-provider/style.css";
import "@idoly/ant-design-solid/checkbox/style.css";
import "@idoly/ant-design-solid/input/style.css";
import "@idoly/ant-design-solid/layout/style.css";
import "@idoly/ant-design-solid/modal/style.css";
import "@idoly/ant-design-solid/segmented/style.css";
import "@idoly/ant-design-solid/select/style.css";
import "@idoly/ant-design-solid/skeleton/style.css";
import "@idoly/ant-design-solid/space/style.css";

function selectedStrings(value: unknown, current: string[]): string[] {
  if (value === null || value === undefined) return current;
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))];
}

function selectedChoice<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : undefined;
}

const environmentLabel: Record<string, string> = { prod: "正式", test: "测试", dev: "开发" };

function issueTypesForEnvironment(environmentKey: string): IssueType[] {
  return [...(ISSUE_TYPES_BY_ENVIRONMENT[environmentKey as keyof typeof ISSUE_TYPES_BY_ENVIRONMENT] ?? [])];
}

type IssueAttachment = IssueDetail["attachments"][number];
type AttachmentPreviewKind = "image" | "text" | "pdf" | "unsupported";

function attachmentPreviewKind(attachment: IssueAttachment): AttachmentPreviewKind {
  if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(attachment.mediaType)) return "image";
  if (attachment.mediaType === "application/pdf") return "pdf";
  if (attachment.mediaType.startsWith("text/") || ["application/json", "application/xml", "application/yaml", "application/x-yaml"].includes(attachment.mediaType) || /\.(txt|log|md|csv|json|xml|ya?ml|properties)$/i.test(attachment.fileName)) return "text";
  return "unsupported";
}

function readBlobText(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(typeof reader.result === "string" ? reader.result : ""));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("attachment_preview_failed")));
    reader.readAsText(blob);
  });
}

function serviceSaveErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  const messages: Record<string, string> = {
    invalid_db_password: "请填写数据库密码",
    invalid_sls_access_key_secret: "请填写 SLS AccessKeySecret",
    invalid_mq_password: "请填写 RabbitMQ 密码",
    service_has_running_issues: "该服务有正在处理的工单，请等待处理结束或先中止 Agent",
  };
  return messages[code] ?? code;
}

function bindMultipleSelectBlankToggle(element: HTMLDivElement, setOpen: (open: boolean) => void): void {
  let blankWasOpen = false;
  element.addEventListener("mousedown", (event) => {
    blankWasOpen = event.target instanceof HTMLElement
      && event.target.classList.contains("ads-select-selector")
      && element.querySelector('[role="combobox"]')?.getAttribute("aria-expanded") === "true";
  }, { capture: true });
  element.addEventListener("click", (event) => {
    if (blankWasOpen) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
    blankWasOpen = false;
  }, { capture: true });
}

import "@idoly/ant-design-solid/tag/style.css";

function DescriptionField(props: { value: () => string; inputLabel: string; expandLabel: string; onChange: (value: string) => void }) {
  const [expanded, setExpanded] = createSignal(false, { ownedWrite: true });
  const [draft, setDraft] = createSignal("", { ownedWrite: true });
  const [mode, setMode] = createSignal<"edit" | "preview">("edit", { ownedWrite: true });
  const open = () => { setDraft(props.value()); setMode("edit"); setExpanded(true); };
  return (
    <div class="description-field">
      <div class="description-field-header"><span>描述</span><Button type="text" shape="circle" icon={<Maximize2 size={14} />} title={props.expandLabel} aria-label={props.expandLabel} onClick={open} /></div>
      <TextArea aria-label={props.inputLabel} autoSize={{ minRows: 3, maxRows: 5 }} value={props.value()} onInput={(event) => props.onChange(event.currentTarget.value)} />
      <Modal open={expanded()} title="编辑描述" okText="应用" cancelText="取消" onOk={() => { props.onChange(draft()); setExpanded(false); }} onCancel={() => setExpanded(false)}>
        <div class="markdown-editor-toolbar"><Segmented size="small" aria-label="描述编辑模式" value={mode()} options={[{ value: "edit", label: "编辑" }, { value: "preview", label: "预览" }]} onChange={(value) => setMode(value as "edit" | "preview")} /></div>
        <Show when={mode() === "edit"} fallback={<div class="description-markdown-preview"><Show when={draft().trim()} fallback={<span class="muted">暂无内容</span>}><Markdown source={draft()} /></Show></div>}>
          <TextArea class="description-expanded-input" aria-label="放大描述编辑器" value={draft()} onInput={(event) => setDraft(event.currentTarget.value)} />
        </Show>
      </Modal>
    </div>
  );
}

function AttachmentPicker(props: {
  files: () => File[];
  existingFiles?: () => IssueDetail["attachments"];
  inputLabel: string;
  onRemoveExisting?: (id: string) => void;
  onFilesChange: (files: File[]) => void;
  onError: (message: string) => void;
}) {
  let input: HTMLInputElement | undefined;
  const existingFiles = () => props.existingFiles?.() ?? [];
  const totalCount = () => existingFiles().length + props.files().length;
  const selectFiles = (selected: File[]) => {
    props.onFilesChange([...props.files(), ...selected]);
    props.onError("");
  };
  return (
    <div class="attachment-picker">
      <input ref={input} class="visually-hidden" type="file" multiple aria-label={props.inputLabel} onChange={(event) => {
        selectFiles(Array.from(event.currentTarget.files ?? []));
        event.currentTarget.value = "";
      }} />
      <div class="attachment-picker-header"><span>附件 <small>{totalCount()}</small></span><Button icon={<Paperclip size={14} />} onClick={() => input?.click()}>添加附件</Button></div>
      <Show when={totalCount()}>
        <div class="attachment-file-list">
          <For each={existingFiles()}>{(file) => <div class="attachment-file"><span><strong>{file.fileName}</strong><small>{file.mediaType} · {fileSize(file.size)}</small></span><Button type="text" shape="circle" icon={<Trash2 size={14} />} title={`移除${file.fileName}`} aria-label={`移除${file.fileName}`} onClick={() => props.onRemoveExisting?.(file.id)} /></div>}</For>
          <For each={props.files()}>{(file, index) => <div class="attachment-file"><span><strong>{file.name}</strong><small>{fileSize(file.size)}</small></span><Button type="text" shape="circle" icon={<Trash2 size={14} />} title={`移除${file.name}`} aria-label={`移除${file.name}`} onClick={() => props.onFilesChange(props.files().filter((_, itemIndex) => itemIndex !== index()))} /></div>}</For>
        </div>
      </Show>
    </div>
  );
}

function IssueQueue(props: {
  selectedId: string;
  userName: string;
  userSubject: string;
  refreshToken: number;
  onSelect: (id: string) => void;
}) {
  const [issues, setIssues] = createSignal<Awaited<ReturnType<typeof listIssues>>>([], { ownedWrite: true });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [loadError, setLoadError] = createSignal("", { ownedWrite: true });
  createEffect(() => ({ refreshToken: props.refreshToken, selectedId: props.selectedId }), ({ selectedId }) => {
    setLoading(true);
    setLoadError("");
    void listIssues().then((loaded) => {
      setIssues(loaded);
      if (!loaded.some((issue) => issue.id === selectedId)) props.onSelect(loaded[0]?.id ?? "");
    }).catch((error) => {
      setIssues([]);
      setLoadError(error instanceof Error ? error.message : "工单加载失败");
    }).finally(() => setLoading(false));
  });
  const [configuration, setConfiguration] = createSignal<Config>({ agentModels: [], environments: [], capabilityCatalog: [], services: [] }, { ownedWrite: true });
  const [people, setPeople] = createSignal<Person[]>([], { ownedWrite: true });
  const [query, setQuery] = createSignal("", { ownedWrite: true });
  const [status, setStatus] = createSignal<string>("active", { ownedWrite: true });
  const [createOpen, setCreateOpen] = createSignal(false, { ownedWrite: true });
  const [title, setTitle] = createSignal("", { ownedWrite: true });
  const [description, setDescription] = createSignal("", { ownedWrite: true });
  const [service, setService] = createSignal("", { ownedWrite: true });
  const [environment, setEnvironment] = createSignal("", { ownedWrite: true });
  void loadConfig().then((value) => {
    setConfiguration(value);
    const selectedEnvironment = value.environments.some((item) => item.key === environment()) ? environment() : value.environments[0]?.key ?? "";
    setEnvironment(selectedEnvironment);
    const allowedTypes = issueTypesForEnvironment(selectedEnvironment);
    setIssueType((current) => allowedTypes.includes(current) ? current : allowedTypes[0] ?? "smart_analysis");
    const environmentId = value.environments.find((item) => item.key === selectedEnvironment)?.id;
    const availableServices = value.services.filter((item) => environmentId && item.environmentIds.includes(environmentId));
    setService((current) => availableServices.some((item) => item.key === current) ? current : availableServices[0]?.key ?? "");
  }).catch((error) => setLoadError(error instanceof Error ? error.message : "配置加载失败"));
  void loadPeople().then((value) => { setPeople(value); }).catch(() => undefined);
  const [priority, setPriority] = createSignal<IssuePriority>("p2", { ownedWrite: true });
  const [issueType, setIssueType] = createSignal<IssueType>("smart_analysis", { ownedWrite: true });
  const [assigneeSubject, setAssigneeSubject] = createSignal<string | null>(props.userSubject || null, { ownedWrite: true });
  const [ccSubjects, setCcSubjects] = createSignal<string[]>([], { ownedWrite: true });
  const [ccOpen, setCcOpen] = createSignal(false);
  const [attachments, setAttachments] = createSignal<File[]>([], { ownedWrite: true });
  const [saving, setSaving] = createSignal(false, { ownedWrite: true });
  const [createError, setCreateError] = createSignal("", { ownedWrite: true });
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
        reporter: props.userName,
      }, attachments());
      setIssues((current) => [issue, ...current.filter((item) => item.id !== issue.id)]);
      props.onSelect(issue.id);
      setCcOpen(false);
      setCreateOpen(false);
      setTitle("");
      setDescription("");
      setAttachments([]);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  const filtered = createMemo(() => {
    const term = query().trim().toLowerCase();
    return issues().filter((issue) => {
      const statusMatch = status() === "all" || (status() === "active" && issue.status !== "resolved") || issue.status === status();
      return statusMatch && (!term || `${issue.id} ${issue.title} ${issue.service.key} ${issue.service.name}`.toLowerCase().includes(term));
    });
  });

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
          <Show when={!loadError()} fallback={<div class="queue-error" role="alert">{loadError()}</div>}>
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
          <label><span>环境</span><Select aria-label="工单环境" value={environment()} onChange={(value) => { const selected = selectedChoice(value, configuration().environments.map((item) => item.key)); if (selected) { setEnvironment(selected); setService(""); if (!issueTypesForEnvironment(selected).includes(issueType())) setIssueType(issueTypesForEnvironment(selected)[0] ?? "smart_analysis"); } }} options={configuration().environments.map((item) => ({ value: item.key, label: item.name }))} /></label>
          <label><span>服务</span><Select aria-label="工单服务" value={service()} onChange={(value) => { const selected = selectedChoice(value, configuration().services.map((item) => item.key)); if (selected) setService(selected); }} options={configuration().services.filter((item) => item.environmentIds.includes(configuration().environments.find((item) => item.key === environment())?.id ?? "")).map((item) => ({ value: item.key, label: item.name }))} /></label>
          <label><span>优先级</span><Select aria-label="工单优先级" value={priority()} onChange={(value) => { const selected = selectedChoice(value, ["p0", "p1", "p2", "p3"] as const); if (selected) setPriority(selected); }} options={[{ value: "p0", label: "P0 · 紧急" }, { value: "p1", label: "P1 · 高" }, { value: "p2", label: "P2 · 中" }, { value: "p3", label: "P3 · 低" }]} /></label>
          <label><span>类型</span><Select aria-label="工单类型" value={issueType()} onChange={(value) => { const selected = selectedChoice(value, issueTypesForEnvironment(environment())); if (selected) setIssueType(selected); }} options={issueTypesForEnvironment(environment()).map((value) => ({ value, label: typeLabel[value] }))} /></label>
          <label><span>处理人</span><Select aria-label="工单处理人" value={assigneeSubject() ?? undefined} allowClear onClear={() => setAssigneeSubject(null)} onChange={(value) => { if (typeof value === "string" && value) setAssigneeSubject(value); }} options={people().map((person) => ({ value: person.subject, label: `${person.name}${person.email ? ` · ${person.email}` : ""}` }))} /></label>
          <label><span>抄送人（可多选）</span><div class="multi-select-trigger" ref={(element) => bindMultipleSelectBlankToggle(element, setCcOpen)}><Select mode="multiple" aria-label="工单抄送人" value={ccSubjects()} open={ccOpen()} onOpenChange={setCcOpen} onChange={(value) => setCcSubjects(selectedStrings(value, ccSubjects()))} options={people().filter((person) => person.subject !== assigneeSubject()).map((person) => ({ value: person.subject, label: `${person.name}${person.email ? ` · ${person.email}` : ""}` }))} /></div></label>
          <label><span>标题</span><Input aria-label="工单标题" value={title()} onInput={(event) => setTitle(event.currentTarget.value)} /></label>
          <DescriptionField value={description} inputLabel="工单描述" expandLabel="放大工单描述" onChange={(value) => setDescription(value)} />
          <AttachmentPicker files={attachments} inputLabel="选择附件" onFilesChange={(files) => setAttachments(files)} onError={(message) => setCreateError(message)} />
          <Show when={createError()}><div class="create-error" role="alert">{createError()}</div></Show>
        </div>
      </Modal>
    </aside>
  );
}

function IssueWorkspace(props: { issue: IssueDetail; onOpenCodeServer: (url: string) => void; onUpdated: () => Promise<void> }) {
  const [editOpen, setEditOpen] = createSignal(false, { ownedWrite: true });
  const [editTitle, setEditTitle] = createSignal("", { ownedWrite: true });
  const [editDescription, setEditDescription] = createSignal("", { ownedWrite: true });
  const [editPriority, setEditPriority] = createSignal<IssuePriority>("p2", { ownedWrite: true });
  const [editType, setEditType] = createSignal<IssueType>("smart_analysis", { ownedWrite: true });
  const [editAssignee, setEditAssignee] = createSignal<string | null>(null, { ownedWrite: true });
  const [editCc, setEditCc] = createSignal<string[]>([], { ownedWrite: true });
  const [editCcOpen, setEditCcOpen] = createSignal(false);
  const [editService, setEditService] = createSignal("", { ownedWrite: true });
  const [editAttachments, setEditAttachments] = createSignal<File[]>([], { ownedWrite: true });
  const [removedAttachmentIds, setRemovedAttachmentIds] = createSignal<string[]>([], { ownedWrite: true });
  const [people, setPeople] = createSignal<Person[]>([], { ownedWrite: true });
  const [configuration, setConfiguration] = createSignal<Config>({ agentModels: [], environments: [], capabilityCatalog: [], services: [] }, { ownedWrite: true });
  const [editSaving, setEditSaving] = createSignal(false, { ownedWrite: true });
  const [editError, setEditError] = createSignal("", { ownedWrite: true });
  const [retrying, setRetrying] = createSignal(false, { ownedWrite: true });
  const [retryError, setRetryError] = createSignal("", { ownedWrite: true });
  const [statusSaving, setStatusSaving] = createSignal(false, { ownedWrite: true });
  const [statusError, setStatusError] = createSignal("", { ownedWrite: true });
  const [commentBody, setCommentBody] = createSignal("", { ownedWrite: true });
  const [commentSaving, setCommentSaving] = createSignal(false, { ownedWrite: true });
  const [commentMode, setCommentMode] = createSignal<"edit" | "preview">("edit", { ownedWrite: true });
  const [commentError, setCommentError] = createSignal("", { ownedWrite: true });
  const [previewAttachment, setPreviewAttachment] = createSignal<IssueAttachment | null>(null, { ownedWrite: true });
  const [previewLoading, setPreviewLoading] = createSignal(false, { ownedWrite: true });
  const [previewText, setPreviewText] = createSignal("", { ownedWrite: true });
  const [previewObjectUrl, setPreviewObjectUrl] = createSignal("", { ownedWrite: true });
  const [previewError, setPreviewError] = createSignal("", { ownedWrite: true });
  const [previewCopied, setPreviewCopied] = createSignal(false, { ownedWrite: true });
  const [imageZoom, setImageZoom] = createSignal(1, { ownedWrite: true });
  const [imageDragging, setImageDragging] = createSignal(false, { ownedWrite: true });
  let previewSequence = 0;
  let imageViewport: HTMLDivElement | undefined;
  let imageDrag: { pointerId: number; x: number; y: number; scrollLeft: number; scrollTop: number } | undefined;
  void loadPeople().then(setPeople);
  void loadConfig().then(setConfiguration);
  const openEditor = () => {
    setEditTitle(props.issue.title); setEditDescription(props.issue.description); setEditPriority(props.issue.priority); setEditType(props.issue.type);
    setEditAssignee(props.issue.assigneeSubject); setEditCc((props.issue.ccRecipients ?? []).map((person) => person.subject));
    setEditService(props.issue.service.key);
    setEditAttachments([]);
    setRemovedAttachmentIds([]);
    setEditError(""); setEditOpen(true);
  };
  const saveIssue = async () => {
    if (!editTitle().trim() || !editService()) return;
    setEditSaving(true); setEditError("");
    try {
      await updateIssue(props.issue.id, { title: editTitle().trim(), description: editDescription().trim(), priority: editPriority(), type: editType(), serviceKey: editService(), assigneeSubject: editAssignee(), ccSubjects: editCc() });
      const removals = removedAttachmentIds();
      if (removals.length) {
        await deleteIssueAttachments(props.issue.id, removals);
        setRemovedAttachmentIds([]);
      }
      const additions = editAttachments();
      if (additions.length) {
        await uploadAttachments(props.issue.id, additions);
        setEditAttachments([]);
      }
      await syncIssueUpdate(props.issue.id);
      await props.onUpdated();
      setEditCcOpen(false);
      setEditOpen(false);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
    } finally { setEditSaving(false); }
  };
  const submitComment = async () => {
    const body = commentBody().trim();
    if (!body) return;
    setCommentSaving(true); setCommentError("");
    try {
      await addIssueComment(props.issue.id, body);
      setCommentBody("");
      setCommentMode("edit");
      await props.onUpdated();
    } catch (error) {
      setCommentError(error instanceof Error ? error.message : String(error));
    } finally { setCommentSaving(false); }
  };
  const closeAttachmentPreview = () => {
    previewSequence += 1;
    const objectUrl = previewObjectUrl();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    setPreviewAttachment(null); setPreviewObjectUrl(""); setPreviewText(""); setPreviewError(""); setPreviewCopied(false); setImageZoom(1); setImageDragging(false); imageDrag = undefined; setPreviewLoading(false);
  };
  const openAttachmentPreview = async (attachment: IssueAttachment) => {
    closeAttachmentPreview();
    setPreviewAttachment(attachment);
    const kind = attachmentPreviewKind(attachment);
    if (kind === "unsupported") return;
    const sequence = ++previewSequence;
    setPreviewLoading(true);
    try {
      const blob = await fetchAttachment(props.issue.id, attachment.id);
      if (sequence !== previewSequence) return;
      if (kind === "text") setPreviewText(await readBlobText(blob));
      else setPreviewObjectUrl(URL.createObjectURL(blob));
    } catch (error) {
      if (sequence === previewSequence) setPreviewError(error instanceof Error ? error.message : "attachment_preview_failed");
    } finally {
      if (sequence === previewSequence) setPreviewLoading(false);
    }
  };
  const changeImageZoom = (requestedZoom: number, focusX?: number, focusY?: number) => {
    const previousZoom = imageZoom();
    const nextZoom = Math.min(4, Math.max(1, Math.round(requestedZoom * 100) / 100));
    if (nextZoom === previousZoom) return;
    const viewport = imageViewport;
    const x = focusX ?? (viewport?.clientWidth ?? 0) / 2;
    const y = focusY ?? (viewport?.clientHeight ?? 0) / 2;
    const contentX = (viewport?.scrollLeft ?? 0) + x;
    const contentY = (viewport?.scrollTop ?? 0) + y;
    setImageZoom(nextZoom);
    if (viewport) requestAnimationFrame(() => {
      const ratio = nextZoom / previousZoom;
      viewport.scrollLeft = contentX * ratio - x;
      viewport.scrollTop = contentY * ratio - y;
    });
  };
  const handleImageWheel = (event: WheelEvent) => {
    event.preventDefault();
    const viewport = imageViewport;
    if (!viewport) return;
    const bounds = viewport.getBoundingClientRect();
    changeImageZoom(imageZoom() * (event.deltaY < 0 ? 1.15 : 1 / 1.15), event.clientX - bounds.left, event.clientY - bounds.top);
  };
  const beginImageDrag = (event: PointerEvent) => {
    const viewport = imageViewport;
    if (!viewport || imageZoom() <= 1 || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    viewport.setPointerCapture(event.pointerId);
    imageDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop };
    setImageDragging(true);
  };
  const moveImageDrag = (event: PointerEvent) => {
    const viewport = imageViewport;
    if (!viewport || imageDrag?.pointerId !== event.pointerId) return;
    event.preventDefault();
    viewport.scrollLeft = imageDrag.scrollLeft - (event.clientX - imageDrag.x);
    viewport.scrollTop = imageDrag.scrollTop - (event.clientY - imageDrag.y);
  };
  const endImageDrag = (event: PointerEvent) => {
    const viewport = imageViewport;
    if (!viewport || imageDrag?.pointerId !== event.pointerId) return;
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    imageDrag = undefined;
    setImageDragging(false);
  };
  const copyPreviewText = async () => {
    try {
      await navigator.clipboard.writeText(previewText());
      setPreviewCopied(true);
    } catch {
      setPreviewError("clipboard_write_failed");
    }
  };
  onCleanup(closeAttachmentPreview);
  const retry = async () => {
    setRetrying(true);
    setRetryError("");
    try {
      await retryIssue(props.issue.id);
      await props.onUpdated();
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : String(error));
    } finally {
      setRetrying(false);
    }
  };
  const changeStatus = async (status: "open" | "resolved") => {
    setStatusSaving(true); setStatusError("");
    try { await updateIssueStatus(props.issue.id, status); await props.onUpdated(); }
    catch (error) { setStatusError(error instanceof Error ? error.message : String(error)); }
    finally { setStatusSaving(false); }
  };
  return (
    <section class="issue-workspace">
      <header class="issue-header">
        <div class="issue-heading">
          <div class="issue-heading-meta">
            <span>{props.issue.id}</span>
            <Tag color={priorityColor[props.issue.priority]}>{props.issue.priority.toUpperCase()}</Tag>
            <Tag>{typeLabel[props.issue.type]}</Tag>
            <Badge status={statusBadge[props.issue.status]} text={statusLabel[props.issue.status]} />
          </div>
          <h1>{props.issue.title}</h1>
          <Show when={props.issue.description.trim()}><div class="issue-description"><Markdown source={props.issue.description} /></div></Show>
        </div>
        <Space>
          <Show when={props.issue.workspace.retryable}>
            <Button icon={<RefreshCw size={15} />} loading={retrying()} onClick={() => { void retry(); }}>{props.issue.workspace.status === "ready" ? "继续处理" : "重试处理"}</Button>
          </Show>
          <Show when={props.issue.status === "pending"}><Button type="primary" icon={<CheckCircle2 size={15} />} loading={statusSaving()} onClick={() => { void changeStatus("resolved"); }}>确认解决</Button></Show>
          <Show when={props.issue.status === "resolved"}><Button icon={<RefreshCw size={15} />} loading={statusSaving()} onClick={() => { void changeStatus("open"); }}>重新打开</Button></Show>
          <Button icon={<Pencil size={15} />} disabled={props.issue.workspace.status === "preparing" || props.issue.workspace.status === "running"} onClick={openEditor}>编辑工单</Button>
        </Space>
      </header>

      <div class="issue-facts">
        <div><span>创建人</span><strong>{props.issue.reporter?.name ?? "-"}</strong></div>
        <div><span>创建时间</span><strong>{new Date(props.issue.createdAt ?? props.issue.updatedAt).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</strong></div>
        <div><span>处理人</span><strong>{props.issue.assignee ?? "未分配"}</strong></div>
        <div><span>抄送人</span><strong>{props.issue.ccRecipients?.map((person) => person.name).join("、") || "无"}</strong></div>
        <div><span>服务</span><strong>{props.issue.service.name}</strong></div>
        <div><span>环境</span><strong>{environmentLabel[props.issue.environmentKey] ?? props.issue.environmentKey}</strong></div>
      </div>
      <Show when={retryError()}><div class="workspace-error" role="alert">{retryError()}</div></Show>
      <Show when={statusError()}><div class="workspace-error" role="alert">{statusError()}</div></Show>
      <Show when={props.issue.workspace.lastError}><div class="workspace-error" role="alert">{props.issue.workspace.lastError}</div></Show>
      <section class="repository-band" aria-labelledby="repositories-title">
        <div class="band-title">
          <GitBranch size={16} />
          <h2 id="repositories-title">代码分支</h2>
          <Show when={workspaceUrl(props.issue.workspace.url)}>
            {(url) => <span class="band-actions"><Button type="text" shape="circle" icon={<ExternalLink size={15} />} title="在 code-server 中打开工单工作区" aria-label="在 code-server 中打开工单工作区" onClick={() => props.onOpenCodeServer(url())} /></span>}
          </Show>
        </div>
        <div class="repository-list">
          <For each={props.issue.repositories} fallback={<span class="muted">尚未绑定仓库</span>}>
            {(repository) => (
              <div class="repository-row">
                <span class="repo-name">{repository.url.split(/[/:]/).at(-1)?.replace(/\.git$/, "")}</span>
                <code>{repository.workingBranch ?? repository.baseBranch}{repository.workingBranch ? "" : " (只读)"}</code>
              </div>
            )}
          </For>
        </div>
      </section>

      <section class="attachment-band" aria-labelledby="attachments-title">
        <div class="band-title"><Paperclip size={16} /><h2 id="attachments-title">附件</h2><span>{props.issue.attachments.length}</span></div>
        <div class="issue-attachment-list">
          <For each={props.issue.attachments} fallback={<div class="empty-band">暂无附件</div>}>
            {(attachment) => <div class="issue-attachment-row"><Paperclip size={15} /><button type="button" class="attachment-preview-trigger" aria-label={`预览 ${attachment.fileName}`} onClick={() => { void openAttachmentPreview(attachment); }}><span><strong>{attachment.fileName}</strong><small>{attachment.mediaType} · {fileSize(attachment.size)}</small></span><Eye size={15} /></button><a class="attachment-download-link" href={attachmentUrl(props.issue.id, attachment.id)} download={attachment.fileName} title={`下载 ${attachment.fileName}`} aria-label={`下载 ${attachment.fileName}`}><Download size={15} /></a></div>}
          </For>
        </div>
      </section>

      <section class="comments-band" aria-labelledby="comments-title">
        <div class="band-title"><MessageSquare size={16} /><h2 id="comments-title">评论与备注</h2><span>{props.issue.comments.length}</span></div>
        <div class="comment-list">
          <For each={props.issue.comments} fallback={<div class="empty-band">暂无评论</div>}>
            {(comment) => <article class="comment-row"><header><strong>{comment.author}</strong><time>{new Date(comment.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time></header><Markdown source={comment.body} /></article>}
          </For>
        </div>
        <div class="comment-editor">
          <div class="markdown-editor-toolbar"><Segmented size="small" aria-label="评论编辑模式" value={commentMode()} options={[{ value: "edit", label: "编辑" }, { value: "preview", label: "预览" }]} onChange={(value) => setCommentMode(value as "edit" | "preview")} /></div>
          <Show when={commentMode() === "edit"} fallback={<div class="comment-markdown-preview"><Show when={commentBody().trim()} fallback={<span class="muted">暂无内容</span>}><Markdown source={commentBody()} /></Show></div>}>
            <TextArea aria-label="添加评论或备注" placeholder="添加评论或备注" autoSize={{ minRows: 3, maxRows: 8 }} value={commentBody()} onInput={(event) => setCommentBody(event.currentTarget.value)} />
          </Show>
          <div class="comment-actions"><Show when={commentError()}><span class="comment-error" role="alert">{commentError()}</span></Show><Button type="primary" icon={<Send size={14} />} loading={commentSaving()} disabled={!commentBody().trim()} onClick={() => { void submitComment(); }}>发布评论</Button></div>
        </div>
      </section>
      <Modal width={860} open={Boolean(previewAttachment())} title={previewAttachment()?.fileName ?? "附件预览"} okText="关闭" cancelText="取消" onOk={closeAttachmentPreview} onCancel={closeAttachmentPreview}>
        <div class="attachment-preview">
          <Show when={!previewLoading()} fallback={<Skeleton active paragraph={{ rows: 8 }} />}>
            <Show when={!previewError()} fallback={<div class="workspace-error" role="alert">{previewError()}</div>}>
              <Show when={previewAttachment()}>{(attachment) => {
                const kind = () => attachmentPreviewKind(attachment());
                return <Show when={kind() !== "unsupported"} fallback={<div class="attachment-preview-unsupported"><Paperclip size={24} /><strong>此格式不支持内嵌预览</strong><a href={attachmentUrl(props.issue.id, attachment().id)} download={attachment().fileName}><Download size={15} />下载附件</a></div>}>
                  <Show when={kind() !== "text"} fallback={<div class="attachment-text-preview-shell"><div class="attachment-preview-toolbar"><Button icon={<Copy size={14} />} onClick={() => { void copyPreviewText(); }}>{previewCopied() ? "已复制" : "复制文字"}</Button></div><pre class="attachment-text-preview" tabindex="0">{previewText()}</pre></div>}>
                    <Show when={kind() !== "image"} fallback={<div class="attachment-image-preview-shell"><div class="attachment-preview-toolbar"><Button type="text" shape="circle" icon={<ZoomOut size={15} />} disabled={imageZoom() <= 1} title="缩小" aria-label="缩小" onClick={() => changeImageZoom(imageZoom() / 1.25)} /><button type="button" class="attachment-zoom-value" title="恢复 100%" aria-label="恢复 100%" onClick={() => changeImageZoom(1)}>{Math.round(imageZoom() * 100)}%</button><Button type="text" shape="circle" icon={<ZoomIn size={15} />} disabled={imageZoom() >= 4} title="放大" aria-label="放大" onClick={() => changeImageZoom(imageZoom() * 1.25)} /></div><div ref={imageViewport} class={`attachment-image-viewport${imageZoom() > 1 ? " is-pannable" : ""}${imageDragging() ? " is-dragging" : ""}`} onWheel={handleImageWheel} onPointerDown={beginImageDrag} onPointerMove={moveImageDrag} onPointerUp={endImageDrag} onPointerCancel={endImageDrag}><div class="attachment-image-stage" style={{ width: `${imageZoom() * 100}%`, height: `${imageZoom() * 100}%` }}><img class="attachment-image-preview" src={previewObjectUrl()} alt={attachment().fileName} draggable={false} /></div></div></div>}>
                      <iframe class="attachment-pdf-preview" src={previewObjectUrl()} title={`预览 ${attachment().fileName}`} />
                    </Show>
                  </Show>
                </Show>;
              }}</Show>
            </Show>
          </Show>
        </div>
      </Modal>
      <Modal open={editOpen()} title="编辑工单" okText="保存" cancelText="取消" confirmLoading={editSaving()} okButtonProps={{ disabled: !editTitle().trim() || !editService() }} onOk={() => { void saveIssue(); }} onCancel={() => { setEditCcOpen(false); setEditAttachments([]); setRemovedAttachmentIds([]); setEditOpen(false); }}>
        <div class="create-issue-form compact-issue-form edit-issue-form">
          <Show when={editError()}><div class="create-error modal-form-error" role="alert">{editError()}</div></Show>
          <label><span>服务</span><Select aria-label="编辑工单服务" value={editService()} onChange={(value) => { const selected = selectedChoice(value, configuration().services.map((service) => service.key)); if (selected) setEditService(selected); }} options={configuration().services.filter((service) => service.environmentIds.includes(configuration().environments.find((environment) => environment.key === props.issue.environmentKey)?.id ?? "")).map((service) => ({ value: service.key, label: service.name }))} /></label>
          <label><span>优先级</span><Select aria-label="编辑工单优先级" value={editPriority()} onChange={(value) => { const selected = selectedChoice(value, ["p0", "p1", "p2", "p3"] as const); if (selected) setEditPriority(selected); }} options={[{ value: "p0", label: "P0 · 紧急" }, { value: "p1", label: "P1 · 高" }, { value: "p2", label: "P2 · 中" }, { value: "p3", label: "P3 · 低" }]} /></label>
          <label><span>类型</span><Select aria-label="编辑工单类型" value={editType()} onChange={(value) => { const selected = selectedChoice(value, issueTypesForEnvironment(props.issue.environmentKey)); if (selected) setEditType(selected); }} options={issueTypesForEnvironment(props.issue.environmentKey).map((value) => ({ value, label: typeLabel[value] }))} /></label>
          <label><span>处理人</span><Select aria-label="编辑工单处理人" value={editAssignee() ?? undefined} allowClear onClear={() => setEditAssignee(null)} onChange={(value) => { if (typeof value === "string" && value) setEditAssignee(value); }} options={people().map((person) => ({ value: person.subject, label: `${person.name}${person.email ? ` · ${person.email}` : ""}` }))} /></label>
          <label><span>抄送人（可多选）</span><div class="multi-select-trigger" ref={(element) => bindMultipleSelectBlankToggle(element, setEditCcOpen)}><Select mode="multiple" aria-label="编辑工单抄送人" value={editCc()} open={editCcOpen()} onOpenChange={setEditCcOpen} onChange={(value) => setEditCc(selectedStrings(value, editCc()))} options={people().filter((person) => person.subject !== editAssignee()).map((person) => ({ value: person.subject, label: `${person.name}${person.email ? ` · ${person.email}` : ""}` }))} /></div></label>
          <label><span>标题</span><Input aria-label="编辑工单标题" value={editTitle()} onInput={(event) => setEditTitle(event.currentTarget.value)} /></label>
          <DescriptionField value={editDescription} inputLabel="编辑工单描述" expandLabel="放大编辑工单描述" onChange={(value) => setEditDescription(value)} />
          <AttachmentPicker files={editAttachments} existingFiles={() => props.issue.attachments.filter((attachment) => !removedAttachmentIds().includes(attachment.id))} inputLabel="编辑工单选择附件" onFilesChange={(files) => setEditAttachments(files)} onRemoveExisting={(id) => { setRemovedAttachmentIds((current) => [...current, id]); setEditError(""); }} onError={(message) => setEditError(message)} />
        </div>
      </Modal>
    </section>
  );
}

function AgentWorkbench(props: { issue: IssueDetail; agentExpanded: boolean; codeExpanded: boolean; codeServerTarget: string | null; onToggleAgent: () => void; onCloseCode: () => void; onRefresh: (issueId: string) => Promise<IssueDetail> }) {
  const agentRunning = () => props.issue.workspace.status === "preparing" || props.issue.workspace.status === "running";
  const codeServerUrl = () => props.codeServerTarget ?? workspaceUrl(props.issue.workspace.url);
  return (
    <section class={`agent-workbench${props.agentExpanded ? " agent-only" : ""}${props.codeExpanded ? " code-only" : ""}`} aria-label={`${props.issue.id} 智能体工作区`}>
      <Show when={props.codeExpanded} fallback={<AgentPanel issue={props.issue} expanded={props.agentExpanded} onToggleExpanded={props.onToggleAgent} onRefresh={props.onRefresh} />}>
        <section class="code-server-pane" aria-label={`${props.issue.id} code-server`}>
          <header class="code-server-header">
            <div><TerminalSquare size={16} /><strong>code-server</strong><small>{props.issue.id}</small></div>
            <span class="code-server-actions">
              <Button type="text" shape="circle" icon={<ExternalLink size={15} />} title="在新窗口打开 code-server" aria-label="在新窗口打开 code-server" disabled={!codeServerUrl()} onClick={() => { const url = codeServerUrl(); if (url) window.open(url, "_blank", "noopener"); }} />
              <Button type="text" shape="circle" icon={<Minimize2 size={16} />} title="还原 code-server" aria-label="还原 code-server" onClick={props.onCloseCode} />
            </span>
          </header>
          <Show when={codeServerUrl()} fallback={<div class="code-server-empty"><strong>{agentRunning() ? "正在准备代码工作区" : "code-server 尚未就绪"}</strong></div>}>
            {(url) => <div class="code-server-frame-wrap"><iframe class="code-server-frame" src={url()} title={`${props.issue.id} code-server 编辑器`} allow="clipboard-read; clipboard-write" /></div>}
          </Show>
        </section>
      </Show>
    </section>
  );
}

type RepositoryKind = Service["repositories"][number]["kind"];
type AgentDraft = { provider: string; model: string; thinkingLevel: ThinkingLevel };

interface ServiceDeploymentDraft {
  environmentKey: string;
  baseBranch: string;
  capabilities: CapabilityName[];
  agent: AgentDraft;
  nacos?: { serverUrl: string; namespace: string; group: string; dataIds: string[]; username: string; password: string };
  db?: { url: string; username: string; password: string };
  sls?: { accessKeyId: string; accessKeySecret: string; region: string; project: string; logstores: string[] };
  playwright?: { baseUrl: string; username: string; password: string };
  redis?: { host: string; port: number; username: string; password: string; database: number };
  mq?: { host: string; port: number; managementPort: number; username: string; password: string; virtualHost: string };
  es?: { url: string; username: string; password: string };
}

function cloneDeploymentDraft(deployment: ServiceDeploymentDraft): ServiceDeploymentDraft {
  return {
    environmentKey: deployment.environmentKey,
    baseBranch: deployment.baseBranch,
    capabilities: [...deployment.capabilities],
    agent: { ...deployment.agent },
    ...(deployment.nacos ? { nacos: { ...deployment.nacos } } : {}),
    ...(deployment.db ? { db: { ...deployment.db } } : {}),
    ...(deployment.sls ? { sls: { ...deployment.sls, logstores: [...deployment.sls.logstores] } } : {}),
    ...(deployment.playwright ? { playwright: { ...deployment.playwright } } : {}),
    ...(deployment.redis ? { redis: { ...deployment.redis } } : {}),
    ...(deployment.mq ? { mq: { ...deployment.mq } } : {}),
    ...(deployment.es ? { es: { ...deployment.es } } : {}),
  };
}

function ServiceRepositoryEditorRow(props: {
  index: number;
  repository: { id?: string; kind: RepositoryKind; url: string };
  only: boolean;
  onChange: (repository: { kind: RepositoryKind; url: string }) => void;
  onDelete: () => void;
}) {
  const [url, setUrl] = createSignal(props.repository.url, { ownedWrite: true });
  return <div class="service-repository-row"><Input aria-label={`仓库地址 ${props.index + 1}`} placeholder="git@example.com:team/project.git" value={url()} onInput={(event) => { const next = event.currentTarget.value; setUrl(next); props.onChange({ kind: props.repository.kind, url: next }); }} /><Button type="text" shape="circle" icon={<Trash2 size={14} />} title={`删除仓库${props.index + 1}`} aria-label={`删除仓库${props.index + 1}`} disabled={props.only} onClick={props.onDelete} /></div>;
}

function CapabilityLabels(props: { catalog: Config["capabilityCatalog"]; keys: CapabilityName[] }) {
  const entries = () => props.catalog.filter((capability) => props.keys.includes(capability.key));
  return <div class="capability-labels"><For each={entries()}>{(capability) => <code>{capability.key}</code>}</For></div>;
}

function ServiceDeploymentEditorRow(props: {
  index: number;
  deployment: ServiceDeploymentDraft;
  capabilityCatalog: Config["capabilityCatalog"];
  agentModels: AgentModelDefinition[];
  environmentOptions: () => Config["environments"];
  onChange: (deployment: ServiceDeploymentDraft) => void;
  onDelete: () => void;
}) {
  let currentDeployment = cloneDeploymentDraft(props.deployment);
  const [environmentKey, setEnvironmentKey] = createSignal(props.deployment.environmentKey, { ownedWrite: true });
  const [baseBranch, setBaseBranch] = createSignal(props.deployment.baseBranch, { ownedWrite: true });
  const [selectedCapabilities, setSelectedCapabilities] = createSignal<CapabilityName[]>([...props.deployment.capabilities], { ownedWrite: true });
  const [agentDraft, setAgentDraft] = createSignal<AgentDraft>({ ...props.deployment.agent }, { ownedWrite: true });
  const [nacosDraft, setNacosDraft] = createSignal({ serverUrl: props.deployment.nacos?.serverUrl ?? "", namespace: props.deployment.nacos?.namespace ?? "", group: props.deployment.nacos?.group ?? "DEFAULT_GROUP", dataIds: props.deployment.nacos?.dataIds?.join(", ") ?? "", username: props.deployment.nacos?.username ?? "", password: props.deployment.nacos?.password ?? "" }, { ownedWrite: true });
  const [dbDraft, setDbDraft] = createSignal({ url: props.deployment.db?.url ?? "", username: props.deployment.db?.username ?? "", password: props.deployment.db?.password ?? "" }, { ownedWrite: true });
  const [slsDraft, setSlsDraft] = createSignal({ accessKeyId: props.deployment.sls?.accessKeyId ?? "", accessKeySecret: props.deployment.sls?.accessKeySecret ?? "", region: props.deployment.sls?.region ?? "", project: props.deployment.sls?.project ?? "", logstores: props.deployment.sls?.logstores.join(", ") ?? "" }, { ownedWrite: true });
  const [playwrightDraft, setPlaywrightDraft] = createSignal({ baseUrl: props.deployment.playwright?.baseUrl ?? "", username: props.deployment.playwright?.username ?? "", password: props.deployment.playwright?.password ?? "" }, { ownedWrite: true });
  const [redisDraft, setRedisDraft] = createSignal({ host: props.deployment.redis?.host ?? "", port: String(props.deployment.redis?.port ?? 6379), username: props.deployment.redis?.username ?? "", password: props.deployment.redis?.password ?? "", database: String(props.deployment.redis?.database ?? 0) }, { ownedWrite: true });
  const [mqDraft, setMqDraft] = createSignal({ host: props.deployment.mq?.host ?? "", port: String(props.deployment.mq?.port ?? 5672), managementPort: String(props.deployment.mq?.managementPort ?? 15672), username: props.deployment.mq?.username ?? "", password: props.deployment.mq?.password ?? "", virtualHost: props.deployment.mq?.virtualHost ?? "/" }, { ownedWrite: true });
  const [esDraft, setEsDraft] = createSignal({ url: props.deployment.es?.url ?? "", username: props.deployment.es?.username ?? "", password: props.deployment.es?.password ?? "" }, { ownedWrite: true });
  const agent = (value = agentDraft()) => ({ ...value, provider: value.provider.trim(), model: value.model.trim() });
  const providerOptions = () => [...new Set(props.agentModels.map((model) => model.provider))].map((provider) => ({ value: provider, label: provider }));
  const modelOptions = () => props.agentModels.filter((model) => model.provider === agentDraft().provider);
  const selectedModel = () => props.agentModels.find((model) => model.provider === agentDraft().provider && model.id === agentDraft().model);
  const nacos = (value = nacosDraft()) => ({ ...value, serverUrl: value.serverUrl.trim(), namespace: value.namespace.trim(), group: value.group.trim(), dataIds: [...new Set(value.dataIds.split(",").map((item) => item.trim()).filter(Boolean))], username: value.username.trim() });
  const db = (value = dbDraft()) => ({ ...value, url: value.url.trim(), username: value.username.trim() });
  const sls = (value = slsDraft()) => ({ ...value, accessKeyId: value.accessKeyId.trim(), region: value.region.trim(), project: value.project.trim(), logstores: value.logstores.split(",").map((item) => item.trim()).filter(Boolean) });
  const playwright = (value = playwrightDraft()) => ({ ...value, baseUrl: value.baseUrl.trim(), username: value.username.trim() });
  const redis = (value = redisDraft()) => ({ ...value, host: value.host.trim(), port: Number(value.port), username: value.username.trim(), database: Number(value.database) });
  const mq = (value = mqDraft()) => ({ ...value, host: value.host.trim(), port: Number(value.port), managementPort: Number(value.managementPort), username: value.username.trim(), virtualHost: value.virtualHost.trim() });
  const es = (value = esDraft()) => ({ ...value, url: value.url.trim(), username: value.username.trim() });
  const update = (change: Partial<ServiceDeploymentDraft>) => {
    currentDeployment = { ...currentDeployment, ...change };
    props.onChange(cloneDeploymentDraft(currentDeployment));
  };
  const updateNacos = (change: Partial<ReturnType<typeof nacosDraft>>) => { const next = { ...nacosDraft(), ...change }; setNacosDraft(next); update({ nacos: nacos(next) }); };
  const updateDb = (change: Partial<ReturnType<typeof dbDraft>>) => { const next = { ...dbDraft(), ...change }; setDbDraft(next); update({ db: db(next) }); };
  const updateSls = (change: Partial<ReturnType<typeof slsDraft>>) => { const next = { ...slsDraft(), ...change }; setSlsDraft(next); update({ sls: sls(next) }); };
  const updatePlaywright = (change: Partial<ReturnType<typeof playwrightDraft>>) => { const next = { ...playwrightDraft(), ...change }; setPlaywrightDraft(next); update({ playwright: playwright(next) }); };
  const updateRedis = (change: Partial<ReturnType<typeof redisDraft>>) => { const next = { ...redisDraft(), ...change }; setRedisDraft(next); update({ redis: redis(next) }); };
  const updateMq = (change: Partial<ReturnType<typeof mqDraft>>) => { const next = { ...mqDraft(), ...change }; setMqDraft(next); update({ mq: mq(next) }); };
  const updateEs = (change: Partial<ReturnType<typeof esDraft>>) => { const next = { ...esDraft(), ...change }; setEsDraft(next); update({ es: es(next) }); };
  const addCapability = (key: CapabilityName) => {
    if (selectedCapabilities().includes(key)) return;
    const next = [...selectedCapabilities(), key];
    setSelectedCapabilities(next);
    update({ capabilities: next, ...(key === "nacos" ? { nacos: nacos() } : {}), ...(key === "db" ? { db: db() } : {}), ...(key === "sls" ? { sls: sls() } : {}), ...(key === "playwright" ? { playwright: playwright() } : {}), ...(key === "redis" ? { redis: redis() } : {}), ...(key === "mq" ? { mq: mq() } : {}), ...(key === "es" ? { es: es() } : {}) });
  };
  const removeCapability = (key: CapabilityName) => {
    const next = selectedCapabilities().filter((item) => item !== key);
    setSelectedCapabilities(next);
    update({ capabilities: next });
  };
  return (
    <div class="service-deployment-row">
      <label class="deployment-environment"><span class="required-field">环境</span><Select aria-label={`部署环境 ${props.index + 1}`} value={environmentKey()} onChange={(value) => { const options = props.environmentOptions(); const selected = selectedChoice(value, options.map((environment) => environment.key)); if (selected) { setEnvironmentKey(selected); update({ environmentKey: selected }); } }} options={props.environmentOptions().map((environment) => ({ value: environment.key, label: environment.name }))} /></label>
      <label class="deployment-branch"><span class="required-field">分支</span><Input aria-label={`部署分支 ${props.index + 1}`} value={baseBranch()} onInput={(event) => { const next = event.currentTarget.value; setBaseBranch(next); update({ baseBranch: next }); }} /></label>
      <div class="deployment-model"><span>模型</span><button type="button" class="deployment-capability-option selected" aria-pressed="true" disabled>model</button></div>
      <div class="deployment-capabilities"><span>能力</span><div class="deployment-capability-options"><For each={props.capabilityCatalog}>{(capability) => { const selected = () => selectedCapabilities().includes(capability.key); return <button type="button" class={`deployment-capability-option${selected() ? " selected" : ""}`} aria-pressed={selected() ? "true" : "false"} onClick={() => selected() ? removeCapability(capability.key) : addCapability(capability.key)}>{capability.key}</button>; }}</For></div></div>
      <div class="deployment-capability-settings deployment-agent"><div class="capability-settings-head"><code>model</code></div><label><span class="required-field">provider</span><Select aria-label={`model provider ${props.index + 1}`} value={agentDraft().provider} onChange={(value) => { const provider = selectedChoice(value, providerOptions().map((option) => option.value)); if (!provider) return; const model = props.agentModels.find((candidate) => candidate.provider === provider); if (!model) return; const next = { provider, model: model.id, thinkingLevel: model.thinkingLevels.includes("medium") ? "medium" as const : model.thinkingLevels[0]! }; setAgentDraft(next); update({ agent: agent(next) }); }} options={providerOptions()} /></label><label><span class="required-field">modelId</span><Select aria-label={`model id ${props.index + 1}`} value={agentDraft().model} onChange={(value) => { const model = modelOptions().find((candidate) => candidate.id === value); if (!model) return; const current = agentDraft(); const next = { ...current, model: model.id, thinkingLevel: model.thinkingLevels.includes(current.thinkingLevel) ? current.thinkingLevel : model.thinkingLevels[0]! }; setAgentDraft(next); update({ agent: agent(next) }); }} options={modelOptions().map((model) => ({ value: model.id, label: model.id }))} /></label><label><span class="required-field">thinkingLevel</span><Select aria-label={`model thinkingLevel ${props.index + 1}`} value={agentDraft().thinkingLevel} onChange={(value) => { const selected = selectedChoice(value, selectedModel()?.thinkingLevels ?? []); if (selected) { const next = { ...agentDraft(), thinkingLevel: selected }; setAgentDraft(next); update({ agent: agent(next) }); } }} options={(selectedModel()?.thinkingLevels ?? []).map((value) => ({ value, label: value }))} /></label></div>
      <Show when={selectedCapabilities().includes("nacos")}><div class="deployment-capability-settings deployment-nacos"><div class="capability-settings-head"><code>nacos</code></div><label><span class="required-field">serverUrl</span><Input aria-label={`nacos serverUrl ${props.index + 1}`} value={nacosDraft().serverUrl} onInput={(event) => { updateNacos({ serverUrl: event.currentTarget.value }); }} /></label><label><span>namespace</span><Input aria-label={`nacos namespace ${props.index + 1}`} value={nacosDraft().namespace} onInput={(event) => { updateNacos({ namespace: event.currentTarget.value }); }} /></label><label><span class="required-field">group</span><Input aria-label={`nacos group ${props.index + 1}`} value={nacosDraft().group} onInput={(event) => { updateNacos({ group: event.currentTarget.value }); }} /></label><label><span class="required-field">dataIds</span><Input aria-label={`nacos dataIds ${props.index + 1}`} placeholder="多个 Data ID 用逗号分隔" value={nacosDraft().dataIds} onInput={(event) => { updateNacos({ dataIds: event.currentTarget.value }); }} /></label><label><span class={nacosDraft().password ? "required-field" : undefined}>username</span><Input aria-label={`nacos username ${props.index + 1}`} value={nacosDraft().username} onInput={(event) => { updateNacos({ username: event.currentTarget.value }); }} /></label><label><span class={nacosDraft().username.trim() ? "required-field" : undefined}>password</span><Input.Password autocomplete="off" aria-label={`nacos password ${props.index + 1}`}  value={nacosDraft().password} onInput={(event) => { updateNacos({ password: event.currentTarget.value }); }} /></label></div></Show>
      <Show when={selectedCapabilities().includes("db")}><div class="deployment-capability-settings deployment-db"><div class="capability-settings-head"><code>db</code></div><label><span class="required-field">url</span><Input aria-label={`db url ${props.index + 1}`} value={dbDraft().url} onInput={(event) => { updateDb({ url: event.currentTarget.value }); }} /></label><label><span class="required-field">username</span><Input aria-label={`db username ${props.index + 1}`} value={dbDraft().username} onInput={(event) => { updateDb({ username: event.currentTarget.value }); }} /></label><label><span class="required-field">password</span><Input.Password autocomplete="off" aria-label={`db password ${props.index + 1}`}  value={dbDraft().password} onInput={(event) => { updateDb({ password: event.currentTarget.value }); }} /></label></div></Show>
      <Show when={selectedCapabilities().includes("redis")}><div class="deployment-capability-settings deployment-redis"><div class="capability-settings-head"><code>redis</code></div><label><span class="required-field">host</span><Input aria-label={`redis host ${props.index + 1}`} value={redisDraft().host} onInput={(event) => { updateRedis({ host: event.currentTarget.value }); }} /></label><label><span class="required-field">port</span><Input aria-label={`redis port ${props.index + 1}`} value={redisDraft().port} onInput={(event) => { updateRedis({ port: event.currentTarget.value }); }} /></label><label><span>username</span><Input aria-label={`redis username ${props.index + 1}`} value={redisDraft().username} onInput={(event) => { updateRedis({ username: event.currentTarget.value }); }} /></label><label><span class={redisDraft().username.trim() ? "required-field" : undefined}>password</span><Input.Password autocomplete="off" aria-label={`redis password ${props.index + 1}`} value={redisDraft().password} onInput={(event) => { updateRedis({ password: event.currentTarget.value }); }} /></label><label><span class="required-field">database</span><Input aria-label={`redis database ${props.index + 1}`} value={redisDraft().database} onInput={(event) => { updateRedis({ database: event.currentTarget.value }); }} /></label></div></Show>
      <Show when={selectedCapabilities().includes("mq")}><div class="deployment-capability-settings deployment-mq"><div class="capability-settings-head"><code>mq</code></div><label><span class="required-field">host</span><Input aria-label={`mq host ${props.index + 1}`} value={mqDraft().host} onInput={(event) => { updateMq({ host: event.currentTarget.value }); }} /></label><label><span class="required-field">port</span><Input aria-label={`mq port ${props.index + 1}`} value={mqDraft().port} onInput={(event) => { updateMq({ port: event.currentTarget.value }); }} /></label><label><span class="required-field">managementPort</span><Input aria-label={`mq managementPort ${props.index + 1}`} value={mqDraft().managementPort} onInput={(event) => { updateMq({ managementPort: event.currentTarget.value }); }} /></label><label><span class="required-field">username</span><Input aria-label={`mq username ${props.index + 1}`} value={mqDraft().username} onInput={(event) => { updateMq({ username: event.currentTarget.value }); }} /></label><label><span class="required-field">password</span><Input.Password autocomplete="off" aria-label={`mq password ${props.index + 1}`} value={mqDraft().password} onInput={(event) => { updateMq({ password: event.currentTarget.value }); }} /></label><label><span class="required-field">virtualHost</span><Input aria-label={`mq virtualHost ${props.index + 1}`} value={mqDraft().virtualHost} onInput={(event) => { updateMq({ virtualHost: event.currentTarget.value }); }} /></label></div></Show>
      <Show when={selectedCapabilities().includes("es")}><div class="deployment-capability-settings deployment-es"><div class="capability-settings-head"><code>es</code></div><label><span class="required-field">url</span><Input aria-label={`es url ${props.index + 1}`} placeholder="http://es.example.com" value={esDraft().url} onInput={(event) => { updateEs({ url: event.currentTarget.value }); }} /></label><label><span class={esDraft().password ? "required-field" : undefined}>username</span><Input aria-label={`es username ${props.index + 1}`} value={esDraft().username} onInput={(event) => { updateEs({ username: event.currentTarget.value }); }} /></label><label><span class={esDraft().username.trim() ? "required-field" : undefined}>password</span><Input.Password autocomplete="off" aria-label={`es password ${props.index + 1}`} value={esDraft().password} onInput={(event) => { updateEs({ password: event.currentTarget.value }); }} /></label></div></Show>
      <Show when={selectedCapabilities().includes("sls")}><div class="deployment-capability-settings deployment-sls"><div class="capability-settings-head"><code>sls</code></div><label><span class="required-field">accessKeyId</span><Input aria-label={`sls accessKeyId ${props.index + 1}`} value={slsDraft().accessKeyId} onInput={(event) => { updateSls({ accessKeyId: event.currentTarget.value }); }} /></label><label><span class="required-field">accessKeySecret</span><Input.Password autocomplete="off" aria-label={`sls accessKeySecret ${props.index + 1}`} value={slsDraft().accessKeySecret} onInput={(event) => { updateSls({ accessKeySecret: event.currentTarget.value }); }} /></label><label><span class="required-field">region</span><Input aria-label={`sls region ${props.index + 1}`} placeholder="cn-hangzhou" value={slsDraft().region} onInput={(event) => { updateSls({ region: event.currentTarget.value }); }} /></label><label><span class="required-field">project</span><Input aria-label={`sls project ${props.index + 1}`} value={slsDraft().project} onInput={(event) => { updateSls({ project: event.currentTarget.value }); }} /></label><label><span class="required-field">logstore</span><Input aria-label={`sls logstore ${props.index + 1}`} placeholder="多个名称用逗号分隔" value={slsDraft().logstores} onInput={(event) => { updateSls({ logstores: event.currentTarget.value }); }} /></label></div></Show>
      <Show when={selectedCapabilities().includes("playwright")}><div class="deployment-capability-settings deployment-playwright"><div class="capability-settings-head"><code>playwright</code></div><label><span class="required-field">baseUrl</span><Input aria-label={`playwright baseUrl ${props.index + 1}`} value={playwrightDraft().baseUrl} onInput={(event) => { updatePlaywright({ baseUrl: event.currentTarget.value }); }} /></label><label><span class={playwrightDraft().password ? "required-field" : undefined}>username</span><Input aria-label={`playwright username ${props.index + 1}`} value={playwrightDraft().username} onInput={(event) => { updatePlaywright({ username: event.currentTarget.value }); }} /></label><label><span class={playwrightDraft().username.trim() ? "required-field" : undefined}>password</span><Input.Password autocomplete="off" aria-label={`playwright password ${props.index + 1}`}  value={playwrightDraft().password} onInput={(event) => { updatePlaywright({ password: event.currentTarget.value }); }} /></label></div></Show>
      <Button type="text" shape="circle" icon={<Trash2 size={14} />} title={`删除部署${props.index + 1}`} aria-label={`删除部署${props.index + 1}`} onClick={props.onDelete} />
    </div>
  );
}

function ConfigurationView() {
  const [configuration, setConfiguration] = createSignal<Config>({ agentModels: [], environments: [], capabilityCatalog: [], services: [] }, { ownedWrite: true });
  const [serviceOpen, setServiceOpen] = createSignal(false, { ownedWrite: true });
  const [serviceName, setServiceName] = createSignal("", { ownedWrite: true });
  const [description, setDescription] = createSignal("", { ownedWrite: true });
  const [serviceRepositories, setServiceRepositories] = createSignal<Array<{ id?: string; kind: RepositoryKind; url: string }>>([{ kind: "backend", url: "" }], { ownedWrite: true });
  const [serviceDeployments, setServiceDeployments] = createStore<ServiceDeploymentDraft[]>([]);
  const [editingServiceKey, setEditingServiceKey] = createSignal<string | null>(null, { ownedWrite: true });
  const [selectedServiceKey, setSelectedServiceKey] = createSignal<string | null>(null, { ownedWrite: true });
  const [deleteTarget, setDeleteTarget] = createSignal<{ kind: "service"; key: string; name: string } | null>(null, { ownedWrite: true });
  const [saving, setSaving] = createSignal(false, { ownedWrite: true });
  const [configurationError, setConfigurationError] = createSignal("", { ownedWrite: true });
  const refresh = async () => {
    try {
      const next = await loadConfig();
      setConfiguration(next);
      if (!next.services.some((service) => service.key === selectedServiceKey())) setSelectedServiceKey(next.services[0]?.key ?? null);
      setConfigurationError("");
    } catch (error) {
      setConfigurationError(error instanceof Error ? error.message : String(error));
    }
  };
  void refresh();
  const selectedService = createMemo(() => configuration().services.find((service) => service.key === selectedServiceKey()));
  const resetServiceForm = () => {
    setServiceName(""); setDescription(""); setServiceRepositories([{ kind: "backend", url: "" }]); setServiceDeployments(() => []); setEditingServiceKey(null);
  };
  const openNewService = () => {
    resetServiceForm(); setConfigurationError(""); setServiceOpen(true);
  };
  const defaultAgent = (): AgentDraft => {
    const model = configuration().agentModels[0];
    return model ? { provider: model.provider, model: model.id, thinkingLevel: model.thinkingLevels.includes("medium") ? "medium" : model.thinkingLevels[0]! } : { provider: "", model: "", thinkingLevel: "off" };
  };
  const openServiceEditor = (service: Service) => {
    setEditingServiceKey(service.key);
    setServiceName(service.name); setDescription(service.description);
    setServiceRepositories(service.repositories.map((repository) => ({ id: repository.id, kind: repository.kind, url: repository.url })));
    const deployments = service.deployments.map((deployment) => ({
      environmentKey: configuration().environments.find((environment) => environment.id === deployment.environmentId)?.key ?? "",
      baseBranch: deployment.baseBranch,
      capabilities: [...deployment.capabilities],
      agent: deployment.agent ? { ...deployment.agent } : defaultAgent(),
      ...(deployment.nacos ? { nacos: { ...deployment.nacos, dataIds: deployment.nacos.dataIds ?? [], password: deployment.nacos.password ?? "" } } : {}),
      ...(deployment.db ? { db: { ...deployment.db } } : {}),
      ...(deployment.sls ? { sls: { ...deployment.sls, logstores: [...deployment.sls.logstores] } } : {}),
      ...(deployment.playwright ? { playwright: { ...deployment.playwright, username: deployment.playwright.username ?? "", password: deployment.playwright.password ?? "" } } : {}),
      ...(deployment.redis ? { redis: { ...deployment.redis, password: deployment.redis.password ?? "" } } : {}),
      ...(deployment.mq ? { mq: { ...deployment.mq } } : {}),
      ...(deployment.es ? { es: { ...deployment.es, password: deployment.es.password ?? "" } } : {}),
    })).filter((deployment) => deployment.environmentKey);
    setServiceDeployments(() => deployments.map(cloneDeploymentDraft));
    setConfigurationError(""); setServiceOpen(true);
  };
  const serviceValidationError = () => {
    if (!serviceName().trim()) return "请填写服务名称";
    if (!serviceRepositories().length || serviceRepositories().some((repository) => !repository.url.trim())) return "请填写所有仓库地址";
    if (new Set(serviceRepositories().map((repository) => repository.url.trim())).size !== serviceRepositories().length) return "仓库地址不能重复";
    if (serviceDeployments.some((deployment) => !deployment.environmentKey || !deployment.baseBranch.trim())) return "请填写所有部署环境和分支";
    if (new Set(serviceDeployments.map((deployment) => deployment.environmentKey)).size !== serviceDeployments.length) return "同一环境只能配置一个部署";
    if (serviceDeployments.some((deployment) => !deployment.agent.provider.trim() || !deployment.agent.model.trim())) return "请配置所有部署模型";
    if (serviceDeployments.some((deployment) => deployment.capabilities.includes("nacos") && !deployment.nacos?.dataIds.length)) return "请填写 Nacos dataIds";
    return "";
  };
  const availableDeploymentEnvironments = createMemo(() => configuration().environments.filter((environment) => !serviceDeployments.some((deployment) => deployment.environmentKey === environment.key)));
  const addServiceDeployment = () => {
    const environment = availableDeploymentEnvironments()[0];
    if (environment) {
      const deployment = { environmentKey: environment.key, baseBranch: "main", capabilities: [], agent: defaultAgent() } satisfies ServiceDeploymentDraft;
      setServiceDeployments((current) => [...current, cloneDeploymentDraft(deployment)]);
    }
  };
  const saveService = async () => {
    const validationError = serviceValidationError();
    if (validationError) { setConfigurationError(validationError); return; }
    setSaving(true); setConfigurationError("");
    try {
      const definition = {
        name: serviceName().trim(), description: description().trim(),
        repositories: serviceRepositories().map((repository) => ({ ...(repository.id ? { id: repository.id } : {}), kind: repository.kind, url: repository.url.trim() })),
        deployments: serviceDeployments.map((deployment) => ({ environmentKey: deployment.environmentKey, baseBranch: deployment.baseBranch.trim(), capabilities: deployment.capabilities, agent: { provider: deployment.agent.provider.trim(), model: deployment.agent.model.trim(), thinkingLevel: deployment.agent.thinkingLevel }, ...(deployment.capabilities.includes("nacos") && deployment.nacos ? { nacos: { serverUrl: deployment.nacos.serverUrl.trim(), namespace: deployment.nacos.namespace.trim(), group: deployment.nacos.group.trim(), dataIds: deployment.nacos.dataIds, username: deployment.nacos.username.trim(), password: deployment.nacos.password } } : {}), ...(deployment.capabilities.includes("db") && deployment.db ? { db: { url: deployment.db.url.trim(), username: deployment.db.username.trim(), password: deployment.db.password } } : {}), ...(deployment.capabilities.includes("sls") && deployment.sls ? { sls: { accessKeyId: deployment.sls.accessKeyId.trim(), accessKeySecret: deployment.sls.accessKeySecret, region: deployment.sls.region.trim(), project: deployment.sls.project.trim(), logstores: deployment.sls.logstores } } : {}), ...(deployment.capabilities.includes("playwright") && deployment.playwright ? { playwright: { baseUrl: deployment.playwright.baseUrl.trim(), username: deployment.playwright.username.trim(), password: deployment.playwright.password } } : {}), ...(deployment.capabilities.includes("redis") && deployment.redis ? { redis: { host: deployment.redis.host.trim(), port: deployment.redis.port, username: deployment.redis.username.trim(), password: deployment.redis.password, database: deployment.redis.database } } : {}), ...(deployment.capabilities.includes("mq") && deployment.mq ? { mq: { host: deployment.mq.host.trim(), port: deployment.mq.port, managementPort: deployment.mq.managementPort, username: deployment.mq.username.trim(), password: deployment.mq.password, virtualHost: deployment.mq.virtualHost.trim() } } : {}), ...(deployment.capabilities.includes("es") && deployment.es ? { es: { url: deployment.es.url.trim(), username: deployment.es.username.trim(), password: deployment.es.password } } : {}) })),
      };
      const editingKey = editingServiceKey();
      if (editingKey) await updateService(editingKey, definition);
      else await createService(definition);
      await refresh();
      setServiceOpen(false); resetServiceForm();
    } catch (error) {
      setConfigurationError(serviceSaveErrorMessage(error));
    } finally { setSaving(false); }
  };
  const confirmDelete = async () => {
    const target = deleteTarget();
    if (!target) return;
    setSaving(true); setConfigurationError("");
    try {
      await deleteService(target.key);
      setDeleteTarget(null);
      await refresh();
    } catch (error) {
      setConfigurationError(error instanceof Error ? error.message : String(error));
    } finally { setSaving(false); }
  };
  return (
    <main class="configuration-workspace">
      <aside class="environment-panel">
        <div class="config-panel-title"><div><span>咸亨国际</span><h1>配置</h1></div></div>
        <div class="configuration-list-heading"><span>服务</span><Button type="text" shape="circle" icon={<Plus size={16} />} title="添加服务" aria-label="添加服务" onClick={openNewService} /></div>
        <div class="environment-list">
          <For each={configuration().services} fallback={<div class="empty-band">暂无服务</div>}>{(service) => (
            <div class={`environment-entry${selectedServiceKey() === service.key ? " selected" : ""}`}><button type="button" class="environment-item" aria-label={service.name} onClick={() => setSelectedServiceKey(service.key)}><span><strong>{service.name}</strong></span></button></div>
          )}</For>
        </div>

      </aside>
      <section class="service-panel">
        <Show when={selectedService()} fallback={<><header class="service-header"><div><span>服务配置</span><h2>暂无服务</h2></div><Button type="primary" icon={<Plus size={15} />} onClick={openNewService}>添加服务</Button></header><div class="empty-band">先创建服务，再配置环境部署</div></>}>
          {(service) => <>
            <header class="service-header">
              <div><span>服务配置 · {service().repositories.length} 个仓库 · {service().deployments.length} 个部署</span><h2>{service().name}</h2></div>
              <Button icon={<Pencil size={14} />} onClick={() => openServiceEditor(service())}>编辑服务</Button>
            </header>
            <div class="service-detail">
              <section class="service-detail-section"><div class="service-detail-heading"><h3>代码仓库</h3><span>{service().repositories.length} 个授权根目录</span></div><div class="detail-repositories"><div class="repository-detail-head"><span>仓库地址</span></div><For each={service().repositories}>{(repository) => <div class="repository-detail-row"><GitBranch size={15} /><code title={repository.url}>{repository.url}</code></div>}</For></div></section>
              <section class="service-detail-section"><div class="service-detail-heading"><h3>环境部署</h3><span>{service().deployments.length} 个环境</span></div><div class="deployment-detail-list"><Show when={service().deployments.length} fallback={<div class="service-detail-empty">尚未配置环境部署</div>}><div class="deployment-detail-head"><span>环境</span><span>分支</span><span>模型</span><span>能力</span></div><For each={service().deployments}>{(deployment) => { const environment = configuration().environments.find((item) => item.id === deployment.environmentId); return <div class="deployment-detail-row"><div data-label="环境"><strong>{environment?.name ?? deployment.environmentId}</strong></div><div data-label="分支"><code>{deployment.baseBranch}</code></div><div data-label="模型"><Show when={deployment.agent} fallback={<span class="capability-empty">未配置</span>}>{(agent) => <code>{agent().provider}/{agent().model} · {agent().thinkingLevel}</code>}</Show></div><div data-label="能力"><Show when={deployment.capabilities.length} fallback={<span class="capability-empty">无外部能力</span>}><CapabilityLabels catalog={configuration().capabilityCatalog} keys={deployment.capabilities} /></Show></div></div>; }}</For></Show></div></section>
              <section class="service-detail-section"><div class="service-detail-heading"><h3>项目描述</h3></div><Show when={service().description.trim()} fallback={<div class="service-detail-empty">暂无项目描述</div>}><Markdown source={service().description} /></Show></section>
            </div>
          </>}
        </Show>
      </section>
      <Modal width={780} open={serviceOpen()} title={editingServiceKey() ? "编辑服务" : "添加服务"} okText={editingServiceKey() ? "保存" : "添加"} cancelText="取消" confirmLoading={saving()} onOk={() => { void saveService(); }} onCancel={() => setServiceOpen(false)}>
        <div class="service-form">
          <Show when={configurationError()}><div class="create-error" role="alert">{configurationError()}</div></Show>
          <label class="service-form-field"><span class="required-field">服务名称</span><Input aria-label="服务名称" value={serviceName()} onInput={(event) => setServiceName(event.currentTarget.value)} /></label>
          <div class="service-form-section"><div class="service-form-section-header"><div><strong class="required-field">代码仓库</strong><span>服务可以关联一个或多个 Git 仓库</span></div><Button icon={<Plus size={14} />} onClick={() => setServiceRepositories((current) => [...current, { kind: "backend", url: "" }])}>添加仓库</Button></div><div class="service-repository-editor"><For each={serviceRepositories()}>{(repository, index) => <ServiceRepositoryEditorRow index={index()} repository={repository} only={serviceRepositories().length === 1} onChange={(next) => setServiceRepositories((current) => { Object.assign(repository, next); return [...current]; })} onDelete={() => setServiceRepositories((current) => current.filter((item) => item !== repository))} />}</For></div></div>
          <div class="service-form-section"><div class="service-form-section-header"><div><strong>环境部署</strong><span>配置分支和 pi 按需使用的外部能力</span></div><Button icon={<Plus size={14} />} disabled={!availableDeploymentEnvironments().length} onClick={addServiceDeployment}>添加部署</Button></div><div class="service-deployment-editor"><For each={serviceDeployments} fallback={<div class="service-form-empty">尚未配置部署</div>}>{(deployment, index) => <ServiceDeploymentEditorRow index={index()} deployment={deployment} capabilityCatalog={configuration().capabilityCatalog} agentModels={configuration().agentModels} environmentOptions={() => configuration().environments.filter((environment) => environment.key === deployment.environmentKey || !serviceDeployments.some((item) => item !== deployment && item.environmentKey === environment.key))} onChange={(next) => setServiceDeployments((current) => current.map((item, itemIndex) => itemIndex === index() ? cloneDeploymentDraft(next) : item))} onDelete={() => setServiceDeployments((current) => current.filter((_, itemIndex) => itemIndex !== index()))} />}</For></div></div>
          <label class="service-form-field"><span>项目描述（Markdown）</span><TextArea aria-label="项目描述" autoSize={{ minRows: 5, maxRows: 10 }} value={description()} onInput={(event) => setDescription(event.currentTarget.value)} /></label>
          <Show when={editingServiceKey()}><div class="destructive-action"><Button danger icon={<Trash2 size={14} />} onClick={() => { setServiceOpen(false); setDeleteTarget({ kind: "service", key: editingServiceKey()!, name: serviceName() }); }}>删除服务</Button></div></Show>
        </div>
      </Modal>
      <Modal open={Boolean(deleteTarget())} title="删除服务" okText="确认删除" cancelText="取消" confirmLoading={saving()} okButtonProps={{ danger: true }} onOk={() => { void confirmDelete(); }} onCancel={() => { setDeleteTarget(null); setConfigurationError(""); }}>
        <p>确定删除“{deleteTarget()?.name}”吗？已被工单使用的配置不能删除。</p>
        <Show when={configurationError()}><div class="create-error" role="alert">{configurationError()}</div></Show>
      </Modal>
    </main>
  );
}

export function App() {
  const [view, setView] = createSignal<"issues" | "statistics" | "configuration">("issues", { ownedWrite: true });
  const [selectedId, setSelectedId] = createSignal("", { ownedWrite: true });
  const [issue, setIssue] = createSignal<IssueDetail | null>(null, { ownedWrite: true });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [issueError, setIssueError] = createSignal("", { ownedWrite: true });
  const [issueRefreshToken, setIssueRefreshToken] = createSignal(0, { ownedWrite: true });
  const [agentExpanded, setAgentExpanded] = createSignal(false, { ownedWrite: true });
  const [codeExpanded, setCodeExpanded] = createSignal(false, { ownedWrite: true });
  const [codeServerTarget, setCodeServerTarget] = createSignal<string | null>(null, { ownedWrite: true });
  let request = 0;
  createEffect(
    () => selectedId(),
    (id) => {
      const currentRequest = ++request;
      setCodeExpanded(false);
      setCodeServerTarget(null);
      if (!id) {
        setIssue(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      setIssueError("");
      void getIssue(id).then((value) => {
        if (currentRequest === request) setIssue(value);
      }).catch((error) => {
        if (currentRequest !== request) return;
        setIssue(null);
        setIssueError(error instanceof Error ? error.message : "工单加载失败");
      }).finally(() => {
        if (currentRequest === request) setLoading(false);
      });
    },
  );
  const refreshIssue = async (issueId: string) => {
    const refreshed = await getIssue(issueId);
    if (selectedId() === issueId) setIssue(refreshed);
    return refreshed;
  };
  const appTheme = createMemo(() => ({
    algorithm: theme.defaultAlgorithm,
    token: {
      colorPrimary: "#176b5b",
      colorPrimaryHover: "#248171",
      colorPrimaryActive: "#105448",
      borderRadius: "6px",
      colorInfo: "#1677ff",
    },
  }));

  return (
    <ConfigProvider theme={appTheme()}>
      <Layout class="app-shell">
        <Layout.Header class="app-header">
          <div class="brand"><span>IP</span><strong>issue-pilot</strong></div>
          <div class="header-context">
            <Segmented
              aria-label="工作台视图"
              size="small"
              value={view()}
              options={[{ value: "issues", label: "工单" }, { value: "statistics", label: "统计" }, { value: "configuration", label: "配置" }]}
              onChange={(value) => setView(value as "issues" | "statistics" | "configuration")}
            />
          </div>
          <div class="identity">
            <span>本地</span>
            <div><strong>周俊杰</strong><small>本地工作区</small></div>
          </div>
        </Layout.Header>
        <Layout.Content class={`app-content${agentExpanded() && view() === "issues" ? " agent-expanded" : ""}${codeExpanded() && view() === "issues" ? " code-expanded" : ""}`}>
          <Show when={view() === "issues"} fallback={view() === "statistics" ? <Statistics /> : <ConfigurationView />}>
            <Show when={!codeExpanded()}><IssueQueue selectedId={selectedId()} userName="周俊杰" userSubject="zjj3753@xianhengguoji.com" refreshToken={issueRefreshToken()} onSelect={setSelectedId} /></Show>
            <Show when={!loading()} fallback={<main class="issue-loading"><Skeleton active paragraph={{ rows: 12 }} /></main>}>
              <Show when={issue()} fallback={<main class="issue-empty"><strong>{issueError() || "暂无工单"}</strong></main>}>
                {(current) => (
                  <>
                    <AgentWorkbench issue={current()} agentExpanded={agentExpanded()} codeExpanded={codeExpanded()} codeServerTarget={codeServerTarget()} onToggleAgent={() => { setCodeExpanded(false); setCodeServerTarget(null); setAgentExpanded((value) => !value); }} onCloseCode={() => { setCodeExpanded(false); setCodeServerTarget(null); }} onRefresh={refreshIssue} />
                    <Show when={!agentExpanded() && !codeExpanded()}><IssueWorkspace issue={current()} onOpenCodeServer={(url) => { setAgentExpanded(false); setCodeServerTarget(url); setCodeExpanded(true); }} onUpdated={async () => { await refreshIssue(current().id); setIssueRefreshToken((value) => value + 1); }} /></Show>
                  </>
                )}
              </Show>
            </Show>
          </Show>
        </Layout.Content>
      </Layout>
    </ConfigProvider>
  );
}
