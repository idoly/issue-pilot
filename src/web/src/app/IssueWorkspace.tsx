import { Badge, Button, Input, Modal, Select, Tag } from "../ui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";

import type { JSX } from "@solidjs/web";
import { issuePilotConfig } from "../../../../issue-pilot.config.ts";
import { CheckCircle2, Code2, Download, Eye, GitBranch, Organization, MessageSquare, Paperclip, Pencil, Plus, RefreshCw } from "../ui/icons";
import { canUseIssueWorkMode, applyIssueScopeTransition, attachmentUrl, createIssue, errorMessage, isWorkspaceBusy, issueScopeForWorkMode, issueWorkMode, listIssues, listIssueSessions, resetIssueSession, planIssueScopeTransition, retryIssue, updateIssue, updateIssueRelatedIssues, updateIssueStatus, type IssueDetail, type IssueExecutionItem, type IssuePriority, type IssueScopeTransitionPlan, type IssueWorkMode } from "../data/client";
import { IssueSessionControls } from "./IssueSessionControls";
import { IssueFiles } from "./IssueFiles";
import { IssueMarkdown } from "./IssueMarkdown";
import { useApplicationResources } from "./ApplicationResources";
import { AttachmentPreview } from "./AttachmentPreview";
import { AttachmentPicker, DescriptionField, RelatedIssueSelect, selectedChoice } from "./IssueForm";
import { attachmentPreviewKind } from "./file-preview";
import { fileSize, priorityColor, priorityOptions, statusBadge, statusLabel, typeLabel, workModeLabel, workModeOptions } from "./model";

type IssueAttachment = IssueDetail["attachments"][number];

const workspaceErrorMessages: Record<string, string> = {
  agent_message_scope_changed: "历史排队消息的处理范围已变更，已停止恢复。请核对历史输入后重试，或按当前范围重新发送。",
  dms_credentials_not_configured: "尚未配置 DMS 凭据，请在用户配置中设置个人或共享 DMS 凭据后重试。",
  personal_dms_credentials_incomplete: "个人 DMS 凭据不完整，请补齐或清除后使用共享凭据。",
  agent_session_changed: "会话已更新，请重新打开编辑工单。",
  agent_session_not_found: "暂无可重置的会话。",
  issue_already_running: "工单正在处理，请等待结束后重置。",
  resolved_issue_cannot_reset_session: "请先重开工单。",
  sls_credentials_not_configured: "尚未配置 SLS 凭据，请在用户配置中设置个人或共享 SLS 凭据后重试。",
  personal_sls_credentials_incomplete: "个人 SLS 凭据不完整，请重新设置完整凭据后重试。",
  model_response_failed: "模型响应中断，处理未完成。已有对话和文件已保留，请核对结果后重试处理。",
};

function IssueFileRow(props: { fileName: string; label?: string; thumbnail?: string | undefined; detail: string; href: string; icon: JSX.Element; onPreview: (() => void) | undefined }) {
  const [thumbnailFailed, setThumbnailFailed] = createSignal(false, { ownedWrite: true });
  return <div class={`issue-attachment-row${props.thumbnail ? " has-thumbnail" : ""}`} title={props.fileName}>
    <Show when={props.thumbnail && !thumbnailFailed()} fallback={props.icon}><button type="button" class="attachment-thumbnail" aria-label={`预览缩略图 ${props.fileName}`} onClick={props.onPreview}><img src={props.thumbnail} alt="" loading="lazy" decoding="async" onError={() => setThumbnailFailed(true)} /></button></Show>
    <Show when={props.onPreview} fallback={<span class="attachment-file-info"><strong>{props.label ?? props.fileName}</strong><small>{props.detail} · 仅下载</small></span>}>
      <button type="button" class="attachment-preview-trigger" aria-label={`预览 ${props.fileName}`} onClick={props.onPreview}><span class="attachment-file-info"><strong>{props.label ?? props.fileName}</strong><small>{props.detail}</small></span><Eye size={15} /></button>
    </Show>
    <a class="attachment-download-link" href={props.href} download={props.fileName} title={`下载 ${props.fileName}`} aria-label={`下载 ${props.fileName}`}><Download size={15} /></a>
  </div>;
}

const dateTimeOptions = {
  timeZone: issuePilotConfig.regional.timeZone,
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
} as const;
const issueDateTimeFormat = new Intl.DateTimeFormat(issuePilotConfig.regional.locale, { ...dateTimeOptions, year: "numeric" });
function localDateTime(value: string): string {
  return issueDateTimeFormat.format(new Date(value));
}

export function IssueWorkspace(props: { issue: IssueDetail; elementRef?: (element: HTMLElement) => void; hidden?: boolean; sourcePanel?: boolean; sourcePanelOpen?: boolean; onOpenSource: () => void; onUpdated: () => Promise<void>; onOpenIssue?: (issueKey: string) => void; onCreatedFollowUp: (issueKey: string) => void }) {
  const { catalog, people, currentUser, peopleError } = useApplicationResources();
  const [editOpen, setEditOpen] = createSignal(false, { ownedWrite: true });
  const [editTitle, setEditTitle] = createSignal("", { ownedWrite: true });
  const [editDescription, setEditDescription] = createSignal("", { ownedWrite: true });
  const [editPriority, setEditPriority] = createSignal<IssuePriority>("p2", { ownedWrite: true });
  const [editAssignee, setEditAssignee] = createSignal<string | null>(null, { ownedWrite: true });
  const [editCc, setEditCc] = createSignal<string[]>([], { ownedWrite: true });
  const [editAttachments, setEditAttachments] = createSignal<File[]>([], { ownedWrite: true });
  const [removedAttachmentIds, setRemovedAttachmentIds] = createSignal<string[]>([], { ownedWrite: true });
  const [editSaving, setEditSaving] = createSignal(false, { ownedWrite: true });
  const [editResetting, setEditResetting] = createSignal(false, { ownedWrite: true });
  const [editError, setEditError] = createSignal("", { ownedWrite: true });
  const [retrying, setRetrying] = createSignal(false, { ownedWrite: true });
  const [retryError, setRetryError] = createSignal("", { ownedWrite: true });
  const [statusSaving, setStatusSaving] = createSignal(false, { ownedWrite: true });
  const [statusError, setStatusError] = createSignal("", { ownedWrite: true });
  const [scopeOpen, setScopeOpen] = createSignal(false, { ownedWrite: true });
  const [scopeMode, setScopeMode] = createSignal<IssueWorkMode>("production_analysis", { ownedWrite: true });
  const [scopeService, setScopeService] = createSignal("", { ownedWrite: true });
  const [scopePlan, setScopePlan] = createSignal<IssueScopeTransitionPlan | null>(null, { ownedWrite: true });
  const [scopePlanning, setScopePlanning] = createSignal(false, { ownedWrite: true });
  const [scopeApplying, setScopeApplying] = createSignal(false, { ownedWrite: true });
  const [scopeError, setScopeError] = createSignal("", { ownedWrite: true });
  const [followUpOpen, setFollowUpOpen] = createSignal(false, { ownedWrite: true });
  const [followUpTitle, setFollowUpTitle] = createSignal("", { ownedWrite: true });
  const [followUpDescription, setFollowUpDescription] = createSignal("", { ownedWrite: true });
  const [followUpService, setFollowUpService] = createSignal("", { ownedWrite: true });
  const [followUpSaving, setFollowUpSaving] = createSignal(false, { ownedWrite: true });
  const [followUpError, setFollowUpError] = createSignal("", { ownedWrite: true });
  const [relatedOpen, setRelatedOpen] = createSignal(false, { ownedWrite: true });
  const [relatedKeys, setRelatedKeys] = createSignal<string[]>([], { ownedWrite: true });
  const [relatedCandidates, setRelatedCandidates] = createSignal<IssueExecutionItem[]>([], { ownedWrite: true });
  const [relatedLoading, setRelatedLoading] = createSignal(false, { ownedWrite: true });
  const [relatedSaving, setRelatedSaving] = createSignal(false, { ownedWrite: true });
  const [relatedError, setRelatedError] = createSignal("", { ownedWrite: true });
  const [previewAttachment, setPreviewAttachment] = createSignal<IssueAttachment | null>(null, { ownedWrite: true });
  const [descriptionExpanded, setDescriptionExpanded] = createSignal(false, { ownedWrite: true });
  const descriptionNeedsCollapse = () => props.issue.description.length > 180 || props.issue.description.split("\n").length > 4;
  let issueGeneration = 0, scopePlanRequest = 0, relatedRequest = 0;
  onCleanup(() => { issueGeneration++; scopePlanRequest++; relatedRequest++; });
  createEffect(() => ({ issueId: props.issue.id, subject: currentUser()?.subject, role: currentUser()?.role }), (context, previous) => {
    if (!previous || context.issueId === previous.issueId && context.subject === previous.subject && context.role === previous.role) return;
    issueGeneration += 1;
    setEditOpen(false); setEditAttachments([]); setRemovedAttachmentIds([]); setEditSaving(false); setEditResetting(false); setEditError("");
    setRetrying(false); setRetryError(""); setStatusSaving(false); setStatusError(""); setScopeOpen(false); setScopePlan(null); setScopePlanning(false); setScopeApplying(false); setScopeError("");
    setFollowUpOpen(false); setFollowUpSaving(false); setFollowUpError("");
    setRelatedOpen(false); setRelatedKeys([]); setRelatedCandidates([]); setRelatedLoading(false); setRelatedSaving(false); setRelatedError("");
    setPreviewAttachment(null); setDescriptionExpanded(false);
  });
  const openEditor = () => {
    setEditTitle(props.issue.title); setEditDescription(props.issue.description); setEditPriority(props.issue.priority);
    setEditAssignee(props.issue.assigneeSubject); setEditCc((props.issue.ccRecipients ?? []).map((person) => person.subject));
    setEditAttachments([]);
    setRemovedAttachmentIds([]);
    setEditError(""); setEditOpen(true);
  };
  const resetDisabled = () => currentUser()?.role !== "developer" || Boolean(props.issue.agentRunning) || isWorkspaceBusy(props.issue.workspace.status);
  const closeEditor = () => { setEditAttachments([]); setRemovedAttachmentIds([]); setEditOpen(false); };
  const saveIssue = async (reset = false) => {
    if (editSaving() || !editTitle().trim() || reset && resetDisabled()) return;
    const issueId = props.issue.id;
    const generation = issueGeneration;
    const input = { title: editTitle().trim(), description: editDescription().trim(), priority: editPriority(), assigneeSubject: editAssignee(), ccSubjects: [...editCc()] };
    const removals = [...removedAttachmentIds()];
    const additions = [...editAttachments()];
    let saved = false, resetDone = false;
    setEditSaving(true); setEditResetting(reset); setEditError("");
    try {
      const sessions = reset ? await listIssueSessions(issueId) : [];
      if (issueGeneration !== generation) return;
      const current = sessions.find(session => session.current);
      if (reset && !current) throw new Error("agent_session_not_found");
      await updateIssue(issueId, input, removals, additions);
      saved = true;
      if (issueGeneration !== generation) return;
      setRemovedAttachmentIds([]); setEditAttachments([]);
      if (reset) { await resetIssueSession(issueId, current!.sessionId); resetDone = true; }
      if (issueGeneration !== generation) return;
      await props.onUpdated();
      if (issueGeneration === generation) setEditOpen(false);
    } catch (error) {
      const code = errorMessage(error);
      let message = workspaceErrorMessages[code] ?? code;
      if (saved && reset && !resetDone && issueGeneration === generation) {
        try { await props.onUpdated(); }
        catch (refreshError) { message += `；刷新工单失败：${errorMessage(refreshError)}`; }
      }
      if (issueGeneration === generation) setEditError(resetDone
        ? `工单已保存，会话已重置，但刷新失败：${message}。请关闭编辑窗口后刷新页面。`
        : saved && reset ? `工单已保存，但重置未完成：${message}。可重试重置，已保存的附件不会重复上传。` : message);
    } finally { if (issueGeneration === generation) { setEditSaving(false); setEditResetting(false); } }
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
  const currentWorkMode = () => issueWorkMode(props.issue.environmentKey as "prod" | "test" | "dev", props.issue.type);
  const availableScopeModes = createMemo(() => workModeOptions.filter(({ value }) => {
    if (!canUseIssueWorkMode(currentUser()?.role ?? "product", value)) return false;
    if (props.issue.environmentKey === "dev" && value !== currentWorkMode()) return false;
    const environmentKind = issueScopeForWorkMode(value).environmentKind;
    return catalog().services.some((service) => service.deployments.some((deployment) => deployment.environmentKey === environmentKind));
  }));
  const availableScopeServices = createMemo(() => {
    const environmentKind = issueScopeForWorkMode(scopeMode()).environmentKind;
    return catalog().services.filter((service) => service.deployments.some((deployment) => deployment.environmentKey === environmentKind));
  });
  const resetScopePlan = () => { scopePlanRequest++; setScopePlanning(false); setScopePlan(null); setScopeError(""); };
  const openScopeTransition = (workMode = currentWorkMode() ?? "production_analysis") => {
    setScopeMode(workMode);
    setScopeService(props.issue.service.key);
    resetScopePlan();
    setScopeOpen(true);
  };
  const requestScopePlan = async () => {
    if (!scopeService()) return;
    const issueId = props.issue.id;
    const generation = issueGeneration, request = ++scopePlanRequest;
    setScopePlanning(true); setScopeError("");
    try {
      const plan = await planIssueScopeTransition(issueId, { serviceKey: scopeService(), workMode: scopeMode() });
      if (issueGeneration === generation && request === scopePlanRequest) setScopePlan(plan);
    } catch (error) {
      if (issueGeneration === generation && request === scopePlanRequest) setScopeError(errorMessage(error));
    } finally { if (issueGeneration === generation && request === scopePlanRequest) setScopePlanning(false); }
  };
  const applyScopeTransition = async () => {
    const plan = scopePlan();
    if (!plan) { await requestScopePlan(); return; }
    const issueId = props.issue.id;
    const generation = issueGeneration;
    setScopeApplying(true); setScopeError("");
    try {
      await applyIssueScopeTransition(issueId, { serviceKey: scopeService(), workMode: scopeMode() }, plan);
      if (issueGeneration !== generation) return;
      await props.onUpdated();
      if (issueGeneration === generation) setScopeOpen(false);
    } catch (error) {
      if (issueGeneration === generation) { setScopePlan(null); setScopeError(errorMessage(error)); }
    } finally { if (issueGeneration === generation) setScopeApplying(false); }
  };
  const productionServices = createMemo(() => catalog().services.filter((service) => service.deployments.some((deployment) => deployment.environmentKey === "prod")));
  const openFollowUp = () => {
    setFollowUpTitle(`【正式跟进】${props.issue.title}`);
    setFollowUpDescription(props.issue.description);
    setFollowUpService(productionServices().some((service) => service.key === props.issue.service.key) ? props.issue.service.key : productionServices()[0]?.key ?? "");
    setFollowUpError("");
    setFollowUpOpen(true);
  };
  const createFormalFollowUp = async () => {
    if (!followUpTitle().trim() || !followUpService()) return;
    const issueId = props.issue.id;
    const generation = issueGeneration;
    setFollowUpSaving(true); setFollowUpError("");
    try {
      const created = await createIssue({
        title: followUpTitle().trim(),
        description: followUpDescription().trim(),
        priority: props.issue.priority,
        workMode: "production_analysis",
        serviceKey: followUpService(),
        assigneeSubject: people().some(({ subject }) => subject === props.issue.assigneeSubject) ? props.issue.assigneeSubject : null,
        ccSubjects: (props.issue.ccRecipients ?? []).map(({ subject }) => subject).filter((subject) => people().some((person) => person.subject === subject)),
        relatedIssueKeys: [issueId],
      });
      if (issueGeneration !== generation) return;
      setFollowUpOpen(false);
      props.onCreatedFollowUp(created.id);
    } catch (error) {
      if (issueGeneration === generation) setFollowUpError(errorMessage(error));
    } finally { if (issueGeneration === generation) setFollowUpSaving(false); }
  };
  const canCreateFollowUp = () => props.issue.environmentKey === "dev" && !props.issue.agentRunning && ["ready", "stopped"].includes(props.issue.workspace.status) && props.issue.workspace.sourceAvailable && productionServices().length > 0;
  const canEditRelatedIssues = () => props.issue.status !== "resolved";
  const selectableRelatedIssues = createMemo(() => relatedCandidates().filter((candidate) => candidate.id !== props.issue.id));
  const closeRelatedEditor = () => { relatedRequest++; setRelatedOpen(false); setRelatedLoading(false); };
  const openRelatedEditor = async () => {
    const generation = issueGeneration, request = ++relatedRequest;
    setRelatedKeys((props.issue.relatedIssues ?? []).map(({ id }) => id));
    setRelatedCandidates([]);
    setRelatedError(""); setRelatedOpen(true); setRelatedLoading(true);
    try {
      const candidates = await listIssues();
      if (issueGeneration === generation && request === relatedRequest) setRelatedCandidates(candidates);
    } catch (error) {
      if (issueGeneration === generation && request === relatedRequest) setRelatedError(errorMessage(error));
    } finally { if (issueGeneration === generation && request === relatedRequest) setRelatedLoading(false); }
  };
  const saveRelatedIssues = async () => {
    const issueId = props.issue.id;
    const generation = issueGeneration;
    setRelatedSaving(true); setRelatedError("");
    try {
      await updateIssueRelatedIssues(issueId, relatedKeys());
      if (issueGeneration !== generation) return;
      await props.onUpdated();
      if (issueGeneration === generation) closeRelatedEditor();
    } catch (error) {
      if (issueGeneration === generation) setRelatedError(errorMessage(error));
    } finally { if (issueGeneration === generation) setRelatedSaving(false); }
  };
  const canChangeScope = () => ["open", "pending"].includes(props.issue.status) && props.issue.workspace.status === "ready" && !isWorkspaceBusy(props.issue.workspace.status);
  const branchName = () => props.issue.repositories[0]?.workingBranch ?? props.issue.repositories[0]?.baseBranch ?? "-";
  return (
    <section ref={props.elementRef} class={`issue-workspace ip-scrollbar${props.sourcePanel ? ` ip-scrollbar-dark source-detail-panel${props.sourcePanelOpen ? " details-open" : ""}` : ""}`} hidden={props.hidden}>
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
              <div class="issue-description-content"><IssueMarkdown issue={props.issue} source={props.issue.description} /></div>
              <Show when={descriptionNeedsCollapse()}><button type="button" class="issue-description-toggle" aria-expanded={descriptionExpanded() ? "true" : "false"} onClick={() => setDescriptionExpanded((expanded) => !expanded)}>{descriptionExpanded() ? "收起描述" : "展开完整描述"}</button></Show>
            </div>
          </Show>
        </div>
        <div class="issue-actions">
          <Show when={props.issue.status === "pending"}><Button class="issue-status-action" type="primary" icon={<CheckCircle2 size={15} />} loading={statusSaving()} onClick={() => { void changeStatus("resolved"); }}>确认解决</Button></Show>
          <Show when={props.issue.status === "resolved"}><Button class="issue-status-action" icon={<RefreshCw size={15} />} loading={statusSaving()} onClick={() => { void changeStatus("open"); }}>重新打开</Button></Show>
          <Show when={props.issue.status !== "resolved" && props.issue.status !== "pending" && props.issue.workspace.retryable}>
            <Button class="issue-status-action" icon={<RefreshCw size={15} />} loading={retrying()} onClick={() => { void retry(); }}>{props.issue.workspace.status === "ready" ? "继续处理" : "重试处理"}</Button>
          </Show>
          <div class="issue-secondary-actions">
            <Show when={canCreateFollowUp()}><Button icon={<Plus size={15} />} onClick={openFollowUp}>创建正式跟进</Button></Show>
            <Show when={canChangeScope()}><Button icon={<GitBranch size={15} />} onClick={() => openScopeTransition()}>变更处理范围</Button></Show>
            <Show when={props.issue.status === "pending" && props.issue.workspace.retryable}>
              <Button icon={<RefreshCw size={15} />} loading={retrying()} onClick={() => { void retry(); }}>{props.issue.workspace.status === "ready" ? "继续处理" : "重试处理"}</Button>
            </Show>
            <Show when={props.issue.status !== "resolved"}><Button icon={<Pencil size={15} />} disabled={isWorkspaceBusy(props.issue.workspace.status)} onClick={openEditor}>编辑工单</Button></Show>
          </div>
        </div>
      </header>

      <Show when={retryError()}><div class="workspace-error" role="alert">{retryError()}</div></Show>
      <Show when={statusError()}><div class="workspace-error" role="alert">{statusError()}</div></Show>
      <Show when={props.issue.workspace.lastError}><div class="workspace-error" role="alert">{workspaceErrorMessages[props.issue.workspace.lastError ?? ""] ?? props.issue.workspace.lastError}</div></Show>
      <section class="attachment-band issue-attachments" aria-labelledby="attachments-title">
        <div class="band-title"><Paperclip size={16} /><h2 id="attachments-title">附件</h2><span>{props.issue.attachments.length}</span></div>
        <div class="issue-attachment-list">
          <For each={props.issue.attachments} fallback={<div class="empty-band">暂无附件</div>}>
            {(attachment, index) => {
              const kind = attachmentPreviewKind(attachment);
              return <IssueFileRow fileName={attachment.fileName} label={kind === "image" && /^[a-f0-9]{24,}\.[a-z0-9]+$/i.test(attachment.fileName) ? `图片附件 ${index() + 1}` : attachment.fileName} thumbnail={kind === "image" ? attachmentUrl(props.issue.id, attachment.id) : undefined} detail={`${kind === "image" ? attachment.mediaType.slice(6).toUpperCase() : attachment.mediaType} · ${fileSize(attachment.size)}`} href={attachmentUrl(props.issue.id, attachment.id)} icon={<Paperclip size={15} />} onPreview={kind === "unsupported" ? undefined : () => setPreviewAttachment(attachment)} />;
            }}
          </For>
        </div>
      </section>
      <Show when={canEditRelatedIssues() || (props.issue.relatedIssues ?? []).length}>
        <section class="repository-band" aria-labelledby="related-issues-title">
          <div class="band-title"><MessageSquare size={16} /><h2 id="related-issues-title">关联工单</h2><span>{props.issue.relatedIssues?.length ?? 0}</span><Show when={canEditRelatedIssues()}><Button type="text" icon={<Pencil size={14} />} disabled={Boolean(props.issue.agentRunning) || isWorkspaceBusy(props.issue.workspace.status)} onClick={() => { void openRelatedEditor(); }}>编辑关联</Button></Show></div>
          <div class="related-issue-list">
            <For each={props.issue.relatedIssues ?? []} fallback={<div class="empty-band">暂无关联工单</div>}>{(relatedIssue) => {
              const assignee = relatedIssue.assignee || relatedIssue.assigneeSubject || "未分配";
              const environment = () => catalog().environments.find(item => item.key === relatedIssue.environmentKey)?.name ?? relatedIssue.environmentKey;
              return <a class="related-issue-row" href={`/?issue=${encodeURIComponent(relatedIssue.id)}`} aria-label={`打开关联工单 ${relatedIssue.id}`} title={relatedIssue.title} onClick={event => { if (props.onOpenIssue && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); props.onOpenIssue(relatedIssue.id); } }}>
                <strong>{relatedIssue.id}</strong>
                <small class="related-issue-assignee">{assignee}</small>
                <Badge status={statusBadge[relatedIssue.status]} text={statusLabel[relatedIssue.status]} />
                <small class="related-issue-service">{relatedIssue.service.name}</small>
                <small class="related-issue-environment">{environment()}</small>
              </a>;
            }}</For>
          </div>
        </section>
      </Show>
      <Show when={props.issue.collaboratingServices?.length}>
        <section class="repository-band" aria-label="协作服务"><div class="band-title"><Organization size={16} /><h2>协作服务</h2></div><div class="capability-labels"><For each={props.issue.collaboratingServices ?? []}>{(service) => <code>{service.name}</code>}</For></div></section>
      </Show>
      <Show when={(props.issue.scopeTransitions ?? []).length}>
        <section class="repository-band" aria-labelledby="scope-history-title">
          <div class="band-title"><h2 id="scope-history-title">处理历史</h2><span>{props.issue.scopeTransitions?.length ?? 0}</span></div>
          <div class="issue-attachment-list">
            <For each={props.issue.scopeTransitions ?? []}>{(transition) => (
              <div class="issue-attachment-row scope-history-row">
                <span>
                  <strong>{transition.from.service.name} · {workModeLabel[transition.from.workMode]} → {transition.to.service.name} · {workModeLabel[transition.to.workMode]}</strong>
                  <small class="scope-history-meta"><span>{transition.actor.name}</span><time datetime={transition.createdAt}>{localDateTime(transition.createdAt)}</time><span>保留 {transition.repositories.retained.length} / 新增 {transition.repositories.added.length} / 移除 {transition.repositories.removed.length}</span></small>
                </span>
              </div>
            )}</For>
          </div>
        </section>
      </Show>
      <section class="repository-band" aria-labelledby="repositories-title">
        <div class="band-title"><GitBranch size={16} /><h2 id="repositories-title">代码分支</h2></div>
        <div class="issue-branch-row">
          <code title={branchName()}>{branchName()}</code>
          <Show when={props.issue.workspace.sourceAvailable && !props.sourcePanel}>
            <Button class="icon-button" type="text" shape="circle" icon={<Code2 size={15} />} title="浏览工单代码" aria-label="浏览工单代码" onClick={props.onOpenSource} />
          </Show>
        </div>
      </section>

      <Show when={props.issue.workingDirectory}><IssueFiles issue={props.issue} hidden={props.hidden} /></Show>
      <AttachmentPreview issueKey={props.issue.id} attachment={previewAttachment()} onClose={() => setPreviewAttachment(null)} />
      <Modal open={relatedOpen()} title="编辑关联工单" okText="保存关联" cancelText="取消" confirmLoading={relatedSaving()} cancelButtonProps={{ disabled: relatedSaving() }} okButtonProps={{ disabled: relatedLoading() || relatedKeys().length > issuePilotConfig.limits.relatedIssues }} onOk={() => { void saveRelatedIssues(); }} onCancel={() => { if (!relatedSaving()) closeRelatedEditor(); }}>
        <div class="create-issue-form related-issue-form">
          <label><span>关联工单（{selectableRelatedIssues().length} 个可选，最多选择 {issuePilotConfig.limits.relatedIssues} 个）</span><RelatedIssueSelect candidates={selectableRelatedIssues()} value={relatedKeys()} loading={relatedLoading()} inputLabel="编辑关联工单" onChange={setRelatedKeys} /></label>
          <p>保存后当前 Agent session 会关闭，并以所选工单的 metadata 和可用 Pi 对话重建只读上下文；只有具备本地开发分支的工单会附带代码快照，附件不会复制。</p>
          <Show when={relatedError()}><div class="create-error modal-form-error" role="alert">{relatedError()}</div></Show>
        </div>
      </Modal>
      <Modal open={followUpOpen()} title="创建正式跟进工单" okText="创建并关联" cancelText="取消" confirmLoading={followUpSaving()} okButtonProps={{ disabled: !followUpTitle().trim() || !followUpService() }} onOk={() => { void createFormalFollowUp(); }} onCancel={() => { if (!followUpSaving()) setFollowUpOpen(false); }}>
        <div class="create-issue-form compact-issue-form follow-up-form">
          <label><span>处理方式</span><Input aria-label="正式跟进处理方式" value="正式问题调查" disabled /></label>
          <label><span>服务</span><Select aria-label="正式跟进服务" value={followUpService()} onChange={(value) => { const selected = selectedChoice(value, productionServices().map((service) => service.key)); if (selected) setFollowUpService(selected); }} options={productionServices().map((service) => ({ value: service.key, label: service.name }))} /></label>
          <label><span>标题</span><Input aria-label="正式跟进标题" value={followUpTitle()} onInput={(event) => setFollowUpTitle(event.currentTarget.value)} /></label>
          <DescriptionField value={followUpDescription} inputLabel="正式跟进描述" expandLabel="放大正式跟进描述" onChange={setFollowUpDescription} />
          <p>新工单会关联当前开发工单，并读取其已提交分支快照和 Pi 对话；附件不会复制。</p>
          <Show when={followUpError()}><div class="create-error modal-form-error" role="alert">{followUpError()}</div></Show>
        </div>
      </Modal>
      <Modal open={scopeOpen()} title="变更处理范围" okText={scopePlan() ? "确认变更" : "预检变更"} cancelText="取消" confirmLoading={scopePlanning() || scopeApplying()} cancelButtonProps={{ disabled: scopePlanning() || scopeApplying() }} okButtonProps={{ disabled: !scopeService() }} onOk={() => { void applyScopeTransition(); }} onCancel={() => { if (!scopePlanning() && !scopeApplying()) setScopeOpen(false); }}>
        <div class="create-issue-form compact-issue-form">
          <label><span>目标处理方式</span><Select aria-label="目标处理方式" disabled={scopeApplying()} value={scopeMode()} onChange={(value) => {
            const selected = selectedChoice(value, availableScopeModes().map((option) => option.value));
            if (!selected) return;
            setScopeMode(selected);
            const environmentKind = issueScopeForWorkMode(selected).environmentKind;
            const candidates = catalog().services.filter((service) => service.deployments.some((deployment) => deployment.environmentKey === environmentKind));
            setScopeService((current) => candidates.some((service) => service.key === current) ? current : candidates[0]?.key ?? "");
            resetScopePlan();
          }} options={availableScopeModes()} /></label>
          <label><span>目标服务</span><Select aria-label="目标服务" disabled={scopeApplying()} value={scopeService()} onChange={(value) => { const selected = selectedChoice(value, availableScopeServices().map((service) => service.key)); if (selected) { setScopeService(selected); resetScopePlan(); } }} options={availableScopeServices().map((service) => ({ value: service.key, label: service.name }))} /></label>
          <Show when={scopePlan()}>{(plan) => <section class="repository-band scope-transition-preview" aria-label="范围变更预览">
            <div class="band-title"><GitBranch size={16} /><h2>{workModeLabel[plan().current.workMode]} → {workModeLabel[plan().target.workMode]}</h2></div>
            <div class="scope-transition-repositories">
              <For each={plan().repositories.retained}>{(repository) => <div class="scope-transition-repository"><strong>保留 · {repository.name}</strong><small>{repository.baseBranch}</small></div>}</For>
              <For each={plan().repositories.added}>{(repository) => <div class="scope-transition-repository"><strong>新增 · {repository.name}</strong><small>{repository.baseBranch}</small></div>}</For>
              <For each={plan().repositories.removed}>{(repository) => <div class="scope-transition-repository"><strong>移除 · {repository.name}</strong><small>{repository.baseBranch}</small></div>}</For>
              <Show when={plan().branch}><div class="scope-transition-repository"><strong>分支</strong><small>{plan().branch}</small></div></Show>
            </div>
            <p>已有对话、附件和评论将保留；{plan().session.closeCurrent ? "当前 Agent session 将关闭并按目标范围重建。" : "当前范围无需变更。"}</p>
          </section>}</Show>
          <Show when={scopeError()}><div class="create-error modal-form-error" role="alert">{scopeError()}</div></Show>
        </div>
      </Modal>
      <Modal open={editOpen()} title="编辑工单" confirmLoading={editSaving()} onOk={() => { void saveIssue(); }} onCancel={closeEditor} footer={<>
        <Button disabled={editSaving()} onClick={closeEditor}>取消</Button>
        <Button danger disabled={editSaving() || !editTitle().trim() || resetDisabled()} loading={editSaving() && editResetting()} onClick={() => { void saveIssue(true); }}>重置</Button>
        <Button type="primary" disabled={editSaving() || !editTitle().trim()} loading={editSaving() && !editResetting()} onClick={() => { void saveIssue(); }}>保存</Button>
      </>}>
        <div class="create-issue-form compact-issue-form edit-issue-form">
          <Show when={editError() || peopleError()}><div class="create-error modal-form-error" role="alert">{editError() || peopleError()}</div></Show>
          <label><span>优先级</span><Select aria-label="编辑工单优先级" value={editPriority()} onChange={(value) => { const selected = selectedChoice(value, priorityOptions.map((option) => option.value)); if (selected) setEditPriority(selected); }} options={priorityOptions} /></label>
          <label><span>处理人</span><Select aria-label="编辑工单处理人" value={editAssignee() ?? undefined} allowClear onClear={() => setEditAssignee(null)} onChange={(value) => { if (typeof value === "string" && value) setEditAssignee(value); }} options={people().filter((person) => !currentWorkMode() || canUseIssueWorkMode(person.role, currentWorkMode()!)).map((person) => ({ value: person.subject, label: `${person.name}${person.email ? ` · ${person.email}` : ""}` }))} /></label>
          <label><span>抄送人（可多选）</span><div class="multi-select-trigger"><Select mode="multiple" aria-label="编辑工单抄送人" value={editCc()} onChange={setEditCc} options={people().filter((person) => person.subject !== editAssignee()).map((person) => ({ value: person.subject, label: `${person.name}${person.email ? ` · ${person.email}` : ""}` }))} /></div></label>
          <label><span>标题</span><Input aria-label="编辑工单标题" value={editTitle()} onInput={(event) => setEditTitle(event.currentTarget.value)} /></label>
          <DescriptionField value={editDescription} inputLabel="编辑工单描述" expandLabel="放大编辑工单描述" onChange={(value) => setEditDescription(value)} />
          <IssueSessionControls issue={props.issue} disabled={editSaving()} />
          <AttachmentPicker files={editAttachments} existingFiles={() => props.issue.attachments.filter((attachment) => !removedAttachmentIds().includes(attachment.id))} inputLabel="编辑工单选择附件" onFilesChange={(files) => setEditAttachments(files)} onRemoveExisting={(id) => { setRemovedAttachmentIds((current) => [...current, id]); setEditError(""); }} onError={(message) => setEditError(message)} />
          <p class="edit-issue-reset-hint">重置会保存当前修改并创建新会话，旧对话可在历史中查看；新会话不会带入旧聊天，代码、附件和工作文件保留。</p>
        </div>
      </Modal>
    </section>
  );
}
