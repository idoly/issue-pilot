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
  Bot,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDot,
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
  Send,
  Square,
  TerminalSquare,
  Trash2,
} from "./icons";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import DOMPurify from "dompurify";
import { marked } from "marked";

import { abortPiPrompt, createEnvironment, createIssue, createService, deleteEnvironment, deleteService, getIssue, listIssues, loadConfiguration, loadPeople, sendPiPrompt, streamIssueAgentEvents, updateEnvironment, updateIssue, updateService, uploadIssueAttachments, type ConfigEnvironment, type ConfigService, type Configuration, type IssueDetail, type IssuePriority, type IssueStatus, type IssueType, type Person } from "./api";
import "@idoly/ant-design-solid/base.css";
import "@idoly/ant-design-solid/badge/style.css";
import "@idoly/ant-design-solid/button/style.css";
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

function IssueQueue(props: {
  selectedId: string;
  userName: string;
  userSubject: string;
  refreshToken: number;
  onSelect: (id: string) => void;
}) {
  const [issues, setIssues] = createSignal<Awaited<ReturnType<typeof listIssues>>>([], { ownedWrite: true });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  createEffect(() => props.refreshToken, () => {
    setLoading(true);
    void listIssues().then(setIssues).finally(() => setLoading(false));
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
        environmentKey: environment(),
        reporter: props.userName,
      });
      await uploadIssueAttachments(issue.id, attachments());
      setIssues((current) => [issue, ...current.filter((item) => item.id !== issue.id)]);
      setCreateOpen(false);
      setTitle("");
      setDescription("");
      setAttachments([]);
      props.onSelect(issue.id);
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
      </div>
      <Modal open={createOpen()} title="新建工单" okText="创建" cancelText="取消" onOk={() => { void submitIssue(); }} onCancel={() => setCreateOpen(false)} confirmLoading={saving()} okButtonProps={{ disabled: !title().trim() || !service().length }}>
        <div class="create-issue-form">
          <label><span>环境</span><Select aria-label="工单环境" value={environment()} onChange={(value) => { setEnvironment(String(value)); setService([]); }} options={configuration().environments.map((item) => ({ value: item.key, label: item.name }))} /></label>
          <label><span>服务（可多选）</span><Select mode="multiple" aria-label="工单服务" value={service()} onChange={(value) => setService(Array.isArray(value) ? value.map(String) : [String(value)])} options={configuration().services.filter((item) => item.environmentIds.includes(configuration().environments.find((item) => item.key === environment())?.id ?? "")).map((item) => ({ value: item.key, label: item.name }))} /></label>
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

function IssueWorkspace(props: { issue: IssueDetail; onUpdated: () => Promise<void> }) {
  const confidence = () => Math.round((props.issue.diagnosis.confidence ?? 0) * 100);
  const [editOpen, setEditOpen] = createSignal(false, { ownedWrite: true });
  const [editTitle, setEditTitle] = createSignal("", { ownedWrite: true });
  const [editDescription, setEditDescription] = createSignal("", { ownedWrite: true });
  const [editPriority, setEditPriority] = createSignal<IssuePriority>("p2", { ownedWrite: true });
  const [editType, setEditType] = createSignal<IssueType>("incident", { ownedWrite: true });
  const [editAssignee, setEditAssignee] = createSignal<string | null>(null, { ownedWrite: true });
  const [editCc, setEditCc] = createSignal<string[]>([], { ownedWrite: true });
  const [editServices, setEditServices] = createSignal<string[]>([], { ownedWrite: true });
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
    setEditError(""); setEditOpen(true);
  };
  const saveIssue = async () => {
    if (!editTitle().trim() || !editServices().length) return;
    setEditSaving(true); setEditError("");
    try {
      await updateIssue(props.issue.id, { title: editTitle().trim(), description: editDescription().trim(), priority: editPriority(), type: editType(), serviceKeys: editServices(), assigneeSubject: editAssignee(), ccSubjects: editCc() });
      await props.onUpdated();
      setEditOpen(false);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
    } finally { setEditSaving(false); }
  };
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
            disabled={!props.issue.workspace.url}
            onClick={() => props.issue.workspace.url && window.open(props.issue.workspace.url, "_blank", "noopener")}
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
          <label><span>服务（可多选）</span><Select mode="multiple" aria-label="编辑工单服务" value={editServices()} onChange={(value) => setEditServices(Array.isArray(value) ? value.map(String) : [String(value)])} options={configuration().services.filter((service) => service.environmentIds.includes(configuration().environments.find((environment) => environment.key === props.issue.environmentKey)?.id ?? "")).map((service) => ({ value: service.key, label: service.name }))} /></label>
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

function AgentThread(props: { issue: IssueDetail; expanded: boolean; onToggleExpanded: () => void; onRefresh: (issueId: string) => Promise<IssueDetail> }) {
  const [message, setMessage] = createSignal("", { ownedWrite: true });
  const [sending, setSending] = createSignal(false, { ownedWrite: true });
  const [aborting, setAborting] = createSignal(false, { ownedWrite: true });
  const [sendError, setSendError] = createSignal("", { ownedWrite: true });
  const [streamActive, setStreamActive] = createSignal(false, { ownedWrite: true });
  const [streamedAnswer, setStreamedAnswer] = createSignal("", { ownedWrite: true });
  const [pendingUserMessages, setPendingUserMessages] = createSignal<string[]>([], { ownedWrite: true });
  let sendSequence = 0;
  let streamController: AbortController | undefined;
  let threadMessagesElement: HTMLDivElement | undefined;
  let followLatest = true;
  const runIsActive = () => props.issue.workspace.status === "preparing" || props.issue.workspace.status === "running";
  const processing = () => sending() || runIsActive() || streamActive();
  createEffect(
    () => props.issue.id,
    (issueId) => {
      streamController?.abort();
      const controller = new AbortController();
      streamController = controller;
      setStreamActive(false);
      setStreamedAnswer("");
      setPendingUserMessages([]);
      followLatest = true;
      const connect = async () => {
        while (!controller.signal.aborted) {
          try {
            await streamIssueAgentEvents(issueId, (event) => {
              if (event.kind === "status" || event.kind === "response_start") setStreamActive(true);
              if (event.kind === "response_start") setStreamedAnswer("");
              if (event.kind === "assistant_delta") setStreamedAnswer((current) => current + event.message);
              if (event.kind === "complete" || event.kind === "error") {
                setStreamActive(false);
                void props.onRefresh(issueId).finally(() => setStreamedAnswer(""));
              }
            }, controller.signal);
          } catch (error) {
            if (controller.signal.aborted) return;
          }
          if (!controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      };
      void connect();
    },
  );
  createEffect(
    () => `${props.issue.id}:${props.issue.piConversation?.length ?? 0}:${streamedAnswer().length}:${pendingUserMessages().length}`,
    () => {
      if (!followLatest) return;
      queueMicrotask(() => threadMessagesElement?.scrollTo?.({ top: threadMessagesElement.scrollHeight }));
    },
  );
  const statusPoll = window.setInterval(() => {
    if (sending() || !runIsActive()) return;
    void props.onRefresh(props.issue.id).then((refreshed) => {
      if (refreshed.workspace.status === "failed") setSendError(refreshed.workspace.lastError || "智能体处理失败");
    }).catch(() => undefined);
  }, 2_000);
  onCleanup(() => { sendSequence += 1; streamController?.abort(); window.clearInterval(statusPoll); });
  const threadMessages = () => {
    const conversation = props.issue.piConversation ?? [];
    const persisted = conversation.map((item) => ({ role: item.role === "assistant" ? "agent" as const : "user" as const, text: item.text }));
    const persistedUserCounts = new Map<string, number>();
    for (const item of conversation) if (item.role === "user") persistedUserCounts.set(item.text, (persistedUserCounts.get(item.text) ?? 0) + 1);
    const pending = pendingUserMessages().filter((text) => {
      const persistedCount = persistedUserCounts.get(text) ?? 0;
      if (!persistedCount) return true;
      persistedUserCounts.set(text, persistedCount - 1);
      return false;
    });
    return [...persisted, ...pending.map((text) => ({ role: "user" as const, text }))];
  };
  const send = async () => {
    const text = message().trim();
    if (!text || sending()) return;
    const issueId = props.issue.id;
    const sequence = ++sendSequence;
    setSending(true);
    setSendError("");
    try {
      await sendPiPrompt(issueId, text);
      setPendingUserMessages((current) => [...current, text]);
      setMessage("");
      void props.onRefresh(issueId);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "消息发送失败");
    } finally {
      if (sequence === sendSequence) setSending(false);
    }
  };

  const stop = async () => {
    if (aborting()) return;
    setAborting(true);
    setSendError("");
    try {
      await abortPiPrompt(props.issue.id);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "停止 pi 失败");
    } finally {
      setAborting(false);
    }
  };

  return (
    <aside class="agent-thread" aria-label={`${props.issue.id} 对话`}>
      <header class="agent-header">
        <span class="agent-mark"><Bot size={17} /></span>
        <div class="agent-identity"><strong>工单智能体</strong><span><i /> {processing() ? "智能体回复中" : "Session 已保存"}</span></div>
        <div class="agent-header-actions">
          <Show when={processing()}>
            <Button type="text" shape="circle" danger icon={<Square size={14} />} title="停止当前 pi 处理" aria-label="停止当前 pi 处理" loading={aborting()} onClick={() => { void stop(); }} />
          </Show>
          <Button
            type="text"
            shape="circle"
            icon={props.expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            title={props.expanded ? "还原对话" : "放大对话"}
            aria-label={props.expanded ? "还原对话" : "放大对话"}
            onClick={props.onToggleExpanded}
          />
        </div>
      </header>
      <div
        class="thread-messages"
        aria-live="polite"
        ref={(element) => { threadMessagesElement = element; }}
        onScroll={(event) => {
          const element = event.currentTarget;
          followLatest = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}
      >
        <For each={threadMessages()} fallback={<Show when={!processing()}><div class="empty-band">智能体尚未返回消息</div></Show>}>
          {(item) => (
            <div class={`thread-message ${item.role}`}>
              <span>{item.role === "agent" ? "AI" : "我"}</span>
              <MarkdownMessage source={item.text} />
            </div>
          )}
        </For>
        <Show when={streamedAnswer()}>
          <div class="thread-message agent streaming-answer" aria-live="polite">
            <span>AI</span>
            <MarkdownMessage source={streamedAnswer()} />
          </div>
        </Show>
        <Show when={processing() && !streamedAnswer()}>
          <div class="thread-message agent agent-processing" role="status" aria-label="智能体正在分析">
            <span>AI</span>
            <div class="message-content"><strong>智能体正在分析</strong><span class="typing-dots" aria-hidden="true"><i /><i /><i /></span></div>
          </div>
        </Show>
      </div>
      <Show when={sendError()}><div class="agent-chat-error" role="alert">{sendError()}</div></Show>
      <div class="agent-input">
        <Input
          aria-label="发送消息"
          placeholder="继续分析或处理工单"
          value={message()}
          onInput={(event) => setMessage(event.currentTarget.value)}
          onPressEnter={send}
          disabled={sending()}
          suffix={
            <Button
              type="text"
              shape="circle"
              icon={<Send size={16} />}
              title="发送"
              aria-label="发送"
              loading={sending()}
              disabled={sending() || !message().trim()}
              onClick={() => { void send(); }}
            />
          }
        />
      </div>
    </aside>
  );
}

function MarkdownMessage(props: { source: string }) {
  const html = createMemo(() => DOMPurify.sanitize(marked.parse(props.source, { async: false }) as string));
  return <div class="message-content markdown-message" innerHTML={html()} />;
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
  const [serviceName, setServiceName] = createSignal("", { ownedWrite: true });
  const [description, setDescription] = createSignal("", { ownedWrite: true });
  const [repositoryUrl, setRepositoryUrl] = createSignal("", { ownedWrite: true });
  const [defaultBranch, setDefaultBranch] = createSignal("main", { ownedWrite: true });
  const [relatedServices, setRelatedServices] = createSignal<string[]>([], { ownedWrite: true });
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
    setServiceName(""); setDescription(""); setRepositoryUrl(""); setDefaultBranch("main"); setRelatedServices([]); setServiceEnvironmentKey(""); setEditingServiceKey(null);
  };
  const openNewService = () => {
    resetServiceForm(); setServiceEnvironmentKey(currentEnvironment()?.key ?? ""); setConfigurationError(""); setServiceOpen(true);
  };
  const openServiceEditor = (service: ConfigService) => {
    setEditingServiceKey(service.key);
    setServiceName(service.name); setDescription(service.description);
    setRepositoryUrl(service.repositories[0]?.url ?? ""); setDefaultBranch(service.repositories[0]?.defaultBranch ?? "main");
    setServiceEnvironmentKey(configuration().environments.find((environment) => service.environmentIds.includes(environment.id))?.key ?? "");
    setRelatedServices(configuration().services.filter((related) => service.relatedServiceIds.includes(related.id)).map((related) => related.key));
    setConfigurationError(""); setServiceOpen(true);
  };
  const saveService = async () => {
    if (!serviceName().trim() || !repositoryUrl().trim() || !serviceEnvironmentKey()) return;
    setSaving(true); setConfigurationError("");
    try {
      const input = {
        name: serviceName().trim(), description: description().trim(),
        environmentKey: serviceEnvironmentKey(),
        repositories: [{ url: repositoryUrl().trim(), defaultBranch: defaultBranch().trim() || "main" }],
        relatedServiceKeys: relatedServices(),
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
                    <div class="service-main"><span><button type="button" class="service-detail-link" onClick={() => setSelectedServiceKey(service.key)}>{service.name}</button><Button type="text" shape="circle" icon={<Pencil size={14} />} title={`编辑${service.name}`} aria-label={`编辑${service.name}`} onClick={() => openServiceEditor(service)} /></span></div>
                    <div class="service-repositories"><For each={service.repositories} fallback={<span class="muted">尚未填写仓库</span>}>{(repository) => <div><GitBranch size={14} /><code>{repository.url}</code><Tag>{repository.defaultBranch}</Tag></div>}</For></div>
                  </article>
                )}
              </For>
            </div>
          </>
        )}>
          {(service) => (
            <>
              <header class="service-header"><div class="service-detail-heading"><Button type="text" shape="circle" icon={<ChevronLeft size={16} />} title="返回服务列表" aria-label="返回服务列表" onClick={() => setSelectedServiceKey(null)} /><div><span>服务详情</span><h2>{service().name}</h2></div></div><Button icon={<Pencil size={14} />} onClick={() => openServiceEditor(service())}>编辑服务</Button></header>
              <div class="service-detail">
                <section class="service-detail-facts">
                  <div><span>所属环境</span><strong>{configuration().environments.find((environment) => service().environmentIds.includes(environment.id))?.name ?? "未配置"}</strong></div>
                  <div><span>关联服务</span><p>{configuration().services.filter((related) => service().relatedServiceIds.includes(related.id)).map((related) => related.name).join("、") || "无"}</p></div>
                </section>
                <section class="service-detail-section"><h3>代码仓库</h3><div class="detail-repositories"><For each={service().repositories}>{(repository) => <div><GitBranch size={15} /><code>{repository.url}</code><Tag>{repository.defaultBranch}</Tag></div>}</For></div></section>
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
      <Modal open={serviceOpen()} title={editingServiceKey() ? "编辑服务" : `在${currentEnvironment()?.name ?? "环境"}中添加服务`} okText={editingServiceKey() ? "保存" : "添加"} cancelText="取消" confirmLoading={saving()} onOk={() => { void saveService(); }} onCancel={() => setServiceOpen(false)} okButtonProps={{ disabled: !serviceName().trim() || !repositoryUrl().trim() || !serviceEnvironmentKey() }}>
        <div class="create-issue-form">
          <label><span>服务名称</span><Input aria-label="服务名称" value={serviceName()} onInput={(event) => setServiceName(event.currentTarget.value)} /></label>
          <label><span>仓库地址</span><Input aria-label="仓库地址" placeholder="git@example.com:team/project.git" value={repositoryUrl()} onInput={(event) => setRepositoryUrl(event.currentTarget.value)} /></label>
          <label><span>默认分支</span><Input aria-label="默认分支" value={defaultBranch()} onInput={(event) => setDefaultBranch(event.currentTarget.value)} /></label>
          <label><span>关联服务（可多选）</span><Select mode="multiple" aria-label="关联服务" value={relatedServices()} onChange={(value) => setRelatedServices(Array.isArray(value) ? value.map(String) : [String(value)])} options={configuration().services.filter((service) => service.key !== editingServiceKey()).map((service) => ({ value: service.key, label: service.name }))} /></label>
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
  const [selectedId, setSelectedId] = createSignal("ISSUE-0042", { ownedWrite: true });
  const [issue, setIssue] = createSignal<IssueDetail | null>(null, { ownedWrite: true });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [issueRefreshToken, setIssueRefreshToken] = createSignal(0, { ownedWrite: true });
  const [agentExpanded, setAgentExpanded] = createSignal(false, { ownedWrite: true });
  let request = 0;
  createEffect(
    () => selectedId(),
    (id) => {
      const currentRequest = ++request;
      setLoading(true);
      void getIssue(id).then((value) => {
        if (currentRequest === request) setIssue(value);
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
        <Layout.Content class={`app-content${agentExpanded() && view() === "issues" ? " agent-expanded" : ""}`}>
          <Show when={view() === "issues"} fallback={view() === "statistics" ? <StatisticsView /> : <ConfigurationView />}>
            <IssueQueue selectedId={selectedId()} userName={props.user?.name ?? "严欣"} userSubject={props.user?.subject ?? "fixture-user"} refreshToken={issueRefreshToken()} onSelect={setSelectedId} />
            <Show when={!loading() && issue()} fallback={<main class="issue-loading"><Skeleton active paragraph={{ rows: 12 }} /></main>}>
              {(current) => (
                <>
                  <Show when={!agentExpanded()}><IssueWorkspace issue={current()} onUpdated={async () => { await refreshIssue(current().id); setIssueRefreshToken((value) => value + 1); }} /></Show>
                  <AgentThread issue={current()} expanded={agentExpanded()} onToggleExpanded={() => setAgentExpanded((value) => !value)} onRefresh={refreshIssue} />
                </>
              )}
            </Show>
          </Show>
        </Layout.Content>
      </Layout>
    </ConfigProvider>
  );
}
