import type { IssuePriority, IssueStatus, IssueType, UserRole, WorkspaceStatus } from "../domain/contracts.ts";
import type { ScopeTransitionHistoryItem, ScopeTransitionPlan } from "../workspace/scope-contracts.ts";

/**
 * Response projections shared with the Web client. The Web imports these as types only, so a server field
 * change breaks the Web typecheck instead of silently drifting from a hand-written copy.
 */

export interface Person {
  subject: string;
  name: string;
  email: string;
  role: UserRole;
  isAdmin?: boolean;
}

export interface CurrentUser extends Person {
  identityLocked: boolean;
}

export interface ManagedUser extends Person {
  revision: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ManagedRepository {
  revision: number;
  id: string;
  name: string;
  url: string;
  group: string;
  createdAt: string;
  updatedAt: string;
  services: Array<{ key: string; name: string }>;
}

export interface IssueListItem {
  id: string;
  title: string;
  priority: IssuePriority;
  type: IssueType;
  status: IssueStatus;
  assignee: string | null;
  assigneeSubject: string | null;
  reporterSubject: string;
  /** Sorted CC recipient subjects; the detail additionally carries their profiles in ccRecipients. */
  ccSubjects: string[];
  service: { key: string; name: string };
  environmentKey: string;
  /** Opaque server change token covering Issue, Workspace and Agent state. */
  revision: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueExecutionItem extends IssueListItem {
  workspaceStatus: WorkspaceStatus;
  agentRunning: boolean;
  resolvedAt: string | null;
}

export interface IssueDetail extends IssueExecutionItem {
  editVersion: string;
  description: string;
  repositories: Array<{ name: string; url: string; baseBranch: string; workingBranch: string | null }>;
  workspace: { status: WorkspaceStatus; sourceAvailable: boolean; runtimeReady: boolean; lastError: string | null; retryable: boolean };
  workingDirectory: string;
  attachments: Array<{ id: string; fileName: string; storedFileName: string; mediaType: string; size: number; sha256: string; createdAt: string }>;
  collaboratingServices: Array<{ key: string; name: string }>;
  relatedIssues: IssueExecutionItem[];
  scopeTransitions: ScopeTransitionHistoryItem[];
  ccRecipients: Person[];
  reporter?: Person | undefined;
}

export interface IssueScopeTransitionPlan extends ScopeTransitionPlan {}

export interface WorkspaceStats {
  sampledAt: string;
  totalBytes: number;
  sharedGitBytes: number;
  policy: { retentionHours: number | null; highWaterBytes: number; targetBytes: number; maintenanceIntervalMinutes: number };
  workspaces: Array<{ issueKey: string; issueStatus: IssueStatus; workspaceStatus: WorkspaceStatus; resolvedAt: string | null; bytes: number; releasable: boolean; blockedReason: string | null }>;
}

export interface WorkspaceStatsState {
  snapshot: WorkspaceStats | null;
  sampling: boolean;
  error: string | null;
}
