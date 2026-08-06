import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { CAPABILITY_KEYS, type CapabilityName } from "../shared/capabilities.ts";
import { normalizeIssueKey } from "../shared/issue-key.ts";

export const POLICY_VERSION = 15 as const;

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
    if (!isString(input.service.browser.deploymentId) || !["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) throw new Error("invalid_browser_service_scope");
  }

  const attachments = input.attachments ?? [];
  const codeMutationAllowed = input.service.environmentKind === "development"
    && WRITE_ISSUE_TYPES.has(input.issueType)
    && input.service.repositories.some((repository) => repository.codeAccess === "write");
  const tools: PolicyToolName[] = [
    ...READ_TOOLS,
    ...(attachments.length ? ["attachment_read"] as PolicyToolName[] : []),
    ...(codeMutationAllowed ? ["repository_edit", "repository_write"] as PolicyToolName[] : []),
    ...CAPABILITY_KEYS.filter((capability) => capabilities.has(capability)).map((capability) => capability as PolicyToolName),
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
      ...(input.service.sls ? { sls: { ...input.service.sls, logstores: [...new Set(input.service.sls.logstores)].sort() } } : {}),
      repositories: input.service.repositories.map((repository) => ({
        ...repository,
        codeAccess: codeMutationAllowed && repository.codeAccess === "write" ? "write" : "read",
        repositoryPath: path.resolve(repository.repositoryPath),
      })),
    },
  };
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
