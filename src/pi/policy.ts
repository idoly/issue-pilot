import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { normalizeIssueKey } from "../shared/issue-key.ts";

export const POLICY_VERSION = 7 as const;

export type ServiceCapabilityName = "configuration_read" | "database_read" | "sls_read" | "browser_use";
export type IssueType = "incident" | "request" | "question" | "smart_analysis";
export type PolicyToolName =
  | "repository_read"
  | "repository_grep"
  | "repository_find"
  | "repository_list"
  | "repository_edit"
  | "repository_write"
  | "attachment_read"
  | "configuration_read"
  | "database_read"
  | "sls_read"
  | "browser_use"
  | "node_project_command"
  | "maven_project_command"
  | "repository_status";

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
  sls?: { project: string; logstores: string[] };
  browser?: { deploymentId: string; baseUrl: string };
  repositories: RepositoryGrant[];
}

export interface GrantedRepository extends RepositoryGrant {
  serviceKey: string;
  environmentKey: string;
  environmentKind: "production" | "test" | "development";
}

export interface IssuePolicy {
  version: typeof POLICY_VERSION;
  issueKey: string;
  issueType: IssueType;
  workspaceRoot: string;
  tools: PolicyToolName[];
  attachments: AttachmentGrant[];
  service: ServiceGrant;
}

const READ_TOOLS: PolicyToolName[] = ["repository_read", "repository_grep", "repository_find", "repository_list"];
const WRITE_ISSUE_TYPES = new Set<IssueType>(["incident", "request", "smart_analysis"]);
const ISSUE_TYPES = new Set<IssueType>(["incident", "request", "question", "smart_analysis"]);
const CAPABILITIES = new Set<ServiceCapabilityName>(["configuration_read", "database_read", "sls_read", "browser_use"]);
const POLICY_TOOLS = new Set<PolicyToolName>([
  ...READ_TOOLS,
  "repository_edit", "repository_write", "attachment_read", "configuration_read", "database_read", "sls_read", "browser_use", "node_project_command", "maven_project_command", "repository_status",
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
  service: ServiceGrant;
}): IssuePolicy {
  const capabilities = new Set(input.service.capabilities);
  if (capabilities.has("sls_read") !== Boolean(input.service.sls)) throw new Error("invalid_sls_service_scope");
  if (capabilities.has("browser_use") !== Boolean(input.service.browser)) throw new Error("invalid_browser_service_scope");
  if (input.service.browser) {
    let parsedUrl: URL;
    try { parsedUrl = new URL(input.service.browser.baseUrl); } catch { throw new Error("invalid_browser_service_scope"); }
    if (!isString(input.service.browser.deploymentId) || (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) throw new Error("invalid_browser_service_scope");
  }
  const attachments = input.attachments ?? [];
  const codeMutationAllowed = WRITE_ISSUE_TYPES.has(input.issueType) && input.service.repositories.some((repository) => repository.codeAccess === "write");
  const tools: PolicyToolName[] = [
    ...READ_TOOLS,
    ...(attachments.length ? ["attachment_read"] as PolicyToolName[] : []),
    ...(codeMutationAllowed ? ["repository_edit", "repository_write"] as PolicyToolName[] : []),
    ...(capabilities.has("configuration_read") ? ["configuration_read"] as PolicyToolName[] : []),
    ...(capabilities.has("database_read") ? ["database_read"] as PolicyToolName[] : []),
    ...(capabilities.has("sls_read") ? ["sls_read"] as PolicyToolName[] : []),
    ...(capabilities.has("browser_use") ? ["browser_use"] as PolicyToolName[] : []),
    "node_project_command",
    "maven_project_command",
    "repository_status",
  ];
  return {
    version: POLICY_VERSION,
    issueKey: normalizeIssueKey(input.issueKey),
    issueType: input.issueType,
    workspaceRoot: path.resolve(input.workspaceRoot),
    tools: [...new Set(tools)],
    attachments: attachments.map((attachment) => ({ ...attachment, attachmentPath: path.resolve(attachment.attachmentPath) })),
    service: {
      ...input.service,
      capabilities: [...new Set(input.service.capabilities)].sort(),
      ...(input.service.sls ? { sls: { project: input.service.sls.project, logstores: [...new Set(input.service.sls.logstores)].sort() } } : {}),
      ...(input.service.browser ? { browser: { deploymentId: input.service.browser.deploymentId, baseUrl: input.service.browser.baseUrl } } : {}),
      repositories: input.service.repositories.map((repository) => ({ ...repository, repositoryPath: path.resolve(repository.repositoryPath) })),
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
  if (!Array.isArray(parsed.tools) || !parsed.tools.every((tool) => POLICY_TOOLS.has(tool as PolicyToolName))) throw new Error("invalid_issue_policy_file");
  if (!Array.isArray(parsed.attachments)) throw new Error("invalid_issue_policy_file");
  const attachmentRoot = path.join(root, "attachments", issueKey.toLowerCase());
  const attachments = await Promise.all(parsed.attachments.map(async (candidate): Promise<AttachmentGrant> => {
    if (!candidate || typeof candidate !== "object") throw new Error("invalid_issue_policy_file");
    const attachment = candidate as Record<string, unknown>;
    if (!isString(attachment.id) || !isString(attachment.fileName) || !isString(attachment.mediaType) || !Number.isInteger(attachment.size) || (attachment.size as number) < 0 || (attachment.size as number) > 20 * 1024 * 1024 || typeof attachment.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(attachment.sha256) || !isString(attachment.attachmentPath)) throw new Error("invalid_issue_policy_file");
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
  const sls = value.sls;
  if (sls !== undefined) {
    if (!sls || typeof sls !== "object") throw new Error("invalid_issue_policy_file");
    const scope = sls as Record<string, unknown>;
    if (!isString(scope.project) || !Array.isArray(scope.logstores) || !scope.logstores.length || !scope.logstores.every(isString)) throw new Error("invalid_issue_policy_file");
  }
  if (value.capabilities.includes("sls_read") !== Boolean(sls)) throw new Error("invalid_issue_policy_file");
  const browser = value.browser;
  if (browser !== undefined) {
    if (!browser || typeof browser !== "object") throw new Error("invalid_issue_policy_file");
    const scope = browser as Record<string, unknown>;
    if (!isString(scope.deploymentId) || !isString(scope.baseUrl)) throw new Error("invalid_issue_policy_file");
    let parsedUrl: URL;
    try { parsedUrl = new URL(scope.baseUrl); } catch { throw new Error("invalid_issue_policy_file"); }
    if ((parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) throw new Error("invalid_issue_policy_file");
  }
  if (value.capabilities.includes("browser_use") !== Boolean(browser)) throw new Error("invalid_issue_policy_file");
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
    service: {
      serviceKey: value.serviceKey,
      environmentKey: value.environmentKey,
      environmentKind: value.environmentKind,
      capabilities: value.capabilities as ServiceCapabilityName[],
      ...(sls ? { sls: sls as { project: string; logstores: string[] } } : {}),
      ...(browser ? { browser: browser as { deploymentId: string; baseUrl: string } } : {}),
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
  assertToolGranted(policy, "sls_read");
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
