import type { IssueWorkMode } from "../domain/contracts.ts";

export const SCOPE_TRANSITION_ACTIONS = ["none", "rebind_read_only", "convert_to_development", "migrate_development"] as const;
export type ScopeTransitionAction = (typeof SCOPE_TRANSITION_ACTIONS)[number];

export interface PlannedRepository {
  name: string;
  url: string;
  baseBranch: string;
}

/** Preflight projection of a scope change; the Web renders it and the server revalidates it before applying. */
export interface ScopeTransitionPlan {
  planHash: string;
  expectedIssueUpdatedAt: string;
  action: ScopeTransitionAction;
  current: {
    service: { key: string; name: string };
    workMode: IssueWorkMode;
    repositoryAccess: "read" | "write";
  };
  target: {
    service: { key: string; name: string };
    workMode: IssueWorkMode;
    repositoryAccess: "read" | "write";
  };
  repositories: {
    retained: PlannedRepository[];
    added: PlannedRepository[];
    removed: PlannedRepository[];
  };
  branch: string | null;
  session: { closeCurrent: boolean; preserveConversation: true };
  preserved: ["attachments", "conversation"];
  warnings: string[];
}

/** Applied scope change, as shown in the Issue's audit history. */
export interface ScopeTransitionHistoryItem {
  id: string;
  action: ScopeTransitionAction;
  from: { service: { key: string; name: string }; workMode: IssueWorkMode };
  to: { service: { key: string; name: string }; workMode: IssueWorkMode };
  repositories: { retained: string[]; added: string[]; removed: string[] };
  planHash: string;
  actor: { subject: string; name: string };
  createdAt: string;
}
