import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";

import { normalizeIssueKey } from "../shared/issue-key.ts";

const execFileAsync = promisify(execFile);

export interface PrepareWorktreeInput {
  issueId: string;
  repositoryId: string;
  url: string;
  baseBranch: string;
  workingBranch?: string;
  existingWorkspacePath?: string;
  existingBaseCommit?: string;
}

export interface PreparedWorktree {
  cachePath: string;
  workspacePath: string;
  baseBranch: string;
  workingBranch: string;
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
  private readonly repositoriesRoot: string;
  private readonly workspacesRoot: string;
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(stateRoot: string) {
    this.repositoriesRoot = resolve(stateRoot, "repositories");
    this.workspacesRoot = resolve(stateRoot, "workspaces");
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
    if (!await exists(cachePath)) await this.git(["clone", "--no-checkout", input.url, cachePath]);
    await this.git(["-C", cachePath, "fetch", "--prune", "origin", input.baseBranch]);

    const issueRoot = resolve(this.workspacesRoot, issueKey.toLowerCase());
    const workspacePath = input.existingWorkspacePath ? resolve(input.existingWorkspacePath) : resolve(issueRoot, segment(input.repositoryId || basename(input.url, ".git")));
    if (dirname(workspacePath) !== issueRoot) throw new Error("workspace_path_outside_issue_root");
    const workingBranch = input.workingBranch ?? issueKey;
    await this.git(["check-ref-format", "--branch", workingBranch]);
    const baseRef = `origin/${input.baseBranch}`;
    const upstreamCommit = (await this.git(["-C", cachePath, "rev-parse", baseRef])).trim();
    let baseCommit = input.existingBaseCommit ?? upstreamCommit;

    if (await exists(workspacePath) && !await exists(resolve(workspacePath, ".git"))) throw new Error("workspace_is_not_git_worktree");
    if (await exists(workspacePath) && !input.existingBaseCommit) baseCommit = (await this.git(["-C", cachePath, "merge-base", workingBranch, baseRef])).trim();
    if (!await exists(workspacePath)) {
      await mkdir(dirname(workspacePath), { recursive: true });
      const branchExists = await execFileAsync("git", ["-C", cachePath, "show-ref", "--verify", "--quiet", `refs/heads/${workingBranch}`]).then(() => true, () => false);
      await this.git(branchExists
        ? ["-C", cachePath, "worktree", "add", workspacePath, workingBranch]
        : ["-C", cachePath, "worktree", "add", "-b", workingBranch, workspacePath, baseRef]);
      baseCommit = upstreamCommit;
    }
    return { cachePath, workspacePath, baseBranch: input.baseBranch, workingBranch, baseCommit };
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
    return stdout;
  }
}
