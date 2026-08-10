import { Badge, Button, Input, Modal, Segmented, Select, Space, Tag, TextArea } from "@idoly/ant-design-solid";
import { createEffect, createSignal, For, Show } from "solid-js";

import { CheckCircle2, Download, ExternalLink, Eye, GitBranch, MessageSquare, Paperclip, Pencil, RefreshCw, Send, Trash2 } from "../ui/icons";
import { addIssueComment, attachmentUrl, deleteIssueAttachments, releaseIssueWorkspace, retryIssue, syncIssueUpdate, updateIssue, updateIssueStatus, uploadAttachments, type IssueDetail, type IssuePriority, type IssueType } from "../data/client";
import { Markdown } from "../ui/Markdown";
import { useApplicationResources } from "./ApplicationResources";
import { AttachmentPreview } from "./AttachmentPreview";
import { AttachmentPicker, DescriptionField, bindMultipleSelectBlankToggle, environmentLabel, issueTypesForEnvironment, selectedChoice, selectedStrings } from "./IssueForm";
import { fileSize, priorityColor, priorityOptions, statusBadge, statusLabel, typeLabel, workspaceUrl } from "./model";

type IssueAttachment = IssueDetail["attachments"][number];

export function IssueWorkspace(props: { issue: IssueDetail; onOpenCodeServer: (url: string) => void; onUpdated: () => Promise<void> }) {
  const { configuration, people, peopleError } = useApplicationResources();
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
  const [editSaving, setEditSaving] = createSignal(false, { ownedWrite: true });
  const [editError, setEditError] = createSignal("", { ownedWrite: true });
  const [retrying, setRetrying] = createSignal(false, { ownedWrite: true });
  const [retryError, setRetryError] = createSignal("", { ownedWrite: true });
  const [statusSaving, setStatusSaving] = createSignal(false, { ownedWrite: true });
  const [statusError, setStatusError] = createSignal("", { ownedWrite: true });
  const [releaseOpen, setReleaseOpen] = createSignal(false, { ownedWrite: true });
  const [releasing, setReleasing] = createSignal(false, { ownedWrite: true });
  const [releaseError, setReleaseError] = createSignal("", { ownedWrite: true });
  const [commentBody, setCommentBody] = createSignal("", { ownedWrite: true });
  const [commentSaving, setCommentSaving] = createSignal(false, { ownedWrite: true });
  const [commentMode, setCommentMode] = createSignal<"edit" | "preview">("edit", { ownedWrite: true });
  const [commentError, setCommentError] = createSignal("", { ownedWrite: true });
  const [previewAttachment, setPreviewAttachment] = createSignal<IssueAttachment | null>(null, { ownedWrite: true });
  let issueGeneration = 0;
  createEffect(() => props.issue.id, (issueId, previousIssueId) => {
    if (previousIssueId === undefined || issueId === previousIssueId) return;
    issueGeneration += 1;
    setEditOpen(false); setEditCcOpen(false); setEditAttachments([]); setRemovedAttachmentIds([]); setEditSaving(false); setEditError("");
    setRetrying(false); setRetryError(""); setStatusSaving(false); setStatusError(""); setReleaseOpen(false); setReleasing(false); setReleaseError("");
    setCommentBody(""); setCommentSaving(false); setCommentMode("edit"); setCommentError(""); setPreviewAttachment(null);
  });
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
    const issueId = props.issue.id;
    const generation = issueGeneration;
    const input = { title: editTitle().trim(), description: editDescription().trim(), priority: editPriority(), type: editType(), serviceKey: editService(), assigneeSubject: editAssignee(), ccSubjects: [...editCc()] };
    const removals = [...removedAttachmentIds()];
    const additions = [...editAttachments()];
    setEditSaving(true); setEditError("");
    try {
      await updateIssue(issueId, input);
      if (removals.length) await deleteIssueAttachments(issueId, removals);
      if (additions.length) await uploadAttachments(issueId, additions);
      await syncIssueUpdate(issueId);
      if (issueGeneration !== generation) return;
      setRemovedAttachmentIds([]); setEditAttachments([]);
      await props.onUpdated();
      setEditCcOpen(false); setEditOpen(false);
    } catch (error) {
      if (issueGeneration === generation) setEditError(error instanceof Error ? error.message : String(error));
    } finally { if (issueGeneration === generation) setEditSaving(false); }
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
      if (issueGeneration === generation) setCommentError(error instanceof Error ? error.message : String(error));
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
      if (issueGeneration === generation) setRetryError(error instanceof Error ? error.message : String(error));
    } finally { if (issueGeneration === generation) setRetrying(false); }
  };
  const changeStatus = async (status: "open" | "resolved") => {
    const issueId = props.issue.id;
    const generation = issueGeneration;
    setStatusSaving(true); setStatusError("");
    try { await updateIssueStatus(issueId, status); if (issueGeneration === generation) await props.onUpdated(); }
    catch (error) { if (issueGeneration === generation) setStatusError(error instanceof Error ? error.message : String(error)); }
    finally { if (issueGeneration === generation) setStatusSaving(false); }
  };
  const releaseWorkspace = async () => {
    const issueId = props.issue.id;
    const generation = issueGeneration;
    setReleasing(true); setReleaseError("");
    try {
      await releaseIssueWorkspace(issueId);
      if (issueGeneration !== generation) return;
      await props.onUpdated();
      setReleaseOpen(false);
    } catch (error) {
      if (issueGeneration === generation) setReleaseError(error instanceof Error ? error.message : String(error));
    } finally { if (issueGeneration === generation) setReleasing(false); }
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
          <Show when={props.issue.workspace.releasable && props.issue.workspace.bytes > 0}><Button danger icon={<Trash2 size={15} />} onClick={() => { setReleaseError(""); setReleaseOpen(true); }}>释放工作区</Button></Show>
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
            {(attachment) => <div class="issue-attachment-row"><Paperclip size={15} /><button type="button" class="attachment-preview-trigger" aria-label={`预览 ${attachment.fileName}`} onClick={() => setPreviewAttachment(attachment)}><span><strong>{attachment.fileName}</strong><small>{attachment.mediaType} · {fileSize(attachment.size)}</small></span><Eye size={15} /></button><a class="attachment-download-link" href={attachmentUrl(props.issue.id, attachment.id)} download={attachment.fileName} title={`下载 ${attachment.fileName}`} aria-label={`下载 ${attachment.fileName}`}><Download size={15} /></a></div>}
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
      <AttachmentPreview issueKey={props.issue.id} attachment={previewAttachment()} onClose={() => setPreviewAttachment(null)} />
      <Modal open={releaseOpen()} title="释放工作区" okText="确认释放" cancelText="取消" confirmLoading={releasing()} okButtonProps={{ danger: true }} onOk={() => { void releaseWorkspace(); }} onCancel={() => { if (!releasing()) setReleaseOpen(false); }}>
        <div class="workspace-release-confirm">
          <p>将释放 {fileSize(props.issue.workspace.bytes)} 的本地依赖和构建文件。Git 分支、Agent 会话和附件会保留，可在重新处理时恢复工作区。</p>
          <Show when={releaseError()}><div class="workspace-error" role="alert">{releaseError()}</div></Show>
        </div>
      </Modal>
      <Modal open={editOpen()} title="编辑工单" okText="保存" cancelText="取消" confirmLoading={editSaving()} okButtonProps={{ disabled: !editTitle().trim() || !editService() }} onOk={() => { void saveIssue(); }} onCancel={() => { setEditCcOpen(false); setEditAttachments([]); setRemovedAttachmentIds([]); setEditOpen(false); }}>
        <div class="create-issue-form compact-issue-form edit-issue-form">
          <Show when={editError() || peopleError()}><div class="create-error modal-form-error" role="alert">{editError() || peopleError()}</div></Show>
          <label><span>服务</span><Select aria-label="编辑工单服务" value={editService()} onChange={(value) => { const selected = selectedChoice(value, configuration().services.map((service) => service.key)); if (selected) setEditService(selected); }} options={configuration().services.filter((service) => service.deployments.some((deployment) => deployment.environmentKey === props.issue.environmentKey)).map((service) => ({ value: service.key, label: service.name }))} /></label>
          <label><span>优先级</span><Select aria-label="编辑工单优先级" value={editPriority()} onChange={(value) => { const selected = selectedChoice(value, priorityOptions.map((option) => option.value)); if (selected) setEditPriority(selected); }} options={priorityOptions} /></label>
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
