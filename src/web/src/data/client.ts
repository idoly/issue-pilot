import type { DingtalkSourceResponse, DingtalkImportInput, DingtalkImportResponse } from "../../../mcp/dingtalk-contracts";
export type { DingtalkSourceResponse, DingtalkImportResponse } from "../../../mcp/dingtalk-contracts";

import { SOURCE_COMMIT_FILE_STATUSES, SOURCE_WORKSPACE_FILE_VERSIONS } from "../../../workspace/source-contracts";
import type { SourceBlame, SourceChanges, SourceCommitFile, SourceCommitFileComparison, SourceFile, SourceHistoryCursor, SourceHistoryPage, SourceRepository, SourceRevisionFile, SourceSearchMatch, SourceTree, SourceWorkspaceFile, SourceWorkspaceFileComparison } from "../../../workspace/source-contracts";
export type { SourceBlame, SourceCommit, SourceCommitFile, SourceCommitFileComparison, SourceFile, SourceHistoryCursor, SourceRepository, SourceSearchMatch, SourceTree, SourceTreeEntry, SourceWorkspaceFileComparison } from "../../../workspace/source-contracts";
import { issuePilotConfig } from "../../../../issue-pilot.config.ts";
import { ISSUE_PRIORITIES, ISSUE_STATUSES, ISSUE_WORK_MODES, errorMessage, isWorkspaceBusy, issueScopeForWorkMode, issueWorkMode, type AgentFooterStats, type IssuePriority, type IssueStatus, type IssueType, type IssueWorkMode, type WorkspaceStatus } from "../../../domain/contracts";
import type { AgentModelOption, Configuration, ConfigurationCatalog, ServiceConfiguration, ServiceConfigurationInput } from "../../../configuration/contracts";
export type { RunEvent } from "../../../agent/events";

export { ISSUE_PRIORITIES, ISSUE_STATUSES, ISSUE_WORK_MODES, errorMessage, isWorkspaceBusy, issueScopeForWorkMode, issueWorkMode };
export type { AgentConfiguration, CapabilityName } from "../../../domain/contracts";
export type { AgentFooterStats, AgentModelOption, IssuePriority, IssueStatus, IssueType, IssueWorkMode };
export type Config = Configuration;
export type ConfigCatalog = ConfigurationCatalog;
export type Service = ServiceConfiguration;
export type ServiceInput = ServiceConfigurationInput;

export type { UserRole } from "../../../domain/contracts";
import type { UserRole } from "../../../domain/contracts";
export { USER_ROLES, canCreateDevelopmentIssues, canUseIssueWorkMode } from "../../../domain/contracts";
export interface Person { subject: string; name: string; email: string; role: UserRole; isAdmin?: boolean }
export interface DmsScopeResolution { instanceId: string; instanceHost: string; instancePort: string; databaseId: string }
export interface ManagedUser extends Person { active: boolean; createdAt: string; updatedAt: string }
export interface ManagedUserInput { subject: string; name: string; email: string; role?: UserRole; isAdmin?: boolean }
export interface ManagedUserUpdate { name?: string; email?: string; active?: boolean; role?: UserRole; isAdmin?: boolean }
export interface PersonalCredentialStatus { provider?: string; modelProviders: string[]; gitSshConfigured: boolean; productionDmsConfigured?: boolean; productionDmsUrl?: string; productionSlsConfigured?: boolean; dingtalkConfigured?: boolean }
export interface PersonalCredentialUpdate {
  production?: {
    dms?: { mode: "replace"; url: string; authorization: string } | { mode: "clear" };
    sls?: { mode: "replace"; accessKeyId: string; accessKeySecret: string } | { mode: "clear" };
  };
  model?: { provider?: string; mode: "replace"; apiKey: string } | { provider?: string; mode: "clear" };
  git?: { mode: "replace"; type: "ssh"; privateKey: string } | { mode: "clear" };
}
export const loadPersonalCredentials = () => request<PersonalCredentialStatus>("/api/me/credentials");
export const updatePersonalCredentials = (input: PersonalCredentialUpdate) => jsonRequest<PersonalCredentialStatus>("/api/me/credentials", "PUT", input);

export interface IssueListItem {
  id: string;
  title: string;
  priority: IssuePriority;
  type: IssueType;
  status: IssueStatus;
  assignee: string | null;
  assigneeSubject: string | null;
  service: { key: string; name: string };
  environmentKey: string;
  createdAt?: string;
  updatedAt: string;
}

export interface IssueExecutionItem extends IssueListItem {
  workspaceStatus: WorkspaceStatus;
  agentRunning: boolean;
  resolvedAt: string | null;
}

export interface IssueComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface IssueScopeTransitionHistoryItem {
  id: string;
  action: "rebind_read_only" | "convert_to_development" | "migrate_development";
  from: { service: { key: string; name: string }; workMode: IssueWorkMode };
  to: { service: { key: string; name: string }; workMode: IssueWorkMode };
  repositories: { retained: string[]; added: string[]; removed: string[] };
  planHash: string;
  actor: { subject: string; name: string };
  createdAt: string;
}

export interface IssueDetail extends IssueListItem {
  description: string;
  agentRunning?: boolean;
  repositories: Array<{ name: string; url: string; baseBranch: string; workingBranch: string | null }>;
  workspace: { status: WorkspaceStatus; sourceAvailable: boolean; lastError?: string | null; retryable?: boolean };
  workingDirectory?: string;
  attachments: Array<{ id: string; fileName: string; workingFileName?: string; mediaType: string; size: number; sha256: string; createdAt?: string }>;
  collaboratingServices?: Array<{ key: string; name: string }>;
  outputs: Array<{ fileName: string; size: number; updatedAt: string }>;
  relatedIssues?: IssueExecutionItem[];
  scopeTransitions?: IssueScopeTransitionHistoryItem[];
  ccRecipients?: Person[];
  reporter?: Person;
  comments: IssueComment[];
}

export interface IssueScopeTransitionPlan {
  planHash: string;
  expectedIssueUpdatedAt: string;
  action: "none" | "rebind_read_only" | "convert_to_development" | "migrate_development";
  current: { service: { key: string; name: string }; workMode: IssueWorkMode; repositoryAccess: "read" | "write" };
  target: { service: { key: string; name: string }; workMode: IssueWorkMode; repositoryAccess: "read" | "write" };
  repositories: {
    retained: Array<{ name: string; url: string; baseBranch: string }>;
    added: Array<{ name: string; url: string; baseBranch: string }>;
    removed: Array<{ name: string; url: string; baseBranch: string }>;
  };
  branch: string | null;
  session: { closeCurrent: boolean; preserveConversation: true };
  preserved: ["attachments", "comments", "conversation"];
  warnings: string[];
}

export interface WorkspaceStats {
  totalBytes: number;
  policy: { retentionHours: number | null; highWaterBytes: number; targetBytes: number; maintenanceIntervalMinutes: number };
  workspaces: Array<{ issueKey: string; issueStatus: IssueStatus; workspaceStatus: WorkspaceStatus; resolvedAt: string | null; bytes: number; releasable: boolean; blockedReason: string | null }>;
}

export interface IssueMetadataInput {
  title: string;
  description: string;
  priority: IssuePriority;
  assigneeSubject: string | null;
  ccSubjects: string[];
}

export interface IssueCreateInput extends IssueMetadataInput {
  workMode: IssueWorkMode;
  serviceKey: string;
  relatedIssueKeys?: string[];
}

const currentUserStorageKey = "issue-pilot.current-user";
let selectedSubject: string | null | undefined;

export function currentUserSubject(): string | null {
  if (selectedSubject === undefined) selectedSubject = typeof localStorage === "undefined" ? null : localStorage.getItem(currentUserStorageKey);
  return selectedSubject;
}

export function setCurrentUserSubject(subject: string | null, remember = true): void {
  if (remember && typeof localStorage !== "undefined") {
    if (subject) localStorage.setItem(currentUserStorageKey, subject);
    else localStorage.removeItem(currentUserStorageKey);
  }
  selectedSubject = subject;
}

async function requestError(response: Response): Promise<Error> {
  const code = await response.json().then((body: { error?: string }) => body.error).catch(() => undefined);
  return new Error(code ?? `request_failed:${response.status}`);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const subject = currentUserSubject();
  if (subject) headers.set("X-Issue-Pilot-Subject", subject);
  if (init?.body !== undefined && !(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
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
export const loadDingtalkSource = (signal?: AbortSignal) => request<DingtalkSourceResponse>("/api/dingtalk/source", { signal });
export const importDingtalkRecords = (input: DingtalkImportInput, signal?: AbortSignal) => request<DingtalkImportResponse>("/api/dingtalk/import", { method: "POST", body: JSON.stringify(input), signal });

export const listIssues = (signal?: AbortSignal) => request<IssueExecutionItem[]>("/api/issues", signal ? { signal } : undefined);
export const listIssuePins = (signal?: AbortSignal) => request<string[]>("/api/issue-pins", signal ? { signal } : undefined);
export const setIssuePinned = (key: string, pinned: boolean) => request<void>(issuePath(key, "/pin"), { method: pinned ? "PUT" : "DELETE" });
export const updateIssueRelatedIssues = (key: string, relatedIssueKeys: string[]) => request<void>(issuePath(key, "/related-issues"), { method: "PUT", body: JSON.stringify({ relatedIssueKeys }) });
export const getIssue = (key: string) => request<IssueDetail>(issuePath(key));
export interface IssueWorkFile {
  name: string;
  path: string;
  kind: "file" | "directory" | "link" | "special";
  size: number;
  updatedAt: string;
}
export const listIssueWorkFiles = async (key: string, path = "", signal?: AbortSignal): Promise<IssueWorkFile[]> => {
  const rows = await request<unknown>(issuePath(key, `/files${path ? `?path=${encodeURIComponent(path)}` : ""}`), signal ? { signal } : undefined);
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== "object" || typeof row.name !== "string" || typeof row.path !== "string" || !["file", "directory", "link", "special"].includes(row.kind) || typeof row.size !== "number" || typeof row.updatedAt !== "string")) throw new Error("invalid_issue_files_response");
  return rows as IssueWorkFile[];
};
export const issueWorkFileUrl = (key: string, path: string) => issuePath(key, `/files/download?path=${encodeURIComponent(path)}`);

export const loadWorkspaceStats = (signal?: AbortSignal) => request<WorkspaceStats>("/api/workspaces/stats", signal ? { signal } : undefined);

type SourceHeader = "Path" | "Query" | "Revision" | "Line" | "Sha256" | "Case-Sensitive" | "Word-Match" | "Staged" | "Recursive" | "Destination" | "Overwrite" | "Offset";

function sourceResponseRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function sourceCommitFile(value: unknown, code: string): SourceCommitFile {
  const file = sourceResponseRecord(value, code);
  if (!SOURCE_COMMIT_FILE_STATUSES.includes(file.status as SourceCommitFile["status"]) || typeof file.path !== "string" || !file.path || (file.previousPath !== null && typeof file.previousPath !== "string")) throw new Error(code);
  return { status: file.status as SourceCommitFile["status"], path: file.path, previousPath: file.previousPath as string | null };
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
  if (typeof file.path !== "string" || !file.path || !SOURCE_WORKSPACE_FILE_VERSIONS.includes(file.version as SourceWorkspaceFile["version"]) || typeof file.content !== "string") throw new Error(code);
  return { path: file.path, version: file.version as SourceWorkspaceFile["version"], content: file.content };
}

function sourceRequest(key: string, resource: string, repository: string, values: Partial<Record<SourceHeader, string>> = {}, signal?: AbortSignal, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("X-Issue-Pilot-Repository", encodeURIComponent(repository));
  for (const [name, value] of Object.entries(values)) if (value) headers.set(`X-Issue-Pilot-${name}`, encodeURIComponent(value));
  return request(issuePath(key, `/source/${resource}`), { ...init, headers, ...(signal ? { signal } : {}) });
}

export const loadSourceRepositories = (key: string, signal?: AbortSignal) => request<SourceRepository[]>(issuePath(key, "/source/repositories"), signal ? { signal } : undefined);
export const loadSourceTree = (key: string, repository: string, path = "", signal?: AbortSignal) => sourceRequest(key, "tree", repository, { Path: path }, signal) as Promise<SourceTree>;
export const loadSourceFile = (key: string, repository: string, path: string, signal?: AbortSignal) => sourceRequest(key, "file", repository, { Path: path }, signal) as Promise<SourceFile>;
export const saveSourceFile = (key: string, repository: string, path: string, content: string, sha256: string) => sourceRequest(key, "file", repository, { Path: path, Sha256: sha256 }, undefined, {
  method: "PUT",
  body: content,
  headers: { "Content-Type": "text/plain; charset=utf-8" },
}) as Promise<SourceFile>;
export const createSourceFile = (key: string, repository: string, path: string, content: string) => sourceRequest(key, "file", repository, { Path: path }, undefined, { method: "POST", body: content, headers: { "Content-Type": "text/plain; charset=utf-8" } }) as Promise<SourceFile>;
export const createSourceDirectory = (key: string, repository: string, path: string) => sourceRequest(key, "directory", repository, { Path: path }, undefined, { method: "POST" });
export const deleteSourcePath = (key: string, repository: string, path: string, recursive: boolean) => sourceRequest(key, "path", repository, { Path: path, Recursive: String(recursive) }, undefined, { method: "DELETE" });
export const renameSourcePath = (key: string, repository: string, path: string, destination: string, overwrite: boolean) => sourceRequest(key, "rename", repository, { Path: path, Destination: destination, Overwrite: String(overwrite) }, undefined, { method: "POST" });
const mutateSourceGit = (key: string, repository: string, action: "stage" | "unstage" | "discard", paths: string[]) => sourceRequest(key, action, repository, {}, undefined, { method: "POST", body: JSON.stringify({ paths }), headers: { "Content-Type": "application/json" } });
export const stageSourcePaths = (key: string, repository: string, paths: string[]) => mutateSourceGit(key, repository, "stage", paths);
export const unstageSourcePaths = (key: string, repository: string, paths: string[]) => mutateSourceGit(key, repository, "unstage", paths);
export const discardSourcePaths = (key: string, repository: string, paths: string[]) => mutateSourceGit(key, repository, "discard", paths);
export const commitSourceChanges = (key: string, repository: string, message: string) => sourceRequest(key, "commit", repository, {}, undefined, { method: "POST", body: JSON.stringify({ message }), headers: { "Content-Type": "application/json" } });
export const searchSource = (key: string, repository: string, query: string, options: { caseSensitive?: boolean; wordMatch?: boolean } = {}, signal?: AbortSignal) => sourceRequest(key, "search", repository, {
  Query: query,
  "Case-Sensitive": String(options.caseSensitive ?? true),
  "Word-Match": String(options.wordMatch ?? false),
}, signal) as Promise<{ matches: SourceSearchMatch[]; truncated: boolean }>;
export const loadSourceBlame = (key: string, repository: string, path: string, line: number, signal?: AbortSignal) => sourceRequest(key, "blame", repository, { Path: path, Line: String(line) }, signal) as Promise<SourceBlame>;
export const loadSourceHistory = (key: string, repository: string, path = "", signal?: AbortSignal, cursor?: SourceHistoryCursor) => sourceRequest(key, "history", repository, { Path: path, ...(cursor ? { Revision: cursor.revision, Offset: String(cursor.offset) } : {}) }, signal) as Promise<SourceHistoryPage>;
export async function loadSourceCommit(key: string, repository: string, revision: string, path = "", signal?: AbortSignal): Promise<SourceChanges> {
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
export async function loadSourceDiff(key: string, repository: string, path = "", signal?: AbortSignal, staged = false): Promise<SourceChanges> {
  const code = "source_diff_response_invalid";
  const response = sourceResponseRecord(await sourceRequest(key, "diff", repository, { Path: path, Staged: String(staged) }, signal), code);
  if (!Array.isArray(response.files) || typeof response.truncated !== "boolean") throw new Error(code);
  return { files: response.files.map((file) => sourceCommitFile(file, code)), truncated: response.truncated };
}
export async function loadSourceDiffFile(key: string, repository: string, path: string, signal?: AbortSignal, staged = false): Promise<SourceWorkspaceFileComparison> {
  const code = "source_diff_file_response_invalid";
  const response = sourceResponseRecord(await sourceRequest(key, "diff-file", repository, { Path: path, Staged: String(staged) }, signal), code);
  const before = sourceWorkspaceFile(response.before, code);
  const after = sourceWorkspaceFile(response.after, code);
  if (!before && !after) throw new Error(code);
  return { file: sourceCommitFile(response.file, code), before, after };
}

const jsonRequest = <T>(path: string, method: "POST" | "PATCH" | "DELETE" | "PUT", body: unknown) => request<T>(path, { method, body: JSON.stringify(body) });

function appendFiles(form: FormData, files: File[]): void {
  for (const file of files) form.append("files", file, file.name);
}

export const resolveDmsScope = (input: { url: string; authorization?: string; serviceKey?: string; environmentKey: string; instanceAlias: string; schemaName: string }) => jsonRequest<DmsScopeResolution>("/api/dms/scope/resolve", "POST", input);


export interface ApplicationEndpoint {
  name: string; path: string; transport: string; readOnly: boolean;
  tools: Array<{ name: string; description: string; annotations: { readOnlyHint: boolean }; inputSchema: { properties?: Record<string, { type?: string; description?: string; enum?: unknown[]; anyOf?: unknown[] }>; required?: string[] } }>;
}
export const loadApplicationEndpoints = (signal?: AbortSignal) => request<{ endpoints: ApplicationEndpoint[] }>("/api/endpoints", signal ? { signal } : undefined);


export interface ManagedRepository { id: string; name: string; url: string; createdAt: string; updatedAt: string; services: Array<{ key: string; name: string }> }
export const loadRepositories = () => request<ManagedRepository[]>("/api/repositories");

export const createUser = (input: ManagedUserInput) => jsonRequest<ManagedUser>("/api/users", "POST", input);
export const updateUser = (subject: string, input: ManagedUserUpdate) => jsonRequest<ManagedUser>(userPath(subject), "PATCH", input);
export const loadServiceConfigurationDescription = (key: string, signal?: AbortSignal) => request<{ context: string }>(`${servicePath(key)}/configuration-description`, signal ? { signal } : undefined);
export const createService = (input: ServiceInput) => jsonRequest<{ key: string; name: string }>("/api/services", "POST", input);
export const updateService = (key: string, input: ServiceInput) => request<void>(servicePath(key), { method: "PATCH", body: JSON.stringify(input) });
export const deleteService = (key: string) => request<void>(servicePath(key), { method: "DELETE" });

export function attachmentUrl(key: string, attachmentId: string): string {
  return issuePath(key, `/attachments/${encodeURIComponent(attachmentId)}`);
}

export function outputUrl(key: string, fileName: string): string {
  return issuePath(key, `/outputs/${encodeURIComponent(fileName)}`);
}

export async function fetchOutput(key: string, fileName: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(outputUrl(key, fileName), { ...(signal ? { signal } : {}) });
  if (!response.ok) throw await requestError(response);
  const reader = response.body?.getReader();
  if (!reader) return "";
  let bytes = 0;
  const chunks: BlobPart[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > issuePilotConfig.web.outputPreviewBytes) throw new Error("文件过大，请下载查看完整内容");
      chunks.push(value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(await new Blob(chunks).arrayBuffer());
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function fetchAttachment(key: string, attachmentId: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(attachmentUrl(key, attachmentId), signal ? { signal } : undefined);
  if (!response.ok) throw await requestError(response);
  return response.blob();
}

export function createIssue(input: IssueCreateInput, files: File[] = []): Promise<IssueExecutionItem> {
  if (!files.length) return jsonRequest("/api/issues", "POST", input);
  const form = new FormData();
  form.append("issue", JSON.stringify(input));
  appendFiles(form, files);
  return request("/api/issues", { method: "POST", body: form });
}
export function updateIssue(key: string, input: IssueMetadataInput, removedAttachmentIds: string[] = [], files: File[] = []): Promise<IssueExecutionItem> {
  if (!removedAttachmentIds.length && !files.length) return jsonRequest(issuePath(key), "PATCH", input);
  const form = new FormData();
  form.append("issue", JSON.stringify({ ...input, removedAttachmentIds }));
  appendFiles(form, files);
  return request(issuePath(key), { method: "PATCH", body: form });
}
export const updateIssueStatus = (key: string, status: "open" | "resolved") => jsonRequest<IssueExecutionItem>(issuePath(key, "/status"), "PATCH", { status });
export const planIssueScopeTransition = (key: string, target: { serviceKey: string; workMode: IssueWorkMode }) => jsonRequest<IssueScopeTransitionPlan>(issuePath(key, "/scope-transition/plan"), "POST", target);
export const applyIssueScopeTransition = (key: string, target: { serviceKey: string; workMode: IssueWorkMode }, plan: Pick<IssueScopeTransitionPlan, "expectedIssueUpdatedAt" | "planHash">) => jsonRequest<{ issueKey: string }>(issuePath(key, "/scope-transition/apply"), "POST", { ...target, expectedIssueUpdatedAt: plan.expectedIssueUpdatedAt, expectedPlanHash: plan.planHash });
export const addIssueComment = (key: string, body: string) => jsonRequest<IssueComment>(issuePath(key, "/comments"), "POST", { body });
export const retryIssue = (key: string) => request<void>(issuePath(key, "/retry"), { method: "POST" });
export function sendAgentMessage(key: string, message: string, images: File[] = []): Promise<void> {
  if (!images.length) return jsonRequest<void>(issuePath(key, "/agent-messages"), "POST", { message });
  const form = new FormData();
  form.append("message", message);
  for (const image of images) form.append("images", image, image.name);
  return request<void>(issuePath(key, "/agent-messages"), { method: "POST", body: form });
}
export const agentStreamUrl = (key: string) => issuePath(key, "/agent-stream");
