import { ISSUE_PRIORITIES, ISSUE_STATUSES, ISSUE_TYPES_BY_ENVIRONMENT, type AgentConfiguration, type AgentFooterStats, type AgentModelDefinition, type AgentThinkingLevel, type CapabilityConfiguration, type CapabilityName, type IssuePriority, type IssueStatus, type IssueType } from "../../../domain/contracts";
export type { RunEvent } from "../../../agent/events";

export { ISSUE_PRIORITIES, ISSUE_STATUSES, ISSUE_TYPES_BY_ENVIRONMENT };
export type { AgentConfiguration, AgentFooterStats, AgentThinkingLevel, CapabilityConfiguration, CapabilityName, IssuePriority, IssueStatus, IssueType };
export type AgentModelOption = Pick<AgentModelDefinition, "provider" | "id" | "thinkingLevels">;

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
  workspace: { status: string; url: string | null; lastError?: string | null; retryable?: boolean };
  attachments: Array<{ id: string; fileName: string; mediaType: string; size: number; sha256: string; createdAt?: string }>;
  ccRecipients?: Person[];
  reporter?: Person;
  environmentKey: string;
  comments: IssueComment[];
}

export interface Environment {
  key: string;
  name: string;
}

export interface ServiceDeployment extends CapabilityConfiguration {
  environmentKey: string;
  baseBranch: string;
  capabilities: CapabilityName[];
  agent: AgentConfiguration | null;
}

export interface Service {
  key: string;
  name: string;
  description: string;
  deployments: ServiceDeployment[];
  repositories: Array<{ id: string; url: string }>;
}

export interface Config {
  agentModels: AgentModelOption[];
  environments: Environment[];
  capabilityCatalog: Array<{ key: CapabilityName }>;
  services: Service[];
}

export interface ServiceInput {
  name: string;
  description: string;
  repositories: Array<{ id?: string; url: string }>;
  deployments: Array<CapabilityConfiguration & { environmentKey: string; baseBranch: string; capabilities: CapabilityName[]; agent: AgentConfiguration }>;
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

const issuePath = (key: string, suffix = "") => `/api/issues/${encodeURIComponent(key)}${suffix}`;
const servicePath = (key: string) => `/api/services/${encodeURIComponent(key)}`;

export const loadPeople = () => request<Person[]>("/api/people");
export const loadCurrentUser = () => request<Person>("/api/me");
export const loadConfig = () => request<Config>("/api/config");
export const listIssues = () => request<IssueListItem[]>("/api/issues");
export const getIssue = (key: string) => request<IssueDetail>(issuePath(key));

const jsonRequest = <T>(path: string, method: "POST" | "PATCH" | "DELETE", body: unknown) => request<T>(path, { method, body: JSON.stringify(body) });

export const createService = (input: ServiceInput) => jsonRequest<{ key: string; name: string }>("/api/services", "POST", input);
export const updateService = (key: string, input: ServiceInput) => jsonRequest<void>(servicePath(key), "PATCH", input);
export const deleteService = (key: string) => request<void>(servicePath(key), { method: "DELETE" });

export function attachmentUrl(key: string, attachmentId: string): string {
  return issuePath(key, `/attachments/${encodeURIComponent(attachmentId)}`);
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
  await request(issuePath(key, "/attachments"), { method: "POST", body: form });
}

export async function deleteIssueAttachments(key: string, attachmentIds: string[]): Promise<void> {
  if (!attachmentIds.length) return;
  await jsonRequest(issuePath(key, "/attachments"), "DELETE", { attachmentIds });
}

export function createIssue(input: IssueInput & { environmentKey: string }, files: File[] = []): Promise<IssueListItem> {
  if (!files.length) return jsonRequest("/api/issues", "POST", input);
  const form = new FormData();
  form.append("issue", JSON.stringify(input));
  for (const file of files) form.append("files", file, file.name);
  return request("/api/issues", { method: "POST", body: form });
}
export const updateIssue = (key: string, input: IssueInput) => jsonRequest<IssueListItem>(issuePath(key), "PATCH", input);
export const updateIssueStatus = (key: string, status: "open" | "resolved") => jsonRequest<IssueListItem>(issuePath(key, "/status"), "PATCH", { status });
export const addIssueComment = (key: string, body: string) => jsonRequest<IssueComment>(issuePath(key, "/comments"), "POST", { body });
export const syncIssueUpdate = (key: string) => request<void>(issuePath(key, "/sync"), { method: "POST" });
export const retryIssue = (key: string) => request<void>(issuePath(key, "/retry"), { method: "POST" });
export const sendAgentMessage = (key: string, message: string) => jsonRequest<void>(issuePath(key, "/agent-messages"), "POST", { message });
export const agentStreamUrl = (key: string) => issuePath(key, "/agent-stream");
