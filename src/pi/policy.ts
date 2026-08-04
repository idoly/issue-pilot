import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { normalizeIssueKey } from "../shared/issue-key.ts";

export const POLICY_VERSION = 2 as const;

export type ServiceCapabilityName = "configuration_read" | "database_read" | "cache_read" | "log_read";
export type IssueType = "incident" | "request" | "question" | "smart_analysis";
export type PolicyToolName =
  | "read"
  | "grep"
  | "find"
  | "ls"
  | "edit"
  | "write"
  | "configuration_read"
  | "database_read"
  | "node_project_command"
  | "maven_project_command"
  | "repository_status";

export interface ServiceCapability {
  serviceKey: string;
  environmentKey: string;
  environmentKind: "production" | "test";
  codeAccess: "read" | "write";
  repositoryPath: string;
  baseCommit: string;
  capabilities: ServiceCapabilityName[];
}

export interface IssuePolicy {
  version: typeof POLICY_VERSION;
  issueKey: string;
  issueType: IssueType;
  workspaceRoot: string;
  tools: PolicyToolName[];
  services: ServiceCapability[];
}

const READ_TOOLS: PolicyToolName[] = ["read", "grep", "find", "ls"];
const WRITE_ISSUE_TYPES = new Set<IssueType>(["incident", "request", "smart_analysis"]);
const ISSUE_TYPES = new Set<IssueType>(["incident", "request", "question", "smart_analysis"]);
const CAPABILITIES = new Set<ServiceCapabilityName>(["configuration_read", "database_read", "cache_read", "log_read"]);
const POLICY_TOOLS = new Set<PolicyToolName>([
  ...READ_TOOLS,
  "edit",
  "write",
  "configuration_read",
  "database_read",
  "node_project_command",
  "maven_project_command",
  "repository_status",
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
  services: ServiceCapability[];
}): IssuePolicy {
  const capabilities = new Set(input.services.flatMap((service) => service.capabilities));
  const codeMutationAllowed = WRITE_ISSUE_TYPES.has(input.issueType) && input.services.some((service) => service.codeAccess === "write");
  const tools: PolicyToolName[] = [
    ...READ_TOOLS,
    ...(codeMutationAllowed ? ["edit", "write"] as PolicyToolName[] : []),
    ...(capabilities.has("configuration_read") ? ["configuration_read"] as PolicyToolName[] : []),
    ...(capabilities.has("database_read") ? ["database_read"] as PolicyToolName[] : []),
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
    services: input.services.map((service) => ({
      ...service,
      repositoryPath: path.resolve(service.repositoryPath),
      capabilities: [...new Set(service.capabilities)].sort(),
    })),
  };
}

export async function loadIssuePolicy(cwd: string, stateRoot = process.env.ISSUE_PILOT_STATE_ROOT): Promise<IssuePolicy> {
  const workspace = path.resolve(cwd);
  const issueKey = normalizeIssueKey(path.basename(workspace));
  const workspacesRoot = path.dirname(workspace);
  if (path.basename(workspacesRoot) !== "workspaces") throw new Error("issue_workspace_not_granted");
  const root = stateRoot ? path.resolve(stateRoot) : path.dirname(workspacesRoot);
  const expectedWorkspace = path.join(root, "workspaces", issueKey.toLowerCase());
  if (workspace !== expectedWorkspace) throw new Error("issue_workspace_not_granted");

  const file = path.join(root, "capabilities", `${issueKey.toLowerCase()}.json`);
  const metadata = await stat(file);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new Error("insecure_issue_capability_file");
  const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  if (parsed.version !== POLICY_VERSION || parsed.issueKey !== issueKey || parsed.workspaceRoot !== workspace || !ISSUE_TYPES.has(parsed.issueType as IssueType)) throw new Error("invalid_issue_policy_file");
  if (!Array.isArray(parsed.tools) || !parsed.tools.every((tool) => POLICY_TOOLS.has(tool as PolicyToolName))) throw new Error("invalid_issue_policy_file");
  if (!Array.isArray(parsed.services)) throw new Error("invalid_issue_policy_file");

  const services = parsed.services.map((candidate): ServiceCapability => {
    if (!candidate || typeof candidate !== "object") throw new Error("invalid_issue_policy_file");
    const value = candidate as Record<string, unknown>;
    if (!isString(value.serviceKey) || !isString(value.environmentKey) || (value.environmentKind !== "production" && value.environmentKind !== "test") || (value.codeAccess !== "read" && value.codeAccess !== "write") || !isString(value.repositoryPath) || !isString(value.baseCommit) || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value.baseCommit)) throw new Error("invalid_issue_policy_file");
    if (!Array.isArray(value.capabilities) || !value.capabilities.every((entry) => CAPABILITIES.has(entry as ServiceCapabilityName))) throw new Error("invalid_issue_policy_file");
    const repositoryPath = path.resolve(value.repositoryPath);
    if (!isWithin(workspace, repositoryPath) || repositoryPath === workspace) throw new Error("invalid_issue_policy_repository");
    return {
      serviceKey: value.serviceKey,
      environmentKey: value.environmentKey,
      environmentKind: value.environmentKind,
      codeAccess: value.codeAccess,
      repositoryPath,
      baseCommit: value.baseCommit,
      capabilities: value.capabilities as ServiceCapabilityName[],
    };
  });
  const normalized = createIssuePolicy({ issueKey, issueType: parsed.issueType as IssueType, workspaceRoot: workspace, services });
  if (JSON.stringify(parsed.tools) !== JSON.stringify(normalized.tools)) throw new Error("issue_policy_tool_set_mismatch");
  return normalized;
}

export function assertToolGranted(policy: IssuePolicy, toolName: string): void {
  if (!policy.tools.includes(toolName as PolicyToolName)) throw new Error("tool_not_granted_for_issue");
}

export function grantedServices(policy: IssuePolicy, serviceKey: string, capability?: ServiceCapabilityName): ServiceCapability[] {
  const services = policy.services.filter((candidate) => candidate.serviceKey === serviceKey);
  if (!services.length) throw new Error("service_not_granted_for_issue");
  if (capability && services.some((service) => !service.capabilities.includes(capability))) throw new Error("capability_not_granted_for_service");
  return services;
}

function repositoryRoots(policy: IssuePolicy): string[] {
  return [...new Set(policy.services.map((service) => service.repositoryPath))];
}

function writeRoots(policy: IssuePolicy): string[] {
  return [...new Set(policy.services.filter((service) => service.codeAccess === "write").map((service) => service.repositoryPath))];
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
  assertToolGranted(policy, access === "write" ? "write" : "read");
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
