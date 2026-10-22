import type { EnvironmentKind, IssuePriority, IssueWorkMode, UserRole } from "../domain/contracts.ts";

export interface DingtalkTable { baseId: string; tableId: string; url: string }
export interface DingtalkField { id: string; name: string; type: string }
export const DINGTALK_COLUMNS = ["title", "description", "assignee", "status", "module", "number", "attachments"] as const;
export type DingtalkColumns = Record<Exclude<typeof DINGTALK_COLUMNS[number], "attachments">, string> & { attachments?: string };
export interface DingtalkRecord { recordId: string; cells: Record<string, unknown> }
export interface DingtalkPreviewRecord {
  recordId: string; title: string; description: string; assignee: string; status: string; module: string; number: string;
  attachments?: Array<{ id: string; fileName: string; size: number }>;
  creatable: boolean; reason?: string; token: string; issueKey?: string;
}
interface DingtalkUser { subject: string; name: string; email: string; role: UserRole; isAdmin?: boolean }
export interface DingtalkSourceResponse {
  user: DingtalkUser; url: string; assignee: string; environment?: EnvironmentKind;
  connection: { available: boolean; kind: "personal" | "shared"; name: string };
}
export interface DingtalkPreviewInput { url: string; columns?: Partial<DingtalkColumns>; cursor?: string }
export interface DingtalkPreviewResponse {
  user: DingtalkUser; fields: DingtalkField[]; columns: DingtalkColumns; records: DingtalkPreviewRecord[];
  cursor: string; scanned: number; statusOptions: string[]; needsMapping: boolean; skippedImported?: number;
}
export interface DingtalkImportInput extends Omit<DingtalkPreviewInput, "cursor"> {
  records: Array<{ recordId: string; token: string }>; workMode: IssueWorkMode; serviceKey: string; priority: IssuePriority; startAgent: boolean;
}
export interface DingtalkImportResponse {
  user: DingtalkUser;
  results: Array<{ recordId: string; status: "created" | "existing" | "stale" | "failed"; issueKey?: string; error?: string }>;
}
