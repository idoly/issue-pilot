import { ISSUE_PRIORITIES, ISSUE_STATUSES, ISSUE_TYPES_BY_ENVIRONMENT, errorMessage, isWorkspaceBusy, type AgentFooterStats, type AgentThinkingLevel, type IssuePriority, type IssueStatus, type IssueType, type WorkspaceStatus } from "../../../domain/contracts";
import type { AgentModelOption, Configuration, ConfigurationCatalog, ServiceConfiguration, ServiceConfigurationInput } from "../../../configuration/contracts";
export type { RunEvent } from "../../../agent/events";

export { ISSUE_PRIORITIES, ISSUE_STATUSES, ISSUE_TYPES_BY_ENVIRONMENT, errorMessage, isWorkspaceBusy };
export type { AgentConfiguration, CapabilityConfiguration, CapabilityName } from "../../../domain/contracts";
export type { AgentFooterStats, AgentModelOption, AgentThinkingLevel, IssuePriority, IssueStatus, IssueType, WorkspaceStatus };
export type Config = Configuration;
export type ConfigCatalog = ConfigurationCatalog;
export type Service = ServiceConfiguration;
export type ServiceInput = ServiceConfigurationInput;

export interface Person { subject: string; name: string; email: string }

export interface IssueListItem {
  id: string;
  title: string;
  priority: IssuePriority;
  type: IssueType;
  status: IssueStatus;
  assignee: string | null;
  assigneeSubject: string | null;
  service: { key: string; name: string };
  createdAt?: string;
  updatedAt: string;
}

export interface IssueComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface IssueDetail extends IssueListItem {
  description: string;
  repositories: Array<{ url: string; baseBranch: string; workingBranch: string | null }>;
  workspace: { status: WorkspaceStatus; url: string | null; lastError?: string | null; retryable?: boolean };
  attachments: Array<{ id: string; fileName: string; mediaType: string; size: number; sha256: string; createdAt?: string }>;
  ccRecipients?: Person[];
  reporter?: Person;
  environmentKey: string;
  comments: IssueComment[];
}

export interface WorkspaceStats {
  totalBytes: number;
  policy: { retentionHours: number | null; highWaterBytes: number; targetBytes: number; maintenanceIntervalMinutes: number };
  workspaces: Array<{ issueKey: string; issueStatus: IssueStatus; workspaceStatus: WorkspaceStatus; resolvedAt: string | null; bytes: number; releasable: boolean; blockedReason: string | null }>;
}

export interface IssueInput {
  title: string;
  description: string;
  priority: IssuePriority;
  type: IssueType;
  serviceKey: string;
  assigneeSubject: string | null;
  ccSubjects: string[];
}

const currentUserStorageKey = "issue-pilot.current-user";

export function currentUserSubject(): string | null {
  return typeof localStorage === "undefined" ? null : localStorage.getItem(currentUserStorageKey);
}

export function setCurrentUserSubject(subject: string | null): void {
  if (typeof localStorage === "undefined") return;
  if (subject) localStorage.setItem(currentUserStorageKey, subject);
  else localStorage.removeItem(currentUserStorageKey);
}

async function requestError(response: Response): Promise<Error> {
  const code = await response.json().then((body: { error?: string }) => body.error).catch(() => undefined);
  return new Error(code ?? `request_failed:${response.status}`);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const subject = currentUserSubject();
  if (subject) headers.set("X-Issue-Pilot-Subject", subject);
  if (init?.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) throw await requestError(response);
  if (response.status === 204 || response.status === 205) return undefined as T;
  const body = await response.text();
  return body ? JSON.parse(body) as T : undefined as T;
}

const issuePath = (key: string, suffix = "") => `/api/issues/${encodeURIComponent(key)}${suffix}`;
const servicePath = (key: string) => `/api/services/${encodeURIComponent(key)}`;

export const loadUsers = () => request<Person[]>("/api/users");
export const loadPeople = () => request<Person[]>("/api/people");
export const loadCurrentUser = () => request<Person>("/api/me");
export const loadCatalog = () => request<ConfigCatalog>("/api/catalog");
export const loadConfig = () => request<Config>("/api/config");
export const listIssues = (signal?: AbortSignal) => request<IssueListItem[]>("/api/issues", signal ? { signal } : undefined);
export const getIssue = (key: string) => request<IssueDetail>(issuePath(key));
export const loadWorkspaceStats = (signal?: AbortSignal) => request<WorkspaceStats>("/api/workspaces/stats", signal ? { signal } : undefined);

const jsonRequest = <T>(path: string, method: "POST" | "PATCH" | "DELETE", body: unknown) => request<T>(path, { method, body: JSON.stringify(body) });

function appendFiles(form: FormData, files: File[]): void {
  for (const file of files) form.append("files", file, file.name);
}

export const createService = (input: ServiceInput) => jsonRequest<{ key: string; name: string }>("/api/services", "POST", input);
export const updateService = (key: string, revision: string, input: ServiceInput) => request<void>(servicePath(key), { method: "PATCH", headers: { "If-Match": revision }, body: JSON.stringify(input) });
export const deleteService = (key: string, revision: string) => request<void>(servicePath(key), { method: "DELETE", headers: { "If-Match": revision } });

export function attachmentUrl(key: string, attachmentId: string): string {
  return issuePath(key, `/attachments/${encodeURIComponent(attachmentId)}`);
}

export async function fetchAttachment(key: string, attachmentId: string): Promise<Blob> {
  const response = await fetch(attachmentUrl(key, attachmentId));
  if (!response.ok) throw await requestError(response);
  return response.blob();
}

export function createIssue(input: IssueInput & { environmentKey: string }, files: File[] = []): Promise<IssueListItem> {
  if (!files.length) return jsonRequest("/api/issues", "POST", input);
  const form = new FormData();
  form.append("issue", JSON.stringify(input));
  appendFiles(form, files);
  return request("/api/issues", { method: "POST", body: form });
}
export function updateIssue(key: string, input: IssueInput, removedAttachmentIds: string[] = [], files: File[] = []): Promise<IssueListItem> {
  if (!removedAttachmentIds.length && !files.length) return jsonRequest(issuePath(key), "PATCH", input);
  const form = new FormData();
  form.append("issue", JSON.stringify({ ...input, removedAttachmentIds }));
  appendFiles(form, files);
  return request(issuePath(key), { method: "PATCH", body: form });
}
export const updateIssueStatus = (key: string, status: "open" | "resolved") => jsonRequest<IssueListItem>(issuePath(key, "/status"), "PATCH", { status });
export const convertIssueToDevelopment = (key: string) => request<{ issueKey: string }>(issuePath(key, "/development"), { method: "POST" });
export const addIssueComment = (key: string, body: string) => jsonRequest<IssueComment>(issuePath(key, "/comments"), "POST", { body });
export const retryIssue = (key: string) => request<void>(issuePath(key, "/retry"), { method: "POST" });
export const sendAgentMessage = (key: string, message: string) => jsonRequest<void>(issuePath(key, "/agent-messages"), "POST", { message });
export const agentStreamUrl = (key: string) => issuePath(key, "/agent-stream");
