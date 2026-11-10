import { access, lstat, mkdir, opendir, readdir, realpath, rmdir } from "node:fs/promises";
import path from "node:path";
import { normalizeIssueKey } from "../domain/contracts.ts";

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
  return access(candidate).then(
    () => true,
    (error) => {
      if (isMissing(error)) return false;
      throw error;
    },
  );
}

function issueSegment(issueKey: string): string {
  return normalizeIssueKey(issueKey).toLowerCase();
}

export function workspacesRoot(stateRoot: string): string {
  return path.resolve(stateRoot, "workspaces");
}

/** Current flat Issue root: repositories, working files and private application files share it. */
export function issueRoot(stateRoot: string, issueKey: string): string {
  return path.join(workspacesRoot(stateRoot), issueSegment(issueKey));
}

/** Old layout is never used as a source of runtime paths. */
export function legacyIssueRoot(stateRoot: string, issueKey: string): string {
  return path.resolve(stateRoot, "issues", issueSegment(issueKey));
}

export async function assertIssueLayoutCurrent(stateRoot: string, issueKey: string): Promise<void> {
  const legacy = legacyIssueRoot(stateRoot, issueKey);
  const directory = await opendir(legacy).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (!directory) return;
  try {
    if ((await realpath(legacy)) !== legacy || (await directory.read()) !== null) throw new Error("issue_layout_migration_required");
  } finally {
    await directory.close();
  }
}

/** Only Issue creation claims the durable root; generated views must not hide its loss. */
export async function assertIssueRoot(stateRoot: string, issueKey: string): Promise<string> {
  const root = issueRoot(stateRoot, issueKey);
  const metadata = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error("issue_root_missing", { cause: error });
    throw error;
  });
  if (!metadata.isDirectory() || (await realpath(root)) !== root) throw new Error("invalid_issue_root");
  await assertIssueLayoutCurrent(stateRoot, issueKey);
  return root;
}

export async function claimIssueRoot(stateRoot: string, issueKey: string): Promise<void> {
  const root = issueRoot(stateRoot, issueKey);
  const legacy = legacyIssueRoot(stateRoot, issueKey);
  const oldRoot = await lstat(legacy).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (oldRoot) throw new Error(`unmanaged_issue_state:issues/${path.basename(legacy)}`);
  await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
  if ((await realpath(path.dirname(root))) !== path.dirname(root)) throw new Error("invalid_issue_root");
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") throw new Error(`unmanaged_issue_state:workspaces/${path.basename(root)}`);
    throw error;
  }
}

export async function removeEmptyIssueRoot(stateRoot: string, issueKey: string): Promise<void> {
  try {
    await rmdir(issueRoot(stateRoot, issueKey));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw new Error("issue_state_rollback_failed", { cause: new AggregateError([error], "issue_state_rollback_failed") });
  }
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

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function directoryEntries(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export async function listSharedCheckouts(stateRoot: string): Promise<Array<{ checkout: string; commit: string; commonDirectory: string }>> {
  const checkoutRoot = sharedCheckoutsRoot(stateRoot);
  const checkouts = [];
  for (const repositoryEntry of (await directoryEntries(checkoutRoot)) ?? []) {
    if (!repositoryEntry.isDirectory() || !/^[0-9a-f]{20}$/.test(repositoryEntry.name)) throw new Error("shared_checkout_changed");
    const repositoryRoot = path.join(checkoutRoot, repositoryEntry.name);
    const commonDirectory = path.join(repositoriesRoot(stateRoot), repositoryEntry.name);
    const commitEntries = await readdir(repositoryRoot, { withFileTypes: true });
    if (!commitEntries.length || commitEntries.some((entry) => !entry.isDirectory() || !/^[0-9a-f]{40}$/.test(entry.name))) throw new Error("shared_checkout_changed");
    for (const entry of commitEntries) checkouts.push({ checkout: path.join(repositoryRoot, entry.name), commit: entry.name, commonDirectory });
  }
  return checkouts;
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

export async function assertManagedIssueWorkspaceLayout(workspaceRoot: string, localPaths: string[]): Promise<void> {
  const expectedEntries = managedIssueWorkspaceEntries(workspaceRoot, localPaths);
  const entries = await readdir(workspaceRoot, { withFileTypes: true });
  // Working files and user-created directories share this root with repositories.
  // Only registered repository entries must be present and must be real directories.
  if ([...expectedEntries].some((name) => !entries.some((entry) => entry.name === name && entry.isDirectory()))) throw new Error("workspace_repository_missing");
}

/** Offline audit; neither startup nor ordinary Issue operations need the complete key set. */
export async function assertIssueStateLayout(stateRoot: string, issueKeys: string[]): Promise<void> {
  const active = new Set(issueKeys.map((key) => normalizeIssueKey(key).toLowerCase()));
  const unmanaged: string[] = [];
  const legacy = await directoryEntries(path.resolve(stateRoot, "issues"));
  for (const [category, entries] of [
    ["workspaces", await directoryEntries(workspacesRoot(stateRoot))],
    ["issues", legacy],
  ] as const) {
    for (const entry of entries ?? []) {
      if (entry.isDirectory() && !active.has(entry.name.toLowerCase())) unmanaged.push(`${category}/${entry.name}`);
    }
  }
  if (unmanaged.length) throw new Error(`unmanaged_issue_state:${unmanaged.sort().join(",")}`);
  // The ordinary layout has no legacy parent. Still probe recorded names if it exists,
  // including non-directory entries so ENOTDIR and permission errors remain visible.
  if (legacy) {
    for (const key of issueKeys) await assertIssueLayoutCurrent(stateRoot, key);
  }
}
