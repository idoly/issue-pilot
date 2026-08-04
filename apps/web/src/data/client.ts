export type IssuePriority = "p0" | "p1" | "p2" | "p3";
export type IssueType = "incident" | "request" | "question" | "smart_analysis";
export type IssueStatus = "open" | "in_progress" | "pending" | "failed" | "resolved" | "closed";

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

export interface AgentEvent {
  id: string;
  issueId?: string;
  kind: string;
  message: string;
  createdAt: string;
}

export interface IssueDetail extends IssueListItem {
  description: string;
  repositories: Array<{ id: string; url: string; baseBranch: string; workingBranch: string | null; codeServerPath: string | null }>;
  diagnosis: {
    classification: "pending" | "bug" | "not_bug" | "change_request" | "cannot_determine";
    rootCause: string | null;
    confidence: number | null;
  };
  evidence: Array<{ id: string; source: string; summary: string; createdAt: string }>;
  testRuns: Array<{ id: string; scope: string; status: string; summary: string; command: string }>;
  workspace: { status: string; url: string | null; lastError?: string | null; retryable?: boolean };
  agentSession?: { sessionId: string } | null;
  attachments: Array<{ id: string; fileName: string; mediaType: string; size: number; sha256: string; scanStatus: string; createdAt?: string }>;
  ccRecipients?: Person[];
  reporter?: Person;
  environmentKey?: string | null;
  affectedServices?: Array<{ key: string; name: string; primary: boolean }>;
  comments?: IssueComment[];
  terminalTranscript?: { data: string; columns: number; rows: number } | null;
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
      { id: "repo-web", url: "git@example.com:commerce/web.git", baseBranch: "release/2026.08", workingBranch: "issue/ISSUE-0042-web", codeServerPath: "/home/coder/workspaces/issue-0042/web" },
      { id: "repo-api", url: "git@example.com:commerce/order-api.git", baseBranch: "main", workingBranch: "issue/ISSUE-0042-api", codeServerPath: "/home/coder/workspaces/issue-0042/order-api" },
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
      author: "issue-pilot",
      body: "## 分析结论\n\n缓存失效消息缺少 `tenantId`。\n\n- 支付状态正常\n- 已补充映射测试",
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
    workspace: { status: "not_created", url: null, retryable: true },
    attachments: [],
  },
  {
    id: "ISSUE-0038",
    title: "批量审批偶发超时",
    description: "超过 500 条记录时审批接口超时。",
    priority: "p1",
    type: "question",
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
    workspace: { status: "running", url: null, retryable: true },
    attachments: [],
  },
];

export interface DemoIssueInput {
  title: string;
  description: string;
  priority: IssuePriority;
  type: IssueType;
  service: string;
  environment: string;
  reporter: string;
  assigneeSubject: string | null;
  ccSubjects: string[];
}

export function createFixture(input: DemoIssueInput): IssueDetail {
  const createdAt = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(createdAt);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const issueDate = `${values.get("year")}${values.get("month")}${values.get("day")}`;
  const pattern = new RegExp(`^ISSUE-${issueDate}-([0-9]{3,4})$`);
  const next = Math.max(0, ...fixture.flatMap((issue) => { const match = pattern.exec(issue.id); return match ? [Number(match[1])] : []; })) + 1;
  const issue: IssueDetail = {
    id: `ISSUE-${issueDate}-${String(next).padStart(3, "0")}`,
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
  };
  fixture.unshift(issue);
  return issue;
}

const fixturesEnabled = import.meta.env.MODE === "test" || import.meta.env.VITE_USE_FIXTURES === "true";

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(typeof FormData !== "undefined" && init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  return fetch(path, { ...init, headers });
}

export interface Environment {
  id: string;
  key: string;
  name: string;
  kind: "production" | "test" | "local";
  scope: "global";
}

export type DeploymentCapability = "configuration_read" | "database_read" | "cache_read" | "log_read";

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

const fixtureConfiguration: Config = {
  environments: [
    { id: "env-production", key: "production", name: "正式", kind: "production", scope: "global" },
    { id: "env-test", key: "test", name: "测试", kind: "test", scope: "global" },
  ],
  capabilityCatalog: [
    { key: "configuration_read", label: "配置读取", description: "按需合并冻结仓库配置、环境 profile 和批准的 Nacos 配置，并对敏感值脱敏。" },
    { key: "database_read", label: "数据库读取", description: "按需解析服务数据源，通过 MySQL 或 DMS 执行有行数限制的只读 SQL。" },
  ],
  services: [{
    id: "service-srm", key: "srm", name: "SRM", description: "# SRM\n\n供应商关系管理服务。\n\n## 模块说明\n\n### 供应商模块\n\n负责供应商档案与准入流程。入口位于 supplier controller。\n\n### 批处理模块\n\n负责供应商数据批量同步任务。", scope: "global",
    environmentIds: ["env-production", "env-test"], deployments: [
      { id: "srm-production", environmentId: "env-production", baseBranch: "main", capabilities: [] },
      { id: "srm-test", environmentId: "env-test", baseBranch: "develop", capabilities: ["configuration_read", "database_read"] },
    ], repositories: [{ id: "srm-repository", kind: "backend", url: "git@example.com:team/srm.git" }],
  }, {
    id: "service-oms", key: "oms", name: "OMS", description: "订单管理服务。", scope: "global",
    environmentIds: [], deployments: [], repositories: [{ id: "oms-repository", kind: "backend", url: "git@example.com:team/oms.git" }],
  }],
};

export async function loadPeople(): Promise<Person[]> {
  if (fixturesEnabled) return structuredClone(fixturePeople);
  const response = await apiFetch("/api/people");
  if (!response.ok) throw new Error(`Failed to load people: ${response.status}`);
  return await response.json() as Person[];
}

export async function loadConfig(): Promise<Config> {
  if (fixturesEnabled) return structuredClone(fixtureConfiguration);
  const response = await apiFetch("/api/config");
  if (!response.ok) throw new Error(`Failed to load configuration: ${response.status}`);
  return await response.json() as Config;
}

export function configKey(prefix: string, name: string, unique = false): string {
  const suffix = unique ? `-${Date.now()}` : "";
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const fallback = unique ? "copy" : String(Date.now());
  const maximumSlugLength = 99 - prefix.length - 1 - suffix.length;
  const slug = (normalized || fallback).slice(0, maximumSlugLength).replace(/-+$/g, "") || "item";
  return `${prefix}-${slug}${suffix}`;
}

export interface ServiceInput {
  name: string;
  description: string;
  repositories: Array<{ id?: string; kind: "frontend" | "backend"; url: string }>;
  deployments: Array<{ environmentKey: string; baseBranch: string; capabilities: DeploymentCapability[] }>;
}

export async function createService(input: ServiceInput): Promise<{ key: string; name: string }> {
  const key = configKey("service", input.name);
  if (fixturesEnabled) {
    const deployments = input.deployments.map((deployment) => ({ id: `${key}-${deployment.environmentKey}`, environmentId: fixtureConfiguration.environments.find((environment) => environment.key === deployment.environmentKey)!.id, baseBranch: deployment.baseBranch, capabilities: [...deployment.capabilities] }));
    const created: Service = { id: `service-${key}`, key, name: input.name, description: input.description, scope: "global", environmentIds: deployments.map((deployment) => deployment.environmentId), deployments, repositories: input.repositories.map((repository, index) => ({ id: repository.id ?? `${key}-${index}`, kind: repository.kind, url: repository.url })) };
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

export async function reorderServices(serviceKeys: string[]): Promise<void> {
  if (fixturesEnabled) {
    const byKey = new Map(fixtureConfiguration.services.map((service) => [service.key, service]));
    if (serviceKeys.length !== byKey.size || new Set(serviceKeys).size !== serviceKeys.length || serviceKeys.some((key) => !byKey.has(key))) throw new Error("invalid_service_order");
    fixtureConfiguration.services = serviceKeys.map((key) => byKey.get(key)!);
    return;
  }
  const response = await apiFetch("/api/services/order", { method: "PUT", body: JSON.stringify({ serviceKeys }) });
  if (!response.ok) throw new Error(await response.json().then((body: { error?: string }) => body.error).catch(() => undefined) ?? `Failed to reorder services: ${response.status}`);
}

export async function createDeployment(key: string, input: { environmentKey: string; baseBranch: string; capabilities: DeploymentCapability[] }): Promise<void> {
  if (fixturesEnabled) {
    const service = fixtureConfiguration.services.find((item) => item.key === key);
    if (!service) throw new Error("service_not_found");
    const environment = fixtureConfiguration.environments.find((item) => item.key === input.environmentKey);
    if (!environment) throw new Error("invalid_environment");
    if (service.environmentIds.includes(environment.id)) throw new Error("deployment_exists");
    service.environmentIds.push(environment.id);
    service.deployments.push({ id: `${service.key}-${environment.id}`, environmentId: environment.id, baseBranch: input.baseBranch, capabilities: [...input.capabilities] });
    return;
  }
  const response = await apiFetch(`/api/services/${encodeURIComponent(key)}/deployments`, { method: "POST", body: JSON.stringify(input) });
  if (!response.ok) throw new Error(await response.json().then((body: { error?: string }) => body.error).catch(() => undefined) ?? `Failed to create deployment: ${response.status}`);
}

export async function updateDeployment(key: string, environmentKey: string, input: { baseBranch: string; capabilities: DeploymentCapability[] }): Promise<void> {
  if (fixturesEnabled) {
    const service = fixtureConfiguration.services.find((item) => item.key === key);
    const environment = fixtureConfiguration.environments.find((item) => item.key === environmentKey);
    const deployment = service?.deployments.find((item) => item.environmentId === environment?.id);
    if (!deployment) throw new Error("deployment_not_found");
    deployment.baseBranch = input.baseBranch;
    deployment.capabilities = [...input.capabilities];
    return;
  }
  const response = await apiFetch(`/api/services/${encodeURIComponent(key)}/deployments/${encodeURIComponent(environmentKey)}`, { method: "PATCH", body: JSON.stringify(input) });
  if (!response.ok) throw new Error(await response.json().then((body: { error?: string }) => body.error).catch(() => undefined) ?? `Failed to update deployment: ${response.status}`);
}

export async function deleteDeployment(key: string, environmentKey: string): Promise<void> {
  if (fixturesEnabled) {
    const service = fixtureConfiguration.services.find((item) => item.key === key);
    const environment = fixtureConfiguration.environments.find((item) => item.key === environmentKey);
    const index = service?.deployments.findIndex((item) => item.environmentId === environment?.id) ?? -1;
    if (!service || !environment || index < 0) throw new Error("deployment_not_found");
    service.deployments.splice(index, 1);
    service.environmentIds = service.environmentIds.filter((id) => id !== environment.id);
    return;
  }
  const response = await apiFetch(`/api/services/${encodeURIComponent(key)}/deployments/${encodeURIComponent(environmentKey)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await response.json().then((body: { error?: string }) => body.error).catch(() => undefined) ?? `Failed to delete deployment: ${response.status}`);
}

export async function updateService(key: string, input: ServiceInput): Promise<void> {
  if (fixturesEnabled) {
    const service = fixtureConfiguration.services.find((item) => item.key === key);
    if (!service) throw new Error("service_not_found");
    service.name = input.name;
    service.description = input.description;
    service.repositories = input.repositories.map((repository, index) => ({ id: repository.id ?? `${key}-${index}`, kind: repository.kind, url: repository.url }));
    service.deployments = input.deployments.map((deployment) => ({ id: `${key}-${deployment.environmentKey}`, environmentId: fixtureConfiguration.environments.find((environment) => environment.key === deployment.environmentKey)!.id, baseBranch: deployment.baseBranch, capabilities: [...deployment.capabilities] }));
    service.environmentIds = service.deployments.map((deployment) => deployment.environmentId);
    return;
  }
  const response = await apiFetch(`/api/services/${encodeURIComponent(key)}`, { method: "PATCH", body: JSON.stringify(input) });
  if (!response.ok) throw new Error(await response.json().then((body: { error?: string }) => body.error).catch(() => undefined) ?? `Failed to update service: ${response.status}`);
}

export async function deleteService(key: string): Promise<void> {
  if (fixturesEnabled) {
    const index = fixtureConfiguration.services.findIndex((item) => item.key === key);
    if (index < 0) throw new Error("service_not_found");
    fixtureConfiguration.services.splice(index, 1);
    return;
  }
  const response = await apiFetch(`/api/services/${encodeURIComponent(key)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await response.json().then((body: { error?: string }) => body.error).catch(() => undefined) ?? `Failed to delete service: ${response.status}`);
}

export async function uploadAttachments(key: string, files: File[]): Promise<void> {
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

export interface IssueInput {
  title: string;
  description: string;
  priority: IssuePriority;
  type: IssueType;
  serviceKeys: string[];
  assigneeSubject: string | null;
  ccSubjects: string[];
}

export async function createIssue(input: IssueInput & { environmentKey: string; reporter: string }): Promise<IssueListItem> {
  if (fixturesEnabled) {
    const environment = fixtureConfiguration.environments.find((item) => item.key === input.environmentKey);
    const valid = environment && input.serviceKeys.every((key) => fixtureConfiguration.services.some((service) => service.key === key && service.environmentIds.includes(environment.id)));
    if (!valid) throw new Error("invalid_service_for_environment");
    return createFixture({ ...input, service: input.serviceKeys.join("+"), environment: input.environmentKey });
  }
  const response = await apiFetch("/api/issues", { method: "POST", body: JSON.stringify(input) });
  if (!response.ok) throw new Error(await response.json().then((body: { error?: string }) => body.error).catch(() => undefined) ?? `Failed to create issue: ${response.status}`);
  return await response.json() as IssueListItem;
}

export async function updateIssueStatus(key: string, status: "open" | "resolved"): Promise<IssueListItem> {
  if (fixturesEnabled) {
    const issue = fixture.find((item) => item.id === key);
    if (!issue) throw new Error("issue_not_found");
    issue.status = status;
    issue.updatedAt = new Date().toISOString();
    return issue;
  }
  const response = await apiFetch(`/api/issues/${encodeURIComponent(key)}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
  if (!response.ok) throw new Error(await response.json().then((body: { error?: string }) => body.error).catch(() => undefined) ?? `Failed to update issue status: ${response.status}`);
  return await response.json() as IssueListItem;
}

export async function updateIssue(key: string, input: IssueInput): Promise<IssueListItem> {
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

export interface TerminalTicket {
  ticket: string;
  mode?: "live" | "pty";
  expiresAt: string;
  fixture?: boolean;
}

export async function requestTerminalTicket(key: string): Promise<TerminalTicket> {
  if (fixturesEnabled) return { ticket: "fixture", expiresAt: new Date(Date.now() + 30_000).toISOString(), fixture: true };
  const response = await apiFetch(`/api/issues/${encodeURIComponent(key)}/terminal-ticket`, { method: "POST" });
  if (!response.ok) throw new Error(await response.json().then((value: { error?: string }) => value.error).catch(() => undefined) ?? `Failed to open pi terminal: ${response.status}`);
  return await response.json() as TerminalTicket;
}

export function terminalUrl(key: string, ticket: string): string {
  const url = new URL(`/api/issues/${encodeURIComponent(key)}/terminal`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  return url.toString();
}

export async function streamAgentEvents(key: string, onEvent: (event: AgentEvent) => void, signal: AbortSignal): Promise<void> {
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
      const event = JSON.parse(line) as AgentEvent | { type: "heartbeat" };
      if (!("type" in event)) onEvent(event);
    }
  }
}

export async function sendPrompt(key: string, message: string, behavior: "steer" | "followUp" = "followUp"): Promise<void> {
  if (fixturesEnabled) {
    const issue = fixture.find((item) => item.id === key);
    if (!issue) throw new Error("issue_not_found");
    return;
  }
  const response = await apiFetch(`/api/issues/${encodeURIComponent(key)}/pi-prompt`, { method: "POST", body: JSON.stringify({ message, behavior }) });
  if (!response.ok) throw new Error(await response.json().then((value: { error?: string }) => value.error).catch(() => undefined) ?? `Failed to send pi prompt: ${response.status}`);
}

export async function abortPrompt(key: string): Promise<void> {
  if (fixturesEnabled) return;
  const response = await apiFetch(`/api/issues/${encodeURIComponent(key)}/pi-abort`, { method: "POST" });
  if (!response.ok && response.status !== 409) throw new Error(await response.json().then((value: { error?: string }) => value.error).catch(() => undefined) ?? `Failed to abort pi prompt: ${response.status}`);
}

export async function retryIssue(key: string): Promise<void> {
  if (fixturesEnabled) {
    const issue = fixture.find((item) => item.id === key);
    if (!issue) throw new Error("issue_not_found");
    issue.workspace = { ...issue.workspace, status: "preparing", lastError: null, retryable: false };
    return;
  }
  const response = await apiFetch(`/api/issues/${encodeURIComponent(key)}/retry`, { method: "POST" });
  if (!response.ok) throw new Error(await response.json().then((value: { error?: string }) => value.error).catch(() => undefined) ?? `Failed to retry issue: ${response.status}`);
}

export async function addComment(key: string, body: string): Promise<IssueComment> {
  if (fixturesEnabled) {
    const issue = fixture.find((item) => item.id === key);
    if (!issue) throw new Error("issue_not_found");
    const createdAt = new Date().toISOString();
    const comment = { id: `${key}-comment-${Date.now()}`, author: "fixture-user", body, createdAt };
    issue.comments = [...(issue.comments ?? []), comment, { id: `${comment.id}-agent`, author: "issue-pilot", body: "## 已收到\n\n我会基于当前工单上下文继续处理。", createdAt: new Date(Date.now() + 1).toISOString() }];
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
