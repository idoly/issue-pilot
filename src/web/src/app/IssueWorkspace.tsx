import { Badge, Button, Input, Modal, Segmented, Select, Tag, TextArea } from "../ui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";

import type { JSX } from "@solidjs/web";
import { issuePilotConfig } from "../../../../issue-pilot.config.ts";
import { CheckCircle2, Code2, Download, Eye, File, GitBranch, MessageSquare, Paperclip, Pencil, Plus, RefreshCw, Send } from "../ui/icons";
import { canUseIssueWorkMode, addIssueComment, applyIssueScopeTransition, attachmentUrl, createIssue, errorMessage, isWorkspaceBusy, issueScopeForWorkMode, issueWorkMode, listIssues, outputUrl, planIssueScopeTransition, retryIssue, updateIssue, updateIssueRelatedIssues, updateIssueStatus, type IssueDetail, type IssueExecutionItem, type IssuePriority, type IssueScopeTransitionPlan, type IssueWorkMode } from "../data/client";
import { IssueFiles } from "./IssueFiles";
import { Markdown } from "../ui/Markdown";
import { useApplicationResources } from "./ApplicationResources";
import { OutputPreview } from "./OutputPreview";
import { AttachmentPreview } from "./AttachmentPreview";
import { AttachmentPicker, DescriptionField, RelatedIssueSelect, selectedChoice } from "./IssueForm";
import { attachmentPreviewKind, outputPreviewUnavailable } from "./file-preview";
import { fileSize, priorityColor, priorityOptions, statusBadge, statusLabel, typeLabel, workModeLabel, workModeOptions } from "./model";

type IssueAttachment = IssueDetail["attachments"][number];

function IssueFileRow(props: { fileName: string; detail: string; href: string; icon: JSX.Element; onPreview: (() => void) | undefined }) {
  return <div class="issue-attachment-row" title={props.fileName}>
    {props.icon}
    <Show when={props.onPreview} fallback={<span class="attachment-file-info"><strong>{props.fileName}</strong><small>{props.detail} · 仅下载</small></span>}>
      <button type="button" class="attachment-preview-trigger" aria-label={`预览 ${props.fileName}`} onClick={props.onPreview}><span class="attachment-file-info"><strong>{props.fileName}</strong><small>{props.detail}</small></span><Eye size={15} /></button>
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
const commentDateTimeFormat = new Intl.DateTimeFormat(issuePilotConfig.regional.locale, dateTimeOptions);

function localDateTime(value: string, includeYear = true): string {
  return (includeYear ? issueDateTimeFormat : commentDateTimeFormat).format(new Date(value));
}

export function IssueWorkspace(props: { issue: IssueDetail; elementRef?: (element: HTMLElement) => void; hidden?: boolean; sourcePanel?: boolean; sourcePanelOpen?: boolean; onOpenSource: () => void; onUpdated: () => Promise<void>; onCreatedFollowUp: (issueKey: string) => void }) {
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
  const [commentBody, setCommentBody] = createSignal("", { ownedWrite: true });
  const [commentSaving, setCommentSaving] = createSignal(false, { ownedWrite: true });
  const [commentMode, setCommentMode] = createSignal<"edit" | "preview">("edit", { ownedWrite: true });
  const [commentError, setCommentError] = createSignal("", { ownedWrite: true });
  const [previewOutput, setPreviewOutput] = createSignal<IssueDetail["outputs"][number] | null>(null, { ownedWrite: true });
  const [previewAttachment, setPreviewAttachment] = createSignal<IssueAttachment | null>(null, { ownedWrite: true });
  const [descriptionExpanded, setDescriptionExpanded] = createSignal(false, { ownedWrite: true });
  const descriptionNeedsCollapse = () => props.issue.description.length > 180 || props.issue.description.split("\n").length > 4;
  let issueGeneration = 0, scopePlanRequest = 0, relatedRequest = 0;
  onCleanup(() => { issueGeneration++; scopePlanRequest++; relatedRequest++; });
  createEffect(() => ({ issueId: props.issue.id, subject: currentUser()?.subject, role: currentUser()?.role }), (context, previous) => {
    if (!previous || context.issueId === previous.issueId && context.subject === previous.subject && context.role === previous.role) return;
    issueGeneration += 1;
    setEditOpen(false); setEditAttachments([]); setRemovedAttachmentIds([]); setEditSaving(false); setEditError("");
    setRetrying(false); setRetryError(""); setStatusSaving(false); setStatusError(""); setScopeOpen(false); setScopePlan(null); setScopePlanning(false); setScopeApplying(false); setScopeError("");
    setFollowUpOpen(false); setFollowUpSaving(false); setFollowUpError("");
    setRelatedOpen(false); setRelatedKeys([]); setRelatedCandidates([]); setRelatedLoading(false); setRelatedSaving(false); setRelatedError("");
    setCommentBody(""); setCommentSaving(false); setCommentMode("edit"); setCommentError(""); setPreviewAttachment(null); setPreviewOutput(null); setDescriptionExpanded(false);
  });
  const openEditor = () => {
    setEditTitle(props.issue.title); setEditDescription(props.issue.description); setEditPriority(props.issue.priority);
    setEditAssignee(props.issue.assigneeSubject); setEditCc((props.issue.ccRecipients ?? []).map((person) => person.subject));
    setEditAttachments([]);
    setRemovedAttachmentIds([]);
    setEditError(""); setEditOpen(true);
  };
  const saveIssue = async () => {
    if (editSaving() || !editTitle().trim()) return;
    const issueId = props.issue.id;
    const generation = issueGeneration;
    const input = { title: editTitle().trim(), description: editDescription().trim(), priority: editPriority(), assigneeSubject: editAssignee(), ccSubjects: [...editCc()] };
    const removals = [...removedAttachmentIds()];
    const additions = [...editAttachments()];
    setEditSaving(true); setEditError("");
    try {
      await updateIssue(issueId, input, removals, additions);
      if (issueGeneration !== generation) return;
      setRemovedAttachmentIds([]); setEditAttachments([]);
      await props.onUpdated();
      if (issueGeneration === generation) setEditOpen(false);
    } catch (error) {
      if (issueGeneration === generation) setEditError(errorMessage(error));
    } finally { if (issueGeneration === generation) setEditSaving(false); }
  };
  const submitComment = async () => {
    const body = commentBody().trim();
    if (commentSaving() || !body) return;
    const issueId = props.issue.id;
    const generation = issueGeneration;
    setCommentSaving(true); setCommentError("");
    try {
      await addIssueComment(issueId, body);
      if (issueGeneration !== generation) return;
      if (commentBody().trim() === body) { setCommentBody(""); setCommentMode("edit"); }
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
  const currentWorkMode = () => issueWorkMode(props.issue.environmentKey as "prod" | "test" | "dev", props.issue.type);
  const outputs = () => props.issue.outputs ?? [];
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
  const environmentName = () => catalog().environments.find((environment) => environment.key === props.issue.environmentKey)?.name ?? props.issue.environmentKey;
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
              <div class="issue-description-content"><Markdown source={props.issue.description} /></div>
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

      <div class="issue-facts">
        <div><span>处理人</span><strong>{props.issue.assignee ?? "未分配"}</strong></div>
        <div><span>创建人</span><strong>{props.issue.reporter?.name ?? "-"}</strong></div>
        <div><span>入口服务</span><strong>{props.issue.service.name}</strong></div>
        <div><span>环境</span><strong>{environmentName()}</strong></div>
        <div><span>创建时间</span><strong>{localDateTime(props.issue.createdAt ?? props.issue.updatedAt)}</strong></div>
        <div><span>抄送人</span><strong>{props.issue.ccRecipients?.map((person) => person.name).join("、") || "无"}</strong></div>
      </div>
      <Show when={retryError()}><div class="workspace-error" role="alert">{retryError()}</div></Show>
      <Show when={statusError()}><div class="workspace-error" role="alert">{statusError()}</div></Show>
      <Show when={props.issue.workspace.lastError}><div class="workspace-error" role="alert">{props.issue.workspace.lastError}</div></Show>
      <Show when={(props.issue.scopeTransitions ?? []).length}>
        <section class="repository-band" aria-labelledby="scope-history-title">
          <div class="band-title"><GitBranch size={16} /><h2 id="scope-history-title">处理范围历史</h2><span>{props.issue.scopeTransitions?.length ?? 0}</span></div>
          <div class="issue-attachment-list">
            <For each={props.issue.scopeTransitions ?? []}>{(transition) => (
              <div class="issue-attachment-row scope-history-row">
                <GitBranch size={15} />
                <span>
                  <strong>{transition.from.service.name} · {workModeLabel[transition.from.workMode]} → {transition.to.service.name} · {workModeLabel[transition.to.workMode]}</strong>
                  <small>{transition.actor.name} · {localDateTime(transition.createdAt)} · 保留 {transition.repositories.retained.length} / 新增 {transition.repositories.added.length} / 移除 {transition.repositories.removed.length}</small>
                </span>
              </div>
            )}</For>
          </div>
        </section>
      </Show>
      <Show when={props.issue.collaboratingServices?.length}>
        <section class="repository-band" aria-label="协作服务"><div class="band-title"><GitBranch size={16} /><h2>协作服务</h2></div><div class="capability-labels"><For each={props.issue.collaboratingServices ?? []}>{(service) => <code>{service.name}</code>}</For></div></section>
      </Show>
      <Show when={canEditRelatedIssues() || (props.issue.relatedIssues ?? []).length}>
        <section class="repository-band" aria-labelledby="related-issues-title">
          <div class="band-title"><MessageSquare size={16} /><h2 id="related-issues-title">关联工单</h2><span>{props.issue.relatedIssues?.length ?? 0}</span><Show when={canEditRelatedIssues()}><Button type="text" icon={<Pencil size={14} />} disabled={Boolean(props.issue.agentRunning) || isWorkspaceBusy(props.issue.workspace.status)} onClick={() => { void openRelatedEditor(); }}>编辑关联</Button></Show></div>
          <div class="issue-attachment-list">
            <For each={props.issue.relatedIssues ?? []} fallback={<div class="empty-band">暂无关联工单</div>}>{(relatedIssue) => <div class="issue-attachment-row"><GitBranch size={15} /><span><strong>{relatedIssue.id}</strong><small>{relatedIssue.title} · {relatedIssue.service.name} / {relatedIssue.environmentKey}</small></span></div>}</For>
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

      <Show when={currentWorkMode() === "production_data" || outputs().length}>
        <section class="attachment-band" aria-labelledby="outputs-title">
          <div class="band-title"><File size={16} /><h2 id="outputs-title">成果文件</h2><span>{outputs().length}</span></div>
          <div class="issue-attachment-list">
            <For each={outputs()} fallback={<div class="empty-band">Agent 尚未生成成果文件</div>}>
              {(output) => <IssueFileRow fileName={output.fileName} detail={`${fileSize(output.size)} · ${localDateTime(output.updatedAt, false)}`} href={outputUrl(props.issue.id, output.fileName)} icon={<File size={15} />} onPreview={outputPreviewUnavailable(output) ? undefined : () => setPreviewOutput(output)} />}
            </For>
          </div>
        </section>
      </Show>

      <Show when={props.issue.workingDirectory}><IssueFiles issue={props.issue} hidden={props.hidden} /></Show>
      <section class="attachment-band" aria-labelledby="attachments-title">
        <div class="band-title"><Paperclip size={16} /><h2 id="attachments-title">附件</h2><span>{props.issue.attachments.length}</span></div>
        <div class="issue-attachment-list">
          <For each={props.issue.attachments} fallback={<div class="empty-band">暂无附件</div>}>
            {(attachment) => <IssueFileRow fileName={attachment.fileName} detail={`${attachment.mediaType} · ${fileSize(attachment.size)}`} href={attachmentUrl(props.issue.id, attachment.id)} icon={<Paperclip size={15} />} onPreview={attachmentPreviewKind(attachment) === "unsupported" ? undefined : () => setPreviewAttachment(attachment)} />}
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
          <div class="markdown-editor-toolbar"><Segmented aria-label="评论编辑模式" value={commentMode()} options={[{ value: "edit", label: "编辑" }, { value: "preview", label: "预览" }]} onChange={(value) => setCommentMode(value as "edit" | "preview")} /></div>
          <Show when={commentMode() === "edit"} fallback={<div class="comment-markdown-preview"><Show when={commentBody().trim()} fallback={<span class="muted">暂无内容</span>}><Markdown source={commentBody()} /></Show></div>}>
            <TextArea aria-label="添加评论或备注" placeholder="添加评论或备注" autoSize={{ minRows: 3, maxRows: 8 }} value={commentBody()} onInput={(event) => setCommentBody(event.currentTarget.value)} />
          </Show>
          <div class="comment-actions"><Show when={commentError()}><span class="comment-error" role="alert">{commentError()}</span></Show><Button type="primary" icon={<Send size={14} />} loading={commentSaving()} disabled={!commentBody().trim()} onClick={() => { void submitComment(); }}>发布评论</Button></div>
        </div>
      </section>
      <OutputPreview issueKey={props.issue.id} output={previewOutput()} onClose={() => setPreviewOutput(null)} />
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
      <Modal open={editOpen()} title="编辑工单" okText="保存" cancelText="取消" confirmLoading={editSaving()} okButtonProps={{ disabled: !editTitle().trim() }} onOk={() => { void saveIssue(); }} onCancel={() => { setEditAttachments([]); setRemovedAttachmentIds([]); setEditOpen(false); }}>
        <div class="create-issue-form compact-issue-form edit-issue-form">
          <Show when={editError() || peopleError()}><div class="create-error modal-form-error" role="alert">{editError() || peopleError()}</div></Show>
          <label><span>优先级</span><Select aria-label="编辑工单优先级" value={editPriority()} onChange={(value) => { const selected = selectedChoice(value, priorityOptions.map((option) => option.value)); if (selected) setEditPriority(selected); }} options={priorityOptions} /></label>
          <label><span>处理人</span><Select aria-label="编辑工单处理人" value={editAssignee() ?? undefined} allowClear onClear={() => setEditAssignee(null)} onChange={(value) => { if (typeof value === "string" && value) setEditAssignee(value); }} options={people().filter((person) => !currentWorkMode() || canUseIssueWorkMode(person.role, currentWorkMode()!)).map((person) => ({ value: person.subject, label: `${person.name}${person.email ? ` · ${person.email}` : ""}` }))} /></label>
          <label><span>抄送人（可多选）</span><div class="multi-select-trigger"><Select mode="multiple" aria-label="编辑工单抄送人" value={editCc()} onChange={setEditCc} options={people().filter((person) => person.subject !== editAssignee()).map((person) => ({ value: person.subject, label: `${person.name}${person.email ? ` · ${person.email}` : ""}` }))} /></div></label>
          <label><span>标题</span><Input aria-label="编辑工单标题" value={editTitle()} onInput={(event) => setEditTitle(event.currentTarget.value)} /></label>
          <DescriptionField value={editDescription} inputLabel="编辑工单描述" expandLabel="放大编辑工单描述" onChange={(value) => setEditDescription(value)} />
          <AttachmentPicker files={editAttachments} existingFiles={() => props.issue.attachments.filter((attachment) => !removedAttachmentIds().includes(attachment.id))} inputLabel="编辑工单选择附件" onFilesChange={(files) => setEditAttachments(files)} onRemoveExisting={(id) => { setRemovedAttachmentIds((current) => [...current, id]); setEditError(""); }} onError={(message) => setEditError(message)} />
        </div>
      </Modal>
    </section>
  );
}
