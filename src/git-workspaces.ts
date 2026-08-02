import { createHash } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface PrepareWorkspaceInput {
  issueId: string;
  repositoryId: string;
  url: string;
  baseBranch: string;
  workingBranch?: string;
}

export interface PreparedWorkspace {
  cachePath: string;
  workspacePath: string;
  baseBranch: string;
  workingBranch: string;
  baseCommit: string;
}

function safeSegment(value: string): string {
  const segment = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!segment) throw new Error(`invalid path segment: ${value}`);
  return segment;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export class GitWorkspaceManager {
  private readonly cacheRoot: string;
  private readonly workspaceRoot: string;
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(stateRoot: string) {
    this.cacheRoot = resolve(stateRoot, "repositories");
    this.workspaceRoot = resolve(stateRoot, "workspaces");
  }

  async prepare(input: PrepareWorkspaceInput): Promise<PreparedWorkspace> {
    if (!/^ISSUE-[0-9]{4,}$/i.test(input.issueId)) throw new Error(`invalid issue ID: ${input.issueId}`);
    if (input.url.startsWith("-")) throw new Error("repository URL must not start with '-'");
    if (!input.baseBranch.trim() || input.baseBranch.startsWith("-")) throw new Error("invalid base branch");

    const repositoryKey = createHash("sha256").update(input.url).digest("hex").slice(0, 20);
    const previous = this.tails.get(repositoryKey) ?? Promise.resolve();
    const current = previous.then(() => this.prepareLocked(input, repositoryKey));
    this.tails.set(repositoryKey, current);
    try {
      return await current;
    } finally {
      if (this.tails.get(repositoryKey) === current) this.tails.delete(repositoryKey);
    }
  }

  private async prepareLocked(input: PrepareWorkspaceInput, repositoryKey: string): Promise<PreparedWorkspace> {
    await mkdir(this.cacheRoot, { recursive: true });
    await mkdir(this.workspaceRoot, { recursive: true });
    const cachePath = resolve(this.cacheRoot, repositoryKey);
    if (!await exists(cachePath)) {
      await this.git(["clone", "--no-checkout", input.url, cachePath]);
    }
    await this.git(["-C", cachePath, "fetch", "--prune", "origin", input.baseBranch]);

    const issueSegment = safeSegment(input.issueId);
    const repositorySegment = safeSegment(input.repositoryId || basename(input.url, ".git"));
    const workspacePath = resolve(this.workspaceRoot, issueSegment, repositorySegment);
    const workingBranch = input.workingBranch ?? `issue/${input.issueId.toUpperCase()}/${repositorySegment}`;
    if (workingBranch.startsWith("-")) throw new Error("invalid working branch");
    const baseRef = `origin/${input.baseBranch}`;
    const baseCommit = (await this.git(["-C", cachePath, "rev-parse", baseRef])).trim();

    if (!await exists(workspacePath)) {
      await mkdir(resolve(workspacePath, ".."), { recursive: true });
      const branchExists = (await execFileAsync("git", ["-C", cachePath, "show-ref", "--verify", "--quiet", `refs/heads/${workingBranch}`]).then(
        () => true,
        () => false,
      ));
      if (branchExists) await this.git(["-C", cachePath, "worktree", "add", workspacePath, workingBranch]);
      else await this.git(["-C", cachePath, "worktree", "add", "-b", workingBranch, workspacePath, baseRef]);
    }

    return { cachePath, workspacePath, baseBranch: input.baseBranch, workingBranch, baseCommit };
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
    return stdout;
  }
}
