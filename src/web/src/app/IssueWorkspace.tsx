import { Badge, Button, Tag } from "../ui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";

import type { JSX } from "@solidjs/web";
import { canWriteIssueCode } from "../../../domain/contracts";
import { CheckCircle2, Code2, Download, Eye, GitBranch, Organization, MessageSquare, Paperclip, Pencil, Plus, RefreshCw } from "../ui/icons";
import { canChangeIssueScope, canModifyIssueCode, attachmentUrl, isIssueActive, relatedIssueUpdateRefusal, retryIssue, updateIssueStatus, type IssueDetail } from "../data/client";
import { IssueSessionControls } from "./IssueSessionControls";
import { IssueFiles } from "./IssueFiles";
import { IssueMarkdown } from "./IssueMarkdown";
import { useApplicationResources } from "./ApplicationResources";
import { AttachmentPreview } from "./AttachmentPreview";
import { FollowUpDialog } from "./FollowUpDialog";
import { IssueEditDialog } from "./IssueEditDialog";
import { RelatedIssuesDialog } from "./RelatedIssuesDialog";
import { ScopeTransitionDialog } from "./ScopeTransitionDialog";

import { attachmentPreviewKind } from "./file-preview";
import { errorText } from "./error-text";
import type { IssueListResource } from "./issue-list";
import {
  attachmentDisplayName,
  environmentKind,
  environmentName,
  executionBadge,
  executionState,
  fileSize,
  localDateTime,
  priorityColor,
  servicesForWorkMode,
  typeLabel,
  workModeLabel,
} from "./model";

type IssueAttachment = IssueDetail["attachments"][number];

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
  const { catalog, currentUser } = useApplicationResources();
  const [editOpen, setEditOpen] = createSignal(false, { ownedWrite: true });
  const [retrying, setRetrying] = createSignal(false, { ownedWrite: true });
  const [retryError, setRetryError] = createSignal("", { ownedWrite: true });
  const [statusSaving, setStatusSaving] = createSignal(false, { ownedWrite: true });
  const [statusError, setStatusError] = createSignal("", { ownedWrite: true });
  const [scopeOpen, setScopeOpen] = createSignal(false, { ownedWrite: true });
  const [followUpOpen, setFollowUpOpen] = createSignal(false, { ownedWrite: true });
  const [relatedOpen, setRelatedOpen] = createSignal(false, { ownedWrite: true });
  let openRelated: (() => void) | undefined, openFollowUp: (() => void) | undefined, openScope: (() => void) | undefined, openEdit: ((issue: IssueDetail) => void) | undefined;
  const [previewAttachment, setPreviewAttachment] = createSignal<IssueAttachment | null>(null, { ownedWrite: true });
  const [descriptionExpanded, setDescriptionExpanded] = createSignal(false, { ownedWrite: true });
  const descriptionNeedsCollapse = () => props.issue.description.length > 180 || props.issue.description.split("\n").length > 4;
  const issueKind = () => environmentKind(props.issue.environmentKey);
  // Active work conflicts with edits and related-Issue changes even when the server's rules pass.
  const issueActive = () => isIssueActive({ agentRunning: props.issue.agentRunning, workspaceStatus: props.issue.workspace.status });
  let issueGeneration = 0;
  onCleanup(() => {
    issueGeneration++;
  });
  createEffect(
    () => ({ issueId: props.issue.id, subject: currentUser()?.subject, role: currentUser()?.role }),
    (context, previous) => {
      if (!previous || (context.issueId === previous.issueId && context.subject === previous.subject && context.role === previous.role)) return;
      issueGeneration += 1;
      setEditOpen(false);
      setRetrying(false);
      setRetryError("");
      setStatusSaving(false);
      setStatusError("");
      setScopeOpen(false);
      setFollowUpOpen(false);
      setRelatedOpen(false);
      setPreviewAttachment(null);
      setDescriptionExpanded(false);
    },
  );
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
  const productionServices = createMemo(() => servicesForWorkMode(catalog().services, "production_analysis"));
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
              <Button
                icon={<Plus size={15} />}
                onClick={() => {
                  openFollowUp?.();
                  setFollowUpOpen(true);
                }}
              >
                创建正式跟进
              </Button>
            </Show>
            <Show when={canChangeScope()}>
              <Button
                icon={<GitBranch size={15} />}
                onClick={() => {
                  openScope?.();
                  setScopeOpen(true);
                }}
              >
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
              <Button
                icon={<Pencil size={15} />}
                disabled={issueActive()}
                onClick={() => {
                  openEdit?.(props.issue);
                  setEditOpen(true);
                }}
              >
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
                  openRelated?.();
                  setRelatedOpen(true);
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
      <RelatedIssuesDialog
        issue={props.issue}
        issueList={props.issueList}
        open={relatedOpen()}
        register={(open) => (openRelated = open)}
        onClose={() => setRelatedOpen(false)}
        onSaved={props.onUpdated}
      />
      <FollowUpDialog issue={props.issue} open={followUpOpen()} register={(open) => (openFollowUp = open)} onClose={() => setFollowUpOpen(false)} onCreated={props.onCreatedFollowUp} />
      <ScopeTransitionDialog issue={props.issue} open={scopeOpen()} register={(open) => (openScope = open)} onClose={() => setScopeOpen(false)} onApplied={props.onUpdated} />
      <IssueEditDialog
        issue={props.issue}
        open={editOpen()}
        register={(open) => (openEdit = open)}
        onClose={() => setEditOpen(false)}
        onSaved={props.onUpdated}
        onDirtyChange={props.onEditDirtyChange}
      />
    </section>
  );
}
