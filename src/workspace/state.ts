import { execFile } from "node:child_process";
import { access, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { normalizeIssueKey } from "../domain/contracts.ts";

const execFileAsync = promisify(execFile);

export interface RepositoryStateRecord {
  localPath: string | null;
  workingBranch: string | null;
}

export type RepositoryState = "read_only" | "development_workspace" | "development_snapshot" | "invalid";

export function classifyRepositoryState(repositories: RepositoryStateRecord[]): RepositoryState {
  if (!repositories.length) return "invalid";
  if (repositories.every((repository) => repository.localPath === null && repository.workingBranch === null)) return "read_only";
  if (repositories.every((repository) => Boolean(repository.localPath) && Boolean(repository.workingBranch))) return "development_workspace";
  if (repositories.every((repository) => repository.localPath === null && Boolean(repository.workingBranch))) return "development_snapshot";
  return "invalid";
}

export function pathExists(candidate: string): Promise<boolean> {
  return access(candidate).then(() => true, () => false);
}

function issueSegment(issueKey: string): string {
  return normalizeIssueKey(issueKey).toLowerCase();
}

export function workspacesRoot(stateRoot: string): string {
  return path.resolve(stateRoot, "workspaces");
}

export function issueWorkspaceRoot(stateRoot: string, issueKey: string): string {
  return path.join(workspacesRoot(stateRoot), issueSegment(issueKey));
}

function issuesRoot(stateRoot: string): string {
  return path.resolve(stateRoot, "issues");
}

export function issueRoot(stateRoot: string, issueKey: string): string {
  return path.join(issuesRoot(stateRoot), issueSegment(issueKey));
}

export function issueSessionRoot(stateRoot: string, issueKey: string): string {
  return path.join(issueRoot(stateRoot, issueKey), "agent");
}

export function issueRuntimeRoot(stateRoot: string, issueKey: string): string {
  return path.join(issueRoot(stateRoot, issueKey), "runtime");
}

export function issueRuntimeWorkspaceFile(stateRoot: string, issueKey: string): string {
  const segment = issueSegment(issueKey);
  return path.join(issuesRoot(stateRoot), segment, "runtime", `${segment}.code-workspace`);
}

export function issueAttachmentRoot(stateRoot: string, issueKey: string): string {
  return path.join(issueRoot(stateRoot, issueKey), "attachments");
}

function gitRoot(stateRoot: string): string {
  return path.resolve(stateRoot, "git");
}

export function repositoriesRoot(stateRoot: string): string {
  return path.join(gitRoot(stateRoot), "repositories");
}

export function sharedCheckoutsRoot(stateRoot: string): string {
  return path.join(gitRoot(stateRoot), "checkouts");
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function directoryNames(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function clearDirectory(directory: string): Promise<void> {
  try {
    await Promise.all((await readdir(directory)).map((entry) => rm(path.join(directory, entry), { recursive: true, force: true })));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function managedIssueWorkspaceEntries(workspaceRoot: string, localPaths: string[]): Set<string> {
  const expectedEntries = new Set<string>();
  for (const localPath of localPaths) {
    const resolved = path.resolve(localPath);
    if (path.dirname(resolved) !== workspaceRoot) throw new Error("workspace_path_outside_issue_root");
    expectedEntries.add(path.basename(resolved));
  }
  if (expectedEntries.size !== localPaths.length) throw new Error("workspace_repository_missing");
  return expectedEntries;
}

export function assertManagedIssueWorkspacePaths(workspaceRoot: string, localPaths: string[]): void {
  managedIssueWorkspaceEntries(workspaceRoot, localPaths);
}

export async function assertManagedIssueWorkspaceLayout(workspaceRoot: string, localPaths: string[]): Promise<void> {
  const expectedEntries = managedIssueWorkspaceEntries(workspaceRoot, localPaths);
  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  if (entries.some((entry) => !expectedEntries.has(entry.name))) throw new Error("workspace_has_untracked_files");
  if (entries.some((entry) => !entry.isDirectory()) || entries.length !== expectedEntries.size) throw new Error("workspace_repository_missing");
}

export async function pruneState(stateRoot: string, issueKeys: string[]): Promise<void> {
  const active = new Set(issueKeys.map((key) => normalizeIssueKey(key).toLowerCase()));
  const managedIssuesRoot = issuesRoot(stateRoot);
  const unmanaged: string[] = [];
  for (const category of ["workspaces", "issues"]) {
    for (const entry of await directoryNames(path.resolve(stateRoot, category))) {
      if (!active.has(entry.toLowerCase())) unmanaged.push(`${category}/${entry}`);
    }
  }
  if (unmanaged.length) throw new Error(`unmanaged_issue_state:${unmanaged.sort().join(",")}`);
  for (const entry of await directoryNames(managedIssuesRoot)) {
    if (active.has(entry.toLowerCase())) await rm(path.join(managedIssuesRoot, entry, "runtime"), { recursive: true, force: true });
  }
  await clearDirectory(sharedCheckoutsRoot(stateRoot));
  const repositoriesDirectory = repositoriesRoot(stateRoot);
  for (const entry of await directoryNames(repositoriesDirectory)) {
    await execFileAsync("git", ["-C", path.join(repositoriesDirectory, entry), "worktree", "prune", "--expire", "now"], { timeout: issuePilotConfig.limits.process.gitPruneMs });
  }
}
