import { execFile } from "node:child_process";
import { access, mkdir, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import pMap from "p-map";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { normalizeIssueKey } from "../domain/contracts.ts";

const execFileAsync = promisify(execFile);
const stateTaskOptions = { concurrency: issuePilotConfig.workspace.taskConcurrency, stopOnError: false } as const;

type SharedCheckout = { checkout: string; commit: string };
type SharedRepository = { commonDirectory: string; checkouts: SharedCheckout[] };

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

export function issueWorkDirectory(stateRoot: string, issueKey: string): string {
  return path.join(issueRoot(stateRoot, issueKey), "work");
}

export function issueSessionRoot(stateRoot: string, issueKey: string): string {
  return path.join(issueRoot(stateRoot, issueKey), "agent");
}

export function issueRuntimeRoot(stateRoot: string, issueKey: string): string {
  return path.join(issueRoot(stateRoot, issueKey), "runtime");
}

export function issueAttachmentRoot(stateRoot: string, issueKey: string): string {
  return path.join(issueRoot(stateRoot, issueKey), "attachments");
}

export function issueOutputRoot(stateRoot: string, issueKey: string): string {
  return path.join(issueRoot(stateRoot, issueKey), "outputs");
}

export async function claimIssueRoot(stateRoot: string, issueKey: string): Promise<void> {
  const root = issueRoot(stateRoot, issueKey);
  await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
  try { await mkdir(root, { mode: 0o700 }); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") throw new Error(`unmanaged_issue_state:issues/${path.basename(root)}`);
    throw error;
  }
}

export async function removeEmptyIssueRoot(stateRoot: string, issueKey: string): Promise<void> {
  const failures: unknown[] = [];
  for (const directory of [issueAttachmentRoot(stateRoot, issueKey), issueRoot(stateRoot, issueKey)]) {
    try { await rmdir(directory); }
    catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) failures.push(error);
    }
  }
  if (failures.length) throw new Error("issue_state_rollback_failed", { cause: new AggregateError(failures, "issue_state_rollback_failed") });
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

async function validateSharedCheckouts(stateRoot: string): Promise<void> {
  const checkoutRoot = sharedCheckoutsRoot(stateRoot);
  let repositoryEntries;
  try { repositoryEntries = await readdir(checkoutRoot, { withFileTypes: true }); }
  catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  const { gitOperationMs, gitOutputBytes } = issuePilotConfig.limits.process;
  const gitEnvironment = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  const sharedRepositories: SharedRepository[] = [];
  for (const repositoryEntry of repositoryEntries) {
    if (!repositoryEntry.isDirectory() || !/^[0-9a-f]{20}$/.test(repositoryEntry.name)) throw new Error("shared_checkout_changed");
    const repositoryRoot = path.join(checkoutRoot, repositoryEntry.name);
    const commonDirectory = path.join(repositoriesRoot(stateRoot), repositoryEntry.name);
    const commitEntries = await readdir(repositoryRoot, { withFileTypes: true });
    if (!commitEntries.length || commitEntries.some((entry) => !entry.isDirectory() || !/^[0-9a-f]{40}$/.test(entry.name))) throw new Error("shared_checkout_changed");
    sharedRepositories.push({
      commonDirectory,
      checkouts: commitEntries.map((entry) => ({ checkout: path.join(repositoryRoot, entry.name), commit: entry.name })),
    });
  }
  const checkouts = sharedRepositories.flatMap(({ commonDirectory, checkouts }) =>
    checkouts.map((checkout) => ({ ...checkout, commonDirectory }))
  );
  try {
    await pMap(checkouts, async ({ checkout, commit, commonDirectory }) => {
      const [head, status, actualCommonDirectory] = await Promise.all([
        execFileAsync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8", env: gitEnvironment, timeout: gitOperationMs, maxBuffer: gitOutputBytes }),
        execFileAsync("git", ["-C", checkout, "status", "--porcelain", "--untracked-files=all", "--ignored=matching"], { encoding: "utf8", env: gitEnvironment, timeout: gitOperationMs, maxBuffer: gitOutputBytes }),
        execFileAsync("git", ["-C", checkout, "rev-parse", "--git-common-dir"], { encoding: "utf8", env: gitEnvironment, timeout: gitOperationMs, maxBuffer: gitOutputBytes }),
      ]);
      if (head.stdout.trim() !== commit || status.stdout.trim() || path.resolve(checkout, actualCommonDirectory.stdout.trim()) !== commonDirectory) throw new Error("shared_checkout_changed");
    }, stateTaskOptions);
  } catch (error) {
    throw new Error("shared_checkout_changed", { cause: error });
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
  await validateSharedCheckouts(stateRoot);
  await pMap(await directoryNames(managedIssuesRoot), async (entry) => {
    if (!active.has(entry.toLowerCase())) return;
    const managedIssueRoot = path.join(managedIssuesRoot, entry);
    const generatedRuntime = /^\.runtime-(?:previous-)?[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const generated = (await readdir(managedIssueRoot)).filter((name) => name === "runtime" || generatedRuntime.test(name));
    await Promise.all(generated.map((name) => rm(path.join(managedIssueRoot, name), { recursive: true, force: true })));
  }, stateTaskOptions);
  const repositoriesDirectory = repositoriesRoot(stateRoot);
  await pMap(
    await directoryNames(repositoriesDirectory),
    (entry) => execFileAsync("git", ["-C", path.join(repositoriesDirectory, entry), "worktree", "prune", "--expire", "now"], { timeout: issuePilotConfig.limits.process.gitPruneMs }),
    stateTaskOptions,
  );
}
