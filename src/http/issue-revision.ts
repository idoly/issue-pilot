import type { AgentRunState, IssuePriority, IssueStatus, IssueType, WorkspaceStatus } from "../domain/contracts.ts";

export interface IssueRevisionInput {
  issue: {
    title: string;
    priority: IssuePriority;
    type: IssueType;
    status: IssueStatus;
    resolvedAt: Date | null;
    updatedAt: Date;
    assigneeSubject: string | null;
  };
  service: { key: string; name: string };
  environmentKey: string;
  /** Display name joined from the subject row; a rename must invalidate an open detail. */
  assignee: string | null;
  workspace: { status: WorkspaceStatus | null; updatedAt: Date | null; runtimeReady: boolean | null; releasedAt: Date | null; lastError: string | null } | undefined;
  runState: AgentRunState;
}

/**
 * One opaque change token for list rows, detail, related-Issue summaries and SSE snapshots.
 * It covers every joined display fact plus Workspace and Agent state, so views need no field list.
 */
export function issueRevision({ issue, service, environmentKey, assignee, workspace, runState }: IssueRevisionInput): string {
  return JSON.stringify([
    issue.title,
    issue.priority,
    issue.type,
    issue.status,
    issue.resolvedAt?.toISOString() ?? null,
    issue.updatedAt.toISOString(),
    issue.assigneeSubject,
    assignee,
    service.key,
    service.name,
    environmentKey,
    workspace?.status ?? "not_created",
    workspace?.updatedAt?.toISOString() ?? null,
    workspace?.runtimeReady === true,
    workspace?.releasedAt?.toISOString() ?? null,
    workspace?.lastError ?? null,
    runState,
  ]);
}
