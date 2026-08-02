import { accessToken } from "./auth";

export type IssuePriority = "p0" | "p1" | "p2" | "p3";
export type IssueType = "incident" | "request" | "task" | "problem" | "question" | "smart_analysis";
export type IssueStatus = "open" | "in_progress" | "pending" | "resolved" | "closed";

export interface IssueListItem {
  id: string;
  title: string;
  priority: IssuePriority;
  type: IssueType;
  status: IssueStatus;
  assignee: string | null;
  assigneeSubject: string | null;
  version: number;
  createdAt?: string;
  updatedAt: string;
  labels: string[];
}

export interface IssueComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface IssueAgentEvent {
  id: string;
  issueId?: string;
  kind: string;
  message: string;
  createdAt: string;
}

export interface PiConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export interface IssueDetail extends IssueListItem {
  description: string;
  repositories: Array<{ id: string; url: string; baseBranch: string; workingBranch: string | null }>;
  diagnosis: {
    classification: "pending" | "bug" | "not_bug" | "change_request" | "cannot_determine";
    rootCause: string | null;
    confidence: number | null;
  };
  evidence: Array<{ id: string; source: string; summary: string; createdAt: string }>;
  testRuns: Array<{ id: string; scope: string; status: string; summary: string; command: string }>;
  workspace: { status: string; url: string | null; lastError?: string | null };
  agentSession?: { sessionId: string } | null;
  attachments: Array<{ id: string; fileName: string; mediaType: string; size: number; sha256: string; scanStatus: string; createdAt?: string }>;
  ccRecipients?: Person[];
  reporter?: Person;
  environmentKey?: string | null;
  affectedServices?: Array<{ key: string; name: string; primary: boolean }>;
  affectedModules?: Array<{ id: string; serviceKey: string; name: string; path: string }>;
  comments?: IssueComment[];
  piConversation?: PiConversationMessage[];
}

export interface Person { subject: string; name: string; email: string }

const fixturePeople: Person[] = [
  { subject: "fixture-user", name: "严欣", email: "694590014@qq.com" },
  { subject: "fixture-reviewer", name: "林栩", email: "reviewer@example.com" },
];

const fixture: IssueDetail[] = [
  {
    id: "ISSUE-0042",
    title: "结算页提交后订单状态未刷新",
    description: "支付回调成功后，结算页仍显示处理中。影响生产环境部分企业订单。",
    priority: "p1",
    type: "incident",
    status: "in_progress",
    assignee: "陈默",
    assigneeSubject: "fixture-user",
    version: 1,
    updatedAt: "2026-08-01T13:46:00.000Z",
    labels: ["checkout", "frontend"],
    repositories: [
      { id: "repo-web", url: "git@example.com:commerce/web.git", baseBranch: "release/2026.08", workingBranch: "issue/ISSUE-0042-web" },
      { id: "repo-api", url: "git@example.com:commerce/order-api.git", baseBranch: "main", workingBranch: "issue/ISSUE-0042-api" },
    ],
    diagnosis: { classification: "bug", rootCause: "回调事件完成后缓存失效消息未包含企业订单租户键。", confidence: 0.86 },
    evidence: [
      { id: "ev-1", source: "sls", summary: "14:21-14:28 期间 37 个订单收到 payment.succeeded，但缓存键未被删除。", createdAt: "2026-08-01T14:32:00.000Z" },
      { id: "ev-2", source: "dms", summary: "订单表状态均为 PAID，排除支付回写失败。", createdAt: "2026-08-01T14:36:00.000Z" },
      { id: "ev-3", source: "code", summary: "tenantId 在 PaymentEventMapper 中未映射。", createdAt: "2026-08-01T14:41:00.000Z" },
    ],
    testRuns: [
      { id: "test-1", scope: "backend", status: "passed", summary: "订单事件映射与缓存失效测试通过", command: "mvn -pl order-service test" },
      { id: "test-2", scope: "frontend", status: "passed", summary: "桌面与移动端支付完成流程通过", command: "npm run test:e2e -- checkout-paid.spec.ts" },
    ],
    workspace: { status: "ready", url: "https://code.example.com/issue/ISSUE-0042" },
    agentSession: { sessionId: "fixture-session-0042" },
    attachments: [],
    ccRecipients: [],
    comments: [{
      id: "comment-agent-1",
      author: "issue-agent",
      body: "## 分析结论\n\n缓存失效消息缺少 `tenantId`。\n\n- 支付状态正常\n- 已补充映射测试",
      createdAt: "2026-08-01T14:45:00.000Z",
    }],
    piConversation: [{
      id: "pi-message-agent-1",
      role: "assistant",
      text: "## 分析结论\n\n缓存失效消息缺少 `tenantId`。\n\n- 支付状态正常\n- 已补充映射测试",
      createdAt: "2026-08-01T14:45:00.000Z",
    }],
  },
  {
    id: "ISSUE-0041",
    title: "客户导出的 CSV 缺少时区信息",
    description: "导出记录中的创建时间未标注时区。",
    priority: "p2",
    type: "request",
    status: "pending",
    assignee: "林栩",
    assigneeSubject: "fixture-user",
    version: 1,
    updatedAt: "2026-08-01T12:18:00.000Z",
    labels: ["export"],
    repositories: [],
    diagnosis: { classification: "change_request", rootCause: null, confidence: 0.72 },
    evidence: [],
    testRuns: [],
    workspace: { status: "not_created", url: null },
    attachments: [],
  },
  {
    id: "ISSUE-0038",
    title: "批量审批偶发超时",
    description: "超过 500 条记录时审批接口超时。",
    priority: "p1",
    type: "problem",
    status: "open",
    assignee: null,
    assigneeSubject: null,
    version: 1,
    updatedAt: "2026-08-01T09:05:00.000Z",
    labels: ["approval", "performance"],
    repositories: [],
    diagnosis: { classification: "pending", rootCause: null, confidence: null },
    evidence: [],
    testRuns: [],
    workspace: { status: "running", url: null },
    attachments: [],
  },
];

export interface CreateDemoIssueInput {
  title: string;
  description: string;
  priority: IssuePriority;
  type: IssueType;
  service: string;
  moduleIds: string[];
  environment: string;
  reporter: string;
  assigneeSubject: string | null;
  ccSubjects: string[];
}

export function createDemoIssue(input: CreateDemoIssueInput): IssueDetail {
  const next = Math.max(...fixture.map((issue) => Number(issue.id.replace("ISSUE-", "")))) + 1;
  const issue: IssueDetail = {
    id: `ISSUE-${String(next).padStart(4, "0")}`,
    title: input.title,
    description: input.description,
    priority: input.priority,
    type: input.type,
    status: "open",
    assignee: input.assigneeSubject ? fixturePeople.find((person) => person.subject === input.assigneeSubject)?.name ?? input.reporter : null,
    assigneeSubject: input.assigneeSubject,
    version: 1,
    updatedAt: new Date().toISOString(),
    labels: [input.service.toLowerCase(), input.environment],
    repositories: [],
    diagnosis: { classification: "pending", rootCause: null, confidence: null },
    evidence: [],
    testRuns: [],
    workspace: { status: "not_created", url: null },
    attachments: [],
    ccRecipients: fixturePeople.filter((person) => input.ccSubjects.includes(person.subject)),
    environmentKey: input.environment,
    affectedServices: input.service.split("+").map((serviceKey, index) => ({ key: serviceKey, name: serviceKey.toUpperCase(), primary: index === 0 })),
    affectedModules: fixtureConfiguration.services.flatMap((service) => service.modules.filter((module) => input.moduleIds.includes(module.id)).map((module) => ({ ...module, serviceKey: service.key }))),
  };
  fixture.unshift(issue);
  return issue;
}

const fixturesEnabled = import.meta.env.MODE === "test" || import.meta.env.VITE_USE_FIXTURES === "true";

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = accessToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init?.body && !(typeof FormData !== "undefined" && init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  return fetch(path, { ...init, headers });
}

export interface ConfigEnvironment {
  id: string;
  key: string;
  name: string;
  kind: "production" | "test" | "local";
  scope: "global";
}

export interface ConfigService {
  id: string;
  key: string;
  name: string;
  description: string;
  scope: "global";
  metadata: Record<string, unknown>;
  environmentIds: string[];
  repositories: Array<{ id: string; url: string; defaultBranch: string; role: string }>;
  modules: Array<{ id: string; name: string; path: string }>;
  relatedServiceIds: string[];
  relatedModuleIds: string[];
}

export interface Configuration {
  environments: ConfigEnvironment[];
  services: ConfigService[];
}

const fixtureConfiguration: Configuration = {
  environments: [
    { id: "env-production", key: "production", name: "正式", kind: "production", scope: "global" },
    { id: "env-test", key: "test", name: "测试", kind: "test", scope: "global" },
  ],
  services: [{
    id: "service-srm", key: "srm", name: "SRM", description: "供应商关系管理服务", scope: "global",
    metadata: {}, environmentIds: ["env-production"], repositories: [], modules: [{ id: "srm-module-supplier", name: "供应商模块", path: "modules/supplier" }], relatedServiceIds: [], relatedModuleIds: [],
  }],
};

export async function loadPeople(): Promise<Person[]> {
  if (fixturesEnabled) return structuredClone(fixturePeople);
  const response = await apiFetch("/api/people");
  if (!response.ok) throw new Error(`Failed to load people: ${response.status}`);
  return await response.json() as Person[];
}

export async function loadConfiguration(): Promise<Configuration> {
  if (fixturesEnabled) return structuredClone(fixtureConfiguration);
  const response = await apiFetch("/api/config");
  if (!response.ok) throw new Error(`Failed to load configuration: ${response.status}`);
  return await response.json() as Configuration;
}

export function createConfigurationKey(prefix: string, name: string, unique = false): string {
  const suffix = unique ? `-${Date.now()}` : "";
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const fallback = unique ? "copy" : String(Date.now());
  const maximumSlugLength = 99 - prefix.length - 1 - suffix.length;
  const slug = (normalized || fallback).slice(0, maximumSlugLength).replace(/-+$/g, "") || "item";
  return `${prefix}-${slug}${suffix}`;
}

export async function createEnvironment(name: string): Promise<{ key: string; name: string }> {
  const key = createConfigurationKey("env", name);
  if (fixturesEnabled) {
    const created: ConfigEnvironment = { id: `env-${key}`, key, name, kind: "test", scope: "global" };
    fixtureConfiguration.environments.push(created);
    return created;
  }
  const response = await apiFetch("/api/environments", { method: "POST", body: JSON.stringify({ key, name }) });
  if (!response.ok) {
    const message = await response.json().then((body: { error?: string }) => body.error).catch(() => undefined);
    throw new Error(message ?? `Failed to create environment: ${response.status}`);
  }
  return await response.json() as { key: string; name: string };
}

export interface ServiceMutationInput {
  name: string;
  description: string;
  environmentKey: string;
  repositories: Array<{ url: string; defaultBranch: string; role?: string }>;
  modules: Array<{ id?: string; name: string; path: string }>;
  relatedServiceKeys: string[];
  relatedModuleIds: string[];
}

export async function createService(input: ServiceMutationInput): Promise<{ key: string; name: string }> {
  const key = createConfigurationKey("service", input.name);
  if (fixturesEnabled) {
    const environmentIds = fixtureConfiguration.environments.filter((environment) => environment.key === input.environmentKey).map((environment) => environment.id);
    const created: ConfigService = { id: `service-${key}`, key, name: input.name, description: input.description, scope: "global", metadata: {}, environmentIds, repositories: input.repositories.map((repository, index) => ({ id: `${key}-${index}`, role: repository.role ?? "application", ...repository })), modules: input.modules.map((module, index) => ({ id: module.id ?? `${key}-module-${index}`, name: module.name, path: module.path })), relatedServiceIds: fixtureConfiguration.services.filter((related) => input.relatedServiceKeys.includes(related.key)).map((related) => related.id), relatedModuleIds: [...input.relatedModuleIds] };
    fixtureConfiguration.services.push(created);
    return created;
  }
  const response = await apiFetch("/api/services", { method: "POST", body: JSON.stringify({ key, ...input }) });
  if (!response.ok) {
    const message = await response.json().then((body: { error?: string }) => body.error).catch(() => undefined);
    throw new Error(message ?? `Failed to create service: ${response.status}`);
  }
  return await response.json() as { key: string; name: string };
}

export async function copyService(key: string, input: { name: string; targetEnvironmentKey: string }): Promise<{ key: string; name: string }> {
  const copyKey = createConfigurationKey("service", input.name, true);
  if (fixturesEnabled) {
    const source = fixtureConfiguration.services.find((service) => service.key === key);
    if (!source) throw new Error("service_not_found");
    const targetEnvironment = fixtureConfiguration.environments.find((environment) => environment.key === input.targetEnvironmentKey);
    if (!targetEnvironment) throw new Error("invalid_environment");
    if (source.environmentIds.includes(targetEnvironment.id)) throw new Error("copy_target_must_differ");
    const allowedTargets = new Set(fixtureConfiguration.services.filter((service) => service.environmentIds.includes(targetEnvironment.id)).map((service) => service.id));
    const relatedServiceIds = source.relatedServiceIds.filter((id) => allowedTargets.has(id));
    const relatedModuleIds = fixtureConfiguration.services.filter((service) => relatedServiceIds.includes(service.id)).flatMap((service) => service.modules.filter((module) => source.relatedModuleIds.includes(module.id)).map((module) => module.id));
    const copied: ConfigService = {
      ...source,
      id: `service-${copyKey}`,
      key: copyKey,
      name: input.name,
      environmentIds: [targetEnvironment.id],
      repositories: source.repositories.map((repository, index) => ({ ...repository, id: `${copyKey}-repository-${index}` })),
      modules: source.modules.map((module, index) => ({ ...module, id: `${copyKey}-module-${index}` })),
      relatedServiceIds,
      relatedModuleIds,
    };
    fixtureConfiguration.services.push(copied);
    return { key: copied.key, name: copied.name };
  }
  const response = await apiFetch(`/api/services/${encodeURIComponent(key)}/copy`, { method: "POST", body: JSON.stringify({ key: copyKey, ...input }) });
  if (!response.ok) throw new Error(await response.json().then((body: { error?: string }) => body.error).catch(() => undefined) ?? `Failed to copy service: ${response.status}`);
  return await response.json() as { key: string; name: string };
}

export async function updateEnvironment(key: string, input: { name: string }): Promise<void> {
  if (fixturesEnabled) {
    const environment = fixtureConfiguration.environments.find((item) => item.key === key);
    if (!environment) throw new Error("environment_not_found");
    environment.name = input.name;
    return;
  }
  const response = await apiFetch(`/api/environments/${encodeURIComponent(key)}`, { method: "PATCH", body: JSON.stringify(input) });
  if (!response.ok) throw new Error(await response.json().then((body: { error?: string }) => body.error).catch(() => undefined) ?? `Failed to update environment: ${response.status}`);
}

export async function deleteEnvironment(key: string): Promise<void> {
  if (fixturesEnabled) {
    const index = fixtureConfiguration.environments.findIndex((item) => item.key === key);
    if (index < 0) throw new Error("environment_not_found");
    const [environment] = fixtureConfiguration.environments.splice(index, 1);
    for (const service of fixtureConfiguration.services) service.environmentIds = service.environmentIds.filter((id) => id !== environment!.id);
    return;
  }
  const response = await apiFetch(`/api/environments/${encodeURIComponent(key)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await response.json().then((body: { error?: string }) => body.error).catch(() => undefined) ?? `Failed to delete environment: ${response.status}`);
}

export async function updateService(key: string, input: ServiceMutationInput): Promise<void> {
  if (fixturesEnabled) {
    const service = fixtureConfiguration.services.find((item) => item.key === key);
    if (!service) throw new Error("service_not_found");
    service.name = input.name;
    service.description = input.description;
    service.metadata = {};
    service.environmentIds = fixtureConfiguration.environments.filter((environment) => environment.key === input.environmentKey).map((environment) => environment.id);
    service.repositories = input.repositories.map((repository, index) => ({ id: `${key}-${index}`, role: repository.role ?? "application", ...repository }));
    service.modules = input.modules.map((module, index) => ({ id: module.id ?? `${key}-module-${index}`, name: module.name, path: module.path }));
    service.relatedServiceIds = fixtureConfiguration.services.filter((related) => input.relatedServiceKeys.includes(related.key)).map((related) => related.id);
    service.relatedModuleIds = [...input.relatedModuleIds];
    return;
  }
  const response = await apiFetch(`/api/services/${encodeURIComponent(key)}`, { method: "PATCH", body: JSON.stringify(input) });
  if (!response.ok) throw new Error(await response.json().then((body: { error?: string }) => body.error).catch(() => undefined) ?? `Failed to update service: ${response.status}`);
}

export async function deleteService(key: string): Promise<void> {
  if (fixturesEnabled) {
    const index = fixtureConfiguration.services.findIndex((item) => item.key === key);
    if (index < 0) throw new Error("service_not_found");
    const [service] = fixtureConfiguration.services.splice(index, 1);
    for (const related of fixtureConfiguration.services) related.relatedServiceIds = related.relatedServiceIds.filter((id) => id !== service!.id);
    return;
  }
  const response = await apiFetch(`/api/services/${encodeURIComponent(key)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await response.json().then((body: { error?: string }) => body.error).catch(() => undefined) ?? `Failed to delete service: ${response.status}`);
}

export async function uploadIssueAttachments(key: string, files: File[]): Promise<void> {
  if (!files.length) return;
  if (fixturesEnabled) {
    const issue = fixture.find((item) => item.id === key);
    if (!issue) throw new Error("issue_not_found");
    issue.attachments.push(...files.map((file, index) => ({ id: `${key}-attachment-${Date.now()}-${index}`, fileName: file.name, mediaType: file.type || "application/octet-stream", size: file.size, sha256: "fixture", scanStatus: "pending" })));
    return;
  }
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  const response = await apiFetch(`/api/issues/${encodeURIComponent(key)}/attachments`, { method: "POST", body: form });
  if (!response.ok) throw new Error(await response.json().then((body: { error?: string }) => body.error).catch(() => undefined) ?? `Failed to upload attachments: ${response.status}`);
}

export interface IssueMutationInput {
  title: string;
  description: string;
  priority: IssuePriority;
  type: IssueType;
  serviceKeys: string[];
  moduleIds: string[];
  assigneeSubject: string | null;
  ccSubjects: string[];
}

export async function createIssue(input: IssueMutationInput & { environmentKey: string; reporter: string }): Promise<IssueListItem> {
  if (fixturesEnabled) return createDemoIssue({ ...input, service: input.serviceKeys.join("+"), environment: input.environmentKey });
  const response = await apiFetch("/api/issues", { method: "POST", body: JSON.stringify(input) });
  if (!response.ok) throw new Error(`Failed to create issue: ${response.status}`);
  return await response.json() as IssueListItem;
}

export async function updateIssue(key: string, input: IssueMutationInput): Promise<IssueListItem> {
  if (fixturesEnabled) {
    const index = fixture.findIndex((item) => item.id === key);
    if (index < 0) throw new Error("issue_not_found");
    const issue = fixture[index]!;
    const updated: IssueDetail = {
      ...issue,
      title: input.title,
      description: input.description,
      priority: input.priority,
      type: input.type,
      assigneeSubject: input.assigneeSubject,
      assignee: input.assigneeSubject ? fixturePeople.find((person) => person.subject === input.assigneeSubject)?.name ?? null : null,
      ccRecipients: fixturePeople.filter((person) => input.ccSubjects.includes(person.subject)),
      affectedServices: input.serviceKeys.map((serviceKey, index) => ({ key: serviceKey, name: serviceKey.toUpperCase(), primary: index === 0 })),
      affectedModules: fixtureConfiguration.services.flatMap((service) => service.modules.filter((module) => input.moduleIds.includes(module.id)).map((module) => ({ ...module, serviceKey: service.key }))),
      version: issue.version + 1,
      updatedAt: new Date().toISOString(),
    };
    fixture[index] = updated;
    return updated;
  }
  const response = await apiFetch(`/api/issues/${encodeURIComponent(key)}`, { method: "PATCH", body: JSON.stringify(input) });
  if (!response.ok) throw new Error(await response.json().then((body: { error?: string }) => body.error).catch(() => undefined) ?? `Failed to update issue: ${response.status}`);
  return await response.json() as IssueListItem;
}

export async function listIssues(): Promise<IssueListItem[]> {
  if (fixturesEnabled) return fixture;
  const response = await apiFetch("/api/issues");
  if (!response.ok) throw new Error(`Failed to load issues: ${response.status}`);
  return await response.json() as IssueListItem[];
}

export interface PiTerminalTicket {
  ticket: string;
  mode?: "live" | "pty";
  expiresAt: string;
  fixture?: boolean;
}

export async function requestPiTerminalTicket(key: string): Promise<PiTerminalTicket> {
  if (fixturesEnabled) return { ticket: "fixture", expiresAt: new Date(Date.now() + 30_000).toISOString(), fixture: true };
  const response = await apiFetch(`/api/issues/${encodeURIComponent(key)}/terminal-ticket`, { method: "POST" });
  if (!response.ok) throw new Error(await response.json().then((value: { error?: string }) => value.error).catch(() => undefined) ?? `Failed to open pi terminal: ${response.status}`);
  return await response.json() as PiTerminalTicket;
}

export function piTerminalWebSocketUrl(key: string, ticket: string): string {
  const url = new URL(`/api/issues/${encodeURIComponent(key)}/terminal`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

export async function streamIssueAgentEvents(key: string, onEvent: (event: IssueAgentEvent) => void, signal: AbortSignal): Promise<void> {
  if (fixturesEnabled) {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    return;
  }
  const response = await apiFetch(`/api/issues/${encodeURIComponent(key)}/agent-stream`, { signal });
  if (!response.ok || !response.body) throw new Error(`Failed to stream agent events: ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as IssueAgentEvent | { type: "heartbeat" };
      if (!("type" in event)) onEvent(event);
    }
  }
}

export async function sendPiPrompt(key: string, message: string, behavior: "steer" | "followUp" = "followUp"): Promise<void> {
  if (fixturesEnabled) {
    const issue = fixture.find((item) => item.id === key);
    if (!issue) throw new Error("issue_not_found");
    const now = Date.now();
    issue.piConversation = [
      ...(issue.piConversation ?? []),
      { id: `${key}-pi-user-${now}`, role: "user", text: message, createdAt: new Date(now).toISOString() },
      { id: `${key}-pi-assistant-${now}`, role: "assistant", text: "## 已收到\n\n我会基于当前 pi session 继续处理。", createdAt: new Date(now + 1).toISOString() },
    ];
    return;
  }
  const response = await apiFetch(`/api/issues/${encodeURIComponent(key)}/pi-prompt`, { method: "POST", body: JSON.stringify({ message, behavior }) });
  if (!response.ok) throw new Error(await response.json().then((value: { error?: string }) => value.error).catch(() => undefined) ?? `Failed to send pi prompt: ${response.status}`);
}

export async function abortPiPrompt(key: string): Promise<void> {
  if (fixturesEnabled) return;
  const response = await apiFetch(`/api/issues/${encodeURIComponent(key)}/pi-abort`, { method: "POST" });
  if (!response.ok && response.status !== 409) throw new Error(await response.json().then((value: { error?: string }) => value.error).catch(() => undefined) ?? `Failed to abort pi prompt: ${response.status}`);
}

export async function sendIssueComment(key: string, body: string): Promise<IssueComment> {
  if (fixturesEnabled) {
    const issue = fixture.find((item) => item.id === key);
    if (!issue) throw new Error("issue_not_found");
    const createdAt = new Date().toISOString();
    const comment = { id: `${key}-comment-${Date.now()}`, author: "fixture-user", body, createdAt };
    issue.comments = [...(issue.comments ?? []), comment, { id: `${comment.id}-agent`, author: "issue-agent", body: "## 已收到\n\n我会基于当前工单上下文继续处理。", createdAt: new Date(Date.now() + 1).toISOString() }];
    return comment;
  }
  const response = await apiFetch(`/api/issues/${encodeURIComponent(key)}/comments`, { method: "POST", body: JSON.stringify({ body }) });
  if (!response.ok) throw new Error(await response.json().then((value: { error?: string }) => value.error).catch(() => undefined) ?? `Failed to send comment: ${response.status}`);
  return await response.json() as IssueComment;
}

export async function getIssue(id: string): Promise<IssueDetail> {
  if (fixturesEnabled) {
    const issue = fixture.find((item) => item.id === id);
    if (!issue) throw new Error(`Issue not found: ${id}`);
    return structuredClone(issue);
  }
  const response = await apiFetch(`/api/issues/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(response.status === 404 ? "issue_not_found" : `Failed to load issue: ${response.status}`);
  return await response.json() as IssueDetail;
}
