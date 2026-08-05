export type IssuePriority = "p0" | "p1" | "p2" | "p3";
export type IssueType = "incident" | "request" | "question" | "smart_analysis";
export type IssueStatus = "open" | "in_progress" | "pending" | "failed" | "resolved" | "closed";

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
  attachments: Array<{ id: string; fileName: string; mediaType: string; size: number; sha256: string; scanStatus: string; createdAt?: string }>;
  ccRecipients?: Person[];
  reporter?: Person;
  environmentKey: string;
  comments: IssueComment[];
  terminalTranscript?: { data: string; columns: number; rows: number } | null;
}

export interface Environment {
  id: string;
  key: string;
  name: string;
  kind: "production" | "test";
  scope: "global";
}

export type DeploymentCapability = "configuration_read" | "database_read";

export interface ServiceDeployment {
  id: string;
  environmentId: string;
  baseBranch: string;
  capabilities: DeploymentCapability[];
}

export interface Service {
  id: string;
  key: string;
  name: string;
  description: string;
  scope: "global";
  environmentIds: string[];
  deployments: ServiceDeployment[];
  repositories: Array<{ id: string; kind: "frontend" | "backend"; url: string }>;
}

export interface Config {
  environments: Environment[];
  capabilityCatalog: Array<{ key: DeploymentCapability; label: string; description: string }>;
  services: Service[];
}

export interface ServiceInput {
  name: string;
  description: string;
  repositories: Array<{ id?: string; kind: "frontend" | "backend"; url: string }>;
  deployments: Array<{ environmentKey: string; baseBranch: string; capabilities: DeploymentCapability[] }>;
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

export interface TerminalTicket {
  ticket: string;
  mode?: "live" | "pty";
  expiresAt: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const error = await response.json().then((body: { error?: string }) => body.error).catch(() => undefined);
    throw new Error(error ?? `request_failed:${response.status}`);
  }
  return response.status === 204 ? undefined as T : await response.json() as T;
}

export function configKey(prefix: string, name: string): string {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const slug = (normalized || String(Date.now())).slice(0, 98 - prefix.length).replace(/-+$/g, "") || "item";
  return `${prefix}-${slug}`;
}

export const loadPeople = () => request<Person[]>("/api/people");
export const loadConfig = () => request<Config>("/api/config");
export const listIssues = () => request<IssueListItem[]>("/api/issues");
export const getIssue = (key: string) => request<IssueDetail>(`/api/issues/${encodeURIComponent(key)}`);

export async function createService(input: ServiceInput): Promise<{ key: string; name: string }> {
  return request("/api/services", { method: "POST", body: JSON.stringify({ key: configKey("service", input.name), ...input }) });
}

export const reorderServices = (serviceKeys: string[]) => request<void>("/api/services/order", { method: "PUT", body: JSON.stringify({ serviceKeys }) });
export const updateService = (key: string, input: ServiceInput) => request<void>(`/api/services/${encodeURIComponent(key)}`, { method: "PATCH", body: JSON.stringify(input) });
export const deleteService = (key: string) => request<void>(`/api/services/${encodeURIComponent(key)}`, { method: "DELETE" });

export async function uploadAttachments(key: string, files: File[]): Promise<void> {
  if (!files.length) return;
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  await request(`/api/issues/${encodeURIComponent(key)}/attachments`, { method: "POST", body: form });
}

export const createIssue = (input: IssueInput & { environmentKey: string; reporter: string }) => request<IssueListItem>("/api/issues", { method: "POST", body: JSON.stringify(input) });
export const updateIssue = (key: string, input: IssueInput) => request<IssueListItem>(`/api/issues/${encodeURIComponent(key)}`, { method: "PATCH", body: JSON.stringify(input) });
export const updateIssueStatus = (key: string, status: "open" | "resolved") => request<IssueListItem>(`/api/issues/${encodeURIComponent(key)}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
export const addIssueComment = (key: string, body: string) => request<IssueComment>(`/api/issues/${encodeURIComponent(key)}/comments`, { method: "POST", body: JSON.stringify({ body }) });
export const syncIssueUpdate = (key: string) => request<void>(`/api/issues/${encodeURIComponent(key)}/sync`, { method: "POST" });
export const retryIssue = (key: string) => request<void>(`/api/issues/${encodeURIComponent(key)}/retry`, { method: "POST" });
export const requestTerminalTicket = (key: string) => request<TerminalTicket>(`/api/issues/${encodeURIComponent(key)}/terminal-ticket`, { method: "POST" });

export function terminalUrl(key: string, ticket: string): string {
  const url = new URL(`/api/issues/${encodeURIComponent(key)}/terminal`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return url.toString();
}
