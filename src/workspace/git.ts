import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { normalizeIssueKey } from "../domain/issue-key.ts";
import { issueWorkspaceRoot, workspacesRoot } from "./paths.ts";

const execFileAsync = promisify(execFile);

export interface PrepareWorktreeInput {
  issueId: string;
  repositoryId: string;
  url: string;
  baseBranch: string;
  mode: "detached" | "hotfix" | "feature";
  workingBranch?: string;
  existingWorkspacePath?: string;
  existingBaseCommit?: string;
}

export interface PreparedWorktree {
  cachePath: string;
  workspacePath: string;
  baseBranch: string;
  workingBranch: string | null;
  baseCommit: string;
}

async function exists(candidate: string): Promise<boolean> {
  try { await access(candidate); return true; } catch { return false; }
}

function segment(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) throw new Error("invalid_workspace_segment");
  return safe;
}

export class Worktrees {
  private readonly stateRoot: string;
  private readonly repositoriesRoot: string;
  private readonly workspacesRoot: string;
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(stateRoot: string) {
    this.stateRoot = resolve(stateRoot);
    this.repositoriesRoot = resolve(this.stateRoot, "repositories");
    this.workspacesRoot = workspacesRoot(this.stateRoot);
  }

  async prepare(input: PrepareWorktreeInput): Promise<PreparedWorktree> {
    const issueKey = normalizeIssueKey(input.issueId);
    if (input.url.startsWith("-") || !input.baseBranch.trim() || input.baseBranch.startsWith("-")) throw new Error("invalid_repository_configuration");
    const repositoryKey = createHash("sha256").update(input.url).digest("hex").slice(0, 20);
    const previous = this.tails.get(repositoryKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.prepareLocked(input, issueKey, repositoryKey));
    this.tails.set(repositoryKey, current);
    try { return await current; } finally { if (this.tails.get(repositoryKey) === current) this.tails.delete(repositoryKey); }
  }

  private async prepareLocked(input: PrepareWorktreeInput, issueKey: string, repositoryKey: string): Promise<PreparedWorktree> {
    await Promise.all([mkdir(this.repositoriesRoot, { recursive: true }), mkdir(this.workspacesRoot, { recursive: true })]);
    const cachePath = resolve(this.repositoriesRoot, repositoryKey);
    if (!await exists(cachePath)) {
      await this.git(["init", "--bare", cachePath]);
      await this.git(["-C", cachePath, "remote", "add", "origin", input.url]);
    }
    await this.git(["-C", cachePath, "fetch", "--prune", "origin", input.baseBranch]);

    const issueRoot = issueWorkspaceRoot(this.stateRoot, issueKey);
    const workspacePath = input.existingWorkspacePath ? resolve(input.existingWorkspacePath) : resolve(issueRoot, segment(input.repositoryId || basename(input.url, ".git")));
    if (dirname(workspacePath) !== issueRoot) throw new Error("workspace_path_outside_issue_root");
    const workingBranch = input.mode === "detached" ? null : input.workingBranch ?? `${input.mode}-${issueKey.toLowerCase()}`;
    if (workingBranch) {
      await this.git(["check-ref-format", "--branch", workingBranch]);
      if (!workingBranch.startsWith(`${input.mode}-`)) throw new Error("invalid_issue_branch_prefix");
    }
    const baseRef = `origin/${input.baseBranch}`;
    const upstreamCommit = (await this.git(["-C", cachePath, "rev-parse", baseRef])).trim();
    let baseCommit = input.mode === "detached" ? upstreamCommit : input.existingBaseCommit ?? upstreamCommit;

    const workspaceExists = await exists(workspacePath);
    if (workspaceExists && !await exists(resolve(workspacePath, ".git"))) throw new Error("workspace_is_not_git_worktree");
    if (workspaceExists) await this.git(["-C", cachePath, "worktree", "repair", "--relative-paths", workspacePath]);
    if (workspaceExists && input.mode === "detached") {
      const dirty = await execFileAsync("git", ["-C", workspacePath, "status", "--porcelain"], { encoding: "utf8" }).then(({ stdout }) => stdout.trim());
      if (dirty) throw new Error("readonly_workspace_has_changes");
      await this.git(["-C", workspacePath, "checkout", "--detach", baseRef]);
    } else if (workspaceExists && workingBranch) {
      const currentBranch = (await this.git(["-C", workspacePath, "branch", "--show-current"])).trim();
      if (currentBranch !== workingBranch) throw new Error("workspace_branch_does_not_match_issue_policy");
      if (!input.existingBaseCommit) baseCommit = (await this.git(["-C", cachePath, "merge-base", workingBranch, baseRef])).trim();
    } else {
      await mkdir(dirname(workspacePath), { recursive: true });
      if (!workingBranch) await this.git(["-C", cachePath, "worktree", "add", "--relative-paths", "--detach", workspacePath, baseRef]);
      else {
        const branchExists = await execFileAsync("git", ["-C", cachePath, "show-ref", "--verify", "--quiet", `refs/heads/${workingBranch}`]).then(() => true, () => false);
        await this.git(branchExists
          ? ["-C", cachePath, "worktree", "add", "--relative-paths", workspacePath, workingBranch]
          : ["-C", cachePath, "worktree", "add", "--relative-paths", "-b", workingBranch, workspacePath, baseRef]);
      }
      baseCommit = upstreamCommit;
    }
    if (workingBranch) {
      const upstream = await execFileAsync("git", ["-C", workspacePath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { encoding: "utf8" }).then(({ stdout }) => stdout.trim(), () => "");
      if (upstream && upstream !== `origin/${workingBranch}`) await this.git(["-C", workspacePath, "branch", "--unset-upstream"]);
    }
    return { cachePath, workspacePath, baseBranch: input.baseBranch, workingBranch, baseCommit };
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
    return stdout;
  }
}
