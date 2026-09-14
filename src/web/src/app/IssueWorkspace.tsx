import { Badge, Button, Input, Modal, Segmented, Select, Tag, TextArea } from "@idoly/ant-design-solid";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

import { issuePilotConfig } from "../../../../issue-pilot.config.ts";
import { CheckCircle2, Code2, Download, Eye, GitBranch, MessageSquare, Paperclip, Pencil, RefreshCw, Send } from "../ui/icons";
import { addIssueComment, attachmentUrl, convertIssueToDevelopment, errorMessage, isWorkspaceBusy, retryIssue, updateIssue, updateIssueStatus, type IssueDetail, type IssuePriority, type IssueType } from "../data/client";
import { Markdown } from "../ui/Markdown";
import { useApplicationResources } from "./ApplicationResources";
import { AttachmentPreview } from "./AttachmentPreview";
import { AttachmentPicker, DescriptionField, issueTypesForEnvironment, selectedChoice } from "./IssueForm";
import { fileSize, priorityColor, priorityOptions, statusBadge, statusLabel, typeLabel } from "./model";

type IssueAttachment = IssueDetail["attachments"][number];

const dateTimeOptions = {
  timeZone: issuePilotConfig.regional.timeZone,
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
} as const;
const issueDateTimeFormat = new Intl.DateTimeFormat(issuePilotConfig.regional.locale, { ...dateTimeOptions, year: "numeric" });
const commentDateTimeFormat = new Intl.DateTimeFormat(issuePilotConfig.regional.locale, dateTimeOptions);

function localDateTime(value: string, includeYear = true): string {
  return (includeYear ? issueDateTimeFormat : commentDateTimeFormat).format(new Date(value));
}

export function IssueWorkspace(props: { issue: IssueDetail; hidden?: boolean; sourcePanel?: boolean; sourcePanelOpen?: boolean; onOpenSource: () => void; onUpdated: () => Promise<void> }) {
  const { catalog, people, peopleError } = useApplicationResources();
  const [editOpen, setEditOpen] = createSignal(false, { ownedWrite: true });
  const [editTitle, setEditTitle] = createSignal("", { ownedWrite: true });
  const [editDescription, setEditDescription] = createSignal("", { ownedWrite: true });
  const [editPriority, setEditPriority] = createSignal<IssuePriority>("p2", { ownedWrite: true });
  const [editType, setEditType] = createSignal<IssueType>("smart_analysis", { ownedWrite: true });
  const [editAssignee, setEditAssignee] = createSignal<string | null>(null, { ownedWrite: true });
  const [editCc, setEditCc] = createSignal<string[]>([], { ownedWrite: true });
  const [editService, setEditService] = createSignal("", { ownedWrite: true });
  const [editEnvironment, setEditEnvironment] = createSignal("", { ownedWrite: true });
  const [editAttachments, setEditAttachments] = createSignal<File[]>([], { ownedWrite: true });
  const [removedAttachmentIds, setRemovedAttachmentIds] = createSignal<string[]>([], { ownedWrite: true });
  const [editSaving, setEditSaving] = createSignal(false, { ownedWrite: true });
  const [editError, setEditError] = createSignal("", { ownedWrite: true });
  const [scopeConfirmOpen, setScopeConfirmOpen] = createSignal(false, { ownedWrite: true });
  const [retrying, setRetrying] = createSignal(false, { ownedWrite: true });
  const [retryError, setRetryError] = createSignal("", { ownedWrite: true });
  const [statusSaving, setStatusSaving] = createSignal(false, { ownedWrite: true });
  const [statusError, setStatusError] = createSignal("", { ownedWrite: true });
  const [conversionOpen, setConversionOpen] = createSignal(false, { ownedWrite: true });
  const [converting, setConverting] = createSignal(false, { ownedWrite: true });
  const [conversionError, setConversionError] = createSignal("", { ownedWrite: true });
  const [commentBody, setCommentBody] = createSignal("", { ownedWrite: true });
  const [commentSaving, setCommentSaving] = createSignal(false, { ownedWrite: true });
  const [commentMode, setCommentMode] = createSignal<"edit" | "preview">("edit", { ownedWrite: true });
  const [commentError, setCommentError] = createSignal("", { ownedWrite: true });
  const [previewAttachment, setPreviewAttachment] = createSignal<IssueAttachment | null>(null, { ownedWrite: true });
  const [descriptionExpanded, setDescriptionExpanded] = createSignal(false, { ownedWrite: true });
  const descriptionNeedsCollapse = () => props.issue.description.length > 180 || props.issue.description.split("\n").length > 4;
  let issueGeneration = 0;
  createEffect(() => props.issue.id, (issueId, previousIssueId) => {
    if (previousIssueId === undefined || issueId === previousIssueId) return;
    issueGeneration += 1;
    setEditOpen(false); setEditAttachments([]); setRemovedAttachmentIds([]); setEditSaving(false); setEditError(""); setScopeConfirmOpen(false);
    setRetrying(false); setRetryError(""); setStatusSaving(false); setStatusError(""); setConversionOpen(false); setConverting(false); setConversionError("");
    setCommentBody(""); setCommentSaving(false); setCommentMode("edit"); setCommentError(""); setPreviewAttachment(null); setDescriptionExpanded(false);
  });
  const openEditor = () => {
    setEditTitle(props.issue.title); setEditDescription(props.issue.description); setEditPriority(props.issue.priority); setEditType(props.issue.type);
    setEditAssignee(props.issue.assigneeSubject); setEditCc((props.issue.ccRecipients ?? []).map((person) => person.subject));
    setEditService(props.issue.service.key); setEditEnvironment(props.issue.environmentKey);
    setEditAttachments([]);
    setRemovedAttachmentIds([]);
    setEditError(""); setEditOpen(true);
  };
  const saveIssue = async () => {
    if (!editTitle().trim() || !editService()) return;
    const issueId = props.issue.id;
    const generation = issueGeneration;
    const input = { title: editTitle().trim(), description: editDescription().trim(), priority: editPriority(), type: editType(), serviceKey: editService(), environmentKey: editEnvironment(), assigneeSubject: editAssignee(), ccSubjects: [...editCc()] };
    const removals = [...removedAttachmentIds()];
    const additions = [...editAttachments()];
    setEditSaving(true); setEditError("");
    try {
      await updateIssue(issueId, input, removals, additions);
      if (issueGeneration !== generation) return;
      setRemovedAttachmentIds([]); setEditAttachments([]);
      await props.onUpdated();
      setScopeConfirmOpen(false); setEditOpen(false);
    } catch (error) {
      if (issueGeneration === generation) setEditError(errorMessage(error));
    } finally { if (issueGeneration === generation) setEditSaving(false); }
  };
  const requestSaveIssue = () => {
    if (editService() !== props.issue.service.key || editEnvironment() !== props.issue.environmentKey) setScopeConfirmOpen(true);
    else void saveIssue();
  };
  const submitComment = async () => {
    const body = commentBody().trim();
    if (!body) return;
    const issueId = props.issue.id;
    const generation = issueGeneration;
    setCommentSaving(true); setCommentError("");
    try {
      await addIssueComment(issueId, body);
      if (issueGeneration !== generation) return;
      setCommentBody(""); setCommentMode("edit");
      await props.onUpdated();
    } catch (error) {
      if (issueGeneration === generation) setCommentError(errorMessage(error));
    } finally { if (issueGeneration === generation) setCommentSaving(false); }
  };

  const retry = async () => {
    const issueId = props.issue.id;
    const generation = issueGeneration;
    setRetrying(true); setRetryError("");
    try {
      await retryIssue(issueId);
      if (issueGeneration === generation) await props.onUpdated();
    } catch (error) {
      if (issueGeneration === generation) setRetryError(errorMessage(error));
    } finally { if (issueGeneration === generation) setRetrying(false); }
  };
  const changeStatus = async (status: "open" | "resolved") => {
    const issueId = props.issue.id;
    const generation = issueGeneration;
    setStatusSaving(true); setStatusError("");
    try { await updateIssueStatus(issueId, status); if (issueGeneration === generation) await props.onUpdated(); }
    catch (error) { if (issueGeneration === generation) setStatusError(errorMessage(error)); }
    finally { if (issueGeneration === generation) setStatusSaving(false); }
  };
  const convertToDevelopment = async () => {
    const issueId = props.issue.id;
    const generation = issueGeneration;
    setConverting(true); setConversionError("");
    try {
      await convertIssueToDevelopment(issueId);
      if (issueGeneration !== generation) return;
      await props.onUpdated();
      if (issueGeneration === generation) setConversionOpen(false);
    } catch (error) {
      if (issueGeneration === generation) setConversionError(errorMessage(error));
    } finally { if (issueGeneration === generation) setConverting(false); }
  };
  const canConvertToDevelopment = () => ["prod", "test"].includes(props.issue.environmentKey) && props.issue.type === "smart_analysis" && ["open", "pending"].includes(props.issue.status) && props.issue.workspace.status === "ready";
  const branchName = () => props.issue.repositories[0]?.workingBranch ?? props.issue.repositories[0]?.baseBranch ?? "-";
  const environmentName = () => catalog().environments.find((environment) => environment.key === props.issue.environmentKey)?.name ?? props.issue.environmentKey;
  const availableIssueTypes = createMemo(() => issueTypesForEnvironment(editEnvironment() || props.issue.environmentKey));
  const targetEnvironmentName = () => catalog().environments.find((environment) => environment.key === editEnvironment())?.name ?? editEnvironment();
  const targetServiceName = () => catalog().services.find((service) => service.key === editService())?.name ?? editService();
  const changeEditEnvironment = (value: unknown) => {
    const selected = selectedChoice(value, catalog().environments.map((environment) => environment.key));
    if (!selected) return;
    const types = issueTypesForEnvironment(selected);
    const services = catalog().services.filter((service) => service.deployments.some((deployment) => deployment.environmentKey === selected));
    setEditEnvironment(selected);
    if (!types.includes(editType())) setEditType(types[0]!);
    if (!services.some((service) => service.key === editService())) setEditService(services[0]?.key ?? "");
  };
  return (
    <section class={`issue-workspace ip-scrollbar${props.sourcePanel ? ` ip-scrollbar-dark source-detail-panel${props.sourcePanelOpen ? " details-open" : ""}` : ""}`} hidden={props.hidden}>
      <header class="issue-header">
        <div class="issue-heading">
          <div class="issue-heading-meta">
            <span>{props.issue.id}</span>
            <Tag color={priorityColor[props.issue.priority]}>{props.issue.priority.toUpperCase()}</Tag>
            <Tag>{typeLabel[props.issue.type]}</Tag>
            <Badge status={statusBadge[props.issue.status]} text={statusLabel[props.issue.status]} />
          </div>
          <h1>{props.issue.title}</h1>
          <Show when={props.issue.description.trim()}>
            <div class={`issue-description${descriptionNeedsCollapse() ? " collapsible" : ""}${descriptionExpanded() ? " expanded" : ""}`}>
              <div class="issue-description-content"><Markdown source={props.issue.description} /></div>
              <Show when={descriptionNeedsCollapse()}><button type="button" class="issue-description-toggle" aria-expanded={descriptionExpanded() ? "true" : "false"} onClick={() => setDescriptionExpanded((expanded) => !expanded)}>{descriptionExpanded() ? "收起描述" : "展开完整描述"}</button></Show>
            </div>
          </Show>
        </div>
        <div class="issue-actions">
          <Show when={canConvertToDevelopment()}><Button icon={<GitBranch size={15} />} loading={converting()} onClick={() => { setConversionError(""); setConversionOpen(true); }}>转开发修复</Button></Show>
          <Show when={props.issue.workspace.retryable}>
            <Button icon={<RefreshCw size={15} />} loading={retrying()} onClick={() => { void retry(); }}>{props.issue.workspace.status === "ready" ? "继续处理" : "重试处理"}</Button>
          </Show>
          <Show when={props.issue.status === "pending"}><Button type="primary" icon={<CheckCircle2 size={15} />} loading={statusSaving()} onClick={() => { void changeStatus("resolved"); }}>确认解决</Button></Show>
          <Show when={props.issue.status === "resolved"}><Button icon={<RefreshCw size={15} />} loading={statusSaving()} onClick={() => { void changeStatus("open"); }}>重新打开</Button></Show>
          <Show when={props.issue.status !== "resolved"}><Button icon={<Pencil size={15} />} disabled={isWorkspaceBusy(props.issue.workspace.status)} onClick={openEditor}>编辑工单</Button></Show>
        </div>
      </header>

      <div class="issue-facts">
        <div><span>处理人</span><strong>{props.issue.assignee ?? "未分配"}</strong></div>
        <div><span>创建人</span><strong>{props.issue.reporter?.name ?? "-"}</strong></div>
        <div><span>服务</span><strong>{props.issue.service.name}</strong></div>
        <div><span>环境</span><strong>{environmentName()}</strong></div>
        <div><span>创建时间</span><strong>{localDateTime(props.issue.createdAt ?? props.issue.updatedAt)}</strong></div>
        <div><span>抄送人</span><strong>{props.issue.ccRecipients?.map((person) => person.name).join("、") || "无"}</strong></div>
      </div>
      <Show when={retryError()}><div class="workspace-error" role="alert">{retryError()}</div></Show>
      <Show when={statusError()}><div class="workspace-error" role="alert">{statusError()}</div></Show>
      <Show when={props.issue.workspace.lastError}><div class="workspace-error" role="alert">{props.issue.workspace.lastError}</div></Show>
      <section class="repository-band" aria-labelledby="repositories-title">
        <div class="band-title"><GitBranch size={16} /><h2 id="repositories-title">代码分支</h2></div>
        <div class="issue-branch-row">
          <code title={branchName()}>{branchName()}</code>
          <Show when={props.issue.workspace.sourceAvailable && !props.sourcePanel}>
            <Button class="icon-button" type="text" shape="circle" icon={<Code2 size={15} />} title="浏览工单代码" aria-label="浏览工单代码" onClick={props.onOpenSource} />
          </Show>
        </div>
      </section>

      <section class="attachment-band" aria-labelledby="attachments-title">
        <div class="band-title"><Paperclip size={16} /><h2 id="attachments-title">附件</h2><span>{props.issue.attachments.length}</span></div>
        <div class="issue-attachment-list">
          <For each={props.issue.attachments} fallback={<div class="empty-band">暂无附件</div>}>
            {(attachment) => <div class="issue-attachment-row"><Paperclip size={15} /><button type="button" class="attachment-preview-trigger" aria-label={`预览 ${attachment.fileName}`} onClick={() => setPreviewAttachment(attachment)}><span><strong>{attachment.fileName}</strong><small>{attachment.mediaType} · {fileSize(attachment.size)}</small></span><Eye size={15} /></button><a class="attachment-download-link" href={attachmentUrl(props.issue.id, attachment.id)} download={attachment.fileName} title={`下载 ${attachment.fileName}`} aria-label={`下载 ${attachment.fileName}`}><Download size={15} /></a></div>}
          </For>
        </div>
      </section>

      <section class="comments-band" aria-labelledby="comments-title">
        <div class="band-title"><MessageSquare size={16} /><h2 id="comments-title">评论与备注</h2><span>{props.issue.comments.length}</span></div>
        <div class="comment-list">
          <For each={props.issue.comments} fallback={<div class="empty-band">暂无评论</div>}>
            {(comment) => <article class="comment-row"><header><strong>{comment.author}</strong><time>{localDateTime(comment.createdAt, false)}</time></header><Markdown source={comment.body} /></article>}
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
      <AttachmentPreview issueKey={props.issue.id} attachment={previewAttachment()} onClose={() => setPreviewAttachment(null)} />
      <Modal open={conversionOpen()} title="转开发修复" okText="确认转换" cancelText="取消" confirmLoading={converting()} cancelButtonProps={{ disabled: converting() }} onOk={() => { void convertToDevelopment(); }} onCancel={() => { if (!converting()) { setConversionError(""); setConversionOpen(false); } }}>
        <p>当前工单将转到开发环境并改为缺陷修复，已有分析对话、附件和评论保持不变，转换后 Agent 将继续处理。</p>
        <Show when={conversionError()}><div class="create-error modal-form-error" role="alert">{conversionError()}</div></Show>
      </Modal>
      <Modal open={scopeConfirmOpen()} title="切换调查范围" okText="确认切换" cancelText="返回编辑" confirmLoading={editSaving()} cancelButtonProps={{ disabled: editSaving() }} onOk={() => { void saveIssue(); }} onCancel={() => { if (!editSaving()) setScopeConfirmOpen(false); }}>
        <p>Agent 将切换到 {targetServiceName()} / {targetEnvironmentName()} 的仓库、能力和凭据。已有对话、附件和评论会保留，运行上下文将重新创建。</p>
      </Modal>
      <Modal open={editOpen() && !scopeConfirmOpen()} title="编辑工单" okText="保存" cancelText="取消" confirmLoading={editSaving()} okButtonProps={{ disabled: !editTitle().trim() || !editService() }} onOk={requestSaveIssue} onCancel={() => { setEditAttachments([]); setRemovedAttachmentIds([]); setScopeConfirmOpen(false); setEditOpen(false); }}>
        <div class="create-issue-form compact-issue-form edit-issue-form">
          <Show when={editError() || peopleError()}><div class="create-error modal-form-error" role="alert">{editError() || peopleError()}</div></Show>
          <label><span>环境</span><Select aria-label="编辑工单环境" disabled={props.issue.environmentKey === "dev"} value={editEnvironment()} onChange={changeEditEnvironment} options={catalog().environments.filter((environment) => environment.key !== "dev" || environment.key === props.issue.environmentKey).map((environment) => ({ value: environment.key, label: environment.name }))} /></label>
          <label><span>服务</span><Select aria-label="编辑工单服务" disabled={props.issue.environmentKey === "dev"} value={editService()} onChange={(value) => { const selected = selectedChoice(value, catalog().services.map((service) => service.key)); if (selected) setEditService(selected); }} options={catalog().services.filter((service) => service.deployments.some((deployment) => deployment.environmentKey === editEnvironment())).map((service) => ({ value: service.key, label: service.name }))} /></label>
          <label><span>优先级</span><Select aria-label="编辑工单优先级" value={editPriority()} onChange={(value) => { const selected = selectedChoice(value, priorityOptions.map((option) => option.value)); if (selected) setEditPriority(selected); }} options={priorityOptions} /></label>
          <label><span>类型</span><Select aria-label="编辑工单类型" value={editType()} onChange={(value) => { const selected = selectedChoice(value, availableIssueTypes()); if (selected) setEditType(selected); }} options={availableIssueTypes().map((value) => ({ value, label: typeLabel[value] }))} /></label>
          <label><span>处理人</span><Select aria-label="编辑工单处理人" value={editAssignee() ?? undefined} allowClear onClear={() => setEditAssignee(null)} onChange={(value) => { if (typeof value === "string" && value) setEditAssignee(value); }} options={people().map((person) => ({ value: person.subject, label: `${person.name}${person.email ? ` · ${person.email}` : ""}` }))} /></label>
          <label><span>抄送人（可多选）</span><div class="multi-select-trigger"><Select mode="multiple" aria-label="编辑工单抄送人" value={editCc()} onChange={setEditCc} options={people().filter((person) => person.subject !== editAssignee()).map((person) => ({ value: person.subject, label: `${person.name}${person.email ? ` · ${person.email}` : ""}` }))} /></div></label>
          <label><span>标题</span><Input aria-label="编辑工单标题" value={editTitle()} onInput={(event) => setEditTitle(event.currentTarget.value)} /></label>
          <DescriptionField value={editDescription} inputLabel="编辑工单描述" expandLabel="放大编辑工单描述" onChange={(value) => setEditDescription(value)} />
          <AttachmentPicker files={editAttachments} existingFiles={() => props.issue.attachments.filter((attachment) => !removedAttachmentIds().includes(attachment.id))} inputLabel="编辑工单选择附件" onFilesChange={(files) => setEditAttachments(files)} onRemoveExisting={(id) => { setRemovedAttachmentIds((current) => [...current, id]); setEditError(""); }} onError={(message) => setEditError(message)} />
        </div>
      </Modal>
    </section>
  );
}
