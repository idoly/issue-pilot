import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { normalizeIssueKey } from "../domain/contracts.ts";
import { issueWorkspaceRoot, pathExists, repositoriesRoot, sharedCheckoutsRoot, workspacesRoot } from "./state.ts";

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
}

export interface PrepareSharedCheckoutInput {
  url: string;
  baseBranch: string;
}

export interface PrepareBranchSnapshotInput extends PrepareSharedCheckoutInput {
  workingBranch: string;
}

export interface PreparedWorktree {
  cachePath: string;
  workspacePath: string;
  baseBranch: string;
  workingBranch: string | null;
  baseCommit: string;
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
  const safe = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
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

export function issueRepositoryWorkspaceNames(repositories: Array<{ url: string; localPath: string | null; workspaceName: string | null }>): Map<string, string> {
  const existingNames = new Map<string, string>();
  for (const repository of repositories) {
    const localName = repository.localPath ? basename(repository.localPath) : undefined;
    if (repository.workspaceName && localName && repository.workspaceName !== localName) throw new Error("workspace_path_does_not_match_repository");
    const name = repository.workspaceName ?? localName;
    if (name) existingNames.set(repository.url, name);
  }
  return repositoryWorkspaceNames(repositories.map((repository) => repository.url), existingNames);
}

const repositoryTails = new Map<string, Promise<unknown>>();

export class WorktreeManager {
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

  async assertClean(url: string, workspacePath: string): Promise<void> {
    const resolvedWorkspace = this.validatedWorkspacePath(workspacePath);
    const repositoryKey = repositoryHash(url, 20);
    await this.serialized(repositoryKey, () => this.assertCleanLocked(resolvedWorkspace));
  }

  async remove(url: string, workspacePath: string): Promise<string> {
    const resolvedWorkspace = this.validatedWorkspacePath(workspacePath);
    const repositoryKey = repositoryHash(url, 20);
    return this.serialized(repositoryKey, async () => {
      const cachePath = resolve(this.repositoriesRoot, repositoryKey);
      await this.assertCleanLocked(resolvedWorkspace);
      const commit = (await this.git(["-C", resolvedWorkspace, "rev-parse", "HEAD"])).trim();
      try {
        await this.git(["-C", cachePath, "worktree", "remove", resolvedWorkspace]);
      } catch (error) {
        if (await pathExists(resolvedWorkspace)) throw error;
        try { await this.git(["-C", cachePath, "worktree", "prune", "--expire", "now"]); }
        catch (pruneError) { throw new WorktreeRemovalFailure(commit, new AggregateError([error, pruneError], "worktree_remove_failed")); }
      }
      return commit;
    });
  }

  private async assertCleanLocked(resolvedWorkspace: string): Promise<void> {
    if (!await pathExists(resolvedWorkspace)) throw new Error("workspace_repository_missing");
    const dirty = (await this.git(["-C", resolvedWorkspace, "status", "--porcelain"])).trim();
    if (dirty) throw new Error("workspace_has_changes");
  }

  private validatedWorkspacePath(workspacePath: string): string {
    const resolvedWorkspace = resolve(workspacePath);
    const relativePath = relative(this.workspacesRoot, resolvedWorkspace);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath) || relativePath.split(sep).length !== 2) throw new Error("workspace_path_outside_workspaces_root");
    return resolvedWorkspace;
  }

  async prepare(input: PrepareWorktreeInput): Promise<PreparedWorktree> {
    const issueKey = normalizeIssueKey(input.issueKey);
    this.validateRepositoryInput(input);
    const repositoryKey = repositoryHash(input.url, 20);
    return this.serialized(repositoryKey, () => this.prepareLocked(input, issueKey, repositoryKey));
  }

  async restoreLocal(input: RestoreWorktreeInput): Promise<void> {
    const issueKey = normalizeIssueKey(input.issueKey);
    if (input.url.startsWith("-")) throw new Error("invalid_repository_configuration");
    const repositoryKey = repositoryHash(input.url, 20);
    return this.serialized(repositoryKey, () => this.restoreLocalLocked(input, issueKey, repositoryKey));
  }

  async prepareBatch<T>(input: PrepareWorktreeBatchInput<T>): Promise<T> {
    const created: Array<{ input: PrepareWorktreeInput; workspacePath: string }> = [];
    const prepared: PreparedWorktree[] = [];
    const workspaceRoots = new Map<string, boolean>();
    for (const worktree of input.worktrees) {
      const issueRoot = issueWorkspaceRoot(this.stateRoot, normalizeIssueKey(worktree.issueKey));
      if (!workspaceRoots.has(issueRoot)) workspaceRoots.set(issueRoot, await pathExists(issueRoot));
    }
    try {
      for (const worktree of input.worktrees) {
        const issueRoot = issueWorkspaceRoot(this.stateRoot, normalizeIssueKey(worktree.issueKey));
        const workspacePath = this.resolveIssueWorkspacePath(issueRoot, worktree.workspaceName, worktree.existingWorkspacePath);
        if (!await pathExists(workspacePath)) created.push({ input: worktree, workspacePath });
        prepared.push(await this.prepare(worktree));
      }
      return await input.finalize(prepared);
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const createdWorktree of created.reverse()) {
        try {
          if (await pathExists(createdWorktree.workspacePath)) await this.remove(createdWorktree.input.url, createdWorktree.workspacePath);
        } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      for (const [workspaceRoot, existed] of workspaceRoots) {
        if (existed) continue;
        try { await rmdir(workspaceRoot); }
        catch (rollbackError) {
          if (!(rollbackError && typeof rollbackError === "object" && "code" in rollbackError && rollbackError.code === "ENOENT")) rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length) throw new WorktreeRollbackFailure(new AggregateError([error, ...rollbackErrors], "worktree_rollback_failed"));
      throw error;
    }
  }

  async removeBatch(input: RemoveWorktreeBatchInput): Promise<void> {
    await Promise.all(input.worktrees.map((worktree) => this.assertClean(worktree.url, worktree.workspacePath)));
    const removed: Array<{ worktree: RemoveWorktreeBatchInput["worktrees"][number]; commit: string }> = [];
    try {
      for (const worktree of input.worktrees) {
        try {
          const commit = await this.remove(worktree.url, worktree.workspacePath);
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
        try { await this.restoreLocal({ issueKey: input.issueKey, mode: input.mode, expectedCommit: commit, ...worktree }); }
        catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      if (rollbackErrors.length) throw new WorktreeRollbackFailure(new AggregateError([error, ...rollbackErrors], "worktree_rollback_failed"));
      throw error;
    }
  }

  async prepareShared(input: PrepareSharedCheckoutInput): Promise<PreparedWorktree> {
    this.validateRepositoryInput(input);
    const repositoryKey = repositoryHash(input.url, 20);
    return this.serialized(repositoryKey, () => this.prepareSharedLocked(input, repositoryKey));
  }

  async prepareBranchSnapshot(input: PrepareBranchSnapshotInput): Promise<PreparedWorktree> {
    this.validateRepositoryInput(input);
    if (input.workingBranch.startsWith("-")) throw new Error("invalid_repository_configuration");
    const repositoryKey = repositoryHash(input.url, 20);
    return this.serialized(repositoryKey, () => this.prepareBranchSnapshotLocked(input, repositoryKey));
  }

  private validateRepositoryInput(input: PrepareSharedCheckoutInput): void {
    if (input.url.startsWith("-") || !input.baseBranch.trim() || input.baseBranch.startsWith("-")) throw new Error("invalid_repository_configuration");
  }

  private async serialized<T>(repositoryKey: string, operation: () => Promise<T>): Promise<T> {
    const lockKey = `${this.stateRoot}:${repositoryKey}`;
    const preceding = repositoryTails.get(lockKey) ?? Promise.resolve();
    const queuedOperation = preceding.catch(() => undefined).then(operation);
    repositoryTails.set(lockKey, queuedOperation);
    try { return await queuedOperation; } finally { if (repositoryTails.get(lockKey) === queuedOperation) repositoryTails.delete(lockKey); }
  }

  private async updateCache(input: PrepareSharedCheckoutInput, repositoryKey: string): Promise<string> {
    await mkdir(this.repositoriesRoot, { recursive: true });
    const cachePath = resolve(this.repositoriesRoot, repositoryKey);
    if (!await pathExists(cachePath)) {
      await this.git(["init", "--bare", cachePath]);
      await this.git(["-C", cachePath, "remote", "add", "origin", input.url]);
    }
    await this.git(["-C", cachePath, "fetch", "--prune", "origin", input.baseBranch]);
    return cachePath;
  }

  private async prepareSharedLocked(input: PrepareSharedCheckoutInput, repositoryKey: string): Promise<PreparedWorktree> {
    const cachePath = await this.updateCache(input, repositoryKey);
    const baseCommit = (await this.git(["-C", cachePath, "rev-parse", `origin/${input.baseBranch}`])).trim();
    const workspacePath = await this.prepareCommitCheckout(cachePath, repositoryKey, baseCommit);
    return { cachePath, workspacePath, baseBranch: input.baseBranch, workingBranch: null, baseCommit };
  }

  private async prepareBranchSnapshotLocked(input: PrepareBranchSnapshotInput, repositoryKey: string): Promise<PreparedWorktree> {
    const cachePath = resolve(this.repositoriesRoot, repositoryKey);
    if (!await pathExists(cachePath)) throw new Error("repository_cache_not_found");
    await this.git(["check-ref-format", "--branch", input.workingBranch]);
    const baseCommit = await this.git(["-C", cachePath, "rev-parse", `refs/heads/${input.workingBranch}`])
      .then((value) => value.trim(), () => { throw new Error("working_branch_not_found"); });
    const workspacePath = await this.prepareCommitCheckout(cachePath, repositoryKey, baseCommit);
    return { cachePath, workspacePath, baseBranch: input.baseBranch, workingBranch: input.workingBranch, baseCommit };
  }

  private async prepareCommitCheckout(cachePath: string, repositoryKey: string, commit: string): Promise<string> {
    const checkoutParent = resolve(this.sharedCheckoutsRoot, repositoryKey);
    const workspacePath = resolve(checkoutParent, commit);
    if (dirname(workspacePath) !== checkoutParent) throw new Error("shared_checkout_path_invalid");

    const workspaceExists = await pathExists(workspacePath);
    if (workspaceExists && !await pathExists(resolve(workspacePath, ".git"))) throw new Error("shared_checkout_is_not_git_worktree");
    if (workspaceExists) {
      await this.git(["-C", cachePath, "worktree", "repair", "--relative-paths", workspacePath]);
      const [head, dirty] = await Promise.all([
        this.git(["-C", workspacePath, "rev-parse", "HEAD"]).then((value) => value.trim()),
        execFileAsync("git", ["-C", workspacePath, "status", "--porcelain"], { encoding: "utf8" }).then(({ stdout }) => stdout.trim()),
      ]);
      if (head !== commit || dirty) throw new Error("shared_checkout_changed");
    } else {
      await mkdir(checkoutParent, { recursive: true });
      await this.git(["-C", cachePath, "worktree", "add", "--relative-paths", "--detach", workspacePath, commit]);
    }
    return workspacePath;
  }

  private async restoreLocalLocked(input: RestoreWorktreeInput, issueKey: string, repositoryKey: string): Promise<void> {
    const cachePath = resolve(this.repositoriesRoot, repositoryKey);
    if (!await pathExists(cachePath)) throw new Error("repository_cache_not_found");
    const issueRoot = issueWorkspaceRoot(this.stateRoot, issueKey);
    const workspacePath = this.resolveIssueWorkspacePath(issueRoot, input.workspaceName, input.workspacePath);
    if (await pathExists(workspacePath)) throw new Error("workspace_path_already_exists");
    await this.git(["check-ref-format", "--branch", input.workingBranch]);
    if (!input.workingBranch.startsWith(`${input.mode}-`)) throw new Error("invalid_issue_branch_prefix");
    const commit = (await this.git(["-C", cachePath, "rev-parse", `refs/heads/${input.workingBranch}`])).trim();
    if (commit !== input.expectedCommit) throw new Error("working_branch_changed_during_release");
    await this.git(["-C", cachePath, "worktree", "prune", "--expire", "now"]);
    await mkdir(dirname(workspacePath), { recursive: true });
    await this.git(["-C", cachePath, "worktree", "add", "--relative-paths", workspacePath, input.workingBranch]);
  }

  private async prepareLocked(input: PrepareWorktreeInput, issueKey: string, repositoryKey: string): Promise<PreparedWorktree> {
    await mkdir(this.workspacesRoot, { recursive: true });
    const cachePath = await this.updateCache(input, repositoryKey);

    const issueRoot = issueWorkspaceRoot(this.stateRoot, issueKey);
    const workspacePath = this.resolveIssueWorkspacePath(issueRoot, input.workspaceName, input.existingWorkspacePath);
    const workingBranch = input.workingBranch ?? `${input.mode}-${issueKey.toLowerCase()}`;
    await this.git(["check-ref-format", "--branch", workingBranch]);
    if (!workingBranch.startsWith(`${input.mode}-`)) throw new Error("invalid_issue_branch_prefix");
    const baseRef = `origin/${input.baseBranch}`;
    const upstreamCommit = (await this.git(["-C", cachePath, "rev-parse", baseRef])).trim();
    let baseCommit = input.existingBaseCommit ?? upstreamCommit;

    const workspaceExists = await pathExists(workspacePath);
    if (workspaceExists && !await pathExists(resolve(workspacePath, ".git"))) throw new Error("workspace_is_not_git_worktree");
    if (workspaceExists) {
      await this.git(["-C", cachePath, "worktree", "repair", "--relative-paths", workspacePath]);
      const currentBranch = (await this.git(["-C", workspacePath, "branch", "--show-current"])).trim();
      if (currentBranch !== workingBranch) throw new Error("workspace_branch_does_not_match_issue_policy");
      if (!input.existingBaseCommit) baseCommit = (await this.git(["-C", cachePath, "merge-base", workingBranch, baseRef])).trim();
    } else {
      await mkdir(dirname(workspacePath), { recursive: true });
      const branchExists = await execFileAsync("git", ["-C", cachePath, "show-ref", "--verify", "--quiet", `refs/heads/${workingBranch}`]).then(() => true, () => false);
      await this.git(branchExists
        ? ["-C", cachePath, "worktree", "add", "--relative-paths", workspacePath, workingBranch]
        : ["-C", cachePath, "worktree", "add", "--relative-paths", "-b", workingBranch, workspacePath, baseRef]);
      baseCommit = upstreamCommit;
    }
    const upstream = await execFileAsync("git", ["-C", workspacePath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { encoding: "utf8" }).then(({ stdout }) => stdout.trim(), () => "");
    if (upstream && upstream !== `origin/${workingBranch}`) await this.git(["-C", workspacePath, "branch", "--unset-upstream"]);
    return { cachePath, workspacePath, baseBranch: input.baseBranch, workingBranch, baseCommit };
  }

  private resolveIssueWorkspacePath(issueRoot: string, workspaceName: string, existingWorkspacePath?: string): string {
    const desiredPath = resolve(issueRoot, safePathSegment(workspaceName));
    if (dirname(desiredPath) !== issueRoot) throw new Error("workspace_path_outside_issue_root");
    if (existingWorkspacePath && resolve(existingWorkspacePath) !== desiredPath) throw new Error("workspace_path_does_not_match_repository");
    return desiredPath;
  }

  private async git(args: string[]): Promise<string> {
    const { gitOperationMs, gitOutputBytes } = issuePilotConfig.limits.process;
    const { stdout } = await execFileAsync("git", args, { timeout: gitOperationMs, maxBuffer: gitOutputBytes });
    return stdout;
  }
}
