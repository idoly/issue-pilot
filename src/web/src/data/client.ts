import { ISSUE_PRIORITIES, ISSUE_STATUSES, ISSUE_TYPES_BY_ENVIRONMENT, errorMessage, isWorkspaceBusy, type AgentFooterStats, type IssuePriority, type IssueStatus, type IssueType, type WorkspaceStatus } from "../../../domain/contracts";
import type { AgentModelOption, Configuration, ConfigurationCatalog, ServiceConfiguration, ServiceConfigurationInput } from "../../../configuration/contracts";
export type { RunEvent } from "../../../agent/events";

export { ISSUE_PRIORITIES, ISSUE_STATUSES, ISSUE_TYPES_BY_ENVIRONMENT, errorMessage, isWorkspaceBusy };
export type { AgentConfiguration, CapabilityName } from "../../../domain/contracts";
export type { AgentFooterStats, AgentModelOption, IssuePriority, IssueStatus, IssueType };
export type Config = Configuration;
export type ConfigCatalog = ConfigurationCatalog;
export type Service = ServiceConfiguration;
export type ServiceInput = ServiceConfigurationInput;

export interface Person { subject: string; name: string; email: string }
export interface ManagedUser extends Person { active: boolean; createdAt: string; updatedAt: string }
export interface ManagedUserInput { subject: string; name: string; email: string }
export interface ManagedUserUpdate { name: string; email: string; active: boolean }

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
  repositories: Array<{ name: string; url: string; baseBranch: string; workingBranch: string | null }>;
  workspace: { status: WorkspaceStatus; sourceAvailable: boolean; lastError?: string | null; retryable?: boolean };
  attachments: Array<{ id: string; fileName: string; mediaType: string; size: number; sha256: string; createdAt?: string }>;
  ccRecipients?: Person[];
  reporter?: Person;
  environmentKey: string;
  comments: IssueComment[];
}

export interface SourceRepository { name: string; url: string; branch: string; access: "read" | "write" }
export interface SourceTreeEntry { name: string; path: string; type: "directory" | "file" | "symlink" | "other"; size: number | null }
export interface SourceTree { path: string; entries: SourceTreeEntry[]; truncated: boolean }
export interface SourceFile { path: string; content: string; size: number }
export interface SourceSearchMatch { path: string; line: number; column: number; preview: string }
export interface SourceCommit { hash: string; shortHash: string; parents: string[]; author: string; date: string; subject: string }
type SourceCommitFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied";
export interface SourceCommitFile { status: SourceCommitFileStatus; path: string; previousPath: string | null }
interface SourceRevisionFile { path: string; revision: string; content: string }
interface SourceWorkspaceFile { path: string; version: "index" | "working-tree"; content: string }
export interface SourceCommitFileComparison { file: SourceCommitFile; before: SourceRevisionFile | null; after: SourceRevisionFile | null }
export interface SourceWorkspaceFileComparison { file: SourceCommitFile; before: SourceWorkspaceFile | null; after: SourceWorkspaceFile | null }

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
const userPath = (subject: string) => `/api/users/${encodeURIComponent(subject)}`;

export const loadUsers = () => request<Person[]>("/api/users");
export const loadManagedUsers = () => request<ManagedUser[]>("/api/users/manage");
export const loadCurrentUser = () => request<Person>("/api/me");
export const loadCatalog = () => request<ConfigCatalog>("/api/catalog");
export const loadConfig = () => request<Config>("/api/config");
export const listIssues = (signal?: AbortSignal) => request<IssueListItem[]>("/api/issues", signal ? { signal } : undefined);
export const getIssue = (key: string) => request<IssueDetail>(issuePath(key));
export const loadWorkspaceStats = (signal?: AbortSignal) => request<WorkspaceStats>("/api/workspaces/stats", signal ? { signal } : undefined);

type SourceHeader = "Path" | "Query" | "Revision" | "Case-Sensitive" | "Word-Match";

function sourceResponseRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function sourceCommitFile(value: unknown, code: string): SourceCommitFile {
  const file = sourceResponseRecord(value, code);
  if (!["added", "modified", "deleted", "renamed", "copied"].includes(String(file.status)) || typeof file.path !== "string" || !file.path || (file.previousPath !== null && typeof file.previousPath !== "string")) throw new Error(code);
  return { status: file.status as SourceCommitFileStatus, path: file.path, previousPath: file.previousPath as string | null };
}

function sourceRevisionFile(value: unknown, code: string): SourceRevisionFile | null {
  if (value === null) return null;
  const file = sourceResponseRecord(value, code);
  if (typeof file.path !== "string" || !file.path || typeof file.revision !== "string" || !/^[0-9a-f]{40}$/i.test(file.revision) || typeof file.content !== "string") throw new Error(code);
  return { path: file.path, revision: file.revision, content: file.content };
}

function sourceWorkspaceFile(value: unknown, code: string): SourceWorkspaceFile | null {
  if (value === null) return null;
  const file = sourceResponseRecord(value, code);
  if (typeof file.path !== "string" || !file.path || !["index", "working-tree"].includes(String(file.version)) || typeof file.content !== "string") throw new Error(code);
  return { path: file.path, version: file.version as SourceWorkspaceFile["version"], content: file.content };
}

function sourceRequest(key: string, resource: string, repository: string, values: Partial<Record<SourceHeader, string>> = {}, signal?: AbortSignal) {
  const headers = new Headers({ "X-Issue-Pilot-Repository": encodeURIComponent(repository) });
  for (const [name, value] of Object.entries(values)) if (value) headers.set(`X-Issue-Pilot-${name}`, encodeURIComponent(value));
  return request(issuePath(key, `/source/${resource}`), { headers, ...(signal ? { signal } : {}) });
}

export const loadSourceRepositories = (key: string, signal?: AbortSignal) => request<SourceRepository[]>(issuePath(key, "/source/repositories"), signal ? { signal } : undefined);
export const loadSourceTree = (key: string, repository: string, path = "", signal?: AbortSignal) => sourceRequest(key, "tree", repository, { Path: path }, signal) as Promise<SourceTree>;
export const loadSourceFile = (key: string, repository: string, path: string, signal?: AbortSignal) => sourceRequest(key, "file", repository, { Path: path }, signal) as Promise<SourceFile>;
export const searchSource = (key: string, repository: string, query: string, options: { caseSensitive?: boolean; wordMatch?: boolean } = {}, signal?: AbortSignal) => sourceRequest(key, "search", repository, {
  Query: query,
  "Case-Sensitive": String(options.caseSensitive ?? true),
  "Word-Match": String(options.wordMatch ?? false),
}, signal) as Promise<{ matches: SourceSearchMatch[]; truncated: boolean }>;
export const loadSourceHistory = (key: string, repository: string, path = "", signal?: AbortSignal) => sourceRequest(key, "history", repository, { Path: path }, signal) as Promise<{ commits: SourceCommit[]; truncated: boolean }>;
export async function loadSourceCommit(key: string, repository: string, revision: string, path = "", signal?: AbortSignal): Promise<{ files: SourceCommitFile[]; truncated: boolean }> {
  const code = "source_commit_response_invalid";
  const response = sourceResponseRecord(await sourceRequest(key, "commit", repository, { Revision: revision, Path: path }, signal), code);
  if (!Array.isArray(response.files) || typeof response.truncated !== "boolean") throw new Error(code);
  return { files: response.files.map((file) => sourceCommitFile(file, code)), truncated: response.truncated };
}
export async function loadSourceCommitFile(key: string, repository: string, revision: string, path: string, signal?: AbortSignal): Promise<SourceCommitFileComparison> {
  const code = "source_commit_file_response_invalid";
  const response = sourceResponseRecord(await sourceRequest(key, "commit-file", repository, { Revision: revision, Path: path }, signal), code);
  const before = sourceRevisionFile(response.before, code);
  const after = sourceRevisionFile(response.after, code);
  if (!before && !after) throw new Error(code);
  return { file: sourceCommitFile(response.file, code), before, after };
}
export async function loadSourceDiff(key: string, repository: string, path = "", signal?: AbortSignal): Promise<{ files: SourceCommitFile[]; truncated: boolean }> {
  const code = "source_diff_response_invalid";
  const response = sourceResponseRecord(await sourceRequest(key, "diff", repository, { Path: path }, signal), code);
  if (!Array.isArray(response.files) || typeof response.truncated !== "boolean") throw new Error(code);
  return { files: response.files.map((file) => sourceCommitFile(file, code)), truncated: response.truncated };
}
export async function loadSourceDiffFile(key: string, repository: string, path: string, signal?: AbortSignal): Promise<SourceWorkspaceFileComparison> {
  const code = "source_diff_file_response_invalid";
  const response = sourceResponseRecord(await sourceRequest(key, "diff-file", repository, { Path: path }, signal), code);
  const before = sourceWorkspaceFile(response.before, code);
  const after = sourceWorkspaceFile(response.after, code);
  if (!before && !after) throw new Error(code);
  return { file: sourceCommitFile(response.file, code), before, after };
}

const jsonRequest = <T>(path: string, method: "POST" | "PATCH" | "DELETE", body: unknown) => request<T>(path, { method, body: JSON.stringify(body) });

function appendFiles(form: FormData, files: File[]): void {
  for (const file of files) form.append("files", file, file.name);
}

export const createUser = (input: ManagedUserInput) => jsonRequest<ManagedUser>("/api/users", "POST", input);
export const updateUser = (subject: string, input: ManagedUserUpdate) => jsonRequest<ManagedUser>(userPath(subject), "PATCH", input);
export const createService = (input: ServiceInput) => jsonRequest<{ key: string; name: string }>("/api/services", "POST", input);
export const updateService = (key: string, input: ServiceInput) => request<void>(servicePath(key), { method: "PATCH", body: JSON.stringify(input) });
export const deleteService = (key: string) => request<void>(servicePath(key), { method: "DELETE" });

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
