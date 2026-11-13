import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readlink, realpath, rm, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { normalizeIssueKey } from "../domain/contracts.ts";
import { executeLocalCommand } from "../process.ts";
import { KeyedSerialQueue } from "../serial.ts";
import { createPrivateIssueBranch, publishIssueBranch, readIssueBranchCommit, readLinkedWorktreeHead, validateIssueGitStore, validateIssueWorktreeBinding } from "./issue-git.ts";
import { assertIssueRoot, issueRoot, listSharedCheckouts, pathExists, repositoriesRoot, sharedCheckoutsRoot, workspacesRoot } from "./state.ts";

const execFileAsync = promisify(execFile);

export interface PrepareWorktreeInput {
  issueKey: string;
  workspaceName: string;
  url: string;
  baseBranch: string;
  mode: "hotfix" | "feature";
  workingBranch?: string;
  existingWorkspacePath?: string;
  existingBaseCommit?: string;
  expectedWorkingCommit?: string;
}

export interface PrepareSharedCheckoutInput {
  url: string;
  baseBranch: string;
}

export interface PreparedWorktree {
  cachePath: string;
  workspacePath: string;
  baseBranch: string;
  workingBranch: string | null;
  baseCommit: string;
}

/** Ownership collected while preparing, used only if the batch is rolled back. */
interface PreparedWorktreeAttempt {
  prepared: PreparedWorktree;
  createdPrivateStore: boolean;
  createdWorktree: boolean;
  repositoryKey: string;
}

export interface RestoreWorktreeInput {
  issueKey: string;
  workspaceName: string;
  url: string;
  mode: "hotfix" | "feature";
  workingBranch: string;
  expectedCommit: string;
  workspacePath: string;
}

export interface PrepareWorktreeBatchInput<T> {
  worktrees: PrepareWorktreeInput[];
  finalize: (prepared: PreparedWorktree[]) => Promise<T>;
}

export interface RemoveWorktreeBatchInput {
  issueKey: string;
  mode: "hotfix" | "feature";
  worktrees: Array<Omit<RestoreWorktreeInput, "issueKey" | "mode" | "expectedCommit">>;
  finalize?: () => Promise<void>;
}

export class WorktreeRemovalFailure extends Error {
  readonly commit: string;

  constructor(commit: string, cause: unknown) {
    super("worktree_remove_failed", { cause });
    this.commit = commit;
  }
}

export class WorktreeRollbackFailure extends Error {
  constructor(cause: unknown) {
    super("worktree_rollback_failed", { cause });
  }
}

function safePathSegment(value: string): string {
  const safe = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!safe || safe === "." || safe === "..") throw new Error("invalid_workspace_segment");
  return safe;
}

function repositoryBasename(url: string): string {
  const withoutQuery = url.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const name = withoutQuery.slice(Math.max(withoutQuery.lastIndexOf("/"), withoutQuery.lastIndexOf(":")) + 1).replace(/\.git$/i, "");
  return safePathSegment(name);
}

function repositoryHash(url: string, length: number): string {
  return createHash("sha256").update(url).digest("hex").slice(0, length);
}

export function repositoryWorkspaceNames(urls: string[], existingNames: ReadonlyMap<string, string> = new Map()): Map<string, string> {
  const names = new Map<string, string>();
  const usedNames = new Set<string>();
  for (const existingName of existingNames.values()) {
    if (safePathSegment(existingName) !== existingName || usedNames.has(existingName)) throw new Error("repository_workspace_name_conflict");
    usedNames.add(existingName);
  }
  for (const url of urls) {
    const existingName = existingNames.get(url);
    if (existingName) names.set(url, existingName);
  }
  const unassigned = urls.filter((url) => !names.has(url));
  const bases = unassigned.map((url) => repositoryBasename(url));
  const counts = new Map<string, number>();
  for (const base of bases) counts.set(base, (counts.get(base) ?? 0) + 1);
  for (const [index, url] of unassigned.entries()) {
    const base = bases[index]!;
    let name = counts.get(base) === 1 && !usedNames.has(base) ? base : `${base}-${repositoryHash(url, 8)}`;
    if (usedNames.has(name)) name = `${base}-${repositoryHash(url, 20)}`;
    if (usedNames.has(name)) throw new Error("repository_workspace_name_conflict");
    names.set(url, name);
    usedNames.add(name);
  }
  return names;
}

export function repositoryStorePath(stateRoot: string, url: string): string {
  return resolve(repositoriesRoot(stateRoot), repositoryHash(url, 20));
}

export function issueRepositoryStorePath(stateRoot: string, issueKey: string, url: string): string {
  return resolve(issueRoot(stateRoot, normalizeIssueKey(issueKey)), ".issue-git", repositoryHash(url, 20));
}

export async function developmentRepositoryStorePath(stateRoot: string, issueKey: string, url: string): Promise<string> {
  const isolated = issueRepositoryStorePath(stateRoot, issueKey, url);
  await lstat(isolated).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error("workspace_git_store_missing", { cause: error });
    throw error;
  });
  await validateIssueGitStore(isolated, url);
  return isolated;
}

export function issueRepositoryWorkspaceNames(repositories: Array<{ url: string; localPath: string | null; workspaceName: string | null }>): Map<string, string> {
  const existingNames = new Map<string, string>();
  for (const repository of repositories) {
    const localName = repository.localPath ? basename(repository.localPath) : undefined;
    if (repository.workspaceName && localName && repository.workspaceName !== localName) throw new Error("workspace_path_does_not_match_repository");
    const name = repository.workspaceName ?? localName;
    if (name) existingNames.set(repository.url, name);
  }
  return repositoryWorkspaceNames(
    repositories.map((repository) => repository.url),
    existingNames,
  );
}

/** New Git directories may be absent, but never create through a redirected ancestor. */
export async function managedGitDirectoryExists(directory: string): Promise<boolean> {
  const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) {
    await managedGitDirectoryExists(dirname(directory));
    return false;
  }
  if (!info.isDirectory() || (await realpath(directory)) !== directory) throw new Error("shared_git_path_invalid");
  return true;
}

const repositoryQueue = new KeyedSerialQueue();

const checkoutUsers = new Map<string, number>();
const checkoutLease = new AsyncLocalStorage<SharedCheckoutLease>();
const checkoutUseTime = new Map<string, number>();

/** Keep materialized paths available through the owning request or Agent session. */
export class SharedCheckoutLease {
  private readonly paths = new Set<string>();
  private closed = false;

  run<T>(operation: () => Promise<T>): Promise<T> {
    return checkoutLease.run(this, operation);
  }

  pin(path: string): void {
    if (this.closed) throw new Error("shared_checkout_lease_closed");
    if (this.paths.has(path)) return;
    this.paths.add(path);
    checkoutUsers.set(path, (checkoutUsers.get(path) ?? 0) + 1);
  }

  close(): void {
    this.closed = true;
    for (const path of this.paths) {
      const remaining = checkoutUsers.get(path)! - 1;
      if (remaining) checkoutUsers.set(path, remaining);
      else checkoutUsers.delete(path);
    }
    this.paths.clear();
  }
}

export async function withSharedCheckout<T>(operation: () => Promise<T>): Promise<T> {
  const lease = new SharedCheckoutLease();
  try {
    return await lease.run(operation);
  } finally {
    lease.close();
  }
}

export const retainedSnapshotRef = (commit: string) => `refs/issue-pilot/snapshots/${commit}`;

/** A clean index alone does not prove a sole copy is reproducible: Git can skip stat-matched files and empty directories. */
async function assertCheckoutMatchesObjects(checkout: string, tree: string): Promise<void> {
  const expected = new Map<string, { mode: string; object: string }>();
  for (const record of tree.split("\0").filter(Boolean)) {
    const match = /^(040000|100644|100755|120000) (?:blob|tree) ([a-f0-9]{40})\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("shared_checkout_not_reproducible");
    expected.set(match[3]!, { mode: match[1]!, object: match[2]! });
  }
  async function verify(directory: string, prefix: string): Promise<void> {
    for (const name of await readdir(directory)) {
      if (!prefix && name === ".git") continue;
      const key = prefix + name;
      const entry = expected.get(key);
      if (!entry) throw new Error("shared_checkout_not_reproducible");
      expected.delete(key);
      const file = resolve(directory, name);
      const metadata = await lstat(file);
      if (entry.mode === "040000" && metadata.isDirectory()) {
        await verify(file, key + "/");
        continue;
      }
      const hash = createHash("sha1");
      if (entry.mode === "120000" && metadata.isSymbolicLink()) {
        const bytes = await readlink(file, { encoding: "buffer" });
        hash.update(`blob ${bytes.length}\0`).update(bytes);
      } else if (metadata.isFile() && metadata.nlink === 1 && (entry.mode === "100755" ? Boolean(metadata.mode & 0o100) : entry.mode === "100644" && !(metadata.mode & 0o111))) {
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const opened = await handle.stat();
          if (opened.dev !== metadata.dev || opened.ino !== metadata.ino || opened.size !== metadata.size) throw new Error("shared_checkout_not_reproducible");
          hash.update(`blob ${opened.size}\0`);
          for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
        } finally {
          await handle.close();
        }
      } else throw new Error("shared_checkout_not_reproducible");
      if (hash.digest("hex") !== entry.object) throw new Error("shared_checkout_not_reproducible");
    }
  }
  await verify(checkout, "");
  if (expected.size) throw new Error("shared_checkout_not_reproducible");
}

export class WorktreeManager {
  private readonly gitEnvironment = new AsyncLocalStorage<Record<string, string>>();

  /** Explicit offline audit. Normal reads validate only the selected checkout. */
  static async assertSharedState(stateRoot: string): Promise<void> {
    const manager = new WorktreeManager(stateRoot);
    for (const { checkout, commit, commonDirectory } of await listSharedCheckouts(manager.stateRoot)) {
      try {
        await manager.assertSharedCheckout(checkout, commit, commonDirectory);
      } catch (error) {
        throw new Error(`shared_checkout_changed:${relative(manager.stateRoot, checkout)}`, { cause: error });
      }
    }
  }

  withGitEnvironment<T>(env: Record<string, string>, operation: () => Promise<T>): Promise<T> {
    return this.gitEnvironment.run(env, operation);
  }
  private readonly stateRoot: string;
  private readonly repositoriesRoot: string;
  private readonly sharedCheckoutsRoot: string;
  private readonly workspacesRoot: string;

  constructor(stateRoot: string) {
    this.stateRoot = resolve(stateRoot);
    this.repositoriesRoot = repositoriesRoot(this.stateRoot);
    this.sharedCheckoutsRoot = sharedCheckoutsRoot(this.stateRoot);
    this.workspacesRoot = workspacesRoot(this.stateRoot);
  }

  async assertClean(url: string, workspacePath: string, expectedBranch?: string): Promise<void> {
    const resolvedWorkspace = this.validatedWorkspacePath(workspacePath);
    const repositoryKey = repositoryHash(url, 20);
    await this.serialized(repositoryKey, async () => {
      const store = await developmentRepositoryStorePath(this.stateRoot, basename(dirname(resolvedWorkspace)), url);
      await this.assertCleanLocked(resolvedWorkspace, store, expectedBranch);
    });
  }

  async remove(url: string, workspacePath: string, expectedBranch?: string): Promise<string> {
    const resolvedWorkspace = this.validatedWorkspacePath(workspacePath);
    const repositoryKey = repositoryHash(url, 20);
    return this.serialized(repositoryKey, async () => {
      const issueKey = basename(dirname(resolvedWorkspace));
      const cachePath = await developmentRepositoryStorePath(this.stateRoot, issueKey, url);
      await this.assertCleanLocked(resolvedWorkspace, cachePath, expectedBranch);
      const commit = (await this.git(["-C", resolvedWorkspace, "rev-parse", "HEAD"])).trim();
      const branch = expectedBranch ?? (await this.git(["-C", resolvedWorkspace, "branch", "--show-current"])).trim();
      if (!branch) throw new Error("workspace_branch_required");
      const shared = resolve(this.repositoriesRoot, repositoryKey);
      const published = await publishIssueBranch(shared, cachePath, branch, true);
      if (published !== commit) throw new Error("working_branch_changed_during_release");
      await this.retainSnapshotCommit(shared, commit);
      try {
        await this.git(["-C", cachePath, "worktree", "remove", resolvedWorkspace]);
      } catch (error) {
        if (await pathExists(resolvedWorkspace)) throw error;
        try {
          await this.git(["-C", cachePath, "worktree", "prune", "--expire", "now"]);
        } catch (pruneError) {
          throw new WorktreeRemovalFailure(commit, new AggregateError([error, pruneError], "worktree_remove_failed"));
        }
      }
      return commit;
    });
  }

  private async assertCleanLocked(resolvedWorkspace: string, store: string, expectedBranch?: string): Promise<void> {
    if (!(await pathExists(resolvedWorkspace))) throw new Error("workspace_repository_missing");
    await readLinkedWorktreeHead(store, resolvedWorkspace).catch((error: unknown) => {
      throw new Error("workspace_git_binding_invalid", { cause: error });
    });
    const inspect = async (args: string[]): Promise<string> => {
      try {
        return await this.git(args);
      } catch (error) {
        const failure = error as NodeJS.ErrnoException & { stderr?: unknown };
        const diagnostic = typeof failure?.stderr === "string" ? failure.stderr : "";
        const reason = /gitfile does not point to a valid repository|not a git repository|invalid gitfile format/i.test(diagnostic)
          ? "workspace_git_binding_invalid"
          : failure?.code === "ENOENT"
            ? "workspace_git_unavailable"
            : "workspace_git_inspection_failed";
        throw new Error(reason, { cause: error });
      }
    };
    // Read branch and dirtiness in one Git snapshot rather than spawning twice.
    const status = await inspect(["--no-optional-locks", "-C", resolvedWorkspace, "status", "--porcelain=v2", "--branch", "--ignored=matching"]);
    const lines = status.split("\n").filter(Boolean);
    if (expectedBranch !== undefined) {
      const head = lines.find((line) => line.startsWith("# branch.head "))?.slice("# branch.head ".length);
      // A historical branch can literally be named like porcelain's detached marker.
      const branch = head === "(detached)" && expectedBranch === head ? (await inspect(["-C", resolvedWorkspace, "branch", "--show-current"])).trim() : head;
      if (branch !== expectedBranch) throw new Error("workspace_branch_does_not_match_issue_policy");
    }
    if (lines.some((line) => !line.startsWith("# "))) throw new Error("workspace_has_changes");

    // Git status and worktree remove both honor flags that can hide local file changes.
    // ls-files -v marks skip-worktree with S and assume-unchanged entries with lowercase tags.
    let atEntryStart = true;
    let hiddenChangesPossible = false;
    try {
      const result = await executeLocalCommand("git", ["-C", resolvedWorkspace, "ls-files", "-v", "-z"], {
        timeout: issuePilotConfig.limits.process.gitOperationMs,
        environment: { ...process.env, ...this.gitEnvironment.getStore() } as Record<string, string>,
        maxOutputBytes: null,
        onStdout: (chunk) => {
          hiddenChangesPossible ||= (atEntryStart && /^[a-zS]/.test(chunk)) || /\0[a-zS]/.test(chunk);
          atEntryStart = chunk.endsWith("\0");
        },
      });
      if (result.code !== 0 || result.killed || !atEntryStart) throw new Error(result.stderr || "git_index_listing_incomplete");
    } catch (error) {
      throw new Error("workspace_git_inspection_failed", { cause: error });
    }
    if (hiddenChangesPossible) throw new Error("workspace_has_changes");
  }

  private validatedWorkspacePath(workspacePath: string): string {
    const resolvedWorkspace = resolve(workspacePath);
    const relativePath = relative(this.workspacesRoot, resolvedWorkspace);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath) || relativePath.split(sep).length !== 2) throw new Error("workspace_path_outside_workspaces_root");
    return resolvedWorkspace;
  }

  async prepare(input: PrepareWorktreeInput): Promise<PreparedWorktree> {
    return (await this.prepareAttempt(input)).prepared;
  }

  private async prepareAttempt(input: PrepareWorktreeInput): Promise<PreparedWorktreeAttempt> {
    const issueKey = normalizeIssueKey(input.issueKey);
    this.validateRepositoryInput(input);
    const repositoryKey = repositoryHash(input.url, 20);
    return this.serialized(repositoryKey, () => this.prepareLocked(input, issueKey, repositoryKey));
  }

  async restoreLocal(input: RestoreWorktreeInput): Promise<void> {
    const issueKey = normalizeIssueKey(input.issueKey);
    if (input.url.startsWith("-")) throw new Error("invalid_repository_configuration");
    const repositoryKey = repositoryHash(input.url, 20);
    return this.serialized(repositoryKey, () => this.restoreLocalLocked(input, issueKey));
  }

  async prepareBatch<T>(input: PrepareWorktreeBatchInput<T>): Promise<T> {
    const created: PreparedWorktreeAttempt[] = [];
    const prepared: PreparedWorktree[] = [];
    try {
      for (const worktree of input.worktrees) {
        const attempt = await this.prepareAttempt(worktree);
        if (attempt.createdWorktree) created.push(attempt);
        prepared.push(attempt.prepared);
      }
      return await input.finalize(prepared);
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const createdWorktree of created.reverse()) {
        try {
          await this.serialized(createdWorktree.repositoryKey, () => this.discardPrepared(createdWorktree));
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length) throw new WorktreeRollbackFailure(new AggregateError([error, ...rollbackErrors], "worktree_rollback_failed"));
      throw error;
    }
  }

  /**
   * Remove only the worktree, branch and private store created by an unrecorded attempt.
   * Publishing here would make a failed preparation look like a completed one.
   */
  private async discardPrepared(attempt: PreparedWorktreeAttempt): Promise<void> {
    const { prepared, createdPrivateStore } = attempt;
    const { cachePath, workspacePath, workingBranch } = prepared;
    if (createdPrivateStore && (await readIssueBranchCommit(cachePath, workingBranch!)) !== prepared.baseCommit) throw new Error("working_branch_changed_outside_issue");
    if (await this.worktreeEntryExists(workspacePath)) {
      await this.assertCleanLocked(workspacePath, cachePath, workingBranch!);
      await this.git(["-C", cachePath, "worktree", "remove", workspacePath]);
    }
    if (createdPrivateStore) {
      await rm(cachePath, { recursive: true });
      await rmdir(dirname(cachePath)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOTEMPTY") throw error;
      });
    }
  }

  private async worktreeEntryExists(workspacePath: string): Promise<boolean> {
    try {
      await lstat(workspacePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async removeBatch(input: RemoveWorktreeBatchInput): Promise<void> {
    await Promise.all(input.worktrees.map((worktree) => this.assertClean(worktree.url, worktree.workspacePath, worktree.workingBranch)));
    const removed: Array<{ worktree: RemoveWorktreeBatchInput["worktrees"][number]; commit: string }> = [];
    try {
      for (const worktree of input.worktrees) {
        try {
          const commit = await this.remove(worktree.url, worktree.workspacePath, worktree.workingBranch);
          removed.push({ worktree, commit });
        } catch (error) {
          if (error instanceof WorktreeRemovalFailure) removed.push({ worktree, commit: error.commit });
          throw error;
        }
      }
      await input.finalize?.();
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const { worktree, commit } of removed.reverse()) {
        try {
          await this.restoreLocal({ issueKey: input.issueKey, mode: input.mode, expectedCommit: commit, ...worktree });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length) throw new WorktreeRollbackFailure(new AggregateError([error, ...rollbackErrors], "worktree_rollback_failed"));
      throw error;
    }
  }

  async prepareShared(input: PrepareSharedCheckoutInput, checkedCheckouts?: Set<string>): Promise<PreparedWorktree> {
    this.validateRepositoryInput(input);
    const repositoryKey = repositoryHash(input.url, 20);
    return this.serialized(repositoryKey, () => this.prepareSharedLocked(input, repositoryKey, checkedCheckouts));
  }

  /** A cold snapshot must still be reachable from a local reference. */
  async assertSnapshotCommit(url: string, commit: string, publishedBranch?: string): Promise<void> {
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("shared_checkout_changed");
    const store = repositoryStorePath(this.stateRoot, url);
    const ref = retainedSnapshotRef(commit);
    try {
      const retained = (await this.git(["-C", store, "show-ref", "--verify", "--hash", "--", ref])).trim();
      if (retained === commit) return;
    } catch (error) {
      if (!publishedBranch || Number((error as NodeJS.ErrnoException).code) !== 128) throw error;
      const absent = await this.git(["-C", store, "show-ref", "--exists", ref]).then(
        () => false,
        (probe: NodeJS.ErrnoException) => {
          if (Number(probe.code) !== 2) throw probe;
          return true;
        },
      );
      // An older release could finish before recording a retained ref. The mirror can prove
      // local reachability only for the tip already verified in the private store.
      if (absent && (await readIssueBranchCommit(store, publishedBranch)) === commit) return;
    }
    throw new Error("shared_checkout_changed");
  }

  /** Materialize only an exact checkout recorded or evicted by this owner. */
  async openSharedCheckout(url: string, commit: string, checkedCheckouts?: Set<string>, publishedBranch?: string): Promise<string> {
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("shared_checkout_changed");
    const repositoryKey = repositoryHash(url, 20);
    const store = resolve(this.repositoriesRoot, repositoryKey);
    return this.serialized(repositoryKey, async () => {
      const checkout = this.sharedCheckoutPath(repositoryKey, commit);
      if (!(await managedGitDirectoryExists(store))) throw new Error("repository_cache_not_found");
      if (!(await managedGitDirectoryExists(checkout))) await this.assertSnapshotCommit(url, commit, publishedBranch);
      return this.prepareCommitCheckout(store, repositoryKey, commit, checkedCheckouts);
    });
  }

  /** Remove only a clean, detached cache copy; preserve its exact commit against Git maintenance. */
  async evictSharedCheckout({ checkout, commit, commonDirectory }: Awaited<ReturnType<typeof listSharedCheckouts>>[number]): Promise<boolean> {
    const repositoryKey = basename(commonDirectory);
    if (
      !/^[a-f0-9]{20}$/.test(repositoryKey) ||
      !/^[a-f0-9]{40}$/.test(commit) ||
      resolve(this.repositoriesRoot, repositoryKey) !== commonDirectory ||
      resolve(this.sharedCheckoutsRoot, repositoryKey, commit) !== checkout
    )
      throw new Error("shared_checkout_changed");
    return this.serialized(repositoryKey, async () => {
      if (checkoutUsers.has(checkout) || !(await managedGitDirectoryExists(checkout))) return false;
      if (!(await managedGitDirectoryExists(commonDirectory))) throw new Error("repository_cache_not_found");
      await this.assertSharedCheckout(checkout, commit, commonDirectory);
      const local = ["--no-lazy-fetch", "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-C", commonDirectory];
      await assertCheckoutMatchesObjects(checkout, await this.git([...local, "ls-tree", "-rtz", commit]));
      await this.retainSnapshotCommit(commonDirectory, commit);
      // Detach the public cache path before deleting files. A failed cleanup must not expose a half-removed checkout.
      const control = resolve(this.stateRoot, "control");
      if (!(await managedGitDirectoryExists(control))) await mkdir(control, { recursive: true, mode: 0o700 });
      if (!(await managedGitDirectoryExists(control))) throw new Error("shared_checkout_changed");
      const quarantine = await mkdtemp(resolve(control, "shared-checkout-eviction-"));
      const retired = resolve(quarantine, "checkout");
      try {
        await this.git([...local, "worktree", "move", checkout, retired]);
      } catch (error) {
        await rmdir(quarantine).catch((cleanup: NodeJS.ErrnoException) => {
          if (cleanup.code !== "ENOTEMPTY") throw new AggregateError([error, cleanup], "shared_checkout_cleanup_failed");
        });
        throw error;
      }
      await rmdir(dirname(checkout)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOTEMPTY") throw error;
      });
      await this.git([...local, "worktree", "remove", retired]);
      await rmdir(quarantine);
      checkoutUseTime.delete(checkout);
      return true;
    });
  }

  async reclaimSharedCheckouts(highWater: number, target: number, onFailure: (error: unknown) => void, stopping: () => boolean): Promise<void> {
    if (highWater <= 0) return;
    if (target < 0 || target >= highWater) throw new Error("shared_checkout_target_must_be_below_high_water");
    if (!(await managedGitDirectoryExists(this.sharedCheckoutsRoot))) return;
    const { stdout } = await execFileAsync("du", ["-x", "-B1", "-d2", "--", this.sharedCheckoutsRoot], {
      timeout: issuePilotConfig.limits.process.diskUsageMs,
      maxBuffer: issuePilotConfig.limits.process.diskUsageOutputBytes,
    });
    const measured = new Map(
      stdout
        .trimEnd()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("\t");
          return [line.slice(separator + 1), Number(line.slice(0, separator))] as const;
        }),
    );
    let remaining = measured.get(this.sharedCheckoutsRoot);
    if (remaining === undefined || !Number.isSafeInteger(remaining) || remaining < 0) throw new Error("invalid_shared_checkout_disk_usage");
    if (remaining <= highWater || stopping()) return;
    const candidates = [];
    for (const candidate of await listSharedCheckouts(this.stateRoot)) {
      const { checkout } = candidate;
      if (checkoutUsers.has(checkout)) continue;
      const used = measured.get(checkout);
      if (!used || !Number.isSafeInteger(used) || used < 0) continue;
      const timestamp = checkoutUseTime.get(checkout) ?? (await lstat(checkout)).mtimeMs;
      candidates.push({ ...candidate, used, timestamp });
    }
    for (const candidate of candidates.sort((left, right) => left.timestamp - right.timestamp).slice(0, 8)) {
      if (remaining <= target || stopping()) break;
      try {
        if (await this.evictSharedCheckout(candidate)) remaining -= candidate.used;
      } catch (error) {
        checkoutUseTime.set(candidate.checkout, Date.now());
        onFailure(new Error(`shared_checkout_reclaim_failed:${basename(candidate.commonDirectory)}/${candidate.commit}`, { cause: error }));
      }
    }
  }

  private validateRepositoryInput(input: PrepareSharedCheckoutInput): void {
    if (input.url.startsWith("-") || !input.baseBranch.trim() || input.baseBranch.startsWith("-")) throw new Error("invalid_repository_configuration");
  }

  private serialized<T>(repositoryKey: string, operation: () => Promise<T>): Promise<T> {
    return repositoryQueue.run(`${this.stateRoot}:${repositoryKey}`, operation);
  }

  private async updateCache(input: PrepareSharedCheckoutInput, repositoryKey: string): Promise<string> {
    await this.assertBranchReference(input.baseBranch);
    const cachePath = resolve(this.repositoriesRoot, repositoryKey);
    if (!(await managedGitDirectoryExists(cachePath))) {
      await mkdir(this.repositoriesRoot, { recursive: true });
      await this.git(["init", "--bare", "--object-format=sha1", cachePath]);
      await this.git(["-C", cachePath, "remote", "add", "origin", input.url]);
    }
    try {
      await this.git(["-C", cachePath, "fetch", "--prune", "origin", input.baseBranch]);
    } catch (error) {
      if (this.gitEnvironment.getStore()) throw new Error("personal_git_fetch_failed");
      throw error;
    }
    return cachePath;
  }

  private async prepareSharedLocked(input: PrepareSharedCheckoutInput, repositoryKey: string, checkedCheckouts?: Set<string>): Promise<PreparedWorktree> {
    const cachePath = await this.updateCache(input, repositoryKey);
    const baseCommit = (await this.git(["-C", cachePath, "rev-parse", `refs/remotes/origin/${input.baseBranch}`])).trim();
    const workspacePath = await this.prepareCommitCheckout(cachePath, repositoryKey, baseCommit, checkedCheckouts);
    return { cachePath, workspacePath, baseBranch: input.baseBranch, workingBranch: null, baseCommit };
  }

  private async retainSnapshotCommit(store: string, commit: string): Promise<void> {
    const local = ["--no-lazy-fetch", "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-C", store];
    await this.git([...local, "rev-list", "--objects", "--missing=error", "--quiet", "--max-count=1", commit]);
    const ref = retainedSnapshotRef(commit);
    const previous = await this.git([...local, "show-ref", "--exists", ref]).then(
      () => commit,
      (error: NodeJS.ErrnoException) => {
        if (Number(error.code) !== 2) throw error;
        return "0".repeat(40);
      },
    );
    await this.git([...local, "update-ref", ref, commit, previous]);
  }

  private sharedCheckoutPath(repositoryKey: string, commit: string): string {
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("shared_checkout_changed");
    return resolve(this.sharedCheckoutsRoot, repositoryKey, commit);
  }

  private async prepareCommitCheckout(cachePath: string, repositoryKey: string, commit: string, checkedCheckouts?: Set<string>): Promise<string> {
    const workspacePath = this.sharedCheckoutPath(repositoryKey, commit);
    const checkoutParent = dirname(workspacePath);

    if (await managedGitDirectoryExists(workspacePath)) {
      if (!(await pathExists(resolve(workspacePath, ".git")))) throw new Error("shared_checkout_is_not_git_worktree");
      await this.assertSharedCheckout(workspacePath, commit, cachePath, checkedCheckouts);
    } else {
      if (await managedGitDirectoryExists(this.sharedCheckoutsRoot)) await managedGitDirectoryExists(checkoutParent);
      await mkdir(checkoutParent, { recursive: true });
      if ((await realpath(checkoutParent)) !== checkoutParent) throw new Error("shared_checkout_changed");
      await this.git(["--no-lazy-fetch", "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-C", cachePath, "worktree", "add", "--relative-paths", "--detach", workspacePath, commit]);
      checkedCheckouts?.add(workspacePath);
    }
    checkoutLease.getStore()?.pin(workspacePath);
    if (issuePilotConfig.workspace.sharedCheckoutHighWaterBytes > 0) checkoutUseTime.set(workspacePath, Date.now());
    return workspacePath;
  }

  /** Share successful checks only within one preparation operation. */
  async assertSharedCheckout(checkout: string, commit: string, cachePath: string, checkedCheckouts?: Set<string>): Promise<void> {
    if (checkedCheckouts?.has(checkout)) return;
    const head = await readLinkedWorktreeHead(cachePath, checkout).catch((error) => {
      throw new Error("shared_checkout_changed", { cause: error });
    });
    if (head !== commit) throw new Error("shared_checkout_changed");
    // A single Git status verifies that Git resolves this detached HEAD and that even ignored content is absent.
    const status = await this.git(["--no-optional-locks", "--no-replace-objects", "-C", checkout, "status", "--porcelain=v2", "--branch", "--untracked-files=all", "--ignored=matching"]);
    const lines = status.trimEnd().split("\n");
    if (!lines.includes(`# branch.oid ${commit}`) || !lines.includes("# branch.head (detached)") || lines.some((line) => !line.startsWith("# "))) throw new Error("shared_checkout_changed");
    checkedCheckouts?.add(checkout);
  }

  private async restoreLocalLocked(input: RestoreWorktreeInput, issueKey: string): Promise<void> {
    const root = await assertIssueRoot(this.stateRoot, issueKey);
    const cachePath = await developmentRepositoryStorePath(this.stateRoot, issueKey, input.url);
    const workspacePath = this.resolveIssueWorkspacePath(root, input.workspaceName, input.workspacePath);
    if (await pathExists(workspacePath)) throw new Error("workspace_path_already_exists");
    await this.git(["check-ref-format", "--branch", input.workingBranch]);
    if (!input.workingBranch.startsWith(`${input.mode}-`)) throw new Error("invalid_issue_branch_prefix");
    const commit = await readIssueBranchCommit(cachePath, input.workingBranch);
    if (commit !== input.expectedCommit) throw new Error("working_branch_changed_during_release");
    await this.git(["-C", cachePath, "worktree", "prune", "--expire", "now"]);
    await this.git(["-C", cachePath, "worktree", "add", "--relative-paths", workspacePath, input.workingBranch]);
  }

  private async prepareLocked(input: PrepareWorktreeInput, issueKey: string, repositoryKey: string): Promise<PreparedWorktreeAttempt> {
    const root = await assertIssueRoot(this.stateRoot, issueKey);
    await this.assertBranchReference(input.baseBranch);
    const workspacePath = this.resolveIssueWorkspacePath(root, input.workspaceName, input.existingWorkspacePath);
    const workingBranch = input.workingBranch ?? `${input.mode}-${issueKey.toLowerCase()}`;
    await this.git(["check-ref-format", "--branch", workingBranch]);
    if (!workingBranch.startsWith(`${input.mode}-`)) throw new Error("invalid_issue_branch_prefix");

    const workspaceExists = await this.worktreeEntryExists(workspacePath);
    if (workspaceExists && !input.existingWorkspacePath && (!input.workingBranch || input.expectedWorkingCommit)) throw new Error("workspace_path_already_exists");
    if (workspaceExists && !(await pathExists(resolve(workspacePath, ".git")))) throw new Error("workspace_is_not_git_worktree");
    const privateStore = issueRepositoryStorePath(this.stateRoot, issueKey, input.url);
    const reuseStore = input.workingBranch !== undefined || (await managedGitDirectoryExists(privateStore));
    const baseRef = `refs/remotes/origin/${input.baseBranch}`;
    let baseCommit: string;
    if (reuseStore) {
      await developmentRepositoryStorePath(this.stateRoot, issueKey, input.url);
      const tip = await readIssueBranchCommit(privateStore, workingBranch);
      if (input.expectedWorkingCommit !== undefined && tip !== input.expectedWorkingCommit) throw new Error("working_branch_changed_during_release");
      if (!input.workingBranch) {
        // A repository previously removed from this Issue can be included again with its own history.
        const sharedStore = await this.updateCache(input, repositoryKey);
        await this.git(["-C", privateStore, "fetch", "--no-tags", sharedStore, `+${baseRef}:${baseRef}`]);
      }
      baseCommit = input.existingBaseCommit ?? (await this.git(["-C", privateStore, "merge-base", `refs/heads/${workingBranch}`, baseRef])).trim();
    } else {
      if (workspaceExists) throw new Error("workspace_git_store_missing");
      const sharedStore = await this.updateCache(input, repositoryKey);
      if (await this.hasBranch(sharedStore, workingBranch)) throw new Error("workspace_git_store_missing");
      baseCommit = (await this.git(["-C", sharedStore, "rev-parse", baseRef])).trim();
      // The private branch borrows these objects. Keep the baseline even if origin is force-pushed.
      await this.retainSnapshotCommit(sharedStore, baseCommit);
      await createPrivateIssueBranch(sharedStore, privateStore, workingBranch, baseCommit);
    }

    const attempt: PreparedWorktreeAttempt = {
      prepared: { cachePath: privateStore, workspacePath, baseBranch: input.baseBranch, workingBranch, baseCommit },
      createdPrivateStore: !reuseStore,
      createdWorktree: !workspaceExists,
      repositoryKey,
    };
    if (workspaceExists) await validateIssueWorktreeBinding(privateStore, workspacePath, workingBranch);
    else {
      try {
        await this.git(["-C", privateStore, "worktree", "add", "--relative-paths", workspacePath, workingBranch]);
      } catch (error) {
        try {
          await this.discardPrepared(attempt);
        } catch (cleanup) {
          throw new WorktreeRollbackFailure(new AggregateError([error, cleanup], "worktree_rollback_failed"));
        }
        throw error;
      }
    }
    return attempt;
  }

  private resolveIssueWorkspacePath(issueRoot: string, workspaceName: string, existingWorkspacePath?: string): string {
    const desiredPath = resolve(issueRoot, safePathSegment(workspaceName));
    if (dirname(desiredPath) !== issueRoot) throw new Error("workspace_path_outside_issue_root");
    if (existingWorkspacePath && resolve(existingWorkspacePath) !== desiredPath) throw new Error("workspace_path_does_not_match_repository");
    return desiredPath;
  }

  private async hasBranch(cachePath: string, branch: string): Promise<boolean> {
    try {
      await this.git(["-C", cachePath, "show-ref", "--exists", `refs/heads/${branch}`]);
      return true;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === 2) return false;
      throw error;
    }
  }

  private async assertBranchReference(branch: string): Promise<void> {
    try {
      if ((await this.git(["check-ref-format", "--branch", branch])).trim() !== branch) throw new Error("invalid_repository_configuration");
    } catch {
      throw new Error("invalid_repository_configuration");
    }
  }

  private async git(args: string[]): Promise<string> {
    const { gitOperationMs, gitOutputBytes } = issuePilotConfig.limits.process;
    const { stdout } = await execFileAsync("git", args, { timeout: gitOperationMs, maxBuffer: gitOutputBytes, env: { ...process.env, ...this.gitEnvironment.getStore() } });
    return stdout;
  }
}
