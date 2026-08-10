import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { migrateGitStorage } from "../../src/workspace/git-storage.ts";
import { legacyRepositoriesRoot, legacySharedCheckoutsRoot, repositoriesRoot, sharedCheckoutsRoot } from "../../src/workspace/state.ts";

const exec = promisify(execFile);

async function git(args: string[]): Promise<string> {
  return (await exec("git", args, { encoding: "utf8" })).stdout.trim();
}

async function missing(candidate: string): Promise<boolean> {
  return access(candidate).then(() => false, () => true);
}

test("moves legacy Git stores under the shared git root and is idempotent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-git-storage-"));
  try {
    await mkdir(path.join(legacySharedCheckoutsRoot(root), "checkout"), { recursive: true });
    await git(["init", "--bare", path.join(legacyRepositoriesRoot(root), "repo")]);
    await writeFile(path.join(legacySharedCheckoutsRoot(root), "checkout", "README.md"), "snapshot\n", "utf8");

    assert.deepEqual(await migrateGitStorage(root), { repositories: true, checkouts: true });
    assert.match(await readFile(path.join(repositoriesRoot(root), "repo", "HEAD"), "utf8"), /^ref: refs\/heads\//);
    assert.equal(await readFile(path.join(sharedCheckoutsRoot(root), "checkout", "README.md"), "utf8"), "snapshot\n");
    assert.equal(await missing(legacyRepositoriesRoot(root)), true);
    assert.equal(await missing(legacySharedCheckoutsRoot(root)), true);
    assert.deepEqual(await migrateGitStorage(root), { repositories: false, checkouts: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repairs relative metadata for existing development worktrees", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-git-storage-worktree-"));
  try {
    const source = path.join(root, "source");
    const repository = path.join(legacyRepositoriesRoot(root), "repo");
    const workspace = path.join(root, "workspaces", "issue-20260810-001", "repo");
    await git(["init", "-b", "main", source]);
    await writeFile(path.join(source, "README.md"), "source\n", "utf8");
    await git(["-C", source, "add", "."]);
    await git(["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "initial"]);
    await git(["clone", "--bare", source, repository]);
    await git(["-C", repository, "worktree", "add", "--detach", "--relative-paths", workspace, "main"]);

    assert.deepEqual(await migrateGitStorage(root), { repositories: true, checkouts: false });
    assert.equal(await git(["-C", workspace, "status", "--porcelain"]), "");
    assert.match(await readFile(path.join(workspace, ".git"), "utf8"), /git\/repositories\/repo\/worktrees\//);
    assert.doesNotMatch(await readFile(path.join(workspace, ".git"), "utf8"), /\.issue-pilot\/repositories/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains both sides when legacy and consolidated Git stores conflict", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-git-storage-conflict-"));
  try {
    await Promise.all([
      mkdir(legacyRepositoriesRoot(root), { recursive: true }),
      mkdir(repositoriesRoot(root), { recursive: true }),
    ]);
    await assert.rejects(migrateGitStorage(root), /git_storage_conflict:repositories/);
    assert.equal(await missing(legacyRepositoriesRoot(root)), false);
    assert.equal(await missing(repositoriesRoot(root)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
