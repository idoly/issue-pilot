import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readlink, readdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { normalizeIssueKey } from "../domain/contracts.ts";

const execFileAsync = promisify(execFile);

function issueSegment(issueKey: string): string {
  return normalizeIssueKey(issueKey).toLowerCase();
}

export function workspacesRoot(stateRoot: string): string {
  return path.resolve(stateRoot, "workspaces");
}

export function issueWorkspaceRoot(stateRoot: string, issueKey: string): string {
  return path.join(workspacesRoot(stateRoot), issueSegment(issueKey));
}

export function issuesRoot(stateRoot: string): string {
  return path.resolve(stateRoot, "issues");
}

export function issueRoot(stateRoot: string, issueKey: string): string {
  return path.join(issuesRoot(stateRoot), issueSegment(issueKey));
}

export function issueAgentRoot(stateRoot: string, issueKey: string): string {
  return path.join(issueRoot(stateRoot, issueKey), "agent");
}

export function issueSessionRoot(stateRoot: string, issueKey: string): string {
  return issueAgentRoot(stateRoot, issueKey);
}

export function issueRuntimeRoot(stateRoot: string, issueKey: string): string {
  return path.join(issueRoot(stateRoot, issueKey), "runtime");
}

export function issueAttachmentRoot(stateRoot: string, issueKey: string): string {
  return path.join(issueRoot(stateRoot, issueKey), "attachments");
}

export function issueWorkspaceLink(stateRoot: string, issueKey: string): string {
  return path.join(issueRoot(stateRoot, issueKey), "workspace");
}

export async function ensureIssueWorkspaceLink(stateRoot: string, issueKey: string): Promise<string> {
  const root = issueRoot(stateRoot, issueKey);
  const link = issueWorkspaceLink(stateRoot, issueKey);
  const target = path.relative(root, issueWorkspaceRoot(stateRoot, issueKey));
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  try {
    const metadata = await lstat(link);
    if (!metadata.isSymbolicLink() || await readlink(link) !== target) throw new Error("issue_workspace_link_conflict");
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    await symlink(target, link, "dir");
  }
  return link;
}

export async function removeIssueWorkspaceLink(stateRoot: string, issueKey: string): Promise<void> {
  const link = issueWorkspaceLink(stateRoot, issueKey);
  try {
    const metadata = await lstat(link);
    const expected = path.relative(issueRoot(stateRoot, issueKey), issueWorkspaceRoot(stateRoot, issueKey));
    if (!metadata.isSymbolicLink() || await readlink(link) !== expected) throw new Error("issue_workspace_link_conflict");
    await rm(link);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
}

export function globalRuntimeRoot(stateRoot: string): string {
  return path.resolve(stateRoot, "runtime");
}

export function backupsRoot(stateRoot: string): string {
  return path.resolve(stateRoot, "backups");
}

export function gitRoot(stateRoot: string): string {
  return path.resolve(stateRoot, "git");
}

export function repositoriesRoot(stateRoot: string): string {
  return path.join(gitRoot(stateRoot), "repositories");
}

export function sharedCheckoutsRoot(stateRoot: string): string {
  return path.join(gitRoot(stateRoot), "checkouts");
}

export function legacyRepositoriesRoot(stateRoot: string): string {
  return path.resolve(stateRoot, "repositories");
}

export function legacySharedCheckoutsRoot(stateRoot: string): string {
  return path.resolve(stateRoot, "checkouts");
}

export function legacyIssueSessionRoot(stateRoot: string, issueKey: string): string {
  return path.resolve(stateRoot, "sessions", issueSegment(issueKey));
}

export function legacyIssueAttachmentStoreRoot(stateRoot: string, issueKey: string): string {
  return path.resolve(stateRoot, "attachments", issueSegment(issueKey));
}

export function legacyWorkspaceAttachmentRoot(stateRoot: string, issueKey: string): string {
  return path.join(issueWorkspaceRoot(stateRoot, issueKey), ".issue-pilot", "attachments");
}

async function directories(root: string): Promise<string[]> {
  return readdir(root, { withFileTypes: true })
    .then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name), () => []);
}

export async function assertManagedIssueWorkspaceLayout(root: string, localPaths: string[]): Promise<void> {
  const allowed = new Set<string>();
  for (const localPath of localPaths) {
    const resolved = path.resolve(localPath);
    if (path.dirname(resolved) !== root) throw new Error("workspace_path_outside_issue_root");
    allowed.add(path.basename(resolved));
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!allowed.has(entry.name)) throw new Error("workspace_has_untracked_files");
  }
}

export async function pruneState(stateRoot: string, issueKeys: string[]): Promise<void> {
  const active = new Set(issueKeys.map((key) => normalizeIssueKey(key).toLowerCase()));
  for (const category of ["workspaces", "issues"]) {
    const root = path.resolve(stateRoot, category);
    for (const entry of await directories(root)) {
      if (!active.has(entry.toLowerCase())) await rm(path.join(root, entry), { recursive: true, force: true });
    }
  }
  for (const entry of await directories(issuesRoot(stateRoot))) {
    if (active.has(entry.toLowerCase())) await rm(path.join(issuesRoot(stateRoot), entry, "runtime"), { recursive: true, force: true });
  }
  await rm(sharedCheckoutsRoot(stateRoot), { recursive: true, force: true });
  const repositoryStorage = repositoriesRoot(stateRoot);
  for (const entry of await directories(repositoryStorage)) {
    await execFileAsync("git", ["-C", path.join(repositoryStorage, entry), "worktree", "prune", "--expire", "now"], { timeout: 30_000 });
  }
}
