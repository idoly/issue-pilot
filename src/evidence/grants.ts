import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { normalizeIssueKey } from "../shared/issue-key.ts";

export type ServiceCapabilityName = "configuration_read" | "database_read" | "cache_read" | "log_read";

export interface ServiceCapability {
  serviceKey: string;
  environmentKey: string;
  environmentKind: "production" | "test" | "local";
  repositoryPath: string;
  baseCommit: string;
  modulePaths: string[];
  capabilities: ServiceCapabilityName[];
}

export interface IssueCapabilities {
  issueKey: string;
  services: ServiceCapability[];
}

function string(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export async function loadIssueCapabilities(cwd: string, stateRoot = process.env.ISSUE_PILOT_STATE_ROOT): Promise<IssueCapabilities> {
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
  const parsed = JSON.parse(await readFile(file, "utf8")) as { issueKey?: unknown; services?: unknown };
  if (parsed.issueKey !== issueKey || !Array.isArray(parsed.services)) throw new Error("invalid_issue_capability_file");
  const services = parsed.services.map((candidate): ServiceCapability => {
    if (!candidate || typeof candidate !== "object") throw new Error("invalid_issue_capability_file");
    const value = candidate as Record<string, unknown>;
    if (!string(value.serviceKey) || !string(value.environmentKey) || !["production", "test", "local"].includes(String(value.environmentKind)) || !string(value.repositoryPath) || !string(value.baseCommit) || !Array.isArray(value.modulePaths) || !value.modulePaths.every(string) || !Array.isArray(value.capabilities) || !value.capabilities.every((entry) => ["configuration_read", "database_read", "cache_read", "log_read"].includes(String(entry)))) throw new Error("invalid_issue_capability_file");
    return {
      serviceKey: value.serviceKey,
      environmentKey: value.environmentKey,
      environmentKind: value.environmentKind as ServiceCapability["environmentKind"],
      repositoryPath: path.resolve(value.repositoryPath),
      baseCommit: value.baseCommit,
      modulePaths: value.modulePaths,
      capabilities: value.capabilities as ServiceCapabilityName[],
    };
  });
  return { issueKey, services };
}

export function grantedService(grants: IssueCapabilities, serviceKey: string, capability: ServiceCapabilityName): ServiceCapability {
  const service = grants.services.find((candidate) => candidate.serviceKey === serviceKey);
  if (!service) throw new Error("service_not_granted_for_issue");
  if (!service.capabilities.includes(capability)) throw new Error("capability_not_granted_for_service");
  return service;
}
