import type { EnvironmentKind, IssuePriority, IssueWorkMode, UserRole } from "../domain/contracts.ts";

export interface DingtalkTable { baseId: string; tableId: string; recordId: string; url: string }
export interface DingtalkField { id: string; name: string; type: string }
export const DINGTALK_COLUMNS = ["title", "description", "number", "attachments"] as const;
export type DingtalkColumns = Record<Exclude<typeof DINGTALK_COLUMNS[number], "attachments">, string> & { attachments?: string };
export interface DingtalkRecord { recordId: string; cells: Record<string, unknown> }
export interface DingtalkIssueRecord {
  recordId: string; title: string; description: string; number: string;
  attachments?: Array<{ id: string; fileName: string; size: number }>;
  creatable: boolean; reason?: string;
}
interface DingtalkUser { subject: string; name: string; email: string; role: UserRole; isAdmin?: boolean }
export interface DingtalkSourceResponse {
  user: DingtalkUser; url: string; environment?: EnvironmentKind;
  connection: { available: boolean; name: string };
}
export interface DingtalkImportInput {
  url: string; workMode: IssueWorkMode; serviceKey: string; priority: IssuePriority; startAgent: boolean; assigneeSubject?: string | null;
}
export interface DingtalkImportResponse {
  user: DingtalkUser; status: "created" | "existing"; issueKey: string;
}
