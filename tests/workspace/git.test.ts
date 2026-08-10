import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { repositoryWorkspaceNames, WorktreeManager } from "../../src/workspace/git.ts";
import { sharedCheckoutsRoot } from "../../src/workspace/state.ts";

const execFileAsync = promisify(execFile);

async function git(args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { encoding: "utf8" })).stdout.trim();
}

test("uses readable repository names and stable suffixes for basename collisions", () => {
  const urls = [
    "git@gitlab.example.test:team-a/srm-server.git",
    "https://gitlab.example.test/team-b/srm-server.git",
    "https://gitlab.example.test/team/srm-admin-front.git",
  ];
  const names = repositoryWorkspaceNames(urls);
  assert.match(names.get(urls[0]!)!, /^srm-server-[a-f0-9]{8}$/);
  assert.match(names.get(urls[1]!)!, /^srm-server-[a-f0-9]{8}$/);
  assert.notEqual(names.get(urls[0]!), names.get(urls[1]!));
  assert.equal(names.get(urls[2]!), "srm-admin-front");
});

test("shares immutable latest baselines for read-only environments and creates prefixed dev branches", async () => {
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

    const stateRoot = join(root, "state");
    const worktreeManager = new WorktreeManager(stateRoot);
    const readonly = await worktreeManager.prepareShared({ url: remote, baseBranch: "main" });
    assert.equal(await git(["-C", readonly.cachePath, "rev-parse", "--is-bare-repository"]), "true");
    assert.equal(readonly.workingBranch, null);
    assert.equal(await git(["-C", readonly.workspacePath, "branch", "--show-current"]), "");
    assert.equal(relative(sharedCheckoutsRoot(stateRoot), readonly.workspacePath).startsWith(".."), false);
    await assert.rejects(access(join(stateRoot, "workspaces", "issue-20260805-010")));
    const firstCommit = await git(["-C", readonly.workspacePath, "rev-parse", "HEAD"]);

    await writeFile(join(source, "README.md"), "second\n", "utf8");
    await git(["-C", source, "add", "."]);
    await git(["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "second"]);
    await git(["-C", source, "push", "origin", "main"]);
    const refreshed = await worktreeManager.prepareShared({ url: remote, baseBranch: "main" });
    assert.notEqual(refreshed.baseCommit, firstCommit);
    assert.notEqual(refreshed.workspacePath, readonly.workspacePath);
    assert.equal(await git(["-C", readonly.workspacePath, "rev-parse", "HEAD"]), firstCommit);
    assert.equal(await git(["-C", refreshed.workspacePath, "rev-parse", "HEAD"]), refreshed.baseCommit);
    assert.equal((await worktreeManager.prepareShared({ url: remote, baseBranch: "main" })).workspacePath, refreshed.workspacePath);

    const hotfix = await worktreeManager.prepare({ issueKey: "ISSUE-20260805-011", workspaceName: "remote", url: remote, baseBranch: "main", mode: "hotfix" });
    assert.equal(hotfix.workingBranch, "hotfix-issue-20260805-011");
    assert.equal(await git(["-C", hotfix.workspacePath, "branch", "--show-current"]), hotfix.workingBranch);
    await assert.rejects(git(["-C", hotfix.workspacePath, "rev-parse", "@{upstream}"]));
    assert.doesNotMatch(await readFile(join(hotfix.workspacePath, ".git"), "utf8"), new RegExp(root));
    assert.doesNotMatch(await readFile(join(hotfix.cachePath, "worktrees", basename(hotfix.workspacePath), "gitdir"), "utf8"), new RegExp(root));
    const feature = await worktreeManager.prepare({ issueKey: "ISSUE-20260805-012", workspaceName: "remote", url: remote, baseBranch: "main", mode: "feature" });
    assert.equal(feature.workingBranch, "feature-issue-20260805-012");
    assert.equal(await git(["-C", feature.workspacePath, "branch", "--show-current"]), feature.workingBranch);

    const previous = await worktreeManager.prepare({ issueKey: "ISSUE-20260805-013", workspaceName: "e8291771-d16d-4161-a70f-2e6c04f4dc45", url: remote, baseBranch: "main", mode: "hotfix" });
    await writeFile(join(previous.workspacePath, "uncommitted.txt"), "preserved\n", "utf8");
    const renamed = await worktreeManager.prepare({ issueKey: "ISSUE-20260805-013", workspaceName: "srm-server", url: remote, baseBranch: "main", mode: "hotfix", existingWorkspacePath: previous.workspacePath });
    assert.equal(basename(renamed.workspacePath), "srm-server");
    await assert.rejects(access(previous.workspacePath));
    assert.match(await git(["-C", renamed.workspacePath, "status", "--porcelain"]), /uncommitted\.txt/);
    assert.equal(await git(["-C", renamed.workspacePath, "branch", "--show-current"]), "hotfix-issue-20260805-013");
    await assert.rejects(worktreeManager.remove(remote, renamed.workspacePath), /workspace_has_changes/);
    await unlink(join(renamed.workspacePath, "uncommitted.txt"));
    await worktreeManager.remove(remote, renamed.workspacePath);
    await assert.rejects(access(renamed.workspacePath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
