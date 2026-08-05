import {
  Badge,
  Button,
  Checkbox,
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
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Eye,
  GitBranch,
  GripVertical,
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
import { DragDropManager } from "@dnd-kit/dom";
import { isSortable, Sortable } from "@dnd-kit/dom/sortable";
import { addIssueComment, attachmentUrl, createIssue, createService, deleteIssueAttachments, deleteService, fetchAttachment, getIssue, listIssues, loadConfig, loadPeople, reorderServices, retryIssue, syncIssueUpdate, updateIssue, updateIssueStatus, updateService, uploadAttachments, type Service, type Config, type DeploymentCapability, type IssueDetail, type IssuePriority, type IssueStatus, type IssueType, type Person } from "../data/client";
import { Markdown } from "../ui/Markdown";
import { workspaceUrl, folderUrl, fileSize, typeLabel, priorityColor, relativeTime, statusBadge, statusLabel } from "./model";
import { PiTerminal } from "./PiTerminal";
import { Statistics } from "./Statistics";
import "@xterm/xterm/css/xterm.css";
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

const DEVELOPMENT_ISSUE_TYPES: IssueType[] = ["incident", "request"];
const ALL_ISSUE_TYPES = Object.keys(typeLabel) as IssueType[];

function issueTypesForEnvironment(environmentKey: string): IssueType[] {
  return environmentKey === "development" ? DEVELOPMENT_ISSUE_TYPES : ALL_ISSUE_TYPES;
}

function validBrowserAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
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
  if (code === "invalid_browser_base_url") return "服务地址必须是完整的 HTTP 或 HTTPS 地址，不能包含账号、查询参数或 # 片段";
  if (code === "browser_password_required") return "配置服务账号时必须填写密码";
  return code;
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
    const oversized = selected.find((file) => file.size > 20 * 1024 * 1024);
    if (oversized) return props.onError(`${oversized.name} 超过 20 MB`);
    if (totalCount() + selected.length > 10) return props.onError("每个工单最多上传 10 个文件");
    props.onFilesChange([...props.files(), ...selected]);
    props.onError("");
  };
  return (
    <div class="attachment-picker">
      <input ref={input} class="visually-hidden" type="file" multiple aria-label={props.inputLabel} onChange={(event) => {
        selectFiles(Array.from(event.currentTarget.files ?? []));
        event.currentTarget.value = "";
      }} />
      <div class="attachment-picker-header"><span>附件 <small>{totalCount()}/10</small></span><Button icon={<Paperclip size={14} />} disabled={totalCount() >= 10} onClick={() => input?.click()}>添加附件</Button></div>
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
  const [configuration, setConfiguration] = createSignal<Config>({ environments: [], capabilityCatalog: [], services: [] }, { ownedWrite: true });
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
    const environmentId = value.environments.find((item) => item.key === selectedEnvironment)?.id;
    const availableServices = value.services.filter((item) => environmentId && item.environmentIds.includes(environmentId));
    setService((current) => availableServices.some((item) => item.key === current) ? current : availableServices[0]?.key ?? "");
  }).catch((error) => setLoadError(error instanceof Error ? error.message : "配置加载失败"));
  void loadPeople().then((value) => { setPeople(value); }).catch(() => undefined);
  const [priority, setPriority] = createSignal<IssuePriority>("p2", { ownedWrite: true });
  const [issueType, setIssueType] = createSignal<IssueType>("incident", { ownedWrite: true });
  const [assigneeSubject, setAssigneeSubject] = createSignal<string | null>(props.userSubject || null, { ownedWrite: true });
  const [ccSubjects, setCcSubjects] = createSignal<string[]>([], { ownedWrite: true });
  const [ccOpen, setCcOpen] = createSignal(false);
  const [attachments, setAttachments] = createSignal<File[]>([], { ownedWrite: true });
  const [saving, setSaving] = createSignal(false, { ownedWrite: true });
  const [createError, setCreateError] = createSignal("", { ownedWrite: true });
  const [queueNotice, setQueueNotice] = createSignal("", { ownedWrite: true });
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
      });
      setIssues((current) => [issue, ...current.filter((item) => item.id !== issue.id)]);
      props.onSelect(issue.id);
      try {
        await uploadAttachments(issue.id, attachments());
        setQueueNotice("");
      } catch (error) {
        const message = error instanceof Error ? error.message : "附件上传失败";
        setQueueNotice(`${issue.id} 已创建，但附件上传失败：${message}`);
      }
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
      const statusMatch = status() === "all" || (status() === "active" && !["resolved", "closed"].includes(issue.status)) || issue.status === status();
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
          onChange={(value) => { const selected = selectedChoice(value, ["active", "open", "in_progress", "pending", "failed", "resolved", "all"] as const); if (selected) setStatus(selected); }}
          options={[
            { value: "active", label: "活动工单" },
            { value: "open", label: "待处理" },
            { value: "in_progress", label: "处理中" },
            { value: "pending", label: "待确认" },
            { value: "failed", label: "异常" },
            { value: "resolved", label: "已解决" },
            { value: "all", label: "全部工单" },
          ]}
        />
        <span class="queue-count">{filtered().length}</span>
      </div>
      <Show when={queueNotice()}><div class="queue-error" role="status">{queueNotice()}</div></Show>
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
          <label><span>环境</span><Select aria-label="工单环境" value={environment()} onChange={(value) => { const selected = selectedChoice(value, configuration().environments.map((item) => item.key)); if (selected) { setEnvironment(selected); setService(""); if (!issueTypesForEnvironment(selected).includes(issueType())) setIssueType("incident"); } }} options={configuration().environments.map((item) => ({ value: item.key, label: item.name }))} /></label>
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
  const [editType, setEditType] = createSignal<IssueType>("incident", { ownedWrite: true });
  const [editAssignee, setEditAssignee] = createSignal<string | null>(null, { ownedWrite: true });
  const [editCc, setEditCc] = createSignal<string[]>([], { ownedWrite: true });
  const [editCcOpen, setEditCcOpen] = createSignal(false);
  const [editService, setEditService] = createSignal("", { ownedWrite: true });
  const [editAttachments, setEditAttachments] = createSignal<File[]>([], { ownedWrite: true });
  const [removedAttachmentIds, setRemovedAttachmentIds] = createSignal<string[]>([], { ownedWrite: true });
  const [people, setPeople] = createSignal<Person[]>([], { ownedWrite: true });
  const [configuration, setConfiguration] = createSignal<Config>({ environments: [], capabilityCatalog: [], services: [] }, { ownedWrite: true });
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
      await deleteIssueAttachments(props.issue.id, removedAttachmentIds());
      await uploadAttachments(props.issue.id, editAttachments());
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
          <Show when={props.issue.status === "resolved" || props.issue.status === "closed"}><Button icon={<RefreshCw size={15} />} loading={statusSaving()} onClick={() => { void changeStatus("open"); }}>重新打开</Button></Show>
          <Button icon={<Pencil size={15} />} disabled={props.issue.workspace.status === "preparing" || props.issue.workspace.status === "running"} onClick={openEditor}>编辑工单</Button>
        </Space>
      </header>

      <div class="issue-facts">
        <div><span>创建人</span><strong>{props.issue.reporter?.name ?? "-"}</strong></div>
        <div><span>创建时间</span><strong>{new Date(props.issue.createdAt ?? props.issue.updatedAt).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</strong></div>
        <div><span>处理人</span><strong>{props.issue.assignee ?? "未分配"}</strong></div>
        <div><span>抄送人</span><strong>{props.issue.ccRecipients?.map((person) => person.name).join("、") || "无"}</strong></div>
        <div><span>服务</span><strong>{props.issue.service.name}</strong></div>
        <div><span>工作区</span><strong>{props.issue.workspace.status === "ready" ? "本轮完成" : props.issue.workspace.status === "preparing" ? "准备中" : props.issue.workspace.status === "running" ? "处理中" : props.issue.workspace.status === "failed" ? "异常" : props.issue.workspace.status}</strong></div>
      </div>
      <Show when={retryError()}><div class="workspace-error" role="alert">{retryError()}</div></Show>
      <Show when={statusError()}><div class="workspace-error" role="alert">{statusError()}</div></Show>
      <Show when={props.issue.workspace.lastError}><div class="workspace-error" role="alert">{props.issue.workspace.lastError}</div></Show>

      <section class="repository-band" aria-labelledby="repositories-title">
        <div class="band-title"><GitBranch size={16} /><h2 id="repositories-title">代码分支</h2></div>
        <div class="repository-list">
          <For each={props.issue.repositories} fallback={<span class="muted">尚未绑定仓库</span>}>
            {(repository) => {
              const codeServerUrl = () => folderUrl(props.issue.workspace.url, repository.codeServerPath);
              return (
                <div class="repository-row">
                  <span class="repo-name">{repository.url.split(/[/:]/).at(-1)?.replace(/\.git$/, "")}</span>
                  <Show when={codeServerUrl()} fallback={<code>{repository.workingBranch ?? repository.baseBranch}{repository.workingBranch ? "" : " (只读)"}</code>}>
                    {(url) => <button type="button" class="repository-branch-link" title={`在 code-server 中打开 ${repository.workingBranch ?? repository.baseBranch}`} onClick={() => props.onOpenCodeServer(url())}><code>{repository.workingBranch ?? repository.baseBranch}{repository.workingBranch ? "" : " (只读)"}</code><ExternalLink size={14} /></button>}
                  </Show>
                </div>
              );
            }}
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
          <label><span>服务</span><Select aria-label="编辑工单服务" value={editService()} onChange={(value) => { const selected = selectedChoice(value, configuration().services.map((service) => service.key)); if (selected) setEditService(selected); }} options={configuration().services.filter((service) => service.environmentIds.includes(configuration().environments.find((environment) => environment.key === props.issue.environmentKey)?.id ?? "")).map((service) => ({ value: service.key, label: service.name }))} /></label>
          <label><span>优先级</span><Select aria-label="编辑工单优先级" value={editPriority()} onChange={(value) => { const selected = selectedChoice(value, ["p0", "p1", "p2", "p3"] as const); if (selected) setEditPriority(selected); }} options={[{ value: "p0", label: "P0 · 紧急" }, { value: "p1", label: "P1 · 高" }, { value: "p2", label: "P2 · 中" }, { value: "p3", label: "P3 · 低" }]} /></label>
          <label><span>类型</span><Select aria-label="编辑工单类型" value={editType()} onChange={(value) => { const selected = selectedChoice(value, issueTypesForEnvironment(props.issue.environmentKey)); if (selected) setEditType(selected); }} options={issueTypesForEnvironment(props.issue.environmentKey).map((value) => ({ value, label: typeLabel[value] }))} /></label>
          <label><span>处理人</span><Select aria-label="编辑工单处理人" value={editAssignee() ?? undefined} allowClear onClear={() => setEditAssignee(null)} onChange={(value) => { if (typeof value === "string" && value) setEditAssignee(value); }} options={people().map((person) => ({ value: person.subject, label: `${person.name}${person.email ? ` · ${person.email}` : ""}` }))} /></label>
          <label><span>抄送人（可多选）</span><div class="multi-select-trigger" ref={(element) => bindMultipleSelectBlankToggle(element, setEditCcOpen)}><Select mode="multiple" aria-label="编辑工单抄送人" value={editCc()} open={editCcOpen()} onOpenChange={setEditCcOpen} onChange={(value) => setEditCc(selectedStrings(value, editCc()))} options={people().filter((person) => person.subject !== editAssignee()).map((person) => ({ value: person.subject, label: `${person.name}${person.email ? ` · ${person.email}` : ""}` }))} /></div></label>
          <label><span>标题</span><Input aria-label="编辑工单标题" value={editTitle()} onInput={(event) => setEditTitle(event.currentTarget.value)} /></label>
          <DescriptionField value={editDescription} inputLabel="编辑工单描述" expandLabel="放大编辑工单描述" onChange={(value) => setEditDescription(value)} />
          <AttachmentPicker files={editAttachments} existingFiles={() => props.issue.attachments.filter((attachment) => !removedAttachmentIds().includes(attachment.id))} inputLabel="编辑工单选择附件" onFilesChange={(files) => setEditAttachments(files)} onRemoveExisting={(id) => { setRemovedAttachmentIds((current) => [...current, id]); setEditError(""); }} onError={(message) => setEditError(message)} />
          <Show when={editError()}><div class="create-error" role="alert">{editError()}</div></Show>
        </div>
      </Modal>
    </section>
  );
}

function AgentWorkbench(props: { issue: IssueDetail; terminalExpanded: boolean; codeExpanded: boolean; codeServerTarget: string | null; onToggleTerminal: () => void; onCloseCode: () => void; onRefresh: (issueId: string) => Promise<IssueDetail> }) {
  const agentRunning = () => props.issue.workspace.status === "preparing" || props.issue.workspace.status === "running";
  const codeServerUrl = () => props.codeServerTarget ?? workspaceUrl(props.issue.workspace.url);
  return (
    <section class={`agent-workbench${props.terminalExpanded ? " terminal-only" : ""}${props.codeExpanded ? " code-only" : ""}`} aria-label={`${props.issue.id} 智能体工作区`}>
      <Show when={props.codeExpanded} fallback={<PiTerminal issue={props.issue} expanded={props.terminalExpanded} onToggleExpanded={props.onToggleTerminal} onRefresh={props.onRefresh} />}>
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

function SortableServiceEntry(props: { service: Service; index: number; selected: boolean; manager: DragDropManager; onSelect: () => void }) {
  let element: HTMLDivElement | undefined;
  let handle: HTMLButtonElement | undefined;
  let sortable: Sortable | undefined;
  let disposed = false;
  const bind = () => {
    if (disposed || sortable || !element || !handle) return;
    sortable = new Sortable({ id: props.service.key, index: props.index, element, handle }, props.manager);
  };
  createEffect(
    () => props.index,
    (index) => { if (sortable) sortable.index = index; },
  );
  onCleanup(() => {
    disposed = true;
    sortable?.destroy();
  });
  return (
    <div ref={(value) => { element = value; queueMicrotask(bind); }} class={`environment-entry sortable-service-entry${props.selected ? " selected" : ""}`}>
      <button ref={(value) => { handle = value; queueMicrotask(bind); }} type="button" class="service-drag-handle" title={`拖动排序 ${props.service.name}`} aria-label={`拖动排序 ${props.service.name}`}><GripVertical size={15} /></button>
      <button type="button" class="environment-item" aria-label={props.service.name} onClick={props.onSelect}><span><strong>{props.service.name}</strong></span></button>
    </div>
  );
}

type RepositoryKind = Service["repositories"][number]["kind"];

interface ServiceDeploymentDraft {
  environmentKey: string;
  baseBranch: string;
  capabilities: DeploymentCapability[];
  sls?: { project: string; logstores: string[] };
  browser?: { baseUrl: string; username: string; password: string; passwordConfigured?: boolean };
}

function cloneDeploymentDraft(deployment: ServiceDeploymentDraft): ServiceDeploymentDraft {
  return {
    environmentKey: deployment.environmentKey,
    baseBranch: deployment.baseBranch,
    capabilities: [...deployment.capabilities],
    ...(deployment.sls ? { sls: { project: deployment.sls.project, logstores: [...deployment.sls.logstores] } } : {}),
    ...(deployment.browser ? { browser: { ...deployment.browser } } : {}),
  };
}

function ServiceRepositoryEditorRow(props: {
  index: number;
  repository: { id?: string; kind: RepositoryKind; url: string };
  only: boolean;
  onChange: (repository: { kind: RepositoryKind; url: string }) => void;
  onDelete: () => void;
}) {
  const [kind, setKind] = createSignal<RepositoryKind>(props.repository.kind, { ownedWrite: true });
  const [url, setUrl] = createSignal(props.repository.url, { ownedWrite: true });
  return <div class="service-repository-row"><Select aria-label={`仓库角色 ${props.index + 1}`} value={kind()} onChange={(value) => { const selected = selectedChoice(value, ["frontend", "backend"] as const); if (selected) { setKind(selected); props.onChange({ kind: selected, url: url() }); } }} options={[{ value: "frontend", label: "前端" }, { value: "backend", label: "后端" }]} /><Input aria-label={`仓库地址 ${props.index + 1}`} placeholder="git@example.com:team/project.git" value={url()} onInput={(event) => { const next = event.currentTarget.value; setUrl(next); props.onChange({ kind: kind(), url: next }); }} /><Button type="text" shape="circle" icon={<Trash2 size={14} />} title={`删除仓库${props.index + 1}`} aria-label={`删除仓库${props.index + 1}`} disabled={props.only} onClick={props.onDelete} /></div>;
}

function CapabilityDescriptions(props: { catalog: Config["capabilityCatalog"]; keys?: DeploymentCapability[] }) {
  const entries = () => props.keys ? props.catalog.filter((capability) => props.keys!.includes(capability.key)) : props.catalog;
  return <div class="capability-descriptions"><div><For each={entries()}>{(capability) => <div><strong>{capability.label}</strong><p>{capability.description}</p></div>}</For></div></div>;
}

function ServiceDeploymentEditorRow(props: {
  index: number;
  deployment: ServiceDeploymentDraft;
  capabilityCatalog: Config["capabilityCatalog"];
  environmentOptions: () => Config["environments"];
  onChange: (deployment: ServiceDeploymentDraft) => void;
  onDelete: () => void;
}) {
  const [environmentKey, setEnvironmentKey] = createSignal(props.deployment.environmentKey, { ownedWrite: true });
  const [baseBranch, setBaseBranch] = createSignal(props.deployment.baseBranch, { ownedWrite: true });
  const [selectedCapabilities, setSelectedCapabilities] = createSignal<DeploymentCapability[]>([...props.deployment.capabilities], { ownedWrite: true });
  let currentSlsProject = props.deployment.sls?.project ?? "";
  let currentSlsLogstores = props.deployment.sls?.logstores.join(", ") ?? "";
  let currentBrowserBaseUrl = props.deployment.browser?.baseUrl ?? "";
  let currentBrowserUsername = props.deployment.browser?.username ?? "";
  let currentBrowserPassword = props.deployment.browser?.password ?? "";
  const [slsProject, setSlsProject] = createSignal(currentSlsProject, { ownedWrite: true });
  const [slsLogstores, setSlsLogstores] = createSignal(currentSlsLogstores, { ownedWrite: true });
  const [browserBaseUrl, setBrowserBaseUrl] = createSignal(currentBrowserBaseUrl, { ownedWrite: true });
  const [browserUsername, setBrowserUsername] = createSignal(currentBrowserUsername, { ownedWrite: true });
  const [browserPassword, setBrowserPassword] = createSignal(currentBrowserPassword, { ownedWrite: true });
  const sls = () => ({ project: currentSlsProject.trim(), logstores: currentSlsLogstores.split(",").map((value) => value.trim()).filter(Boolean) });
  const browser = () => ({ baseUrl: currentBrowserBaseUrl.trim(), username: currentBrowserUsername.trim(), password: currentBrowserPassword, passwordConfigured: props.deployment.browser?.passwordConfigured });
  const update = (change: Partial<ServiceDeploymentDraft>) => props.onChange({ ...props.deployment, ...change });
  return (
    <div class="service-deployment-row">
      <label class="deployment-environment"><span>环境</span><Select aria-label={`部署环境 ${props.index + 1}`} value={environmentKey()} onChange={(value) => { const options = props.environmentOptions(); const selected = selectedChoice(value, options.map((environment) => environment.key)); if (selected) { setEnvironmentKey(selected); update({ environmentKey: selected }); } }} options={props.environmentOptions().map((environment) => ({ value: environment.key, label: environment.name }))} /></label>
      <label class="deployment-branch"><span>分支</span><Input aria-label={`部署分支 ${props.index + 1}`} value={baseBranch()} onInput={(event) => { const next = event.currentTarget.value; setBaseBranch(next); update({ baseBranch: next }); }} /></label>
      <div class="deployment-capabilities"><span>能力</span><div class="deployment-capability-controls"><Checkbox.Group aria-label={`部署能力 ${props.index + 1}`} class="capability-checkboxes" value={selectedCapabilities()} onChange={(value) => { const selected = new Set(selectedStrings(value, selectedCapabilities())); const next = props.capabilityCatalog.filter((capability) => selected.has(capability.key)).map((capability) => capability.key); setSelectedCapabilities(next); update({ capabilities: next, ...(next.includes("sls_read") ? { sls: sls() } : {}), ...(next.includes("browser_use") ? { browser: browser() } : {}) }); }} options={props.capabilityCatalog.map((capability) => ({ value: capability.key, label: capability.label }))} /><CapabilityDescriptions catalog={props.capabilityCatalog} /></div></div>
      <Show when={selectedCapabilities().includes("sls_read")}><div class="deployment-sls"><label><span>SLS Project</span><Input aria-label={`SLS Project ${props.index + 1}`} value={slsProject()} onInput={(event) => { currentSlsProject = event.currentTarget.value; setSlsProject(currentSlsProject); update({ sls: sls() }); }} /></label><label><span>Logstore</span><Input aria-label={`SLS Logstore ${props.index + 1}`} placeholder="多个名称用逗号分隔" value={slsLogstores()} onInput={(event) => { currentSlsLogstores = event.currentTarget.value; setSlsLogstores(currentSlsLogstores); update({ sls: sls() }); }} /></label></div></Show>
      <Show when={selectedCapabilities().includes("browser_use")}><div class="deployment-browser"><label><span>服务地址</span><Input aria-label={`服务地址 ${props.index + 1}`} placeholder="https://service.example.com/app" value={browserBaseUrl()} onInput={(event) => { currentBrowserBaseUrl = event.currentTarget.value; setBrowserBaseUrl(currentBrowserBaseUrl); update({ browser: browser() }); }} /></label><label><span>账号</span><Input aria-label={`服务账号 ${props.index + 1}`} value={browserUsername()} onInput={(event) => { currentBrowserUsername = event.currentTarget.value; setBrowserUsername(currentBrowserUsername); update({ browser: browser() }); }} /></label><label><span>密码</span><Input type="password" aria-label={`服务密码 ${props.index + 1}`} placeholder={props.deployment.browser?.passwordConfigured ? "留空以保留现有密码" : ""} value={browserPassword()} onInput={(event) => { currentBrowserPassword = event.currentTarget.value; setBrowserPassword(currentBrowserPassword); update({ browser: browser() }); }} /></label></div></Show>
      <Button type="text" shape="circle" icon={<Trash2 size={14} />} title={`删除部署${props.index + 1}`} aria-label={`删除部署${props.index + 1}`} onClick={props.onDelete} />
    </div>
  );
}

function ConfigurationView() {
  const [configuration, setConfiguration] = createSignal<Config>({ environments: [], capabilityCatalog: [], services: [] }, { ownedWrite: true });
  const [serviceOpen, setServiceOpen] = createSignal(false, { ownedWrite: true });
  const [serviceName, setServiceName] = createSignal("", { ownedWrite: true });
  const [description, setDescription] = createSignal("", { ownedWrite: true });
  const [serviceRepositories, setServiceRepositories] = createSignal<Array<{ id?: string; kind: RepositoryKind; url: string }>>([{ kind: "backend", url: "" }], { ownedWrite: true });
  const [serviceDeployments, setServiceDeployments] = createStore<ServiceDeploymentDraft[]>([]);
  let deploymentDrafts: ServiceDeploymentDraft[] = [];
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
  const dragDropManager = import.meta.env.MODE === "test" ? null : new DragDropManager();
  const moveService = async (sourceKey: string, targetIndex: number) => {
    const previous = configuration();
    const sourceIndex = previous.services.findIndex((service) => service.key === sourceKey);
    if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= previous.services.length || sourceIndex === targetIndex) return;
    const services = [...previous.services];
    const [moved] = services.splice(sourceIndex, 1);
    services.splice(targetIndex, 0, moved!);
    setConfiguration({ ...previous, services });
    try {
      await reorderServices(services.map((service) => service.key));
      setConfigurationError("");
    } catch (error) {
      setConfigurationError(error instanceof Error ? error.message : String(error));
      await refresh();
    }
  };
  const stopDragMonitor = dragDropManager?.monitor.addEventListener("dragend", ({ operation, canceled }) => {
    const source = operation.source;
    if (!canceled && isSortable(source) && source.initialIndex !== source.index) void moveService(String(source.id), source.index);
  });
  onCleanup(() => {
    stopDragMonitor?.();
    dragDropManager?.destroy();
  });
  const resetServiceForm = () => {
    deploymentDrafts = [];
    setServiceName(""); setDescription(""); setServiceRepositories([{ kind: "backend", url: "" }]); setServiceDeployments(() => []); setEditingServiceKey(null);
  };
  const openNewService = () => {
    resetServiceForm(); setConfigurationError(""); setServiceOpen(true);
  };
  const openServiceEditor = (service: Service) => {
    setEditingServiceKey(service.key);
    setServiceName(service.name); setDescription(service.description);
    setServiceRepositories(service.repositories.map((repository) => ({ id: repository.id, kind: repository.kind, url: repository.url })));
    deploymentDrafts = service.deployments.map((deployment) => ({
      environmentKey: configuration().environments.find((environment) => environment.id === deployment.environmentId)?.key ?? "",
      baseBranch: deployment.baseBranch,
      capabilities: [...deployment.capabilities],
      ...(deployment.sls ? { sls: { project: deployment.sls.project, logstores: [...deployment.sls.logstores] } } : {}),
      ...(deployment.browser ? { browser: { baseUrl: deployment.browser.baseUrl, username: deployment.browser.username ?? "", password: "", passwordConfigured: deployment.browser.passwordConfigured } } : {}),
    })).filter((deployment) => deployment.environmentKey);
    setServiceDeployments(() => deploymentDrafts.map(cloneDeploymentDraft));
    setConfigurationError(""); setServiceOpen(true);
  };
  const serviceRepositoriesValid = createMemo(() => serviceRepositories().length > 0 && serviceRepositories().every((repository) => repository.url.trim()) && new Set(serviceRepositories().map((repository) => repository.url.trim())).size === serviceRepositories().length);
  const serviceDeploymentsValid = () => deploymentDrafts.every((deployment) => deployment.environmentKey && deployment.baseBranch.trim() && (!deployment.capabilities.includes("sls_read") || Boolean(deployment.sls?.project.trim() && deployment.sls.logstores.length)) && (!deployment.capabilities.includes("browser_use") || Boolean(deployment.browser && validBrowserAddress(deployment.browser.baseUrl.trim()) && (!deployment.browser.username.trim() || deployment.browser.password || deployment.browser.passwordConfigured)))) && new Set(deploymentDrafts.map((deployment) => deployment.environmentKey)).size === deploymentDrafts.length;
  const serviceValidationError = () => {
    if (!serviceName().trim()) return "请填写服务名称";
    if (!serviceRepositories().length || serviceRepositories().some((repository) => !repository.url.trim())) return "请填写所有仓库地址";
    if (new Set(serviceRepositories().map((repository) => repository.url.trim())).size !== serviceRepositories().length) return "仓库地址不能重复";
    if (deploymentDrafts.some((deployment) => !deployment.environmentKey || !deployment.baseBranch.trim())) return "请填写所有部署环境和分支";
    if (new Set(deploymentDrafts.map((deployment) => deployment.environmentKey)).size !== deploymentDrafts.length) return "同一环境只能配置一个部署";
    const invalidSls = deploymentDrafts.findIndex((deployment) => deployment.capabilities.includes("sls_read") && !Boolean(deployment.sls?.project.trim() && deployment.sls.logstores.length));
    if (invalidSls >= 0) return `部署 ${invalidSls + 1} 的 SLS Project 和 Logstore 不能为空`;
    const invalidBrowserAddress = deploymentDrafts.findIndex((deployment) => deployment.capabilities.includes("browser_use") && !validBrowserAddress(deployment.browser?.baseUrl.trim() ?? ""));
    if (invalidBrowserAddress >= 0) return `部署 ${invalidBrowserAddress + 1} 的服务地址必须是完整的 HTTP 或 HTTPS 地址，不能包含查询参数或 # 片段`;
    const missingBrowserPassword = deploymentDrafts.findIndex((deployment) => deployment.capabilities.includes("browser_use") && Boolean(deployment.browser?.username.trim()) && !Boolean(deployment.browser?.password || deployment.browser?.passwordConfigured));
    if (missingBrowserPassword >= 0) return `部署 ${missingBrowserPassword + 1} 配置账号时必须填写密码`;
    return "";
  };
  const availableDeploymentEnvironments = createMemo(() => configuration().environments.filter((environment) => !serviceDeployments.some((deployment) => deployment.environmentKey === environment.key)));
  const addServiceDeployment = () => {
    const environment = availableDeploymentEnvironments()[0];
    if (environment) {
      const deployment = { environmentKey: environment.key, baseBranch: "main", capabilities: [] } satisfies ServiceDeploymentDraft;
      deploymentDrafts.push(deployment);
      setServiceDeployments((current) => [...current, cloneDeploymentDraft(deployment)]);
    }
  };
  const saveService = async () => {
    const validationError = serviceValidationError();
    if (validationError || !serviceRepositoriesValid() || !serviceDeploymentsValid()) { setConfigurationError(validationError || "服务配置不完整"); return; }
    setSaving(true); setConfigurationError("");
    try {
      const definition = {
        name: serviceName().trim(), description: description().trim(),
        repositories: serviceRepositories().map((repository) => ({ ...(repository.id ? { id: repository.id } : {}), kind: repository.kind, url: repository.url.trim() })),
        deployments: deploymentDrafts.map((deployment) => ({ environmentKey: deployment.environmentKey, baseBranch: deployment.baseBranch.trim(), capabilities: deployment.capabilities, ...(deployment.capabilities.includes("sls_read") && deployment.sls ? { sls: { project: deployment.sls.project.trim(), logstores: deployment.sls.logstores } } : {}), ...(deployment.capabilities.includes("browser_use") && deployment.browser ? { browser: { baseUrl: deployment.browser.baseUrl.trim(), username: deployment.browser.username.trim(), ...(deployment.browser.password ? { password: deployment.browser.password } : {}) } } : {}) })),
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
          <For each={configuration().services} fallback={<div class="empty-band">暂无服务</div>}>{(service, index) => (
            dragDropManager
              ? <SortableServiceEntry service={service} index={index()} selected={selectedServiceKey() === service.key} manager={dragDropManager} onSelect={() => setSelectedServiceKey(service.key)} />
              : <div class={`environment-entry sortable-service-entry${selectedServiceKey() === service.key ? " selected" : ""}`}><span class="service-drag-placeholder"><GripVertical size={15} /></span><button type="button" class="environment-item" aria-label={service.name} onClick={() => setSelectedServiceKey(service.key)}><span><strong>{service.name}</strong></span></button></div>
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
              <section class="service-detail-section"><div class="service-detail-heading"><h3>代码仓库</h3><span>{service().repositories.length} 个授权根目录</span></div><div class="detail-repositories"><div class="repository-detail-head"><span>角色</span><span>仓库地址</span></div><For each={service().repositories}>{(repository) => <div class="repository-detail-row"><GitBranch size={15} /><span class={`repository-kind ${repository.kind}`}>{repository.kind === "frontend" ? "前端" : "后端"}</span><code title={repository.url}>{repository.url}</code></div>}</For></div></section>
              <section class="service-detail-section"><div class="service-detail-heading"><h3>环境部署</h3><span>{service().deployments.length} 个环境</span></div><div class="deployment-detail-list"><For each={service().deployments} fallback={<div class="service-detail-empty">尚未配置环境部署</div>}>{(deployment) => { const environment = configuration().environments.find((item) => item.id === deployment.environmentId); return <div class="deployment-detail-row"><div class="deployment-detail-meta"><div class="deployment-environment-summary"><strong>{environment?.name ?? deployment.environmentId}</strong></div></div><div class="deployment-branch-summary"><span>分支</span><code>{deployment.baseBranch}</code></div><div class="deployment-detail-capabilities"><span>能力</span><div class="deployment-detail-capability-content"><Show when={deployment.capabilities.length} fallback={<span class="capability-empty">无外部能力</span>}><CapabilityDescriptions catalog={configuration().capabilityCatalog} keys={deployment.capabilities} /><Show when={deployment.sls}>{(scope) => <div class="deployment-sls-summary"><code>{scope().project}</code><span>{scope().logstores.join("、")}</span></div>}</Show><Show when={deployment.browser}>{(browser) => <div class="deployment-browser-summary"><code>{browser().baseUrl}</code><span>{browser().username || "未配置账号"}</span></div>}</Show></Show></div></div></div>; }}</For></div></section>
              <section class="service-detail-section"><div class="service-detail-heading"><h3>项目描述</h3></div><Show when={service().description.trim()} fallback={<div class="service-detail-empty">暂无项目描述</div>}><Markdown source={service().description} /></Show></section>
            </div>
          </>}
        </Show>
      </section>
      <Modal width={780} open={serviceOpen()} title={editingServiceKey() ? "编辑服务" : "添加服务"} okText={editingServiceKey() ? "保存" : "添加"} cancelText="取消" confirmLoading={saving()} onOk={() => { void saveService(); }} onCancel={() => setServiceOpen(false)}>
        <div class="service-form">
          <Show when={configurationError()}><div class="create-error" role="alert">{configurationError()}</div></Show>
          <label class="service-form-field"><span>服务名称</span><Input aria-label="服务名称" value={serviceName()} onInput={(event) => setServiceName(event.currentTarget.value)} /></label>
          <div class="service-form-section"><div class="service-form-section-header"><div><strong>代码仓库</strong><span>服务可以关联一个或多个 Git 仓库</span></div><Button icon={<Plus size={14} />} onClick={() => setServiceRepositories((current) => [...current, { kind: "backend", url: "" }])}>添加仓库</Button></div><div class="service-repository-editor"><For each={serviceRepositories()}>{(repository, index) => <ServiceRepositoryEditorRow index={index()} repository={repository} only={serviceRepositories().length === 1} onChange={(next) => setServiceRepositories((current) => { Object.assign(repository, next); return [...current]; })} onDelete={() => setServiceRepositories((current) => current.filter((item) => item !== repository))} />}</For></div></div>
          <div class="service-form-section"><div class="service-form-section-header"><div><strong>环境部署</strong><span>配置分支和 pi 按需使用的外部能力</span></div><Button icon={<Plus size={14} />} disabled={!availableDeploymentEnvironments().length} onClick={addServiceDeployment}>添加部署</Button></div><div class="service-deployment-editor"><For each={serviceDeployments} fallback={<div class="service-form-empty">尚未配置部署</div>}>{(deployment, index) => <ServiceDeploymentEditorRow index={index()} deployment={deployment} capabilityCatalog={configuration().capabilityCatalog} environmentOptions={() => configuration().environments.filter((environment) => environment.key === deployment.environmentKey || !serviceDeployments.some((item) => item !== deployment && item.environmentKey === environment.key))} onChange={(next) => { deploymentDrafts[index()] = cloneDeploymentDraft(next); setServiceDeployments((current) => { Object.assign(current[index()]!, next); }); }} onDelete={() => { deploymentDrafts.splice(index(), 1); setServiceDeployments((current) => current.filter((_, itemIndex) => itemIndex !== index())); }} />}</For></div></div>
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
  const [terminalExpanded, setTerminalExpanded] = createSignal(false, { ownedWrite: true });
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
            <div><strong>demo-owner</strong><small>本地工作区</small></div>
          </div>
        </Layout.Header>
        <Layout.Content class={`app-content${terminalExpanded() && view() === "issues" ? " terminal-expanded" : ""}${codeExpanded() && view() === "issues" ? " code-expanded" : ""}`}>
          <Show when={view() === "issues"} fallback={view() === "statistics" ? <Statistics /> : <ConfigurationView />}>
            <Show when={!codeExpanded()}><IssueQueue selectedId={selectedId()} userName="demo-owner" userSubject="demo-owner" refreshToken={issueRefreshToken()} onSelect={setSelectedId} /></Show>
            <Show when={!loading()} fallback={<main class="issue-loading"><Skeleton active paragraph={{ rows: 12 }} /></main>}>
              <Show when={issue()} fallback={<main class="issue-empty"><strong>{issueError() || "暂无工单"}</strong></main>}>
                {(current) => (
                  <>
                    <AgentWorkbench issue={current()} terminalExpanded={terminalExpanded()} codeExpanded={codeExpanded()} codeServerTarget={codeServerTarget()} onToggleTerminal={() => { setCodeExpanded(false); setCodeServerTarget(null); setTerminalExpanded((value) => !value); }} onCloseCode={() => { setCodeExpanded(false); setCodeServerTarget(null); }} onRefresh={refreshIssue} />
                    <Show when={!terminalExpanded() && !codeExpanded()}><IssueWorkspace issue={current()} onOpenCodeServer={(url) => { setTerminalExpanded(false); setCodeServerTarget(url); setCodeExpanded(true); }} onUpdated={async () => { await refreshIssue(current().id); setIssueRefreshToken((value) => value + 1); }} /></Show>
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
