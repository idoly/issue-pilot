import { Badge, Button, Input, Modal, Select, Tag } from "../ui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";

import type { JSX } from "@solidjs/web";
import { canWriteIssueCode } from "../../../domain/contracts";
import { sharedConfig } from "../../../../issue-pilot.config.ts";
import { CheckCircle2, Code2, Download, Eye, GitBranch, Organization, MessageSquare, Paperclip, Pencil, Plus, RefreshCw } from "../ui/icons";
import {
  canChangeIssueScope,
  canModifyIssueCode,
  canResetIssueSession,
  canUseIssueWorkMode,
  applyIssueScopeTransition,
  attachmentUrl,
  createIssue,
  getIssue,
  isIssueActive,
  isWorkspaceBusy,
  issueWorkMode,
  planIssueScopeTransition,
  relatedIssueUpdateRefusal,
  retryIssue,
  RequestError,
  updateIssue,
  updateIssueRelatedIssues,
  updateIssueStatus,
  type IssueDetail,
  type IssuePriority,
  type IssueScopeTransitionPlan,
  type IssueWorkMode,
} from "../data/client";
import { IssueSessionControls } from "./IssueSessionControls";
import { IssueFiles } from "./IssueFiles";
import { IssueMarkdown } from "./IssueMarkdown";
import { useApplicationResources } from "./ApplicationResources";
import { AttachmentPreview } from "./AttachmentPreview";
import { AttachmentPicker, DescriptionField, RelatedIssueSelect, selectedChoice } from "./IssueForm";
import { attachmentPreviewKind } from "./file-preview";
import { errorText, type ErrorTexts } from "./error-text";
import type { IssueListResource } from "./issue-list";
import { createLatestTask } from "../data/latest";
import {
  attachmentDisplayName,
  availableWorkModes,
  environmentKind,
  environmentName,
  executionBadge,
  executionState,
  fileSize,
  localDateTime,
  personLabel,
  priorityColor,
  priorityOptions,
  servicesForWorkMode,
  typeLabel,
  workModeLabel,
} from "./model";

type IssueAttachment = IssueDetail["attachments"][number];

const editErrors: ErrorTexts = { issue_already_running: "工单正在处理，请等待处理结束后再保存。" };
// Saving relations reserves this Issue and every selected related Issue.
const relatedSaveErrors: ErrorTexts = { issue_already_running: "本工单或所选关联工单正在处理，请等待处理结束后再保存关联。" };

function IssueFileRow(props: { fileName: string; label?: string; thumbnail?: string | undefined; detail: string; href: string; icon: JSX.Element; onPreview: (() => void) | undefined }) {
  const [thumbnailFailed, setThumbnailFailed] = createSignal(false, { ownedWrite: true });
  return (
    <div class={`issue-attachment-row${props.thumbnail ? " has-thumbnail" : ""}`} title={props.fileName}>
      <Show when={props.thumbnail && !thumbnailFailed()} fallback={props.icon}>
        <button type="button" class="attachment-thumbnail" aria-label={`预览缩略图 ${props.fileName}`} onClick={props.onPreview}>
          <img src={props.thumbnail} alt="" loading="lazy" decoding="async" onError={() => setThumbnailFailed(true)} />
        </button>
      </Show>
      <Show
        when={props.onPreview}
        fallback={
          <span class="attachment-file-info">
            <strong>{props.label ?? props.fileName}</strong>
            <small>{props.detail} · 仅下载</small>
          </span>
        }
      >
        <button type="button" class="attachment-preview-trigger" aria-label={`预览 ${props.fileName}`} onClick={props.onPreview}>
          <span class="attachment-file-info">
            <strong>{props.label ?? props.fileName}</strong>
            <small>{props.detail}</small>
          </span>
          <Eye size={15} />
        </button>
      </Show>
      <a class="attachment-download-link" href={props.href} download={props.fileName} title={`下载 ${props.fileName}`} aria-label={`下载 ${props.fileName}`}>
        <Download size={15} />
      </a>
    </div>
  );
}

export function IssueWorkspace(props: {
  issue: IssueDetail;
  /** The shared Issue list supplies related-Issue candidates; opening the editor refreshes it. */
  issueList: IssueListResource;
  elementRef?: (element: HTMLElement) => void;
  hidden?: boolean;
  sourcePanel?: boolean;
  sourcePanelOpen?: boolean;
  onOpenSource: () => void;
  onUpdated: () => Promise<void>;
  onOpenIssue?: (issueKey: string) => void;
  onCreatedFollowUp: (issueKey: string) => void;
  onEditDirtyChange?: (dirty: boolean) => void;
}) {
  const { catalog, people, currentUser, peopleError } = useApplicationResources();
  const [editOpen, setEditOpen] = createSignal(false, { ownedWrite: true });
  const [editBase, setEditBase] = createSignal<IssueDetail | null>(null, { ownedWrite: true });
  const [editConflict, setEditConflict] = createSignal(false, { ownedWrite: true });
  const [editTitle, setEditTitle] = createSignal("", { ownedWrite: true });
  const [editDescription, setEditDescription] = createSignal("", { ownedWrite: true });
  const [editPriority, setEditPriority] = createSignal<IssuePriority>("p2", { ownedWrite: true });
  const [editAssignee, setEditAssignee] = createSignal<string | null>(null, { ownedWrite: true });
  const [editCc, setEditCc] = createSignal<string[]>([], { ownedWrite: true });
  const [editAttachments, setEditAttachments] = createSignal<File[]>([], { ownedWrite: true });
  const [removedAttachmentIds, setRemovedAttachmentIds] = createSignal<string[]>([], { ownedWrite: true });
  const [editSaving, setEditSaving] = createSignal(false, { ownedWrite: true });
  const [editResetting, setEditResetting] = createSignal(false, { ownedWrite: true });
  const [editCommitted, setEditCommitted] = createSignal("", { ownedWrite: true });
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
  const [relatedLoading, setRelatedLoading] = createSignal(false, { ownedWrite: true });
  const [relatedSaving, setRelatedSaving] = createSignal(false, { ownedWrite: true });
  const [relatedError, setRelatedError] = createSignal("", { ownedWrite: true });
  const [previewAttachment, setPreviewAttachment] = createSignal<IssueAttachment | null>(null, { ownedWrite: true });
  const [descriptionExpanded, setDescriptionExpanded] = createSignal(false, { ownedWrite: true });
  const descriptionNeedsCollapse = () => props.issue.description.length > 180 || props.issue.description.split("\n").length > 4;
  let issueGeneration = 0;
  const scopePlanTask = createLatestTask(),
    relatedTask = createLatestTask();
  onCleanup(() => {
    issueGeneration++;
    scopePlanTask.cancel();
    relatedTask.cancel();
  });
  createEffect(
    () => ({ issueId: props.issue.id, subject: currentUser()?.subject, role: currentUser()?.role }),
    (context, previous) => {
      if (!previous || (context.issueId === previous.issueId && context.subject === previous.subject && context.role === previous.role)) return;
      issueGeneration += 1;
      scopePlanTask.cancel();
      relatedTask.cancel();
      setEditOpen(false);
      setEditBase(null);
      setEditConflict(false);
      setEditAttachments([]);
      setRemovedAttachmentIds([]);
      setEditSaving(false);
      setEditResetting(false);
      setEditCommitted("");
      setEditError("");
      setRetrying(false);
      setRetryError("");
      setStatusSaving(false);
      setStatusError("");
      setScopeOpen(false);
      setScopePlan(null);
      setScopePlanning(false);
      setScopeApplying(false);
      setScopeError("");
      setFollowUpOpen(false);
      setFollowUpSaving(false);
      setFollowUpError("");
      setRelatedOpen(false);
      setRelatedKeys([]);
      setRelatedLoading(false);
      setRelatedSaving(false);
      setRelatedError("");
      setPreviewAttachment(null);
      setDescriptionExpanded(false);
    },
  );
  // Navigation away discards the edit dialog; the host warns while these fields differ from the Issue.
  const editDirty = () => {
    const base = editBase();
    return Boolean(
      editOpen() &&
      !editCommitted() &&
      base &&
      (editTitle().trim() !== base.title ||
        editDescription().trim() !== base.description ||
        editPriority() !== base.priority ||
        editAssignee() !== base.assigneeSubject ||
        editCc().join("\0") !== base.ccRecipients.map((person) => person.subject).join("\0") ||
        editAttachments().length > 0 ||
        removedAttachmentIds().length > 0),
    );
  };
  createEffect(editDirty, (dirty) => {
    props.onEditDirtyChange?.(dirty);
  });
  onCleanup(() => props.onEditDirtyChange?.(false));
  const initializeEditor = (issue: IssueDetail) => {
    setEditBase(issue);
    setEditConflict(false);
    setEditTitle(issue.title);
    setEditDescription(issue.description);
    setEditPriority(issue.priority);
    setEditAssignee(issue.assigneeSubject);
    setEditCc(issue.ccRecipients.map((person) => person.subject));
    setEditAttachments([]);
    setRemovedAttachmentIds([]);
    setEditError("");
  };
  const openEditor = () => {
    if (!editCommitted()) initializeEditor(props.issue);
    setEditOpen(true);
  };
  const reloadEditDraft = async () => {
    if (editSaving()) return;
    const generation = issueGeneration;
    setEditSaving(true);
    try {
      const latest = await getIssue(props.issue.id);
      if (generation === issueGeneration) initializeEditor(latest);
    } catch (error) {
      if (generation === issueGeneration) setEditError(`读取失败：${errorText(error)}。草稿仍保留。`);
    } finally {
      if (generation === issueGeneration) setEditSaving(false);
    }
  };
  const issueKind = () => environmentKind(props.issue.environmentKey);
  // Active work conflicts with the edit/reset reservation even when the server's reset rule passes.
  const issueActive = () => isIssueActive({ agentRunning: props.issue.agentRunning, workspaceStatus: props.issue.workspace.status });
  const resetDisabled = () =>
    !canResetIssueSession({ actorRole: currentUser()?.role ?? "product", status: props.issue.status, agentRunning: props.issue.agentRunning }) || isWorkspaceBusy(props.issue.workspace.status);
  const closeEditor = () => {
    setEditAttachments([]);
    setRemovedAttachmentIds([]);
    setEditOpen(false);
  };
  const markEditCommitted = (message: string) => {
    setEditCommitted(message);
    setRemovedAttachmentIds([]);
    setEditAttachments([]);
  };
  const refreshSavedIssue = async (generation: number) => {
    setEditError("");
    try {
      await props.onUpdated();
      if (issueGeneration === generation) {
        closeEditor();
        setEditCommitted("");
      }
    } catch (error) {
      if (issueGeneration === generation) setEditError(`但刷新失败：${errorText(error)}`);
    }
  };
  const retryEditRefresh = async () => {
    if (editSaving() || !editCommitted()) return;
    const generation = issueGeneration;
    setEditSaving(true);
    try {
      await refreshSavedIssue(generation);
    } finally {
      if (issueGeneration === generation) setEditSaving(false);
    }
  };
  const saveIssue = async (reset = false) => {
    const base = editBase();
    if (!base || editSaving() || editCommitted() || !editTitle().trim() || (reset && resetDisabled())) return;
    const issueId = props.issue.id;
    const generation = issueGeneration;
    const input = {
      title: editTitle().trim(),
      description: editDescription().trim(),
      priority: editPriority(),
      assigneeSubject: editAssignee(),
      ccSubjects: [...editCc()],
      expectedEditVersion: base.editVersion,
    };
    const removals = [...removedAttachmentIds()];
    const additions = [...editAttachments()];
    setEditSaving(true);
    setEditResetting(reset);
    setEditError("");
    try {
      // Save and reset are one reservation on the server; sending them separately would queue a metadata round first.
      await updateIssue(issueId, input, removals, additions, reset);
      if (issueGeneration !== generation) return;
      markEditCommitted(reset ? "工单已保存并重置" : "工单已保存");
      await refreshSavedIssue(generation);
    } catch (error) {
      if (issueGeneration !== generation) return;
      if (error instanceof RequestError && error.outcome === "committed") markEditCommitted("工单已保存，后续清理失败，请重新读取");
      else if (error instanceof Error && error.message === "issue_edit_conflict") {
        setEditConflict(true);
        setEditError("工单已被修改，当前草稿仍保留。请复制需要保留的内容，再重新载入最新工单。");
      } else setEditError(errorText(error, editErrors));
    } finally {
      if (issueGeneration === generation) {
        setEditSaving(false);
        setEditResetting(false);
      }
    }
  };
  const mayRunAgent = () => canWriteIssueCode(currentUser(), environmentKind(props.issue.environmentKey));
  const retry = async () => {
    if (!mayRunAgent()) return;
    const issueId = props.issue.id;
    const generation = issueGeneration;
    setRetrying(true);
    setRetryError("");
    try {
      await retryIssue(issueId);
      if (issueGeneration === generation) await props.onUpdated();
    } catch (error) {
      if (issueGeneration === generation) setRetryError(errorText(error));
    } finally {
      if (issueGeneration === generation) setRetrying(false);
    }
  };
  const changeStatus = async (status: "open" | "resolved") => {
    const issueId = props.issue.id;
    const generation = issueGeneration;
    setStatusSaving(true);
    setStatusError("");
    try {
      await updateIssueStatus(issueId, status);
      if (issueGeneration === generation) await props.onUpdated();
    } catch (error) {
      if (issueGeneration !== generation) return;
      if (!(error instanceof Error && error.message === "invalid_issue_status_transition")) {
        setStatusError(errorText(error));
        return;
      }
      try {
        await props.onUpdated();
        if (issueGeneration === generation && props.issue.status !== status) setStatusError("工单状态已变化，请按最新状态操作。");
      } catch {
        if (issueGeneration === generation) setStatusError("工单状态已变化，请刷新页面查看最新状态。");
      }
    } finally {
      if (issueGeneration === generation) setStatusSaving(false);
    }
  };
  const currentWorkMode = () => {
    const kind = issueKind();
    return kind && issueWorkMode(kind, props.issue.type);
  };
  // Code-changing Issues only migrate between services within their own work mode.
  const availableScopeModes = createMemo(() => {
    const kind = issueKind();
    return availableWorkModes(currentUser()?.role, catalog().services).filter(({ value }) => !kind || !canModifyIssueCode(kind) || value === currentWorkMode());
  });
  const availableScopeServices = createMemo(() => servicesForWorkMode(catalog().services, scopeMode()));
  const resetScopePlan = () => {
    scopePlanTask.cancel();
    setScopePlanning(false);
    setScopePlan(null);
    setScopeError("");
  };
  const openScopeTransition = (workMode = currentWorkMode() ?? "production_analysis") => {
    setScopeMode(workMode);
    setScopeService(props.issue.service.key);
    resetScopePlan();
    setScopeOpen(true);
  };
  const requestScopePlan = async () => {
    if (!scopeService()) return;
    const issueId = props.issue.id;
    const request = scopePlanTask.begin();
    setScopePlanning(true);
    setScopeError("");
    try {
      const plan = await planIssueScopeTransition(issueId, { serviceKey: scopeService(), workMode: scopeMode() }, request.signal);
      if (request.isCurrent()) setScopePlan(plan);
    } catch (error) {
      if (request.isCurrent()) setScopeError(errorText(error));
    } finally {
      if (request.isCurrent()) setScopePlanning(false);
      request.finish();
    }
  };
  const applyScopeTransition = async () => {
    const plan = scopePlan();
    if (!plan) {
      await requestScopePlan();
      return;
    }
    const issueId = props.issue.id;
    const generation = issueGeneration;
    setScopeApplying(true);
    setScopeError("");
    try {
      await applyIssueScopeTransition(issueId, { serviceKey: scopeService(), workMode: scopeMode() }, plan);
      if (issueGeneration !== generation) return;
      await props.onUpdated();
      if (issueGeneration === generation) setScopeOpen(false);
    } catch (error) {
      if (issueGeneration === generation) {
        setScopePlan(null);
        setScopeError(errorText(error));
      }
    } finally {
      if (issueGeneration === generation) setScopeApplying(false);
    }
  };
  const productionServices = createMemo(() => servicesForWorkMode(catalog().services, "production_analysis"));
  const openFollowUp = () => {
    setFollowUpTitle(`【正式跟进】${props.issue.title}`);
    setFollowUpDescription(props.issue.description);
    setFollowUpService(productionServices().some((service) => service.key === props.issue.service.key) ? props.issue.service.key : (productionServices()[0]?.key ?? ""));
    setFollowUpError("");
    setFollowUpOpen(true);
  };
  const createFormalFollowUp = async () => {
    if (!followUpTitle().trim() || !followUpService()) return;
    const issueId = props.issue.id;
    const generation = issueGeneration;
    setFollowUpSaving(true);
    setFollowUpError("");
    try {
      const created = await createIssue({
        title: followUpTitle().trim(),
        description: followUpDescription().trim(),
        priority: props.issue.priority,
        workMode: "production_analysis",
        serviceKey: followUpService(),
        assigneeSubject: people().some(({ subject }) => subject === props.issue.assigneeSubject) ? props.issue.assigneeSubject : null,
        ccSubjects: props.issue.ccRecipients.map(({ subject }) => subject).filter((subject) => people().some((person) => person.subject === subject)),
        relatedIssueKeys: [issueId],
      });
      if (issueGeneration !== generation) return;
      setFollowUpOpen(false);
      props.onCreatedFollowUp(created.id);
    } catch (error) {
      if (issueGeneration === generation) setFollowUpError(errorText(error));
    } finally {
      if (issueGeneration === generation) setFollowUpSaving(false);
    }
  };
  // A UI rule without a server counterpart: follow-ups read the development Issue's committed snapshot.
  const canCreateFollowUp = () =>
    canModifyIssueCode(issueKind() ?? "prod") &&
    !props.issue.agentRunning &&
    ["ready", "stopped"].includes(props.issue.workspace.status) &&
    props.issue.workspace.sourceAvailable &&
    productionServices().length > 0;
  const relatedRefusal = (onlyRemoves = false) => relatedIssueUpdateRefusal(props.issue, { onlyRemoves });
  // Resolved Issues hide the editor; a missing runtime view still permits detaching existing relations.
  const canEditRelatedIssues = () => relatedRefusal() !== "related_issue_update_not_allowed";
  const selectableRelatedIssues = createMemo(() => props.issueList.items().filter((candidate) => candidate.id !== props.issue.id));
  const closeRelatedEditor = () => {
    relatedTask.cancel();
    setRelatedOpen(false);
    setRelatedLoading(false);
  };
  const openRelatedEditor = async () => {
    const request = relatedTask.begin();
    setRelatedKeys(props.issue.relatedIssues.map(({ id }) => id));
    setRelatedError("");
    setRelatedOpen(true);
    setRelatedLoading(true);
    try {
      await props.issueList.refresh();
      if (request.isCurrent() && props.issueList.error()) setRelatedError(errorText(props.issueList.error()));
    } finally {
      if (request.isCurrent()) setRelatedLoading(false);
      request.finish();
    }
  };
  const saveRelatedIssues = async () => {
    const issueId = props.issue.id;
    const generation = issueGeneration;
    const currentKeys = new Set(props.issue.relatedIssues.map(({ id }) => id));
    // A failed related context only blocks additions; the user can still detach broken relations.
    const refusal = relatedRefusal(relatedKeys().every((id) => currentKeys.has(id)));
    if (refusal) {
      setRelatedError(errorText(refusal, relatedSaveErrors));
      return;
    }
    setRelatedSaving(true);
    setRelatedError("");
    try {
      await updateIssueRelatedIssues(issueId, relatedKeys());
      if (issueGeneration !== generation) return;
      await props.onUpdated();
      if (issueGeneration === generation) closeRelatedEditor();
    } catch (error) {
      if (issueGeneration === generation) setRelatedError(errorText(error, relatedSaveErrors));
    } finally {
      if (issueGeneration === generation) setRelatedSaving(false);
    }
  };
  const canChangeScope = () => {
    const kind = issueKind();
    return kind !== undefined && canChangeIssueScope({ environmentKind: kind, status: props.issue.status, workspaceStatus: props.issue.workspace.status, agentRunning: props.issue.agentRunning });
  };
  const branchName = () => props.issue.repositories[0]?.workingBranch ?? props.issue.repositories[0]?.baseBranch ?? "-";
  return (
    <section
      ref={props.elementRef}
      class={`issue-workspace ip-scrollbar${props.sourcePanel ? ` ip-scrollbar-dark source-detail-panel${props.sourcePanelOpen ? " details-open" : ""}` : ""}`}
      hidden={props.hidden}
    >
      <header class="issue-header">
        <div class="issue-heading">
          <div class="issue-heading-meta">
            <span>{props.issue.id}</span>
            <Tag color={priorityColor[props.issue.priority]}>{props.issue.priority.toUpperCase()}</Tag>
            <Tag>{typeLabel[props.issue.type]}</Tag>
            <Badge status={executionBadge[executionState(props.issue).key]} text={executionState(props.issue).label} />
          </div>
          <h1>{props.issue.title}</h1>
          <Show when={props.issue.description.trim()}>
            <div class={`issue-description${descriptionNeedsCollapse() ? " collapsible" : ""}${descriptionExpanded() ? " expanded" : ""}`}>
              <div class="issue-description-content">
                <IssueMarkdown issue={props.issue} source={props.issue.description} />
              </div>
              <Show when={descriptionNeedsCollapse()}>
                <button type="button" class="issue-description-toggle" aria-expanded={descriptionExpanded() ? "true" : "false"} onClick={() => setDescriptionExpanded((expanded) => !expanded)}>
                  {descriptionExpanded() ? "收起描述" : "展开完整描述"}
                </button>
              </Show>
            </div>
          </Show>
        </div>
        <div class="issue-actions">
          <Show when={props.issue.status === "pending"}>
            <Button
              class="issue-status-action"
              type="primary"
              icon={<CheckCircle2 size={15} />}
              loading={statusSaving()}
              onClick={() => {
                void changeStatus("resolved");
              }}
            >
              确认解决
            </Button>
          </Show>
          <Show when={props.issue.status === "resolved"}>
            <Button
              class="issue-status-action"
              icon={<RefreshCw size={15} />}
              loading={statusSaving()}
              onClick={() => {
                void changeStatus("open");
              }}
            >
              重新打开
            </Button>
          </Show>
          <Show when={mayRunAgent() && props.issue.status !== "resolved" && props.issue.status !== "pending" && props.issue.workspace.retryable}>
            <Button
              class="issue-status-action"
              icon={<RefreshCw size={15} />}
              loading={retrying()}
              onClick={() => {
                void retry();
              }}
            >
              {props.issue.workspace.status === "ready" ? "继续处理" : "重试处理"}
            </Button>
          </Show>
          <div class="issue-secondary-actions">
            <Show when={canCreateFollowUp()}>
              <Button icon={<Plus size={15} />} onClick={openFollowUp}>
                创建正式跟进
              </Button>
            </Show>
            <Show when={canChangeScope()}>
              <Button icon={<GitBranch size={15} />} onClick={() => openScopeTransition()}>
                变更处理范围
              </Button>
            </Show>
            <Show when={mayRunAgent() && props.issue.status === "pending" && props.issue.workspace.retryable}>
              <Button
                icon={<RefreshCw size={15} />}
                loading={retrying()}
                onClick={() => {
                  void retry();
                }}
              >
                {props.issue.workspace.status === "ready" ? "继续处理" : "重试处理"}
              </Button>
            </Show>
            <Show when={props.issue.status !== "resolved"}>
              <Button icon={<Pencil size={15} />} disabled={issueActive()} onClick={openEditor}>
                编辑工单
              </Button>
            </Show>
            <IssueSessionControls issue={props.issue} />
          </div>
        </div>
      </header>

      <Show when={retryError()}>
        <div class="workspace-error" role="alert">
          {retryError()}
        </div>
      </Show>
      <Show when={statusError()}>
        <div class="workspace-error" role="alert">
          {statusError()}
        </div>
      </Show>
      <Show when={props.issue.workspace.lastError}>
        <div class="workspace-error" role="alert">
          {errorText(props.issue.workspace.lastError)}
        </div>
      </Show>
      <section class="attachment-band issue-attachments" aria-labelledby="attachments-title">
        <div class="band-title">
          <Paperclip size={16} />
          <h2 id="attachments-title">附件</h2>
          <span>{props.issue.attachments.length}</span>
        </div>
        <div class="issue-attachment-list">
          <For each={props.issue.attachments} fallback={<div class="empty-band">暂无附件</div>}>
            {(attachment, index) => {
              const kind = attachmentPreviewKind(attachment);
              return (
                <IssueFileRow
                  fileName={attachment.fileName}
                  label={attachmentDisplayName(attachment.fileName, kind === "image", index() + 1)}
                  thumbnail={kind === "image" ? attachmentUrl(props.issue.id, attachment.id) : undefined}
                  detail={`${kind === "image" ? attachment.mediaType.slice(6).toUpperCase() : attachment.mediaType} · ${fileSize(attachment.size)}`}
                  href={attachmentUrl(props.issue.id, attachment.id)}
                  icon={<Paperclip size={15} />}
                  onPreview={kind === "unsupported" ? undefined : () => setPreviewAttachment(attachment)}
                />
              );
            }}
          </For>
        </div>
      </section>
      <Show when={canEditRelatedIssues() || props.issue.relatedIssues.length}>
        <section class="repository-band" aria-labelledby="related-issues-title">
          <div class="band-title">
            <MessageSquare size={16} />
            <h2 id="related-issues-title">关联工单</h2>
            <span>{props.issue.relatedIssues.length}</span>
            <Show when={canEditRelatedIssues()}>
              <Button
                type="text"
                icon={<Pencil size={14} />}
                disabled={issueActive()}
                onClick={() => {
                  void openRelatedEditor();
                }}
              >
                编辑关联
              </Button>
            </Show>
          </div>
          <div class="related-issue-list">
            <For each={props.issue.relatedIssues} fallback={<div class="empty-band">暂无关联工单</div>}>
              {(relatedIssue) => {
                const assignee = relatedIssue.assignee || relatedIssue.assigneeSubject || "未分配";
                const environment = () => environmentName(catalog().environments, relatedIssue.environmentKey);
                return (
                  <a
                    class="related-issue-row"
                    href={`/?issue=${encodeURIComponent(relatedIssue.id)}`}
                    aria-label={`打开关联工单 ${relatedIssue.id}`}
                    title={relatedIssue.title}
                    onClick={(event) => {
                      if (props.onOpenIssue && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                        event.preventDefault();
                        props.onOpenIssue(relatedIssue.id);
                      }
                    }}
                  >
                    <strong>{relatedIssue.id}</strong>
                    <small class="related-issue-assignee">{assignee}</small>
                    <Badge status={executionBadge[executionState(relatedIssue).key]} text={executionState(relatedIssue).label} />
                    <small class="related-issue-service">{relatedIssue.service.name}</small>
                    <small class="related-issue-environment">{environment()}</small>
                  </a>
                );
              }}
            </For>
          </div>
        </section>
      </Show>
      <Show when={props.issue.collaboratingServices.length}>
        <section class="repository-band" aria-label="协作服务">
          <div class="band-title">
            <Organization size={16} />
            <h2>协作服务</h2>
          </div>
          <div class="capability-labels">
            <For each={props.issue.collaboratingServices}>{(service) => <code>{service.name}</code>}</For>
          </div>
        </section>
      </Show>
      <Show when={props.issue.scopeTransitions.length}>
        <section class="repository-band" aria-labelledby="scope-history-title">
          <div class="band-title">
            <h2 id="scope-history-title">处理历史</h2>
            <span>{props.issue.scopeTransitions.length}</span>
          </div>
          <div class="issue-attachment-list">
            <For each={props.issue.scopeTransitions}>
              {(transition) => (
                <div class="issue-attachment-row scope-history-row">
                  <span>
                    <strong>
                      {transition.from.service.name} · {workModeLabel[transition.from.workMode]} → {transition.to.service.name} · {workModeLabel[transition.to.workMode]}
                    </strong>
                    <small class="scope-history-meta">
                      <span>{transition.actor.name}</span>
                      <time datetime={transition.createdAt}>{localDateTime(transition.createdAt)}</time>
                      <span>
                        保留 {transition.repositories.retained.length} / 新增 {transition.repositories.added.length} / 移除 {transition.repositories.removed.length}
                      </span>
                    </small>
                  </span>
                </div>
              )}
            </For>
          </div>
        </section>
      </Show>
      <section class="repository-band" aria-labelledby="repositories-title">
        <div class="band-title">
          <GitBranch size={16} />
          <h2 id="repositories-title">代码分支</h2>
        </div>
        <div class="issue-branch-row">
          <code title={branchName()}>{branchName()}</code>
          <Show when={props.issue.workspace.sourceAvailable && !props.sourcePanel}>
            <Button class="icon-button" type="text" shape="circle" icon={<Code2 size={15} />} title="浏览工单代码" aria-label="浏览工单代码" onClick={props.onOpenSource} />
          </Show>
        </div>
      </section>

      <Show when={props.issue.workingDirectory}>
        <IssueFiles issue={props.issue} hidden={props.hidden} />
      </Show>
      <AttachmentPreview issueKey={props.issue.id} attachment={previewAttachment()} onClose={() => setPreviewAttachment(null)} />
      <Modal
        open={relatedOpen()}
        title="编辑关联工单"
        okText="保存关联"
        cancelText="取消"
        confirmLoading={relatedSaving()}
        cancelButtonProps={{ disabled: relatedSaving() }}
        okButtonProps={{ disabled: relatedLoading() || relatedKeys().length > sharedConfig.limits.relatedIssues }}
        onOk={() => {
          void saveRelatedIssues();
        }}
        onCancel={() => {
          if (!relatedSaving()) closeRelatedEditor();
        }}
      >
        <div class="create-issue-form related-issue-form">
          <label>
            <span>
              关联工单（{selectableRelatedIssues().length} 个可选，最多选择 {sharedConfig.limits.relatedIssues} 个）
            </span>
            <RelatedIssueSelect candidates={selectableRelatedIssues()} value={relatedKeys()} loading={relatedLoading()} inputLabel="编辑关联工单" onChange={setRelatedKeys} />
          </label>
          <p>保存后将关闭当前会话。下次运行会使用所选工单的资料和可用对话作为只读上下文；有本地开发分支时也会提供代码快照。</p>
          <Show when={relatedError()}>
            <div class="create-error modal-form-error" role="alert">
              {relatedError()}
            </div>
          </Show>
        </div>
      </Modal>
      <Modal
        open={followUpOpen()}
        title="创建正式跟进工单"
        okText="创建并关联"
        cancelText="取消"
        confirmLoading={followUpSaving()}
        okButtonProps={{ disabled: !followUpTitle().trim() || !followUpService() }}
        onOk={() => {
          void createFormalFollowUp();
        }}
        onCancel={() => {
          if (!followUpSaving()) setFollowUpOpen(false);
        }}
      >
        <div class="create-issue-form compact-issue-form follow-up-form">
          <label>
            <span>处理方式</span>
            <Input aria-label="正式跟进处理方式" value="正式问题调查" disabled />
          </label>
          <label>
            <span>服务</span>
            <Select
              aria-label="正式跟进服务"
              value={followUpService()}
              onChange={(value) => {
                const selected = selectedChoice(
                  value,
                  productionServices().map((service) => service.key),
                );
                if (selected) setFollowUpService(selected);
              }}
              options={productionServices().map((service) => ({ value: service.key, label: service.name }))}
            />
          </label>
          <label>
            <span>标题</span>
            <Input aria-label="正式跟进标题" value={followUpTitle()} onInput={(event) => setFollowUpTitle(event.currentTarget.value)} />
          </label>
          <DescriptionField value={followUpDescription} inputLabel="正式跟进描述" expandLabel="放大正式跟进描述" onChange={setFollowUpDescription} />
          <p>新工单会关联当前开发工单，并读取其已提交分支快照和 Pi 对话；附件不会复制。</p>
          <Show when={followUpError()}>
            <div class="create-error modal-form-error" role="alert">
              {followUpError()}
            </div>
          </Show>
        </div>
      </Modal>
      <Modal
        open={scopeOpen()}
        title="变更处理范围"
        okText={scopePlan() ? "确认变更" : "预检变更"}
        cancelText="取消"
        confirmLoading={scopePlanning() || scopeApplying()}
        cancelButtonProps={{ disabled: scopePlanning() || scopeApplying() }}
        okButtonProps={{ disabled: !scopeService() }}
        onOk={() => {
          void applyScopeTransition();
        }}
        onCancel={() => {
          if (!scopePlanning() && !scopeApplying()) setScopeOpen(false);
        }}
      >
        <div class="create-issue-form compact-issue-form">
          <label>
            <span>目标处理方式</span>
            <Select
              aria-label="目标处理方式"
              disabled={scopeApplying()}
              value={scopeMode()}
              onChange={(value) => {
                const selected = selectedChoice(
                  value,
                  availableScopeModes().map((option) => option.value),
                );
                if (!selected) return;
                setScopeMode(selected);
                const candidates = servicesForWorkMode(catalog().services, selected);
                setScopeService((current) => (candidates.some((service) => service.key === current) ? current : (candidates[0]?.key ?? "")));
                resetScopePlan();
              }}
              options={availableScopeModes()}
            />
          </label>
          <label>
            <span>目标服务</span>
            <Select
              aria-label="目标服务"
              disabled={scopeApplying()}
              value={scopeService()}
              onChange={(value) => {
                const selected = selectedChoice(
                  value,
                  availableScopeServices().map((service) => service.key),
                );
                if (selected) {
                  setScopeService(selected);
                  resetScopePlan();
                }
              }}
              options={availableScopeServices().map((service) => ({ value: service.key, label: service.name }))}
            />
          </label>
          <Show when={scopePlan()}>
            {(plan) => (
              <section class="repository-band scope-transition-preview" aria-label="范围变更预览">
                <div class="band-title">
                  <GitBranch size={16} />
                  <h2>
                    {workModeLabel[plan().current.workMode]} → {workModeLabel[plan().target.workMode]}
                  </h2>
                </div>
                <div class="scope-transition-repositories">
                  <For each={plan().repositories.retained}>
                    {(repository) => (
                      <div class="scope-transition-repository">
                        <strong>保留 · {repository.name}</strong>
                        <small>{repository.baseBranch}</small>
                      </div>
                    )}
                  </For>
                  <For each={plan().repositories.added}>
                    {(repository) => (
                      <div class="scope-transition-repository">
                        <strong>新增 · {repository.name}</strong>
                        <small>{repository.baseBranch}</small>
                      </div>
                    )}
                  </For>
                  <For each={plan().repositories.removed}>
                    {(repository) => (
                      <div class="scope-transition-repository">
                        <strong>移除 · {repository.name}</strong>
                        <small>{repository.baseBranch}</small>
                      </div>
                    )}
                  </For>
                  <Show when={plan().branch}>
                    <div class="scope-transition-repository">
                      <strong>分支</strong>
                      <small>{plan().branch}</small>
                    </div>
                  </Show>
                </div>
                <p>已有对话和附件将保留；{plan().session.closeCurrent ? "当前 Agent session 将关闭并按目标范围重建。" : "当前范围无需变更。"}</p>
              </section>
            )}
          </Show>
          <Show when={scopeError()}>
            <div class="create-error modal-form-error" role="alert">
              {scopeError()}
            </div>
          </Show>
        </div>
      </Modal>
      <Modal
        open={editOpen()}
        title="编辑工单"
        confirmLoading={editSaving()}
        onOk={() => {
          void saveIssue();
        }}
        onCancel={closeEditor}
        footer={
          <>
            <Button disabled={editSaving()} onClick={closeEditor}>
              {editCommitted() ? "关闭" : "取消"}
            </Button>
            <Show
              when={editCommitted()}
              fallback={
                <>
                  <Button
                    danger
                    disabled={editSaving() || !editTitle().trim() || resetDisabled()}
                    loading={editSaving() && editResetting()}
                    onClick={() => {
                      void saveIssue(true);
                    }}
                  >
                    重置
                  </Button>
                  <Button
                    type="primary"
                    disabled={editSaving() || !editTitle().trim()}
                    loading={editSaving() && !editResetting()}
                    onClick={() => {
                      void saveIssue();
                    }}
                  >
                    保存
                  </Button>
                </>
              }
            >
              <Button type="primary" disabled={editSaving()} loading={editSaving()} onClick={() => void retryEditRefresh()}>
                重新读取
              </Button>
            </Show>
          </>
        }
      >
        <Show
          when={!editCommitted()}
          fallback={
            <p role={editSaving() && !editError() ? "status" : "alert"}>
              {editCommitted()}
              {editError() ? `，${editError()}` : "。"}
            </p>
          }
        >
          <div class="create-issue-form compact-issue-form edit-issue-form">
            <Show when={editError() || peopleError()}>
              <div class="create-error modal-form-error" role="alert">
                {editError() || peopleError()}
                <Show when={editConflict()}>
                  <Button size="small" disabled={editSaving()} onClick={() => void reloadEditDraft()}>
                    重新载入（放弃草稿）
                  </Button>
                </Show>
              </div>
            </Show>
            <label>
              <span>优先级</span>
              <Select
                aria-label="编辑工单优先级"
                value={editPriority()}
                onChange={(value) => {
                  const selected = selectedChoice(
                    value,
                    priorityOptions.map((option) => option.value),
                  );
                  if (selected) setEditPriority(selected);
                }}
                options={priorityOptions}
              />
            </label>
            <label>
              <span>处理人</span>
              <Select
                aria-label="编辑工单处理人"
                value={editAssignee() ?? undefined}
                allowClear
                onClear={() => setEditAssignee(null)}
                onChange={(value) => {
                  if (typeof value === "string" && value) setEditAssignee(value);
                }}
                options={people()
                  .filter((person) => !currentWorkMode() || canUseIssueWorkMode(person.role, currentWorkMode()!))
                  .map((person) => ({ value: person.subject, label: personLabel(person) }))}
              />
            </label>
            <label>
              <span>抄送人</span>
              <div class="multi-select-trigger">
                <Select
                  mode="multiple"
                  aria-label="编辑工单抄送人"
                  value={editCc()}
                  onChange={setEditCc}
                  options={people()
                    .filter((person) => person.subject !== editAssignee())
                    .map((person) => ({ value: person.subject, label: personLabel(person) }))}
                />
              </div>
            </label>
            <label>
              <span>标题</span>
              <Input aria-label="编辑工单标题" value={editTitle()} onInput={(event) => setEditTitle(event.currentTarget.value)} />
            </label>
            <DescriptionField value={editDescription} inputLabel="编辑工单描述" expandLabel="放大编辑工单描述" onChange={(value) => setEditDescription(value)} />
            <AttachmentPicker
              files={editAttachments}
              existingFiles={() => (editBase()?.attachments ?? []).filter((attachment) => !removedAttachmentIds().includes(attachment.id))}
              inputLabel="编辑工单选择附件"
              onFilesChange={(files) => setEditAttachments(files)}
              onRemoveExisting={(id) => {
                setRemovedAttachmentIds((current) => [...current, id]);
                setEditError("");
              }}
              onError={(message) => setEditError(message)}
            />
            <p class="edit-issue-reset-hint">重置会保存当前修改并创建新会话，旧对话可在历史中查看；新会话不会带入旧聊天，代码、附件和工作文件保留。</p>
          </div>
        </Show>
      </Modal>
    </section>
  );
}
