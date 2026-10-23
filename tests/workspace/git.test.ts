import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { issueRepositoryWorkspaceNames, repositoryWorkspaceNames, WorktreeManager, WorktreeRemovalFailure } from "../../src/workspace/git.ts";
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

test("preserves persisted issue repository workspace names", () => {
  const active = issueRepositoryWorkspaceNames([
    { url: "https://example.test/team/orders.git", localPath: "/state/workspaces/issue-20260805-001/orders", workspaceName: null },
  ]);
  assert.equal(active.get("https://example.test/team/orders.git"), "orders");

  const snapshotUrls = ["https://example.test/team-a/orders.git", "https://example.test/team-b/orders.git"];
  const snapshot = issueRepositoryWorkspaceNames(snapshotUrls.map((url) => ({ url, localPath: null, workspaceName: null })));
  assert.deepEqual(snapshot, repositoryWorkspaceNames(snapshotUrls));
  assert.throws(() => issueRepositoryWorkspaceNames([
    { url: snapshotUrls[0]!, localPath: "/state/workspaces/issue-20260805-001/orders", workspaceName: "other" },
  ]), /workspace_path_does_not_match_repository/);
  assert.throws(() => repositoryWorkspaceNames(snapshotUrls, new Map(snapshotUrls.map((url) => [url, "orders"] as const))), /repository_workspace_name_conflict/);
});

test("serializes repository operations across manager instances sharing one state root", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-git-lock-"));
  try {
    const managers = [new WorktreeManager(root), new WorktreeManager(root)];
    let active = 0;
    let maximumActive = 0;
    for (const manager of managers) {
      const internal = manager as unknown as { git(args: string[]): Promise<string> };
      internal.git = async (args) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return args.includes("rev-parse") ? "a".repeat(40) : "";
      };
    }
    const url = "https://example.test/team/orders.git";
    await Promise.all(managers.map((manager) => manager.prepareShared({ url, baseBranch: "main" })));
    assert.equal(maximumActive, 1);

    active = 0;
    maximumActive = 0;
    const cleanPath = join(root, "workspaces", "issue-20260805-001", "orders");
    await mkdir(cleanPath, { recursive: true });
    await Promise.all([
      managers[0]!.prepareShared({ url, baseBranch: "main" }),
      managers[1]!.assertClean(url, cleanPath),
    ]);
    assert.equal(maximumActive, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const detached of [false, true]) test(`refuses batch removal when a clean worktree ${detached ? "is detached" : "has changed branches"}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-release-drift-"));
  try {
    const source = join(root, "source"), remote = join(root, "remote.git");
    await git(["init", "-b", "main", source]);
    await git(["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "initial"]);
    await git(["clone", "--bare", source, remote]);
    const manager = new WorktreeManager(join(root, "state"));
    const issueKey = "ISSUE-20261018-996";
    const first = await manager.prepare({ issueKey, workspaceName: "first", url: remote, baseBranch: "main", mode: "hotfix" });
    // A second repository gives the same Issue a separate worktree and ref.
    const otherRemote = join(root, "other.git");
    await git(["clone", "--bare", source, otherRemote]);
    const second = await manager.prepare({ issueKey, workspaceName: "second", url: otherRemote, baseBranch: "main", mode: "hotfix" });
    await git(["-C", second.workspacePath, ...(detached ? ["checkout", "--detach"] : ["switch", "-c", "manual-branch"])]);
    let finalized = false;
    await assert.rejects(manager.removeBatch({ issueKey, mode: "hotfix", worktrees: [first, second].map((worktree, index) => ({ workspaceName: index ? "second" : "first", url: index ? otherRemote : remote, workingBranch: worktree.workingBranch!, workspacePath: worktree.workspacePath })), finalize: async () => { finalized = true; } }), /workspace_branch_does_not_match_issue_policy/);
    assert.equal(finalized, false);
    await access(first.workspacePath); await access(second.workspacePath);
    assert.equal(await git(["-C", first.workspacePath, "branch", "--show-current"]), first.workingBranch);
    assert.equal(await git(["-C", second.workspacePath, "branch", "--show-current"]), detached ? "" : "manual-branch");
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const missingBranch of [false, true]) test(`restores recorded development branches ${missingBranch ? "without replacing a missing ref" : "without contacting the remote"}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-local-restore-"));
  try {
    const source = join(root, "source"), remote = join(root, "remote.git");
    await git(["init", "-b", "main", source]);
    await writeFile(join(source, "README.md"), "initial\n");
    await git(["-C", source, "add", "."]);
    await git(["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "initial"]);
    await git(["clone", "--bare", source, remote]);
    const manager = new WorktreeManager(join(root, "state"));
    const input = { issueKey: "ISSUE-20261018-997", workspaceName: "local", url: remote, baseBranch: "main", mode: "hotfix" as const };
    const prepared = await manager.prepare(input);
    await writeFile(join(prepared.workspacePath, "local.txt"), "local commit\n");
    await git(["-C", prepared.workspacePath, "add", "."]);
    await git(["-C", prepared.workspacePath, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "local change"]);
    const expected = await manager.remove(remote, prepared.workspacePath);
    const restore = { ...input, workingBranch: prepared.workingBranch!, existingBaseCommit: prepared.baseCommit };
    if (missingBranch) {
      await git(["-C", prepared.cachePath, "update-ref", "-d", `refs/heads/${prepared.workingBranch}`]);
      await assert.rejects(manager.prepare(restore), /working_branch_not_found/);
      await assert.rejects(manager.prepareBranchSnapshot({ issueKey: input.issueKey, url: remote, baseBranch: "main", workingBranch: prepared.workingBranch! }), /working_branch_not_found/);
      await assert.rejects(access(prepared.workspacePath));
      await assert.rejects(git(["-C", prepared.cachePath, "show-ref", "--verify", `refs/heads/${prepared.workingBranch}`]));
    } else {
      await rm(remote, { recursive: true, force: true });
      await git(["-C", prepared.cachePath, "update-ref", "-d", "refs/remotes/origin/main"]);
      const restored = await manager.prepare(restore);
      assert.equal(await git(["-C", restored.workspacePath, "rev-parse", "HEAD"]), expected);
      assert.equal(restored.baseCommit, prepared.baseCommit);
      assert.equal(await readFile(join(restored.workspacePath, "local.txt"), "utf8"), "local commit\n");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const malformed of [true, false]) test(`does not disguise ${malformed ? "a malformed ref" : "a ref to a missing object"} as a missing branch during restore or snapshot preparation`, async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-corrupt-ref-"));
  try {
    const source = join(root, "source"), remote = join(root, "remote.git");
    await git(["init", "-b", "main", source]);
    await git(["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "initial"]);
    await git(["clone", "--bare", source, remote]);
    const manager = new WorktreeManager(join(root, "state"));
    const input = { issueKey: "ISSUE-20261018-992", workspaceName: "application", url: remote, baseBranch: "main", mode: "hotfix" as const };
    const prepared = await manager.prepare(input);
    await manager.remove(remote, prepared.workspacePath, prepared.workingBranch!);
    const ref = join(prepared.cachePath, "refs", "heads", prepared.workingBranch!);
    const evidence = malformed ? "invalid-ref-evidence\n" : `${"a".repeat(40)}\n`;
    await writeFile(ref, evidence);
    for (const operation of [
      () => manager.prepare({ ...input, workingBranch: prepared.workingBranch!, existingBaseCommit: prepared.baseCommit }),
      () => manager.prepareBranchSnapshot({ issueKey: input.issueKey, url: remote, baseBranch: "main", workingBranch: prepared.workingBranch! }),
    ]) {
      await assert.rejects(operation(), error => error instanceof Error && error.message !== "working_branch_not_found" && "code" in error && error.code === (malformed ? 1 : 128));
      assert.equal(await readFile(ref, "utf8"), evidence);
      await assert.rejects(access(prepared.workspacePath));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuses to reuse a shared checkout containing ignored files and preserves the evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-shared-ignored-"));
  try {
    const source = join(root, "source"), remote = join(root, "remote.git");
    await git(["init", "-b", "main", source]);
    await writeFile(join(source, ".gitignore"), "private-cache/\n");
    await git(["-C", source, "add", "."]);
    await git(["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "baseline"]);
    await git(["clone", "--bare", source, remote]);
    const manager = new WorktreeManager(join(root, "state"));
    const prepared = await manager.prepareShared({ url: remote, baseBranch: "main" });
    const evidence = join(prepared.workspacePath, "private-cache", "evidence.txt");
    await mkdir(join(prepared.workspacePath, "private-cache"));
    await writeFile(evidence, "preserve ignored evidence\n");
    assert.equal(await git(["-C", prepared.workspacePath, "status", "--porcelain"]), "");
    await assert.rejects(manager.prepareShared({ url: remote, baseBranch: "main" }), /shared_checkout_changed/);
    assert.equal(await readFile(evidence, "utf8"), "preserve ignored evidence\n");
    assert.equal(await git(["-C", prepared.workspacePath, "rev-parse", "HEAD"]), prepared.baseCommit);
    await rm(join(prepared.workspacePath, "private-cache"), { recursive: true });
    assert.equal((await manager.prepareShared({ url: remote, baseBranch: "main" })).workspacePath, prepared.workspacePath);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const development of [false, true]) test(`uses the configured remote branch despite a shadowing tag for ${development ? "development" : "read-only"} preparation`, async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-git-ref-shadow-"));
  try {
    const source = join(root, "source"), remote = join(root, "remote.git");
    await git(["init", "-b", "main", source]);
    await writeFile(join(source, "value.txt"), "old baseline\n");
    await git(["-C", source, "add", "."]);
    await git(["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "old"]);
    const old = await git(["-C", source, "rev-parse", "HEAD"]);
    await git(["clone", "--bare", source, remote]);
    const manager = new WorktreeManager(join(root, "state"));
    const initial = await manager.prepareShared({ url: remote, baseBranch: "main" });
    // Tags can arrive during ordinary fetches and Git resolves them before remote shorthand.
    await git(["-C", initial.cachePath, "tag", "origin/main", old]);
    await writeFile(join(source, "value.txt"), "current baseline\n");
    await git(["-C", source, "add", "."]);
    await git(["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "current"]);
    await git(["-C", source, "push", remote, "main"]);
    const expected = await git(["-C", source, "rev-parse", "HEAD"]);
    const prepared = development
      ? await manager.prepare({ issueKey: "ISSUE-20261018-993", workspaceName: "application", url: remote, baseBranch: "main", mode: "hotfix" })
      : await manager.prepareShared({ url: remote, baseBranch: "main" });
    assert.equal(prepared.baseCommit, expected);
    assert.equal(await git(["-C", prepared.workspacePath, "rev-parse", "HEAD"]), expected);
    assert.equal(await readFile(join(prepared.workspacePath, "value.txt"), "utf8"), "current baseline\n");
    assert.equal(await git(["-C", initial.cachePath, "rev-parse", "refs/tags/origin/main"]), old);
  } finally { await rm(root, { recursive: true, force: true }); }
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
    await assert.rejects(git(["--git-dir", remote, "rev-parse", `refs/heads/${hotfix.workingBranch}`]));
    const unchangedSnapshot = await worktreeManager.prepareBranchSnapshot({ issueKey: "ISSUE-20260805-011", url: remote, baseBranch: "main", workingBranch: hotfix.workingBranch! });
    assert.equal(unchangedSnapshot.workspacePath, refreshed.workspacePath);
    await writeFile(join(hotfix.workspacePath, "branch.txt"), "branch snapshot\n", "utf8");
    await git(["-C", hotfix.workspacePath, "add", "."]);
    await git(["-C", hotfix.workspacePath, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "branch snapshot"]);
    const changedSnapshot = await worktreeManager.prepareBranchSnapshot({ issueKey: "ISSUE-20260805-011", url: remote, baseBranch: "main", workingBranch: hotfix.workingBranch! });
    assert.equal(await git(["-C", changedSnapshot.workspacePath, "rev-parse", "HEAD"]), await git(["-C", hotfix.workspacePath, "rev-parse", "HEAD"]));
    assert.equal(await readFile(join(changedSnapshot.workspacePath, "branch.txt"), "utf8"), "branch snapshot\n");
    assert.doesNotMatch(await readFile(join(hotfix.workspacePath, ".git"), "utf8"), new RegExp(root));
    assert.doesNotMatch(await readFile(join(hotfix.cachePath, "worktrees", basename(hotfix.workspacePath), "gitdir"), "utf8"), new RegExp(root));
    const feature = await worktreeManager.prepare({ issueKey: "ISSUE-20260805-012", workspaceName: "remote", url: remote, baseBranch: "main", mode: "feature" });
    assert.equal(feature.workingBranch, "feature-issue-20260805-012");
    assert.equal(await git(["-C", feature.workspacePath, "branch", "--show-current"]), feature.workingBranch);

    const unexpected = await worktreeManager.prepare({ issueKey: "ISSUE-20260805-013", workspaceName: "unexpected-name", url: remote, baseBranch: "main", mode: "hotfix" });
    await writeFile(join(unexpected.workspacePath, "uncommitted.txt"), "preserved\n", "utf8");
    await assert.rejects(
      worktreeManager.prepare({ issueKey: "ISSUE-20260805-013", workspaceName: "srm-server", url: remote, baseBranch: "main", mode: "hotfix", existingWorkspacePath: unexpected.workspacePath }),
      /workspace_path_does_not_match_repository/,
    );
    assert.match(await git(["-C", unexpected.workspacePath, "status", "--porcelain"]), /uncommitted\.txt/);
    assert.equal(await git(["-C", unexpected.workspacePath, "branch", "--show-current"]), "hotfix-issue-20260805-013");
    await assert.rejects(worktreeManager.remove(remote, unexpected.workspacePath), /workspace_has_changes/);
    await unlink(join(unexpected.workspacePath, "uncommitted.txt"));
    const unexpectedCommit = await git(["-C", unexpected.workspacePath, "rev-parse", "HEAD"]);
    assert.equal(await worktreeManager.remove(remote, unexpected.workspacePath), unexpectedCommit);
    await assert.rejects(access(unexpected.workspacePath));
    await assert.rejects(worktreeManager.restoreLocal({
      issueKey: "ISSUE-20260805-013",
      workspaceName: "unexpected-name",
      url: remote,
      mode: "hotfix",
      workingBranch: unexpected.workingBranch!,
      expectedCommit: "0".repeat(40),
      workspacePath: unexpected.workspacePath,
    }), /working_branch_changed_during_release/);
    await worktreeManager.restoreLocal({
      issueKey: "ISSUE-20260805-013",
      workspaceName: "unexpected-name",
      url: remote,
      mode: "hotfix",
      workingBranch: unexpected.workingBranch!,
      expectedCommit: unexpectedCommit,
      workspacePath: unexpected.workspacePath,
    });
    assert.equal(await git(["-C", unexpected.workspacePath, "branch", "--show-current"]), unexpected.workingBranch);

    const internal = worktreeManager as unknown as { git(args: string[]): Promise<string> };
    const runGit = internal.git.bind(worktreeManager);
    let simulatedRemoveFailure = false;
    internal.git = async (args) => {
      if (!simulatedRemoveFailure && args.includes("worktree") && args.includes("remove")) {
        simulatedRemoveFailure = true;
        await rm(unexpected.workspacePath, { recursive: true, force: true });
        throw new Error("simulated_remove_failure");
      }
      return runGit(args);
    };
    assert.equal(await worktreeManager.remove(remote, unexpected.workspacePath), unexpectedCommit);
    internal.git = runGit;
    await assert.rejects(access(unexpected.workspacePath));
    await worktreeManager.restoreLocal({
      issueKey: "ISSUE-20260805-013",
      workspaceName: "unexpected-name",
      url: remote,
      mode: "hotfix",
      workingBranch: unexpected.workingBranch!,
      expectedCommit: unexpectedCommit,
      workspacePath: unexpected.workspacePath,
    });
    assert.equal(await git(["-C", unexpected.workspacePath, "rev-parse", "HEAD"]), unexpectedCommit);

    let failPrune = false;
    internal.git = async (args) => {
      if (args.includes("worktree") && args.includes("remove")) {
        await rm(unexpected.workspacePath, { recursive: true, force: true });
        failPrune = true;
        throw new Error("simulated_remove_failure");
      }
      if (failPrune && args.includes("worktree") && args.includes("prune")) throw new Error("simulated_prune_failure");
      return runGit(args);
    };
    await assert.rejects(worktreeManager.remove(remote, unexpected.workspacePath), (error: unknown) => error instanceof WorktreeRemovalFailure && error.commit === unexpectedCommit);
    internal.git = runGit;
    await worktreeManager.restoreLocal({
      issueKey: "ISSUE-20260805-013",
      workspaceName: "unexpected-name",
      url: remote,
      mode: "hotfix",
      workingBranch: unexpected.workingBranch!,
      expectedCommit: unexpectedCommit,
      workspacePath: unexpected.workspacePath,
    });
    assert.equal(await git(["-C", unexpected.workspacePath, "rev-parse", "HEAD"]), unexpectedCommit);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
