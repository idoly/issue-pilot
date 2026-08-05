import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { Worktrees } from "../../src/workspace/git.ts";

const execFileAsync = promisify(execFile);

async function git(args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { encoding: "utf8" })).stdout.trim();
}

test("uses detached latest baselines for read-only environments and prefixed development branches", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-git-"));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  try {
    await git(["init", "-b", "main", source]);
    await writeFile(join(source, "README.md"), "first\n", "utf8");
    await git(["-C", source, "add", "."]);
    await git(["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "first"]);
    await git(["clone", "--bare", source, remote]);
    await git(["-C", source, "remote", "add", "origin", remote]);

    const worktrees = new Worktrees(join(root, "state"));
    const readonly = await worktrees.prepare({ issueId: "ISSUE-20260805-010", repositoryId: "repository", url: remote, baseBranch: "main", mode: "detached" });
    assert.equal(readonly.workingBranch, null);
    assert.equal(await git(["-C", readonly.workspacePath, "branch", "--show-current"]), "");
    const firstCommit = await git(["-C", readonly.workspacePath, "rev-parse", "HEAD"]);

    await writeFile(join(source, "README.md"), "second\n", "utf8");
    await git(["-C", source, "add", "."]);
    await git(["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "second"]);
    await git(["-C", source, "push", "origin", "main"]);
    const refreshed = await worktrees.prepare({ issueId: "ISSUE-20260805-010", repositoryId: "repository", url: remote, baseBranch: "main", mode: "detached", existingWorkspacePath: readonly.workspacePath });
    assert.notEqual(refreshed.baseCommit, firstCommit);
    assert.equal(await git(["-C", refreshed.workspacePath, "rev-parse", "HEAD"]), refreshed.baseCommit);

    const hotfix = await worktrees.prepare({ issueId: "ISSUE-20260805-011", repositoryId: "repository", url: remote, baseBranch: "main", mode: "hotfix" });
    assert.equal(hotfix.workingBranch, "hotfix/issue-20260805-011");
    assert.equal(await git(["-C", hotfix.workspacePath, "branch", "--show-current"]), hotfix.workingBranch);
    const feature = await worktrees.prepare({ issueId: "ISSUE-20260805-012", repositoryId: "repository", url: remote, baseBranch: "main", mode: "feature" });
    assert.equal(feature.workingBranch, "feature/issue-20260805-012");
    assert.equal(await git(["-C", feature.workspacePath, "branch", "--show-current"]), feature.workingBranch);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
