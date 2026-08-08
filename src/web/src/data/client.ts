import { ISSUE_STATUSES, ISSUE_TYPES_BY_ENVIRONMENT, type AgentThinkingLevel, type CapabilityName, type IssueStatus, type IssueType } from "../../../domain/contracts";
export type { RunEvent } from "../../../agent/events";

export { ISSUE_STATUSES, ISSUE_TYPES_BY_ENVIRONMENT };
export type { CapabilityName, IssueStatus, IssueType };
export type IssuePriority = "p0" | "p1" | "p2" | "p3";

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
  version: number;
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
  repositories: Array<{ id: string; url: string; baseBranch: string; workingBranch: string | null; codeServerPath: string | null }>;
  workspace: { status: string; url: string | null; lastError?: string | null; retryable?: boolean };
  agentSession?: { sessionId: string } | null;
  attachments: Array<{ id: string; fileName: string; mediaType: string; size: number; sha256: string; createdAt?: string }>;
  ccRecipients?: Person[];
  reporter?: Person;
  environmentKey: string;
  comments: IssueComment[];
}

export interface Environment {
  id: string;
  key: string;
  name: string;
  kind: "prod" | "test" | "dev";
}

export type ThinkingLevel = AgentThinkingLevel;
export interface AgentModelDefinition { provider: string; id: string; name: string; api: string; thinkingLevels: ThinkingLevel[] }

export interface ServiceDeployment {
  id: string;
  environmentId: string;
  baseBranch: string;
  capabilities: CapabilityName[];
  agent?: { provider: string; model: string; thinkingLevel: ThinkingLevel } | null;
  nacos?: { serverUrl: string; namespace: string; group: string; dataIds: string[]; username: string; password?: string } | null;
  db?: { url: string; username: string; password: string } | null;
  sls?: { accessKeyId: string; accessKeySecret: string; region: string; project: string; logstores: string[] } | null;
  playwright?: { baseUrl: string; username: string; password?: string } | null;
  redis?: { host: string; port: number; username: string; password?: string; database: number } | null;
  mq?: { host: string; port: number; managementPort: number; username: string; password: string; virtualHost: string } | null;
  es?: { url: string; username: string; password?: string } | null;
}

export interface Service {
  id: string;
  key: string;
  name: string;
  description: string;
  createdAt: string;
  environmentIds: string[];
  deployments: ServiceDeployment[];
  repositories: Array<{ id: string; kind: "frontend" | "backend"; url: string }>;
}

export interface Config {
  agentModels: AgentModelDefinition[];
  environments: Environment[];
  capabilityCatalog: Array<{ key: CapabilityName }>;
  services: Service[];
}

export interface ServiceInput {
  name: string;
  description: string;
  repositories: Array<{ id?: string; kind: "frontend" | "backend"; url: string }>;
  deployments: Array<{ environmentKey: string; baseBranch: string; capabilities: CapabilityName[]; agent: { provider: string; model: string; thinkingLevel: ThinkingLevel }; nacos?: { serverUrl: string; namespace: string; group: string; dataIds: string[]; username: string; password?: string }; db?: { url: string; username: string; password: string }; sls?: { accessKeyId: string; accessKeySecret: string; region: string; project: string; logstores: string[] }; playwright?: { baseUrl: string; username: string; password?: string }; redis?: { host: string; port: number; username: string; password?: string; database: number }; mq?: { host: string; port: number; managementPort: number; username: string; password: string; virtualHost: string }; es?: { url: string; username: string; password?: string } }>;
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const error = await response.json().then((body: { error?: string }) => body.error).catch(() => undefined);
    throw new Error(error ?? `request_failed:${response.status}`);
  }
  if (response.status === 204 || response.status === 205) return undefined as T;
  const body = await response.text();
  return body ? JSON.parse(body) as T : undefined as T;
}

export const loadPeople = () => request<Person[]>("/api/people");
export const loadConfig = () => request<Config>("/api/config");
export const listIssues = () => request<IssueListItem[]>("/api/issues");
export const getIssue = (key: string) => request<IssueDetail>(`/api/issues/${encodeURIComponent(key)}`);

export async function createService(input: ServiceInput): Promise<{ key: string; name: string }> {
  return request("/api/services", { method: "POST", body: JSON.stringify(input) });
}

export const updateService = (key: string, input: ServiceInput) => request<void>(`/api/services/${encodeURIComponent(key)}`, { method: "PATCH", body: JSON.stringify(input) });
export const deleteService = (key: string) => request<void>(`/api/services/${encodeURIComponent(key)}`, { method: "DELETE" });

export function attachmentUrl(key: string, attachmentId: string): string {
  return `/api/issues/${encodeURIComponent(key)}/attachments/${encodeURIComponent(attachmentId)}`;
}

export async function fetchAttachment(key: string, attachmentId: string): Promise<Blob> {
  const response = await fetch(attachmentUrl(key, attachmentId));
  if (!response.ok) {
    const error = await response.json().then((body: { error?: string }) => body.error).catch(() => undefined);
    throw new Error(error ?? `request_failed:${response.status}`);
  }
  return response.blob();
}

export async function uploadAttachments(key: string, files: File[]): Promise<void> {
  if (!files.length) return;
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  await request(`/api/issues/${encodeURIComponent(key)}/attachments`, { method: "POST", body: form });
}

export async function deleteIssueAttachments(key: string, attachmentIds: string[]): Promise<void> {
  if (!attachmentIds.length) return;
  await request(`/api/issues/${encodeURIComponent(key)}/attachments`, { method: "DELETE", body: JSON.stringify({ attachmentIds }) });
}

export function createIssue(input: IssueInput & { environmentKey: string; reporter: string }, files: File[] = []): Promise<IssueListItem> {
  if (!files.length) return request("/api/issues", { method: "POST", body: JSON.stringify(input) });
  const form = new FormData();
  form.append("issue", JSON.stringify(input));
  for (const file of files) form.append("files", file, file.name);
  return request("/api/issues", { method: "POST", body: form });
}
export const updateIssue = (key: string, input: IssueInput) => request<IssueListItem>(`/api/issues/${encodeURIComponent(key)}`, { method: "PATCH", body: JSON.stringify(input) });
export const updateIssueStatus = (key: string, status: "open" | "resolved") => request<IssueListItem>(`/api/issues/${encodeURIComponent(key)}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
export const addIssueComment = (key: string, body: string) => request<IssueComment>(`/api/issues/${encodeURIComponent(key)}/comments`, { method: "POST", body: JSON.stringify({ body }) });
export const syncIssueUpdate = (key: string) => request<void>(`/api/issues/${encodeURIComponent(key)}/sync`, { method: "POST" });
export const retryIssue = (key: string) => request<void>(`/api/issues/${encodeURIComponent(key)}/retry`, { method: "POST" });
export const sendAgentMessage = (key: string, message: string) => request<void>(`/api/issues/${encodeURIComponent(key)}/agent-messages`, { method: "POST", body: JSON.stringify({ message }) });
export const abortAgent = (key: string) => request<void>(`/api/issues/${encodeURIComponent(key)}/agent-abort`, { method: "POST" });
export const agentStreamUrl = (key: string) => `/api/issues/${encodeURIComponent(key)}/agent-stream`;
