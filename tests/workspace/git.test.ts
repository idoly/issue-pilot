import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  issueRepositoryStorePath,
  issueRepositoryWorkspaceNames,
  repositoryStorePath,
  repositoryWorkspaceNames,
  retainedSnapshotRef,
  SharedCheckoutLease,
  WorktreeManager,
  WorktreeRemovalFailure,
} from "../../src/workspace/git.ts";
import { sharedCheckoutsRoot } from "../../src/workspace/state.ts";

const execFileAsync = promisify(execFile);

async function git(args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { encoding: "utf8" })).stdout.trim();
}

test("missing private Git never falls back to an older shared branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-git-missing-private-"));
  try {
    const source = join(root, "source"),
      state = join(root, "state");
    await git(["init", "-b", "main", source]);
    const commit = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m"];
    await git(["-C", source, ...commit, "initial"]);
    const manager = new WorktreeManager(state);
    const input = { issueKey: "ISSUE-20261024-900", workspaceName: "repo", url: source, baseBranch: "main", mode: "hotfix" as const };
    const own = await manager.prepare(input);
    await git(["-C", own.workspacePath, ...commit, "private change"]);
    const workingBranch = own.workingBranch!;
    const privateTip = await git(["-C", own.cachePath, "show-ref", "--hash", `refs/heads/${workingBranch}`]);
    assert.notEqual(privateTip, own.baseCommit);
    await rename(own.cachePath, join(root, "preserved-private"));
    await assert.rejects(manager.recordBranchSnapshot({ ...input, workingBranch }), /workspace_git_store_missing/);
    await assert.rejects(manager.prepare({ ...input, workingBranch, existingBaseCommit: own.baseCommit }), /workspace_git_store_missing/);
    await assert.rejects(manager.remove(source, own.workspacePath, workingBranch), /workspace_git_store_missing/);
    assert.equal(await git(["-C", repositoryStorePath(state, source), "show-ref", "--hash", `refs/heads/${workingBranch}`]), own.baseCommit);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses readable repository names and stable suffixes for basename collisions", () => {
  const urls = ["git@gitlab.example.test:team-a/srm-server.git", "https://gitlab.example.test/team-b/srm-server.git", "https://gitlab.example.test/team/srm-admin-front.git"];
  const names = repositoryWorkspaceNames(urls);
  assert.match(names.get(urls[0]!)!, /^srm-server-[a-f0-9]{8}$/);
  assert.match(names.get(urls[1]!)!, /^srm-server-[a-f0-9]{8}$/);
  assert.notEqual(names.get(urls[0]!), names.get(urls[1]!));
  assert.equal(names.get(urls[2]!), "srm-admin-front");
});

test("worktree removal preserves ignored files until they are explicitly removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-ignored-worktree-"));
  try {
    const source = join(root, "source"),
      remote = join(root, "remote.git");
    await git(["init", "-b", "main", source]);
    await writeFile(join(source, ".gitignore"), "local-report.txt\nscratch/\n");
    await git(["-C", source, "add", ".gitignore"]);
    await git(["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "baseline"]);
    await git(["clone", "--bare", source, remote]);
    const manager = new WorktreeManager(join(root, "state"));
    const prepared = await manager.prepare({ issueKey: "ISSUE-20261024-901", workspaceName: "repo", url: remote, baseBranch: "main", mode: "hotfix" });
    assert.ok(prepared.workingBranch);
    const branch = prepared.workingBranch;
    await writeFile(join(prepared.workspacePath, "local-report.txt"), "preserve ignored report");
    await mkdir(join(prepared.workspacePath, "scratch"));
    await writeFile(join(prepared.workspacePath, "scratch", "checkpoint.json"), '{"completed":42}');
    assert.equal(await git(["-C", prepared.workspacePath, "status", "--porcelain"]), "");
    await assert.rejects(manager.remove(remote, prepared.workspacePath, branch), /workspace_has_changes/);
    assert.equal(await readFile(join(prepared.workspacePath, "local-report.txt"), "utf8"), "preserve ignored report");
    assert.equal(await readFile(join(prepared.workspacePath, "scratch", "checkpoint.json"), "utf8"), '{"completed":42}');
    await rm(join(prepared.workspacePath, "local-report.txt"));
    await rm(join(prepared.workspacePath, "scratch"), { recursive: true });
    await manager.remove(remote, prepared.workspacePath, branch);
    await assert.rejects(access(prepared.workspacePath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worktree removal preserves changes hidden by Git index flags", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-hidden-worktree-changes-"));
  try {
    const source = join(root, "source");
    const fileName = "evidence\nS report.txt";
    const original = "committed content\n";
    const changed = "uncommitted content\n";
    await git(["init", "-b", "main", source]);
    await writeFile(join(source, fileName), original);
    await git(["-C", source, "add", "--", fileName]);
    await git(["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "baseline"]);
    const manager = new WorktreeManager(join(root, "state"));
    const { workspacePath, workingBranch } = await manager.prepare({ issueKey: "ISSUE-20261024-902", workspaceName: "repo", url: source, baseBranch: "main", mode: "hotfix" });
    const file = join(workspacePath, fileName);

    for (const flag of ["assume-unchanged", "skip-worktree"]) {
      await git(["-C", workspacePath, "update-index", `--${flag}`, "--", fileName]);
      await writeFile(file, changed);
      assert.equal(await git(["-C", workspacePath, "status", "--porcelain", "--ignored=matching"]), "");
      await assert.rejects(manager.assertClean(source, workspacePath, workingBranch!), { message: "workspace_has_changes" });
      await assert.rejects(manager.remove(source, workspacePath, workingBranch!), { message: "workspace_has_changes" });
      assert.equal(await readFile(file, "utf8"), changed);
      await git(["-C", workspacePath, "update-index", `--no-${flag}`, "--", fileName]);
      assert.notEqual(await git(["-C", workspacePath, "status", "--porcelain"]), "");
      await writeFile(file, original);
    }

    await manager.remove(source, workspacePath, workingBranch!);
    await assert.rejects(access(workspacePath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports an invalid Git pointer as a stable reason while preserving the checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-git-pointer-inspection-"));
  try {
    const source = join(root, "source"),
      remote = join(root, "remote.git");
    await git(["init", "-b", "main", source]);
    await writeFile(join(source, "evidence.txt"), "preserve checkout");
    await git(["-C", source, "add", "."]);
    await git(["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "baseline"]);
    await git(["clone", "--bare", source, remote]);
    const manager = new WorktreeManager(join(root, "state"));
    const prepared = await manager.prepare({ issueKey: "ISSUE-20261024-971", workspaceName: "repo", url: remote, baseBranch: "main", mode: "hotfix" });
    assert.ok(prepared.workingBranch);
    await writeFile(join(prepared.workspacePath, ".git"), `gitdir: ${join(root, "missing-metadata")}\n`);
    for (const operation of [() => manager.assertClean(remote, prepared.workspacePath, prepared.workingBranch!), () => manager.remove(remote, prepared.workspacePath, prepared.workingBranch!)]) {
      await assert.rejects(operation(), (error) => error instanceof Error && error.message === "workspace_git_binding_invalid" && error.cause instanceof Error);
    }
    assert.equal(await readFile(join(prepared.workspacePath, "evidence.txt"), "utf8"), "preserve checkout");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves persisted issue repository workspace names", () => {
  const active = issueRepositoryWorkspaceNames([{ url: "https://example.test/team/orders.git", localPath: "/state/workspaces/issue-20260805-001/orders", workspaceName: null }]);
  assert.equal(active.get("https://example.test/team/orders.git"), "orders");

  const snapshotUrls = ["https://example.test/team-a/orders.git", "https://example.test/team-b/orders.git"];
  const snapshot = issueRepositoryWorkspaceNames(snapshotUrls.map((url) => ({ url, localPath: null, workspaceName: null })));
  assert.deepEqual(snapshot, repositoryWorkspaceNames(snapshotUrls));
  assert.throws(
    () => issueRepositoryWorkspaceNames([{ url: snapshotUrls[0]!, localPath: "/state/workspaces/issue-20260805-001/orders", workspaceName: "other" }]),
    /workspace_path_does_not_match_repository/,
  );
  assert.throws(() => repositoryWorkspaceNames(snapshotUrls, new Map(snapshotUrls.map((url) => [url, "orders"] as const))), /repository_workspace_name_conflict/);
});

test("serializes repository operations across manager instances sharing one state root", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-git-lock-"));
  try {
    const url = join(root, "source");
    await git(["init", "-b", "main", url]);
    await git(["-C", url, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "initial"]);
    const managers = [new WorktreeManager(root), new WorktreeManager(root)];
    const own = await managers[0]!.prepare({ issueKey: "ISSUE-20260805-001", workspaceName: "orders", url, baseBranch: "main", mode: "hotfix" });
    let active = 0;
    let maximumActive = 0;
    for (const manager of managers) {
      const internal = manager as unknown as { git(args: string[]): Promise<string> };
      internal.git = async (args) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        if (args[0] === "check-ref-format") return `${args.at(-1)}\n`;
        return args.includes("rev-parse") ? "a".repeat(40) : "";
      };
    }
    await Promise.all(managers.map((manager) => manager.prepareShared({ url, baseBranch: "main" })));
    assert.equal(maximumActive, 1);

    active = 0;
    maximumActive = 0;
    await Promise.all([managers[0]!.prepareShared({ url, baseBranch: "main" }), managers[1]!.assertClean(url, own.workspacePath)]);
    assert.equal(maximumActive, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const detached of [false, true])
  test(`refuses batch removal when a clean worktree ${detached ? "is detached" : "has changed branches"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "issue-pilot-release-drift-"));
    try {
      const source = join(root, "source"),
        remote = join(root, "remote.git");
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
      await assert.rejects(
        manager.removeBatch({
          issueKey,
          mode: "hotfix",
          worktrees: [first, second].map((worktree, index) => ({
            workspaceName: index ? "second" : "first",
            url: index ? otherRemote : remote,
            workingBranch: worktree.workingBranch!,
            workspacePath: worktree.workspacePath,
          })),
          finalize: async () => {
            finalized = true;
          },
        }),
        /workspace_branch_does_not_match_issue_policy/,
      );
      assert.equal(finalized, false);
      await access(first.workspacePath);
      await access(second.workspacePath);
      assert.equal(await git(["-C", first.workspacePath, "branch", "--show-current"]), first.workingBranch);
      assert.equal(await git(["-C", second.workspacePath, "branch", "--show-current"]), detached ? "" : "manual-branch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

for (const missingBranch of [false, true])
  test(`restores recorded development branches ${missingBranch ? "without replacing a missing ref" : "without contacting the remote"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "issue-pilot-local-restore-"));
    try {
      const source = join(root, "source"),
        remote = join(root, "remote.git");
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
        await git(["-C", prepared.cachePath, "tag", prepared.workingBranch!, expected]);
        await assert.rejects(manager.prepare(restore), /working_branch_not_found/);
        await assert.rejects(manager.recordBranchSnapshot({ issueKey: input.issueKey, url: remote, workingBranch: prepared.workingBranch! }), /working_branch_not_found/);
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

for (const malformed of [true, false])
  test(`does not disguise ${malformed ? "a malformed ref" : "a ref to a missing object"} as a missing branch during restore or snapshot preparation`, async () => {
    const root = await mkdtemp(join(tmpdir(), "issue-pilot-corrupt-ref-"));
    try {
      const source = join(root, "source"),
        remote = join(root, "remote.git");
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
        () => manager.recordBranchSnapshot({ issueKey: input.issueKey, url: remote, workingBranch: prepared.workingBranch! }),
      ]) {
        await assert.rejects(operation(), (error) => error instanceof Error && error.message !== "working_branch_not_found" && "code" in error && error.code === (malformed ? 1 : 128));
        assert.equal(await readFile(ref, "utf8"), evidence);
        await assert.rejects(access(prepared.workspacePath));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

test("refuses to reuse a shared checkout containing ignored files and preserves the evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-shared-ignored-"));
  try {
    const source = join(root, "source"),
      remote = join(root, "remote.git");
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
    await assert.rejects(manager.evictSharedCheckout({ checkout: prepared.workspacePath, commonDirectory: prepared.cachePath, commit: prepared.baseCommit }), /shared_checkout_changed/);
    assert.equal(await readFile(evidence, "utf8"), "preserve ignored evidence\n");
    assert.equal(await git(["-C", prepared.workspacePath, "rev-parse", "HEAD"]), prepared.baseCommit);
    await rm(join(prepared.workspacePath, "private-cache"), { recursive: true });
    assert.equal((await manager.prepareShared({ url: remote, baseBranch: "main" })).workspacePath, prepared.workspacePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("evicts only idle shared checkouts and restores the exact commit without the upstream", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-eviction-"));
  try {
    const remote = join(root, "origin");
    await git(["init", "-b", "main", remote]);
    await writeFile(join(remote, "fixture.txt"), "original snapshot\n");
    await git(["-C", remote, "add", "."]);
    await git(["-C", remote, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "snapshot"]);
    const state = join(root, "state");
    const manager = new WorktreeManager(state);
    const lease = new SharedCheckoutLease();
    const { workspacePath: checkout, cachePath: commonDirectory, baseCommit: commit } = await lease.run(() => manager.prepareShared({ url: remote, baseBranch: "main" }));
    const fail = (error: unknown) => {
      throw error;
    };
    await manager.reclaimSharedCheckouts(1, 0, fail, () => false);
    assert.equal(await readFile(join(checkout, "fixture.txt"), "utf8"), "original snapshot\n");
    lease.close();
    await mkdir(join(checkout, "untracked-empty-directory"));
    await assert.rejects(manager.evictSharedCheckout({ checkout, commonDirectory, commit }), /shared_checkout_not_reproducible/);
    await access(join(checkout, "untracked-empty-directory"));
    await rm(join(checkout, "untracked-empty-directory"), { recursive: true });
    await rename(remote, join(root, "unavailable-origin"));
    await manager.reclaimSharedCheckouts(1, 0, fail, () => false);
    await assert.rejects(access(checkout), { code: "ENOENT" });
    assert.equal(await git(["-C", commonDirectory, "show-ref", "--hash", retainedSnapshotRef(commit)]), commit);
    const afterRestart = new WorktreeManager(state);
    assert.equal(await afterRestart.openSharedCheckout(remote, commit), checkout);
    assert.equal(await readFile(join(checkout, "fixture.txt"), "utf8"), "original snapshot\n");
    const blob = await git(["-C", commonDirectory, "rev-parse", `${commit}:fixture.txt`]);
    const object = join(commonDirectory, "objects", blob.slice(0, 2), blob.slice(2));
    await rename(object, join(root, "object-under-test"));
    await assert.rejects(afterRestart.evictSharedCheckout({ checkout, commonDirectory, commit }));
    assert.equal(await readFile(join(checkout, "fixture.txt"), "utf8"), "original snapshot\n");
    await rename(join(root, "object-under-test"), object);
    const wrapper = join(root, "fake-bin");
    await mkdir(wrapper);
    await writeFile(join(wrapper, "git"), '#!/bin/sh\ncase "$*" in *"worktree remove "*/shared-checkout-eviction-*/checkout) exit 42;; esac\nexec "$ISSUE_TEST_REAL_GIT" "$@"\n', { mode: 0o700 });
    const realGit = (await execFileAsync("sh", ["-c", "command -v git"])).stdout.trim();
    await assert.rejects(
      afterRestart.withGitEnvironment({ PATH: `${wrapper}:${process.env.PATH}`, ISSUE_TEST_REAL_GIT: realGit }, () => afterRestart.evictSharedCheckout({ checkout, commonDirectory, commit })),
      { code: 42 },
    );
    await assert.rejects(access(checkout), { code: "ENOENT" });
    const [quarantine] = await readdir(join(state, "control"));
    assert.equal(await readFile(join(state, "control", quarantine!, "checkout", "fixture.txt"), "utf8"), "original snapshot\n");
    assert.equal(await afterRestart.openSharedCheckout(remote, commit), checkout);
    await git(["-C", commonDirectory, "update-ref", "-d", retainedSnapshotRef(commit)]);
    await git(["-C", commonDirectory, "worktree", "remove", checkout]);
    await assert.rejects(afterRestart.openSharedCheckout(remote, commit));
    await assert.rejects(access(checkout), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to create a shared checkout through a redirected parent", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-shared-redirect-"));
  try {
    const remote = join(root, "remote");
    const state = join(root, "state");
    const preserved = join(root, "preserved");
    await git(["init", "-b", "main", remote]);
    await git(["-C", remote, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "baseline"]);
    await mkdir(preserved);
    await mkdir(sharedCheckoutsRoot(state), { recursive: true });
    await symlink(preserved, join(sharedCheckoutsRoot(state), basename(repositoryStorePath(state, remote))));
    await assert.rejects(new WorktreeManager(state).prepareShared({ url: remote, baseBranch: "main" }), /shared_git_path_invalid/);
    assert.deepEqual(await readdir(preserved), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const development of [false, true])
  test(`uses the configured remote branch despite a shadowing tag for ${development ? "development" : "read-only"} preparation`, async () => {
    const root = await mkdtemp(join(tmpdir(), "issue-pilot-git-ref-shadow-"));
    try {
      const source = join(root, "source"),
        remote = join(root, "remote.git");
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
    const unchangedSnapshot = await worktreeManager.recordBranchSnapshot({ issueKey: "ISSUE-20260805-011", url: remote, workingBranch: hotfix.workingBranch! });
    assert.equal(unchangedSnapshot.checkout, refreshed.workspacePath);
    await writeFile(join(hotfix.workspacePath, "branch.txt"), "branch snapshot\n", "utf8");
    await git(["-C", hotfix.workspacePath, "add", "."]);
    await git(["-C", hotfix.workspacePath, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "branch snapshot"]);
    const changedSnapshot = await worktreeManager.recordBranchSnapshot({ issueKey: "ISSUE-20260805-011", url: remote, workingBranch: hotfix.workingBranch! });
    assert.equal(changedSnapshot.commit, await git(["-C", hotfix.workspacePath, "rev-parse", "HEAD"]));
    await assert.rejects(access(changedSnapshot.checkout), { code: "ENOENT" });
    assert.equal(await worktreeManager.openSharedCheckout(remote, changedSnapshot.commit), changedSnapshot.checkout);
    assert.equal(await readFile(join(changedSnapshot.checkout, "branch.txt"), "utf8"), "branch snapshot\n");
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
    await assert.rejects(
      worktreeManager.restoreLocal({
        issueKey: "ISSUE-20260805-013",
        workspaceName: "unexpected-name",
        url: remote,
        mode: "hotfix",
        workingBranch: unexpected.workingBranch!,
        expectedCommit: "0".repeat(40),
        workspacePath: unexpected.workspacePath,
      }),
      /working_branch_changed_during_release/,
    );
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

test("clean inspection handles non-ASCII branch headers and still rejects detached HEAD", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-git-status-snapshot-"));
  try {
    const source = join(root, "source"),
      remote = join(root, "remote.git");
    await git(["init", "-b", "main", source]);
    await writeFile(join(source, "README.md"), "fixture\n");
    await git(["-C", source, "add", "."]);
    await git(["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "seed"]);
    await git(["clone", "--bare", source, remote]);
    const manager = new WorktreeManager(join(root, "state"));
    const prepared = await manager.prepare({ issueKey: "ISSUE-20261025-992", workspaceName: "repo", url: remote, baseBranch: "main", mode: "hotfix" });
    for (const branch of ["修复/完整分支", "(detached)"]) {
      await git(["-C", prepared.workspacePath, "branch", "-m", branch]);
      await manager.assertClean(remote, prepared.workspacePath, branch);
    }
    await git(["-C", prepared.workspacePath, "checkout", "--detach", "HEAD"]);
    await assert.rejects(manager.assertClean(remote, prepared.workspacePath, "(detached)"), /workspace_branch_does_not_match_issue_policy/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed first preparation discards the worktree, branch and private store it created", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-retry-base-"));
  try {
    const source = join(root, "source"),
      remote = join(root, "remote.git"),
      state = join(root, "state");
    await git(["init", "-b", "main", source]);
    await writeFile(join(source, "README.md"), "first\n");
    await git(["-C", source, "add", "."]);
    await git(["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "first"]);
    await git(["clone", "--bare", source, remote]);
    const manager = new WorktreeManager(state);
    const worktree = { issueKey: "ISSUE-20261103-901", workspaceName: "repo", url: remote, baseBranch: "main", mode: "hotfix" as const };
    // Issue roots are claimed at creation, before any preparation.
    await mkdir(join(state, "workspaces", "issue-20261103-901"), { recursive: true });
    await assert.rejects(
      manager.prepareBatch({
        worktrees: [worktree],
        finalize: async () => {
          throw new Error("simulated_finalize_failure");
        },
      }),
      /simulated_finalize_failure/,
    );
    // An unrecorded attempt must leave no worktree, branch or private store for a later retry to adopt.
    await assert.rejects(access(join(state, "workspaces", "issue-20261103-901", "repo")), { code: "ENOENT" });
    await assert.rejects(access(issueRepositoryStorePath(state, worktree.issueKey, remote)), { code: "ENOENT" });
    await assert.rejects(git(["-C", remote, "show-ref", "--verify", "refs/heads/hotfix-issue-20261103-901"]));
    // Production moves on before the retry; the fresh branch starts at the new base.
    await writeFile(join(source, "README.md"), "second\n");
    await git(["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-am", "second"]);
    await git(["-C", source, "push", remote, "main"]);
    const prepared = await manager.prepare(worktree);
    const head = await git(["-C", prepared.workspacePath, "rev-parse", "HEAD"]);
    assert.equal(prepared.baseCommit, head);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
