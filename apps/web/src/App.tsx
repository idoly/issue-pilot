import {
  Badge,
  Button,
  ConfigProvider,
  Input,
  TextArea,
  Layout,
  Modal,
  Progress,
  Segmented,
  Select,
  Skeleton,
  Space,
  Tabs,
  Tag,
  theme,
} from "@idoly/ant-design-solid";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Copy,
  Database,
  ExternalLink,
  FileSearch,
  GitBranch,
  ListFilter,
  Maximize2,
  Minimize2,
  Paperclip,
  Pencil,
  Plus,
  Search,
  TerminalSquare,
  Trash2,
} from "./icons";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import type { FitAddon as XtermFitAddon } from "@xterm/addon-fit";
import DOMPurify from "dompurify";
import { marked } from "marked";

import { copyService, createEnvironment, createIssue, createService, deleteEnvironment, deleteService, getIssue, listIssues, loadConfiguration, loadPeople, piTerminalWebSocketUrl, requestPiTerminalTicket, updateEnvironment, updateIssue, updateService, uploadIssueAttachments, type ConfigEnvironment, type ConfigService, type Configuration, type IssueDetail, type IssuePriority, type IssueStatus, type IssueType, type Person } from "./api";
import "@xterm/xterm/css/xterm.css";
import "@idoly/ant-design-solid/base.css";
import "@idoly/ant-design-solid/badge/style.css";
import "@idoly/ant-design-solid/button/style.css";
import "@idoly/ant-design-solid/config-provider/style.css";
import "@idoly/ant-design-solid/input/style.css";
import "@idoly/ant-design-solid/layout/style.css";
import "@idoly/ant-design-solid/modal/style.css";
import "@idoly/ant-design-solid/progress/style.css";
import "@idoly/ant-design-solid/segmented/style.css";
import "@idoly/ant-design-solid/select/style.css";
import "@idoly/ant-design-solid/skeleton/style.css";
import "@idoly/ant-design-solid/space/style.css";
import "@idoly/ant-design-solid/tabs/style.css";
import "@idoly/ant-design-solid/tag/style.css";

const priorityColor: Record<IssuePriority, string> = { p0: "red", p1: "volcano", p2: "blue", p3: "default" };
const issueTypeLabel: Record<IssueType, string> = { incident: "缺陷修复", request: "临时需求", task: "数据处理", problem: "问题排查", question: "技术咨询", smart_analysis: "智能分析" };
const statusLabel: Record<IssueStatus, string> = {
  open: "待处理",
  in_progress: "处理中",
  pending: "等待中",
  resolved: "已解决",
  closed: "已关闭",
};
const statusBadge: Record<IssueStatus, "default" | "processing" | "warning" | "success"> = {
  open: "default",
  in_progress: "processing",
  pending: "warning",
  resolved: "success",
  closed: "default",
};

function relativeTime(value: string): string {
  const minutes = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`;
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function browserWorkspaceUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const url = new URL(value, window.location.href);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") url.hostname = window.location.hostname;
  return url.toString();
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
  const [configuration, setConfiguration] = createSignal<Configuration>({ environments: [], services: [] }, { ownedWrite: true });
  const [people, setPeople] = createSignal<Person[]>([], { ownedWrite: true });
  void loadConfiguration().then((value) => { setConfiguration(value); });
  void loadPeople().then((value) => { setPeople(value); });
  const [query, setQuery] = createSignal("", { ownedWrite: true });
  const [status, setStatus] = createSignal<string>("active", { ownedWrite: true });
  const [createOpen, setCreateOpen] = createSignal(false, { ownedWrite: true });
  const [title, setTitle] = createSignal("", { ownedWrite: true });
  const [description, setDescription] = createSignal("", { ownedWrite: true });
  const [service, setService] = createSignal<string[]>(["srm"], { ownedWrite: true });
  const [moduleIds, setModuleIds] = createSignal<string[]>([], { ownedWrite: true });
  const [environment, setEnvironment] = createSignal("production", { ownedWrite: true });
  const [priority, setPriority] = createSignal<IssuePriority>("p2", { ownedWrite: true });
  const [issueType, setIssueType] = createSignal<IssueType>("incident", { ownedWrite: true });
  const [assigneeSubject, setAssigneeSubject] = createSignal<string | null>(props.userSubject || null, { ownedWrite: true });
  const [ccSubjects, setCcSubjects] = createSignal<string[]>([], { ownedWrite: true });
  const [attachments, setAttachments] = createSignal<File[]>([], { ownedWrite: true });
  let attachmentInput: HTMLInputElement | undefined;
  const [saving, setSaving] = createSignal(false, { ownedWrite: true });
  const [createError, setCreateError] = createSignal("", { ownedWrite: true });
  const submitIssue = async () => {
    if (!title().trim() || !service().length) return;
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
        serviceKeys: service(),
        moduleIds: moduleIds(),
        environmentKey: environment(),
        reporter: props.userName,
      });
      await uploadIssueAttachments(issue.id, attachments());
      setIssues((current) => [issue, ...current.filter((item) => item.id !== issue.id)]);
      setCreateOpen(false);
      setTitle("");
      setDescription("");
      setModuleIds([]);
      setAttachments([]);
      props.onSelect(issue.id);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  const selectableModules = createMemo(() => configuration().services
    .filter((configuredService) => service().includes(configuredService.key))
    .flatMap((configuredService) => configuredService.modules.map((module) => ({ value: module.id, label: `${configuredService.name} · ${module.name}` }))));
  const filtered = createMemo(() => {
    const term = query().trim().toLowerCase();
    return issues().filter((issue) => {
      const statusMatch = status() === "all" || (status() === "active" && !["resolved", "closed"].includes(issue.status)) || issue.status === status();
      return statusMatch && (!term || `${issue.id} ${issue.title} ${issue.labels.join(" ")}`.toLowerCase().includes(term));
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
          onChange={(value) => setStatus(String(value))}
          options={[
            { value: "active", label: "活动工单" },
            { value: "open", label: "待处理" },
            { value: "in_progress", label: "处理中" },
            { value: "pending", label: "等待中" },
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
      <Modal open={createOpen()} title="新建工单" okText="创建" cancelText="取消" onOk={() => { void submitIssue(); }} onCancel={() => setCreateOpen(false)} confirmLoading={saving()} okButtonProps={{ disabled: !title().trim() || !service().length }}>
        <div class="create-issue-form">
          <label><span>环境</span><Select aria-label="工单环境" value={environment()} onChange={(value) => { setEnvironment(String(value)); setService([]); setModuleIds([]); }} options={configuration().environments.map((item) => ({ value: item.key, label: item.name }))} /></label>
          <label><span>服务（可多选）</span><Select mode="multiple" aria-label="工单服务" value={service()} onChange={(value) => { const keys = Array.isArray(value) ? value.map(String) : [String(value)]; setService(keys); const allowed = new Set(configuration().services.filter((item) => keys.includes(item.key)).flatMap((item) => item.modules.map((module) => module.id))); setModuleIds((current) => current.filter((id) => allowed.has(id))); }} options={configuration().services.filter((item) => item.environmentIds.includes(configuration().environments.find((item) => item.key === environment())?.id ?? "")).map((item) => ({ value: item.key, label: item.name }))} /></label>
          <Show when={selectableModules().length}><label><span>模块（可多选，不选表示整个服务）</span><Select mode="multiple" aria-label="工单模块" value={moduleIds()} onChange={(value) => setModuleIds(Array.isArray(value) ? value.map(String) : [String(value)])} options={selectableModules()} /></label></Show>
          <label><span>优先级</span><Select aria-label="工单优先级" value={priority()} onChange={(value) => setPriority(value as IssuePriority)} options={[{ value: "p0", label: "P0 · 紧急" }, { value: "p1", label: "P1 · 高" }, { value: "p2", label: "P2 · 中" }, { value: "p3", label: "P3 · 低" }]} /></label>
          <label><span>类型</span><Select aria-label="工单类型" value={issueType()} onChange={(value) => setIssueType(value as IssueType)} options={Object.entries(issueTypeLabel).map(([value, label]) => ({ value, label }))} /></label>
          <label><span>处理人</span><Select aria-label="工单处理人" value={assigneeSubject() ?? undefined} allowClear onChange={(value) => setAssigneeSubject(value ? String(value) : null)} options={people().map((person) => ({ value: person.subject, label: `${person.name}${person.email ? ` · ${person.email}` : ""}` }))} /></label>
          <label><span>抄送人（可多选）</span><Select mode="multiple" aria-label="工单抄送人" value={ccSubjects()} onChange={(value) => setCcSubjects(Array.isArray(value) ? value.map(String) : [String(value)])} options={people().filter((person) => person.subject !== assigneeSubject()).map((person) => ({ value: person.subject, label: `${person.name}${person.email ? ` · ${person.email}` : ""}` }))} /></label>
          <label><span>标题</span><Input aria-label="工单标题" value={title()} onInput={(event) => setTitle(event.currentTarget.value)} /></label>
          <label><span>描述</span><Input aria-label="工单描述" value={description()} onInput={(event) => setDescription(event.currentTarget.value)} /></label>
          <div class="attachment-picker">
            <input ref={attachmentInput} class="visually-hidden" type="file" multiple aria-label="选择附件" onChange={(event) => {
              const selected = Array.from(event.currentTarget.files ?? []);
              const oversized = selected.find((file) => file.size > 20 * 1024 * 1024);
              if (oversized) setCreateError(`${oversized.name} 超过 20 MB`);
              else if (attachments().length + selected.length > 10) setCreateError("每个工单最多上传 10 个文件");
              else { setAttachments((current) => [...current, ...selected]); setCreateError(""); }
              event.currentTarget.value = "";
            }} />
            <div class="attachment-picker-header"><span>附件</span><Button icon={<Paperclip size={14} />} onClick={() => attachmentInput?.click()}>添加附件</Button></div>
            <For each={attachments()}>{(file, index) => <div class="attachment-file"><span><strong>{file.name}</strong><small>{formatFileSize(file.size)}</small></span><Button type="text" shape="circle" icon={<Trash2 size={14} />} title={`移除${file.name}`} aria-label={`移除${file.name}`} onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index()))} /></div>}</For>
          </div>
          <Show when={createError()}><div class="create-error" role="alert">{createError()}</div></Show>
        </div>
      </Modal>
    </aside>
  );
}

function EvidencePanel(props: { issue: IssueDetail }) {
  const sourceIcon = (source: string) => {
    if (source === "sls") return <FileSearch size={16} />;
    if (source === "dms") return <Database size={16} />;
    return <GitBranch size={16} />;
  };
  return (
    <div class="evidence-list">
      <For each={props.issue.evidence} fallback={<div class="empty-band">暂无证据</div>}>
        {(evidence) => (
          <div class="evidence-row">
            <span class="evidence-source">{sourceIcon(evidence.source)} {evidence.source.toUpperCase()}</span>
            <span class="evidence-summary">{evidence.summary}</span>
            <time>{new Date(evidence.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>
          </div>
        )}
      </For>
    </div>
  );
}

function IssueWorkspace(props: { issue: IssueDetail; onOpenCodeServer: () => void; onUpdated: () => Promise<void> }) {
  const confidence = () => Math.round((props.issue.diagnosis.confidence ?? 0) * 100);
  const [editOpen, setEditOpen] = createSignal(false, { ownedWrite: true });
  const [editTitle, setEditTitle] = createSignal("", { ownedWrite: true });
  const [editDescription, setEditDescription] = createSignal("", { ownedWrite: true });
  const [editPriority, setEditPriority] = createSignal<IssuePriority>("p2", { ownedWrite: true });
  const [editType, setEditType] = createSignal<IssueType>("incident", { ownedWrite: true });
  const [editAssignee, setEditAssignee] = createSignal<string | null>(null, { ownedWrite: true });
  const [editCc, setEditCc] = createSignal<string[]>([], { ownedWrite: true });
  const [editServices, setEditServices] = createSignal<string[]>([], { ownedWrite: true });
  const [editModuleIds, setEditModuleIds] = createSignal<string[]>([], { ownedWrite: true });
  const [people, setPeople] = createSignal<Person[]>([], { ownedWrite: true });
  const [configuration, setConfiguration] = createSignal<Configuration>({ environments: [], services: [] }, { ownedWrite: true });
  const [editSaving, setEditSaving] = createSignal(false, { ownedWrite: true });
  const [editError, setEditError] = createSignal("", { ownedWrite: true });
  void loadPeople().then(setPeople);
  void loadConfiguration().then(setConfiguration);
  const openEditor = () => {
    setEditTitle(props.issue.title); setEditDescription(props.issue.description); setEditPriority(props.issue.priority); setEditType(props.issue.type);
    setEditAssignee(props.issue.assigneeSubject); setEditCc((props.issue.ccRecipients ?? []).map((person) => person.subject));
    setEditServices([...(props.issue.affectedServices ?? [])].sort((left, right) => Number(right.primary) - Number(left.primary)).map((service) => service.key));
    setEditModuleIds((props.issue.affectedModules ?? []).map((module) => module.id));
    setEditError(""); setEditOpen(true);
  };
  const saveIssue = async () => {
    if (!editTitle().trim() || !editServices().length) return;
    setEditSaving(true); setEditError("");
    try {
      await updateIssue(props.issue.id, { title: editTitle().trim(), description: editDescription().trim(), priority: editPriority(), type: editType(), serviceKeys: editServices(), moduleIds: editModuleIds(), assigneeSubject: editAssignee(), ccSubjects: editCc() });
      await props.onUpdated();
      setEditOpen(false);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
    } finally { setEditSaving(false); }
  };
  const editableModules = createMemo(() => configuration().services
    .filter((service) => editServices().includes(service.key))
    .flatMap((service) => service.modules.map((module) => ({ value: module.id, label: `${service.name} · ${module.name}` }))));
  const tabs = () => [
    {
      key: "diagnosis",
      label: "诊断",
      children: (
        <div class="diagnosis-grid">
          <div class="diagnosis-summary">
            <div class="section-label">结论</div>
            <div class="diagnosis-classification">
              <CircleDot size={18} />
              {props.issue.diagnosis.classification === "bug" ? "确认缺陷" : props.issue.diagnosis.classification}
            </div>
            <p>{props.issue.diagnosis.rootCause ?? "智能体正在综合日志、数据库与代码证据。"}</p>
          </div>
          <div class="confidence-meter">
            <div class="section-label">置信度</div>
            <strong>{confidence()}%</strong>
            <Progress percent={confidence()} showInfo={false} />
          </div>
        </div>
      ),
    },
    { key: "evidence", label: `证据 ${props.issue.evidence.length}`, children: <EvidencePanel issue={props.issue} /> },
    {
      key: "attachments",
      label: `附件 ${props.issue.attachments.length}`,
      children: (
        <div class="issue-attachment-list">
          <For each={props.issue.attachments} fallback={<div class="empty-band">暂无附件</div>}>
            {(attachment) => <div class="issue-attachment-row"><Paperclip size={15} /><span><strong>{attachment.fileName}</strong><small>{attachment.mediaType} · {formatFileSize(attachment.size)}</small></span><Tag>{attachment.scanStatus === "pending" ? "待扫描" : attachment.scanStatus}</Tag></div>}
          </For>
        </div>
      ),
    },
    {
      key: "tests",
      label: `测试 ${props.issue.testRuns.length}`,
      children: (
        <div class="test-list">
          <For each={props.issue.testRuns} fallback={<div class="empty-band">暂无测试记录</div>}>
            {(test) => (
              <div class="test-row">
                <CheckCircle2 size={17} class={test.status === "passed" ? "test-passed" : "test-failed"} />
                <span class="test-scope">{test.scope}</span>
                <span><strong>{test.summary}</strong><code>{test.command}</code></span>
              </div>
            )}
          </For>
        </div>
      ),
    },
  ];

  return (
    <section class="issue-workspace">
      <header class="issue-header">
        <div class="issue-heading">
          <div class="issue-heading-meta">
            <span>{props.issue.id}</span>
            <Tag color={priorityColor[props.issue.priority]}>{props.issue.priority.toUpperCase()}</Tag>
            <Tag>{issueTypeLabel[props.issue.type]}</Tag>
            <Badge status={statusBadge[props.issue.status]} text={statusLabel[props.issue.status]} />
          </div>
          <h1>{props.issue.title}</h1>
          <p>{props.issue.description}</p>
        </div>
        <Space>
          <Button icon={<Pencil size={15} />} onClick={openEditor}>编辑工单</Button>
          <Button
            type="primary"
            icon={<TerminalSquare size={16} />}
            disabled={!browserWorkspaceUrl(props.issue.workspace.url)}
            onClick={props.onOpenCodeServer}
          >
            打开 code-server
          </Button>
        </Space>
      </header>

      <div class="issue-facts">
        <div><span>创建人</span><strong>{props.issue.reporter?.name ?? "-"}</strong></div>
        <div><span>创建时间</span><strong>{new Date(props.issue.createdAt ?? props.issue.updatedAt).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</strong></div>
        <div><span>处理人</span><strong>{props.issue.assignee ?? "未分配"}</strong></div>
        <div><span>抄送人</span><strong>{props.issue.ccRecipients?.map((person) => person.name).join("、") || "无"}</strong></div>
        <div><span>服务</span><strong>{props.issue.affectedServices?.map((service) => service.name).join("、") || "-"}</strong></div>
        <div><span>模块</span><strong>{props.issue.affectedModules?.map((module) => `${module.serviceKey} · ${module.name}`).join("、") || "整个服务"}</strong></div>
        <div><span>仓库</span><strong>{props.issue.repositories.length}</strong></div>
        <div><span>Session</span><strong class={props.issue.agentSession ? "session-live" : ""}><Show when={props.issue.agentSession}><span /></Show>{props.issue.agentSession ? "已创建" : "等待创建"}</strong></div>
        <div><span>工作区</span><strong>{props.issue.workspace.status === "ready" ? "就绪" : props.issue.workspace.status === "preparing" ? "准备中" : props.issue.workspace.status === "running" ? "处理中" : props.issue.workspace.status === "failed" ? "失败" : props.issue.workspace.status}</strong></div>
      </div>
      <Show when={props.issue.workspace.lastError}><div class="workspace-error" role="alert">{props.issue.workspace.lastError}</div></Show>

      <section class="repository-band" aria-labelledby="repositories-title">
        <div class="band-title"><GitBranch size={16} /><h2 id="repositories-title">代码分支</h2></div>
        <div class="repository-list">
          <For each={props.issue.repositories} fallback={<span class="muted">尚未绑定仓库</span>}>
            {(repository) => (
              <div class="repository-row">
                <span class="repo-name">{repository.url.split(/[/:]/).at(-1)?.replace(/\.git$/, "")}</span>
                <code>{repository.baseBranch}</code>
                <span class="branch-arrow">→</span>
                <code>{repository.workingBranch ?? "尚未创建修复分支"}</code>
                <Button type="text" shape="circle" icon={<ExternalLink size={15} />} title="查看仓库" aria-label="查看仓库" />
              </div>
            )}
          </For>
        </div>
      </section>

      <Tabs defaultActiveKey="diagnosis" items={tabs()} />
      <Modal open={editOpen()} title="编辑工单" okText="保存" cancelText="取消" confirmLoading={editSaving()} okButtonProps={{ disabled: !editTitle().trim() || !editServices().length }} onOk={() => { void saveIssue(); }} onCancel={() => setEditOpen(false)}>
        <div class="create-issue-form">
          <label><span>服务（可多选）</span><Select mode="multiple" aria-label="编辑工单服务" value={editServices()} onChange={(value) => { const keys = Array.isArray(value) ? value.map(String) : [String(value)]; setEditServices(keys); const allowed = new Set(configuration().services.filter((service) => keys.includes(service.key)).flatMap((service) => service.modules.map((module) => module.id))); setEditModuleIds((current) => current.filter((id) => allowed.has(id))); }} options={configuration().services.filter((service) => service.environmentIds.includes(configuration().environments.find((environment) => environment.key === props.issue.environmentKey)?.id ?? "")).map((service) => ({ value: service.key, label: service.name }))} /></label>
          <Show when={editableModules().length}><label><span>模块（可多选，不选表示整个服务）</span><Select mode="multiple" aria-label="编辑工单模块" value={editModuleIds()} onChange={(value) => setEditModuleIds(Array.isArray(value) ? value.map(String) : [String(value)])} options={editableModules()} /></label></Show>
          <label><span>优先级</span><Select aria-label="编辑工单优先级" value={editPriority()} onChange={(value) => setEditPriority(value as IssuePriority)} options={[{ value: "p0", label: "P0 · 紧急" }, { value: "p1", label: "P1 · 高" }, { value: "p2", label: "P2 · 中" }, { value: "p3", label: "P3 · 低" }]} /></label>
          <label><span>类型</span><Select aria-label="编辑工单类型" value={editType()} onChange={(value) => setEditType(value as IssueType)} options={Object.entries(issueTypeLabel).map(([value, label]) => ({ value, label }))} /></label>
          <label><span>处理人</span><Select aria-label="编辑工单处理人" value={editAssignee() ?? undefined} allowClear onChange={(value) => setEditAssignee(value ? String(value) : null)} options={people().map((person) => ({ value: person.subject, label: `${person.name}${person.email ? ` · ${person.email}` : ""}` }))} /></label>
          <label><span>抄送人（可多选）</span><Select mode="multiple" aria-label="编辑工单抄送人" value={editCc()} onChange={(value) => setEditCc(Array.isArray(value) ? value.map(String) : [String(value)])} options={people().filter((person) => person.subject !== editAssignee()).map((person) => ({ value: person.subject, label: `${person.name}${person.email ? ` · ${person.email}` : ""}` }))} /></label>
          <label><span>标题</span><Input aria-label="编辑工单标题" value={editTitle()} onInput={(event) => setEditTitle(event.currentTarget.value)} /></label>
          <label><span>描述</span><TextArea aria-label="编辑工单描述" autoSize={{ minRows: 4, maxRows: 10 }} value={editDescription()} onInput={(event) => setEditDescription(event.currentTarget.value)} /></label>
          <Show when={editError()}><div class="create-error" role="alert">{editError()}</div></Show>
        </div>
      </Modal>
    </section>
  );
}

function AgentWorkbench(props: { issue: IssueDetail; terminalExpanded: boolean; codeExpanded: boolean; onToggleTerminal: () => void; onCloseCode: () => void; onRefresh: (issueId: string) => Promise<IssueDetail> }) {
  const agentRunning = () => props.issue.workspace.status === "preparing" || props.issue.workspace.status === "running";
  const codeServerUrl = () => browserWorkspaceUrl(props.issue.workspace.url);
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

function PiTerminal(props: { issue: IssueDetail; expanded: boolean; onToggleExpanded: () => void; onRefresh: (issueId: string) => Promise<IssueDetail> }) {
  type TerminalStatus = "waiting" | "connecting" | "open" | "closed" | "error";
  const fixtureTerminal = import.meta.env.MODE === "test";
  const [status, setStatus] = createSignal<TerminalStatus>(fixtureTerminal ? "open" : "waiting", { ownedWrite: true });
  const [terminalError, setTerminalError] = createSignal("", { ownedWrite: true });
  const [connectionMode, setConnectionMode] = createSignal<"live" | "pty">("pty", { ownedWrite: true });
  let terminalElement: HTMLDivElement | undefined;
  let terminal: XtermTerminal | undefined;
  let fitAddon: XtermFitAddon | undefined;
  let socket: WebSocket | undefined;
  let terminalHeartbeat: number | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let connectionSequence = 0;
  let mounted = false;
  let disposed = false;

  const runIsActive = () => props.issue.workspace.status === "preparing" || props.issue.workspace.status === "running";
  const statusText = () => {
    if (status() === "open") return connectionMode() === "live" ? "实时会话" : "已连接";
    if (status() === "connecting") return "连接中";
    if (status() === "error") return "连接失败";
    if (status() === "closed") return "已退出";
    return runIsActive() ? "等待当前处理完成" : "等待 Session";
  };
  const closeSocket = () => {
    connectionSequence += 1;
    if (terminalHeartbeat !== undefined) window.clearInterval(terminalHeartbeat);
    terminalHeartbeat = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "view changed");
    socket = undefined;
  };
  const writeStatus = (message: string) => {
    terminal?.write(`\r\n\x1b[38;5;244m${message}\x1b[0m\r\n`);
  };
  const terminalSnapshot = () => ({ issueId: props.issue.id, runActive: runIsActive(), sessionReady: Boolean(props.issue.agentSession) });
  const connect = async (snapshot = terminalSnapshot()) => {
    if (!mounted || fixtureTerminal || !terminal) return;
    closeSocket();
    terminal.reset();
    setTerminalError("");
    if (!snapshot.sessionReady) {
      setStatus("waiting");
      writeStatus("Waiting for the issue pi session...");
      return;
    }
    const issueId = snapshot.issueId;
    const sequence = ++connectionSequence;
    setStatus("connecting");
    writeStatus(`Opening pi session for ${issueId}...`);
    try {
      const ticket = await requestPiTerminalTicket(issueId);
      if (sequence !== connectionSequence) return;
      setConnectionMode(ticket.mode ?? "pty");
      const nextSocket = new WebSocket(piTerminalWebSocketUrl(issueId, ticket.ticket));
      socket = nextSocket;
      nextSocket.addEventListener("open", () => {
        if (sequence !== connectionSequence) return;
        setStatus("open");
        fitAddon?.fit();
        nextSocket.send(JSON.stringify({ type: "resize", cols: terminal!.cols, rows: terminal!.rows }));
        terminalHeartbeat = window.setInterval(() => {
          if (nextSocket.readyState === WebSocket.OPEN) nextSocket.send(JSON.stringify({ type: "heartbeat" }));
        }, 5_000);
        terminal!.focus();
      });
      nextSocket.addEventListener("message", (event) => {
        if (sequence !== connectionSequence) return;
        try {
          const message = JSON.parse(String(event.data)) as { type: "output"; data: string } | { type: "exit"; exitCode: number } | { type: "error"; error: string };
          if (message.type === "output") terminal!.write(message.data);
          else if (message.type === "exit") { setStatus("closed"); writeStatus(`pi exited with code ${message.exitCode}`); }
          else { setStatus("error"); setTerminalError(message.error); writeStatus(message.error); }
        } catch {
          setStatus("error");
          setTerminalError("terminal_protocol_error");
        }
      });
      nextSocket.addEventListener("close", () => {
        if (terminalHeartbeat !== undefined) window.clearInterval(terminalHeartbeat);
        terminalHeartbeat = undefined;
        if (sequence === connectionSequence && status() === "open") setStatus("closed");
      });
      nextSocket.addEventListener("error", () => {
        if (sequence !== connectionSequence) return;
        setStatus("error");
        setTerminalError("terminal_connection_failed");
      });
    } catch (error) {
      if (sequence !== connectionSequence) return;
      const message = error instanceof Error ? error.message : "terminal_connection_failed";
      setStatus(message === "pi_session_running" || message === "pi_session_not_ready" ? "waiting" : "error");
      setTerminalError(message);
      writeStatus(message);
    }
  };

  createEffect(
    terminalSnapshot,
    (snapshot) => {
      if (fixtureTerminal) setStatus(snapshot.runActive || !snapshot.sessionReady ? "waiting" : "open");
      else if (mounted) void connect(snapshot);
    },
  );
  queueMicrotask(() => { void (async () => {
    if (disposed) return;
    mounted = true;
    if (fixtureTerminal) return;
    const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-web-links"),
    ]);
    if (disposed) return;
    terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: '"SFMono-Regular", "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      letterSpacing: 0,
      lineHeight: 1.18,
      scrollback: 10_000,
      theme: { background: "#111714", foreground: "#d8e1dc", cursor: "#69d3ad", selectionBackground: "#315346", black: "#17201d", brightBlack: "#65736d", green: "#69d3ad", brightGreen: "#8be6c4", yellow: "#e0c36a", brightYellow: "#f0d883", blue: "#6ba8d9", brightBlue: "#8bc4ef", cyan: "#65c7c0", brightCyan: "#86ddd6", red: "#dd746c", brightRed: "#f08b83", magenta: "#bd8bd1", brightMagenta: "#d5a4e5", white: "#d8e1dc", brightWhite: "#f4f7f5" },
    });
    fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(terminalElement!);
    terminal.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data }));
    });
    resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(() => {
        if (!fitAddon || !terminal) return;
        fitAddon.fit();
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      });
    });
    resizeObserver.observe(terminalElement!);
    void connect();
  })(); });
  const statusPoll = window.setInterval(() => {
    if (!runIsActive() && props.issue.agentSession) return;
    void props.onRefresh(props.issue.id).catch(() => undefined);
  }, 2_000);
  onCleanup(() => {
    disposed = true;
    mounted = false;
    closeSocket();
    window.clearInterval(statusPoll);
    resizeObserver?.disconnect();
    terminal?.dispose();
  });

  return (
    <section class="pi-terminal-panel" aria-label={`${props.issue.id} pi 终端`}>
      <header class="pi-terminal-header">
        <div class="pi-terminal-title"><TerminalSquare size={17} /><span><strong>pi</strong><small>{props.issue.id}</small></span></div>
        <div class="pi-terminal-actions">
          <span class={`pi-terminal-status ${status()}`}><i />{statusText()}</span>
          <Show when={status() === "closed" || status() === "error"}>
            <Button type="text" size="small" onClick={() => { void connect(); }}>重连</Button>
          </Show>
          <Button type="text" shape="circle" icon={props.expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />} title={props.expanded ? "还原终端" : "放大终端"} aria-label={props.expanded ? "还原终端" : "放大终端"} onClick={props.onToggleExpanded} />
        </div>
      </header>
      <Show when={!fixtureTerminal} fallback={<pre class="pi-terminal-fixture" role="log">{`pi --session ${props.issue.id}\n\n${props.issue.piConversation?.map((message) => `${message.role === "user" ? ">" : "pi"} ${message.text.replace(/[#*_`]/g, "")}`).join("\n\n") ?? ""}\n\n> `}</pre>}>
        <div class="pi-terminal" ref={(element) => { terminalElement = element; }} onClick={() => terminal?.focus()} />
      </Show>
      <Show when={terminalError() && status() === "error"}><div class="pi-terminal-error" role="alert">{terminalError()}</div></Show>
    </section>
  );
}

function MarkdownDocument(props: { source: string }) {
  const html = createMemo(() => DOMPurify.sanitize(marked.parse(props.source || "暂无项目描述", { async: false }) as string));
  return <div class="markdown-document" innerHTML={html()} />;
}

function ConfigurationView() {
  const [configuration, setConfiguration] = createSignal<Configuration>({ environments: [], services: [] }, { ownedWrite: true });
  const [selectedEnvironment, setSelectedEnvironment] = createSignal("production", { ownedWrite: true });
  const [environmentOpen, setEnvironmentOpen] = createSignal(false, { ownedWrite: true });
  const [environmentName, setEnvironmentName] = createSignal("", { ownedWrite: true });
  const [serviceOpen, setServiceOpen] = createSignal(false, { ownedWrite: true });
  const [copyOpen, setCopyOpen] = createSignal(false, { ownedWrite: true });
  const [copySource, setCopySource] = createSignal<ConfigService | null>(null, { ownedWrite: true });
  const [copyName, setCopyName] = createSignal("", { ownedWrite: true });
  const [copyEnvironmentKey, setCopyEnvironmentKey] = createSignal("", { ownedWrite: true });
  const [serviceName, setServiceName] = createSignal("", { ownedWrite: true });
  const [description, setDescription] = createSignal("", { ownedWrite: true });
  const [repositoryUrl, setRepositoryUrl] = createSignal("", { ownedWrite: true });
  const [defaultBranch, setDefaultBranch] = createSignal("main", { ownedWrite: true });
  const [serviceModules, setServiceModules] = createSignal<Array<{ id?: string; name: string; path: string }>>([], { ownedWrite: true });
  const [relatedServices, setRelatedServices] = createSignal<string[]>([], { ownedWrite: true });
  const [relatedModuleIds, setRelatedModuleIds] = createSignal<string[]>([], { ownedWrite: true });
  const [serviceEnvironmentKey, setServiceEnvironmentKey] = createSignal("", { ownedWrite: true });
  const [editingEnvironmentKey, setEditingEnvironmentKey] = createSignal<string | null>(null, { ownedWrite: true });
  const [editingServiceKey, setEditingServiceKey] = createSignal<string | null>(null, { ownedWrite: true });
  const [selectedServiceKey, setSelectedServiceKey] = createSignal<string | null>(null, { ownedWrite: true });
  const [deleteTarget, setDeleteTarget] = createSignal<{ kind: "environment" | "service"; key: string; name: string } | null>(null, { ownedWrite: true });
  const [saving, setSaving] = createSignal(false, { ownedWrite: true });
  const [configurationError, setConfigurationError] = createSignal("", { ownedWrite: true });
  const refresh = async () => {
    try {
      setConfiguration(await loadConfiguration());
      setConfigurationError("");
    } catch (error) {
      setConfigurationError(error instanceof Error ? error.message : String(error));
    }
  };
  void refresh();
  const currentEnvironment = createMemo(() => configuration().environments.find((item) => item.key === selectedEnvironment()));
  const visibleServices = createMemo(() => {
    const environmentId = currentEnvironment()?.id;
    return configuration().services.filter((service) => environmentId && service.environmentIds.includes(environmentId));
  });
  const selectedService = createMemo(() => configuration().services.find((service) => service.key === selectedServiceKey()));
  const editingEnvironmentHasServices = createMemo(() => {
    const environment = configuration().environments.find((item) => item.key === editingEnvironmentKey());
    return Boolean(environment && configuration().services.some((service) => service.environmentIds.includes(environment.id)));
  });
  const openNewEnvironment = () => {
    setEditingEnvironmentKey(null); setEnvironmentName(""); setConfigurationError(""); setEnvironmentOpen(true);
  };
  const openEnvironmentEditor = (environment: ConfigEnvironment) => {
    setEditingEnvironmentKey(environment.key); setEnvironmentName(environment.name); setConfigurationError(""); setEnvironmentOpen(true);
  };
  const saveEnvironment = async () => {
    if (!environmentName().trim()) return;
    setSaving(true); setConfigurationError("");
    try {
      const editingKey = editingEnvironmentKey();
      if (editingKey) await updateEnvironment(editingKey, { name: environmentName().trim() });
      else {
        const created = await createEnvironment(environmentName().trim());
        setSelectedEnvironment(created.key);
      }
      await refresh();
      setEnvironmentOpen(false); setEnvironmentName(""); setEditingEnvironmentKey(null);
    } catch (error) {
      setConfigurationError(error instanceof Error ? error.message : String(error));
    } finally { setSaving(false); }
  };
  const resetServiceForm = () => {
    setServiceName(""); setDescription(""); setRepositoryUrl(""); setDefaultBranch("main"); setServiceModules([]); setRelatedServices([]); setRelatedModuleIds([]); setServiceEnvironmentKey(""); setEditingServiceKey(null);
  };
  const openNewService = () => {
    resetServiceForm(); setServiceEnvironmentKey(currentEnvironment()?.key ?? ""); setConfigurationError(""); setServiceOpen(true);
  };
  const openServiceEditor = (service: ConfigService) => {
    setEditingServiceKey(service.key);
    setServiceName(service.name); setDescription(service.description);
    setRepositoryUrl(service.repositories[0]?.url ?? ""); setDefaultBranch(service.repositories[0]?.defaultBranch ?? "main"); setServiceModules(service.modules.map((module) => ({ ...module })));
    setServiceEnvironmentKey(configuration().environments.find((environment) => service.environmentIds.includes(environment.id))?.key ?? "");
    setRelatedServices(configuration().services.filter((related) => service.relatedServiceIds.includes(related.id)).map((related) => related.key));
    setRelatedModuleIds([...service.relatedModuleIds]);
    setConfigurationError(""); setServiceOpen(true);
  };
  const copyTargetEnvironments = createMemo(() => {
    const source = copySource();
    return configuration().environments.filter((environment) => !source?.environmentIds.includes(environment.id));
  });
  const openCopyService = (service: ConfigService) => {
    const targets = configuration().environments.filter((environment) => !service.environmentIds.includes(environment.id));
    setCopySource(service);
    setCopyName(`${service.name} 副本`);
    setCopyEnvironmentKey(targets[0]?.key ?? "");
    setConfigurationError("");
    setCopyOpen(true);
  };
  const saveServiceCopy = async () => {
    const source = copySource();
    if (!source || !copyName().trim() || !copyEnvironmentKey()) return;
    setSaving(true); setConfigurationError("");
    try {
      const copied = await copyService(source.key, { name: copyName().trim(), targetEnvironmentKey: copyEnvironmentKey() });
      await refresh();
      setSelectedEnvironment(copyEnvironmentKey());
      setSelectedServiceKey(copied.key);
      setCopyOpen(false); setCopySource(null); setCopyName(""); setCopyEnvironmentKey("");
    } catch (error) {
      setConfigurationError(error instanceof Error ? error.message : String(error));
    } finally { setSaving(false); }
  };
  const serviceModulesValid = createMemo(() => serviceModules().every((module) => module.name.trim() && module.path.trim()));
  const saveService = async () => {
    if (!serviceName().trim() || !repositoryUrl().trim() || !serviceEnvironmentKey() || !serviceModulesValid()) return;
    setSaving(true); setConfigurationError("");
    try {
      const input = {
        name: serviceName().trim(), description: description().trim(),
        environmentKey: serviceEnvironmentKey(),
        repositories: [{ url: repositoryUrl().trim(), defaultBranch: defaultBranch().trim() || "main" }],
        modules: serviceModules().map((module) => ({ ...(module.id ? { id: module.id } : {}), name: module.name.trim(), path: module.path.trim() })),
        relatedServiceKeys: relatedServices(),
        relatedModuleIds: relatedModuleIds(),
      };
      const editingKey = editingServiceKey();
      if (editingKey) await updateService(editingKey, input);
      else await createService(input);
      await refresh();
      setServiceOpen(false); resetServiceForm();
    } catch (error) {
      setConfigurationError(error instanceof Error ? error.message : String(error));
    } finally { setSaving(false); }
  };
  const relatedModuleOptions = createMemo(() => {
    const relatedKeys = new Set(relatedServices());
    return configuration().services.filter((service) => relatedKeys.has(service.key)).flatMap((service) => service.modules.map((module) => ({ value: module.id, label: `${service.name} · ${module.name}` })));
  });
  const confirmDelete = async () => {
    const target = deleteTarget();
    if (!target) return;
    setSaving(true); setConfigurationError("");
    try {
      if (target.kind === "environment") {
        await deleteEnvironment(target.key);
        if (selectedEnvironment() === target.key) setSelectedEnvironment(configuration().environments.find((item) => item.key !== target.key)?.key ?? "");
      } else await deleteService(target.key);
      setDeleteTarget(null);
      await refresh();
    } catch (error) {
      setConfigurationError(error instanceof Error ? error.message : String(error));
    } finally { setSaving(false); }
  };
  return (
    <main class="configuration-workspace">
      <aside class="environment-panel">
        <div class="config-panel-title"><div><span>咸亨国际</span><h1>环境</h1></div><Button type="text" shape="circle" icon={<Plus size={16} />} title="添加环境" aria-label="添加环境" onClick={openNewEnvironment} /></div>
        <div class="environment-list">
          <For each={configuration().environments}>{(environment) => (
            <div class={`environment-entry${selectedEnvironment() === environment.key ? " selected" : ""}`}>
              <button type="button" class="environment-item" onClick={() => { setSelectedEnvironment(environment.key); setSelectedServiceKey(null); }}>
                <span><strong>{environment.name}</strong></span>
              </button>
              <Show when={environment.key !== "production" && environment.key !== "test"}>
                <Button type="text" shape="circle" icon={<Pencil size={14} />} title={`编辑${environment.name}`} aria-label={`编辑${environment.name}`} onClick={() => openEnvironmentEditor(environment)} />
              </Show>
            </div>
          )}</For>
        </div>
      </aside>
      <section class="service-panel">
        <Show when={selectedService()} fallback={(
          <>
            <header class="service-header"><div><span>组织环境</span><h2>{currentEnvironment()?.name ?? "环境"} · 服务</h2></div><Button type="primary" icon={<Plus size={15} />} onClick={openNewService}>添加服务</Button></header>
            <div class="service-list">
              <For each={visibleServices()} fallback={<div class="empty-band">当前环境暂无服务</div>}>
                {(service) => (
                  <article class="service-row">
                    <div class="service-main"><span><button type="button" class="service-detail-link" onClick={() => setSelectedServiceKey(service.key)}>{service.name}</button><span class="service-main-actions"><Button type="text" shape="circle" icon={<Copy size={14} />} title={`复制${service.name}`} aria-label={`复制${service.name}`} onClick={() => openCopyService(service)} /><Button type="text" shape="circle" icon={<Pencil size={14} />} title={`编辑${service.name}`} aria-label={`编辑${service.name}`} onClick={() => openServiceEditor(service)} /></span></span><p>{service.modules.length ? `${service.modules.length} 个模块` : "整个服务"}</p></div>
                    <div class="service-repositories"><For each={service.repositories} fallback={<span class="muted">尚未填写仓库</span>}>{(repository) => <div><GitBranch size={14} /><code>{repository.url}</code><Tag>{repository.defaultBranch}</Tag></div>}</For></div>
                  </article>
                )}
              </For>
            </div>
          </>
        )}>
          {(service) => (
            <>
              <header class="service-header"><div class="service-detail-heading"><Button type="text" shape="circle" icon={<ChevronLeft size={16} />} title="返回服务列表" aria-label="返回服务列表" onClick={() => setSelectedServiceKey(null)} /><div><span>服务详情</span><h2>{service().name}</h2></div></div><Space><Button icon={<Copy size={14} />} onClick={() => openCopyService(service())}>复制服务</Button><Button icon={<Pencil size={14} />} onClick={() => openServiceEditor(service())}>编辑服务</Button></Space></header>
              <div class="service-detail">
                <section class="service-detail-facts">
                  <div><span>所属环境</span><strong>{configuration().environments.find((environment) => service().environmentIds.includes(environment.id))?.name ?? "未配置"}</strong></div>
                  <div><span>关联服务</span><p>{configuration().services.filter((related) => service().relatedServiceIds.includes(related.id)).map((related) => related.name).join("、") || "无"}</p></div>
                  <div><span>关联模块</span><p>{configuration().services.flatMap((related) => related.modules.filter((module) => service().relatedModuleIds.includes(module.id)).map((module) => `${related.name} · ${module.name}`)).join("、") || "整个关联服务"}</p></div>
                </section>
                <section class="service-detail-section"><h3>代码仓库</h3><div class="detail-repositories"><For each={service().repositories}>{(repository) => <div><GitBranch size={15} /><code>{repository.url}</code><Tag>{repository.defaultBranch}</Tag></div>}</For></div></section>
                <section class="service-detail-section"><h3>模块</h3><div class="module-list"><For each={service().modules} fallback={<span class="muted">未拆分模块，工单将关联整个服务</span>}>{(module) => <div><strong>{module.name}</strong><code>{module.path}</code></div>}</For></div></section>
                <section class="service-detail-section"><h3>项目描述</h3><MarkdownDocument source={service().description} /></section>
              </div>
            </>
          )}
        </Show>
      </section>
      <Modal open={environmentOpen()} title={editingEnvironmentKey() ? "编辑环境" : "添加环境"} okText={editingEnvironmentKey() ? "保存" : "添加"} cancelText="取消" confirmLoading={saving()} onOk={() => { void saveEnvironment(); }} onCancel={() => setEnvironmentOpen(false)} okButtonProps={{ disabled: !environmentName().trim() }}>
        <div class="create-issue-form">
          <label><span>环境名称</span><Input aria-label="新环境名称" value={environmentName()} onInput={(event) => setEnvironmentName(event.currentTarget.value)} /></label>
          <Show when={editingEnvironmentKey() && editingEnvironmentKey() !== "production" && editingEnvironmentKey() !== "test" && !editingEnvironmentHasServices()}><div class="destructive-action"><Button danger icon={<Trash2 size={14} />} onClick={() => { setEnvironmentOpen(false); setDeleteTarget({ kind: "environment", key: editingEnvironmentKey()!, name: environmentName() }); }}>删除环境</Button></div></Show>
          <Show when={configurationError()}><div class="create-error" role="alert">{configurationError()}</div></Show>
        </div>
      </Modal>
      <Modal open={copyOpen()} title="复制服务" okText="复制" cancelText="取消" confirmLoading={saving()} onOk={() => { void saveServiceCopy(); }} onCancel={() => { setCopyOpen(false); setCopySource(null); setConfigurationError(""); }} okButtonProps={{ disabled: !copyName().trim() || !copyEnvironmentKey() }}>
        <div class="create-issue-form">
          <label><span>服务名称</span><Input aria-label="复制服务名称" value={copyName()} onInput={(event) => setCopyName(event.currentTarget.value)} /></label>
          <label><span>目标环境</span><Select aria-label="复制目标环境" value={copyEnvironmentKey()} onChange={(value) => setCopyEnvironmentKey(String(value))} options={copyTargetEnvironments().map((environment) => ({ value: environment.key, label: environment.name }))} /></label>
          <Show when={configurationError()}><div class="create-error" role="alert">{configurationError()}</div></Show>
        </div>
      </Modal>
      <Modal open={serviceOpen()} title={editingServiceKey() ? "编辑服务" : `在${currentEnvironment()?.name ?? "环境"}中添加服务`} okText={editingServiceKey() ? "保存" : "添加"} cancelText="取消" confirmLoading={saving()} onOk={() => { void saveService(); }} onCancel={() => setServiceOpen(false)} okButtonProps={{ disabled: !serviceName().trim() || !repositoryUrl().trim() || !serviceEnvironmentKey() || !serviceModulesValid() }}>
        <div class="create-issue-form">
          <label><span>服务名称</span><Input aria-label="服务名称" value={serviceName()} onInput={(event) => setServiceName(event.currentTarget.value)} /></label>
          <label><span>仓库地址</span><Input aria-label="仓库地址" placeholder="git@example.com:team/project.git" value={repositoryUrl()} onInput={(event) => setRepositoryUrl(event.currentTarget.value)} /></label>
          <label><span>默认分支</span><Input aria-label="默认分支" value={defaultBranch()} onInput={(event) => setDefaultBranch(event.currentTarget.value)} /></label>
          <div class="service-module-editor"><div class="service-module-editor-header"><span>模块（可选）</span><Button icon={<Plus size={14} />} onClick={() => setServiceModules((current) => [...current, { name: "", path: "" }])}>添加模块</Button></div><For each={serviceModules()}>{(module, index) => <div class="service-module-row"><Input aria-label={`模块名称 ${index() + 1}`} placeholder="订单模块" value={module.name} onInput={(event) => setServiceModules((current) => current.map((item, itemIndex) => itemIndex === index() ? { ...item, name: event.currentTarget.value } : item))} /><Input aria-label={`模块路径 ${index() + 1}`} placeholder="modules/order-service" value={module.path} onInput={(event) => setServiceModules((current) => current.map((item, itemIndex) => itemIndex === index() ? { ...item, path: event.currentTarget.value } : item))} /><Button type="text" shape="circle" icon={<Trash2 size={14} />} title={`删除模块${index() + 1}`} aria-label={`删除模块${index() + 1}`} onClick={() => setServiceModules((current) => current.filter((_, itemIndex) => itemIndex !== index()))} /></div>}</For></div>
          <label><span>关联服务（可多选）</span><Select mode="multiple" aria-label="关联服务" value={relatedServices()} onChange={(value) => { const keys = Array.isArray(value) ? value.map(String) : [String(value)]; setRelatedServices(keys); const allowed = new Set(configuration().services.filter((service) => keys.includes(service.key)).flatMap((service) => service.modules.map((module) => module.id))); setRelatedModuleIds((current) => current.filter((id) => allowed.has(id))); }} options={configuration().services.filter((service) => service.key !== editingServiceKey()).map((service) => ({ value: service.key, label: service.name }))} /></label>
          <Show when={relatedModuleOptions().length}><label><span>关联模块（可多选，不选表示整个关联服务）</span><Select mode="multiple" aria-label="关联模块" value={relatedModuleIds()} onChange={(value) => setRelatedModuleIds(Array.isArray(value) ? value.map(String) : [String(value)])} options={relatedModuleOptions()} /></label></Show>
          <label><span>项目描述（Markdown）</span><TextArea aria-label="项目描述" autoSize={{ minRows: 6, maxRows: 14 }} value={description()} onInput={(event) => setDescription(event.currentTarget.value)} /></label>
          <Show when={editingServiceKey()}><div class="destructive-action"><Button danger icon={<Trash2 size={14} />} onClick={() => { setServiceOpen(false); setDeleteTarget({ kind: "service", key: editingServiceKey()!, name: serviceName() }); }}>删除服务</Button></div></Show>
          <Show when={configurationError()}><div class="create-error" role="alert">{configurationError()}</div></Show>
        </div>
      </Modal>
      <Modal open={Boolean(deleteTarget())} title={`删除${deleteTarget()?.kind === "environment" ? "环境" : "服务"}`} okText="确认删除" cancelText="取消" confirmLoading={saving()} okButtonProps={{ danger: true }} onOk={() => { void confirmDelete(); }} onCancel={() => { setDeleteTarget(null); setConfigurationError(""); }}>
        <p>确定删除“{deleteTarget()?.name}”吗？已被工单使用的配置不能删除；环境仍有关联服务时也不能删除。</p>
        <Show when={configurationError()}><div class="create-error" role="alert">{configurationError()}</div></Show>
      </Modal>
    </main>
  );
}

function StatisticsView() {
  const projects = [
    { name: "commerce/order-api", count: 28 },
    { name: "commerce/web", count: 21 },
    { name: "approval/service", count: 14 },
    { name: "platform/ant-design-solid", count: 8 },
  ];
  const types = [
    { name: "缺陷 / incident", count: 31, color: "#c54b42" },
    { name: "需求 / request", count: 22, color: "#176b5b" },
    { name: "任务 / task", count: 13, color: "#356b9a" },
    { name: "问题 / question", count: 5, color: "#a67a2d" },
  ];
  return (
    <main class="statistics-workspace">
      <header class="statistics-header">
        <div><span>最近 30 天</span><h1>工单处理统计</h1></div>
        <Select aria-label="统计周期" defaultValue="30d" options={[{ value: "7d", label: "最近 7 天" }, { value: "30d", label: "最近 30 天" }, { value: "90d", label: "最近 90 天" }]} />
      </header>
      <section class="metric-strip" aria-label="核心指标">
        <div><span>提出工单</span><strong>71</strong><small>较上期 +8.4%</small></div>
        <div><span>已完成</span><strong>54</strong><small>完成率 76.1%</small></div>
        <div><span>平均处理</span><strong>18.6h</strong><small>中位数 11.2h</small></div>
        <div><span>P95 处理</span><strong>63.4h</strong><small>目标 72h 内</small></div>
        <div><span>当前未分配</span><strong>6</strong><small>其中 P1 2 个</small></div>
      </section>
      <div class="statistics-grid">
        <section class="statistics-section">
          <div class="statistics-title"><h2>项目工单量</h2><span>按关联仓库计数</span></div>
          <For each={projects}>{(project) => <div class="ranking-row"><span>{project.name}</span><div><i style={{ width: `${project.count / projects[0]!.count * 100}%` }} /></div><strong>{project.count}</strong></div>}</For>
        </section>
        <section class="statistics-section">
          <div class="statistics-title"><h2>工单类型</h2><span>共 71 个</span></div>
          <For each={types}>{(type) => <div class="type-row"><i style={{ background: type.color }} /><span>{type.name}</span><strong>{type.count}</strong><small>{Math.round(type.count / 71 * 100)}%</small></div>}</For>
        </section>
        <section class="statistics-section assignee-section">
          <div class="statistics-title"><h2>个人处理情况</h2><span>按当前处理人</span></div>
          <div class="assignee-table">
            <div class="assignee-head"><span>处理人</span><span>完成</span><span>处理中</span><span>平均时长</span></div>
            <For each={[["陈默", "14", "3", "12.8h"], ["林栩", "11", "2", "16.3h"], ["周宁", "9", "4", "21.7h"], ["未分配", "0", "6", "-"]] as const}>
              {(row) => <div><strong>{row[0]}</strong><span>{row[1]}</span><span>{row[2]}</span><span>{row[3]}</span></div>}
            </For>
          </div>
        </section>
      </div>
    </main>
  );
}

export interface AppProps {
  user?: { subject?: string; name: string; email: string };
  onLogout?: () => void;
}

export function App(props: AppProps = {}) {
  const [view, setView] = createSignal<"issues" | "statistics" | "configuration">("issues", { ownedWrite: true });
  const [selectedId, setSelectedId] = createSignal("", { ownedWrite: true });
  const [issue, setIssue] = createSignal<IssueDetail | null>(null, { ownedWrite: true });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [issueError, setIssueError] = createSignal("", { ownedWrite: true });
  const [issueRefreshToken, setIssueRefreshToken] = createSignal(0, { ownedWrite: true });
  const [terminalExpanded, setTerminalExpanded] = createSignal(false, { ownedWrite: true });
  const [codeExpanded, setCodeExpanded] = createSignal(false, { ownedWrite: true });
  let request = 0;
  createEffect(
    () => selectedId(),
    (id) => {
      const currentRequest = ++request;
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
          <div class="brand"><span>IP</span><strong>工单智研</strong></div>
          <div class="header-context">
            <Segmented
              aria-label="工作台视图"
              size="small"
              value={view()}
              options={[{ value: "issues", label: "工单" }, { value: "statistics", label: "统计" }, { value: "configuration", label: "配置" }]}
              onChange={(value) => setView(value as "issues" | "statistics" | "configuration")}
            />
            <span class="environment">生产</span>
          </div>
          <button type="button" class="identity identity-button" onClick={props.onLogout} title="退出登录">
            <span>{(props.user?.name ?? "严欣").slice(0, 2)}</span>
            <div><strong>{props.user?.name ?? "严欣"}</strong><small>{props.user?.email ?? "694590014@qq.com"}</small></div>
          </button>
        </Layout.Header>
        <Layout.Content class={`app-content${terminalExpanded() && view() === "issues" ? " terminal-expanded" : ""}${codeExpanded() && view() === "issues" ? " code-expanded" : ""}`}>
          <Show when={view() === "issues"} fallback={view() === "statistics" ? <StatisticsView /> : <ConfigurationView />}>
            <Show when={!codeExpanded()}><IssueQueue selectedId={selectedId()} userName={props.user?.name ?? "严欣"} userSubject={props.user?.subject ?? "fixture-user"} refreshToken={issueRefreshToken()} onSelect={setSelectedId} /></Show>
            <Show when={!loading()} fallback={<main class="issue-loading"><Skeleton active paragraph={{ rows: 12 }} /></main>}>
              <Show when={issue()} fallback={<main class="issue-empty"><strong>{issueError() || "暂无工单"}</strong></main>}>
                {(current) => (
                  <>
                    <AgentWorkbench issue={current()} terminalExpanded={terminalExpanded()} codeExpanded={codeExpanded()} onToggleTerminal={() => { setCodeExpanded(false); setTerminalExpanded((value) => !value); }} onCloseCode={() => setCodeExpanded(false)} onRefresh={refreshIssue} />
                    <Show when={!terminalExpanded() && !codeExpanded()}><IssueWorkspace issue={current()} onOpenCodeServer={() => { setTerminalExpanded(false); setCodeExpanded(true); }} onUpdated={async () => { await refreshIssue(current().id); setIssueRefreshToken((value) => value + 1); }} /></Show>
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
