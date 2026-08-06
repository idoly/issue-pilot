import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { CAPABILITY_KEYS, type CapabilityName } from "../shared/capabilities.ts";
import { normalizeIssueKey } from "../shared/issue-key.ts";

export const POLICY_VERSION = 14 as const;

export type ServiceCapabilityName = CapabilityName;
export type IssueType = "incident" | "request" | "question" | "smart_analysis";
export type PolicyToolName =
  | "repository_read"
  | "repository_grep"
  | "repository_find"
  | "repository_list"
  | "repository_edit"
  | "repository_write"
  | "attachment_read"
  | "nacos"
  | "db"
  | "sls"
  | "playwright"
  | "redis"
  | "es"
  | "mq"
  | "node_project_command"
  | "maven_project_command"
  | "repository_status"
  | "complete_issue";

export interface RepositoryGrant {
  codeAccess: "read" | "write";
  repositoryPath: string;
  baseCommit: string;
}

export interface AttachmentGrant {
  id: string;
  fileName: string;
  mediaType: string;
  size: number;
  sha256: string;
  attachmentPath: string;
}

export interface ServiceGrant {
  serviceKey: string;
  environmentKey: string;
  environmentKind: "production" | "test" | "development";
  capabilities: ServiceCapabilityName[];
  nacos?: { deploymentId: string; serverUrl: string; namespace: string; group: string };
  db?: { deploymentId: string };
  sls?: { deploymentId: string; region: string; project: string; logstores: string[] };
  browser?: { deploymentId: string; baseUrl: string };
  redis?: { deploymentId: string };
  es?: { deploymentId: string };
  mq?: { deploymentId: string; virtualHost: string };
  repositories: RepositoryGrant[];
}

export interface GrantedRepository extends RepositoryGrant {
  serviceKey: string;
  environmentKey: string;
  environmentKind: "production" | "test" | "development";
}

export interface ModelGrant {
  provider: string;
  modelId: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface IssuePolicy {
  version: typeof POLICY_VERSION;
  issueKey: string;
  issueType: IssueType;
  workspaceRoot: string;
  model: ModelGrant;
  tools: PolicyToolName[];
  attachments: AttachmentGrant[];
  service: ServiceGrant;
}

const READ_TOOLS: PolicyToolName[] = ["repository_read", "repository_grep", "repository_find", "repository_list"];
const WRITE_ISSUE_TYPES = new Set<IssueType>(["incident", "request"]);
const ISSUE_TYPES = new Set<IssueType>(["incident", "request", "question", "smart_analysis"]);
const CAPABILITIES = new Set<ServiceCapabilityName>(CAPABILITY_KEYS);
const POLICY_TOOLS = new Set<PolicyToolName>([
  ...READ_TOOLS,
  "repository_edit", "repository_write", "attachment_read", "nacos", "db", "sls", "playwright", "redis", "es", "mq", "node_project_command", "maven_project_command", "repository_status", "complete_issue",
]);

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function createIssuePolicy(input: {
  issueKey: string;
  issueType: IssueType;
  workspaceRoot: string;
  attachments?: AttachmentGrant[];
  model?: ModelGrant;
  service: ServiceGrant;
}): IssuePolicy {
  const capabilities = new Set(input.service.capabilities);
  if (capabilities.has("nacos") !== Boolean(input.service.nacos)) throw new Error("invalid_nacos_service_scope");
  if (capabilities.has("db") !== Boolean(input.service.db)) throw new Error("invalid_db_service_scope");
  if (capabilities.has("sls") !== Boolean(input.service.sls)) throw new Error("invalid_sls_service_scope");
  if (capabilities.has("playwright") !== Boolean(input.service.browser)) throw new Error("invalid_browser_service_scope");
  if (capabilities.has("redis") !== Boolean(input.service.redis)) throw new Error("invalid_redis_service_scope");
  if (capabilities.has("es") !== Boolean(input.service.es)) throw new Error("invalid_es_service_scope");
  if (capabilities.has("mq") !== Boolean(input.service.mq)) throw new Error("invalid_mq_service_scope");
  if (input.service.nacos && !isString(input.service.nacos.deploymentId)) throw new Error("invalid_nacos_service_scope");
  if (input.service.db && !isString(input.service.db.deploymentId)) throw new Error("invalid_db_service_scope");
  if (input.service.redis && !isString(input.service.redis.deploymentId)) throw new Error("invalid_redis_service_scope");
  if (input.service.es && !isString(input.service.es.deploymentId)) throw new Error("invalid_es_service_scope");
  if (input.service.mq && (!isString(input.service.mq.deploymentId) || !isString(input.service.mq.virtualHost))) throw new Error("invalid_mq_service_scope");
  if (input.service.browser) {
    let parsedUrl: URL;
    try { parsedUrl = new URL(input.service.browser.baseUrl); } catch { throw new Error("invalid_browser_service_scope"); }
    if (!isString(input.service.browser.deploymentId) || (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) throw new Error("invalid_browser_service_scope");
  }
  const attachments = input.attachments ?? [];
  const codeMutationAllowed = input.service.environmentKind === "development" && WRITE_ISSUE_TYPES.has(input.issueType) && input.service.repositories.some((repository) => repository.codeAccess === "write");
  const tools: PolicyToolName[] = [
    ...READ_TOOLS,
    ...(attachments.length ? ["attachment_read"] as PolicyToolName[] : []),
    ...(codeMutationAllowed ? ["repository_edit", "repository_write"] as PolicyToolName[] : []),
    ...(capabilities.has("playwright") ? ["playwright"] as PolicyToolName[] : []),
    ...(capabilities.has("nacos") ? ["nacos"] as PolicyToolName[] : []),
    ...(capabilities.has("db") ? ["db"] as PolicyToolName[] : []),
    ...(capabilities.has("redis") ? ["redis"] as PolicyToolName[] : []),
    ...(capabilities.has("mq") ? ["mq"] as PolicyToolName[] : []),
    ...(capabilities.has("es") ? ["es"] as PolicyToolName[] : []),
    ...(capabilities.has("sls") ? ["sls"] as PolicyToolName[] : []),
    "node_project_command",
    "maven_project_command",
    "repository_status",
    "complete_issue",
  ];
  return {
    version: POLICY_VERSION,
    issueKey: normalizeIssueKey(input.issueKey),
    issueType: input.issueType,
    workspaceRoot: path.resolve(input.workspaceRoot),
    model: input.model ?? { provider: "managed", modelId: "default", thinkingLevel: "medium" },
    tools: [...new Set(tools)],
    attachments: attachments.map((attachment) => ({ ...attachment, attachmentPath: path.resolve(attachment.attachmentPath) })),
    service: {
      ...input.service,
      capabilities: CAPABILITY_KEYS.filter((capability) => capabilities.has(capability)),
      ...(input.service.nacos ? { nacos: { ...input.service.nacos } } : {}),
      ...(input.service.db ? { db: { ...input.service.db } } : {}),
      ...(input.service.sls ? { sls: { deploymentId: input.service.sls.deploymentId, region: input.service.sls.region, project: input.service.sls.project, logstores: [...new Set(input.service.sls.logstores)].sort() } } : {}),
      ...(input.service.browser ? { browser: { deploymentId: input.service.browser.deploymentId, baseUrl: input.service.browser.baseUrl } } : {}),
      ...(input.service.redis ? { redis: { ...input.service.redis } } : {}),
      ...(input.service.es ? { es: { deploymentId: input.service.es.deploymentId } } : {}),
      ...(input.service.mq ? { mq: { deploymentId: input.service.mq.deploymentId, virtualHost: input.service.mq.virtualHost } } : {}),
      repositories: input.service.repositories.map((repository) => ({ ...repository, codeAccess: codeMutationAllowed && repository.codeAccess === "write" ? "write" : "read", repositoryPath: path.resolve(repository.repositoryPath) })),
    },
  };
}

export async function loadIssuePolicy(cwd: string, stateRoot = process.env.ISSUE_PILOT_STATE_ROOT): Promise<IssuePolicy> {
  const workspace = path.resolve(cwd);
  const issueKey = normalizeIssueKey(path.basename(workspace));
  const workspacesRoot = path.dirname(workspace);
  if (path.basename(workspacesRoot) !== "workspaces") throw new Error("issue_workspace_not_granted");
  const root = stateRoot ? path.resolve(stateRoot) : path.dirname(workspacesRoot);
  if (workspace !== path.join(root, "workspaces", issueKey.toLowerCase())) throw new Error("issue_workspace_not_granted");

  const file = path.join(root, "capabilities", `${issueKey.toLowerCase()}.json`);
  const metadata = await stat(file);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new Error("insecure_issue_capability_file");
  const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  if (parsed.version !== POLICY_VERSION || parsed.issueKey !== issueKey || parsed.workspaceRoot !== workspace || !ISSUE_TYPES.has(parsed.issueType as IssueType)) throw new Error("invalid_issue_policy_file");
  if (!parsed.model || typeof parsed.model !== "object") throw new Error("invalid_issue_policy_file");
  const model = parsed.model as Record<string, unknown>;
  if (!isString(model.provider) || !isString(model.modelId) || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(model.thinkingLevel))) throw new Error("invalid_issue_policy_file");
  if (!Array.isArray(parsed.tools) || !parsed.tools.every((tool) => POLICY_TOOLS.has(tool as PolicyToolName))) throw new Error("invalid_issue_policy_file");
  if (!Array.isArray(parsed.attachments)) throw new Error("invalid_issue_policy_file");
  const attachmentRoot = path.join(root, "attachments", issueKey.toLowerCase());
  const attachments = await Promise.all(parsed.attachments.map(async (candidate): Promise<AttachmentGrant> => {
    if (!candidate || typeof candidate !== "object") throw new Error("invalid_issue_policy_file");
    const attachment = candidate as Record<string, unknown>;
    if (!isString(attachment.id) || !isString(attachment.fileName) || !isString(attachment.mediaType) || !Number.isInteger(attachment.size) || (attachment.size as number) < 0 || typeof attachment.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(attachment.sha256) || !isString(attachment.attachmentPath)) throw new Error("invalid_issue_policy_file");
    const attachmentPath = path.resolve(attachment.attachmentPath);
    if (!isWithin(attachmentRoot, attachmentPath) || attachmentPath === attachmentRoot) throw new Error("invalid_issue_policy_attachment");
    const [canonicalRoot, canonicalPath, metadata] = await Promise.all([realpath(attachmentRoot), realpath(attachmentPath), stat(attachmentPath)]);
    if (!isWithin(canonicalRoot, canonicalPath) || !metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new Error("invalid_issue_policy_attachment");
    return { id: attachment.id, fileName: attachment.fileName, mediaType: attachment.mediaType, size: attachment.size as number, sha256: attachment.sha256.toLowerCase(), attachmentPath };
  }));
  if (new Set(attachments.map((attachment) => attachment.id)).size !== attachments.length || new Set(attachments.map((attachment) => attachment.attachmentPath)).size !== attachments.length) throw new Error("invalid_issue_policy_file");
  if (!parsed.service || typeof parsed.service !== "object") throw new Error("invalid_issue_policy_file");

  const value = parsed.service as Record<string, unknown>;
  if (!isString(value.serviceKey) || !isString(value.environmentKey) || (value.environmentKind !== "production" && value.environmentKind !== "test" && value.environmentKind !== "development")) throw new Error("invalid_issue_policy_file");
  if (!Array.isArray(value.capabilities) || !value.capabilities.every((entry) => CAPABILITIES.has(entry as ServiceCapabilityName))) throw new Error("invalid_issue_policy_file");
  const nacos = value.nacos;
  if (nacos !== undefined && (!nacos || typeof nacos !== "object" || !isString((nacos as Record<string, unknown>).deploymentId) || !isString((nacos as Record<string, unknown>).serverUrl) || !isString((nacos as Record<string, unknown>).group))) throw new Error("invalid_issue_policy_file");
  if (value.capabilities.includes("nacos") !== Boolean(nacos)) throw new Error("invalid_issue_policy_file");
  const db = value.db;
  if (db !== undefined && (!db || typeof db !== "object" || !isString((db as Record<string, unknown>).deploymentId))) throw new Error("invalid_issue_policy_file");
  if (value.capabilities.includes("db") !== Boolean(db)) throw new Error("invalid_issue_policy_file");
  const sls = value.sls;
  if (sls !== undefined) {
    if (!sls || typeof sls !== "object") throw new Error("invalid_issue_policy_file");
    const scope = sls as Record<string, unknown>;
    if (!isString(scope.deploymentId) || !isString(scope.region) || !isString(scope.project) || !Array.isArray(scope.logstores) || !scope.logstores.length || !scope.logstores.every(isString)) throw new Error("invalid_issue_policy_file");
  }
  if (value.capabilities.includes("sls") !== Boolean(sls)) throw new Error("invalid_issue_policy_file");
  const browser = value.browser;
  if (browser !== undefined) {
    if (!browser || typeof browser !== "object") throw new Error("invalid_issue_policy_file");
    const scope = browser as Record<string, unknown>;
    if (!isString(scope.deploymentId) || !isString(scope.baseUrl)) throw new Error("invalid_issue_policy_file");
    let parsedUrl: URL;
    try { parsedUrl = new URL(scope.baseUrl); } catch { throw new Error("invalid_issue_policy_file"); }
    if ((parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) throw new Error("invalid_issue_policy_file");
  }
  if (value.capabilities.includes("playwright") !== Boolean(browser)) throw new Error("invalid_issue_policy_file");
  const redis = value.redis;
  if (redis !== undefined && (!redis || typeof redis !== "object" || !isString((redis as Record<string, unknown>).deploymentId))) throw new Error("invalid_issue_policy_file");
  if (value.capabilities.includes("redis") !== Boolean(redis)) throw new Error("invalid_issue_policy_file");
  const es = value.es;
  if (es !== undefined && (!es || typeof es !== "object" || !isString((es as Record<string, unknown>).deploymentId))) throw new Error("invalid_issue_policy_file");
  if (value.capabilities.includes("es") !== Boolean(es)) throw new Error("invalid_issue_policy_file");
  const mq = value.mq;
  if (mq !== undefined && (!mq || typeof mq !== "object" || !isString((mq as Record<string, unknown>).deploymentId) || !isString((mq as Record<string, unknown>).virtualHost))) throw new Error("invalid_issue_policy_file");
  if (value.capabilities.includes("mq") !== Boolean(mq)) throw new Error("invalid_issue_policy_file");
  if (!Array.isArray(value.repositories) || !value.repositories.length) throw new Error("invalid_issue_policy_file");
  const repositories = value.repositories.map((candidate): RepositoryGrant => {
    if (!candidate || typeof candidate !== "object") throw new Error("invalid_issue_policy_file");
    const repository = candidate as Record<string, unknown>;
    if ((repository.codeAccess !== "read" && repository.codeAccess !== "write") || !isString(repository.repositoryPath) || !isString(repository.baseCommit) || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(repository.baseCommit)) throw new Error("invalid_issue_policy_file");
    const repositoryPath = path.resolve(repository.repositoryPath);
    if (!isWithin(workspace, repositoryPath) || repositoryPath === workspace) throw new Error("invalid_issue_policy_repository");
    return { codeAccess: repository.codeAccess, repositoryPath, baseCommit: repository.baseCommit };
  });
  const normalized = createIssuePolicy({
    issueKey,
    issueType: parsed.issueType as IssueType,
    workspaceRoot: workspace,
    attachments,
    model: model as unknown as ModelGrant,
    service: {
      serviceKey: value.serviceKey,
      environmentKey: value.environmentKey,
      environmentKind: value.environmentKind,
      capabilities: value.capabilities as ServiceCapabilityName[],
      ...(nacos ? { nacos: nacos as { deploymentId: string; serverUrl: string; namespace: string; group: string } } : {}),
      ...(db ? { db: db as { deploymentId: string } } : {}),
      ...(sls ? { sls: sls as { deploymentId: string; region: string; project: string; logstores: string[] } } : {}),
      ...(browser ? { browser: browser as { deploymentId: string; baseUrl: string } } : {}),
      ...(redis ? { redis: redis as { deploymentId: string } } : {}),
      ...(es ? { es: es as { deploymentId: string } } : {}),
      ...(mq ? { mq: mq as { deploymentId: string; virtualHost: string } } : {}),
      repositories,
    },
  });
  if (JSON.stringify(parsed.tools) !== JSON.stringify(normalized.tools)) throw new Error("issue_policy_tool_set_mismatch");
  return normalized;
}

export function assertToolGranted(policy: IssuePolicy, toolName: string): void {
  if (!policy.tools.includes(toolName as PolicyToolName)) throw new Error("tool_not_granted_for_issue");
}

export function assertSlsGranted(policy: IssuePolicy, project: string, logstore: string): void {
  assertToolGranted(policy, "sls");
  if (policy.service.sls?.project !== project || !policy.service.sls.logstores.includes(logstore)) throw new Error("sls_scope_not_granted_for_service");
}

export function grantedRepositories(policy: IssuePolicy, capability?: ServiceCapabilityName): GrantedRepository[] {
  if (capability && !policy.service.capabilities.includes(capability)) throw new Error("capability_not_granted_for_service");
  return policy.service.repositories.map((repository) => ({
    ...repository,
    serviceKey: policy.service.serviceKey,
    environmentKey: policy.service.environmentKey,
    environmentKind: policy.service.environmentKind,
  }));
}

function repositoryRoots(policy: IssuePolicy): string[] {
  return policy.service.repositories.map((repository) => repository.repositoryPath);
}

function writeRoots(policy: IssuePolicy): string[] {
  return policy.service.repositories.filter((repository) => repository.codeAccess === "write").map((repository) => repository.repositoryPath);
}

async function canonicalTarget(target: string, write: boolean): Promise<string> {
  try {
    return await realpath(target);
  } catch (error) {
    if (!write || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    let parent = path.dirname(target);
    while (parent !== path.dirname(parent)) {
      try {
        const canonicalParent = await realpath(parent);
        return path.join(canonicalParent, path.relative(parent, target));
      } catch (parentError) {
        if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") throw parentError;
        parent = path.dirname(parent);
      }
    }
    throw new Error("workspace_path_not_available");
  }
}

export async function authorizeWorkspacePath(policy: IssuePolicy, cwd: string, requestedPath: string, access: "read" | "write"): Promise<string> {
  assertToolGranted(policy, access === "write" ? "repository_write" : "repository_read");
  const raw = requestedPath.startsWith("@") ? requestedPath.slice(1) : requestedPath;
  if (!raw || raw.includes("\0")) throw new Error("invalid_workspace_path");
  const target = path.resolve(cwd, raw);
  const roots = access === "write" ? writeRoots(policy) : repositoryRoots(policy);
  if (!roots.some((root) => isWithin(root, target))) throw new Error("workspace_path_not_granted");
  const owningRoot = roots.find((root) => isWithin(root, target))!;
  const canonicalRoot = await realpath(owningRoot);
  const canonical = await canonicalTarget(target, access === "write");
  if (!isWithin(canonicalRoot, canonical)) throw new Error("workspace_symlink_escape_not_granted");
  if (access === "write") {
    const repository = repositoryRoots(policy).find((root) => isWithin(root, target));
    const relative = repository ? path.relative(repository, target) : "";
    if (relative.split(path.sep).includes(".git")) throw new Error("workspace_git_metadata_write_not_granted");
    const existing = await lstat(target).catch(() => undefined);
    if (existing?.isSymbolicLink()) throw new Error("workspace_symlink_write_not_granted");
  }
  return target;
}

export async function grantedProject(policy: IssuePolicy, cwd: string, requestedPath: string): Promise<{ repositoryPath: string; projectPath: string }> {
  const projectPath = await authorizeWorkspacePath(policy, cwd, requestedPath, "read");
  const repositoryPath = repositoryRoots(policy).find((root) => isWithin(root, projectPath));
  if (!repositoryPath) throw new Error("project_path_not_granted");
  return { repositoryPath, projectPath };
}
