import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs, { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { isolateIssueWorktree, publishIssueBranch, publishedIssueBranchFile } from "../../src/workspace/issue-git.ts";

const exec = promisify(execFile);
const git = async (args: string[]) => (await exec("git", args)).stdout.trim();

test("legacy worktree isolation rolls back a failed switch and preserves staged, unstaged and untracked files on retry", async context => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-git-migration-"));
  try {
    const shared = path.join(root, "shared"), workspace = path.join(root, "issue", "repo"), privateStore = path.join(root, "issue", ".issue-git-fixture");
    await git(["init", "--bare", shared]);
    const source = path.join(root, "source");
    await git(["clone", shared, source]);
    await writeFile(path.join(source, "file.txt"), "initial");
    await git(["-C", source, "add", "."]);
    await git(["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "initial"]);
    await git(["-C", source, "push", "origin", "HEAD:main"]);
    await git(["-C", shared, "remote", "add", "origin", source]);
    await git(["-C", shared, "fetch", "origin", "HEAD:refs/remotes/origin/main"]);
    await mkdir(path.dirname(workspace));
    const branch = "hotfix-issue-20261023-003";
    await git(["-C", shared, "worktree", "add", "--relative-paths", "-b", branch, workspace, "main"]);
    await writeFile(path.join(workspace, "file.txt"), "staged");
    await git(["-C", workspace, "add", "."]);
    await writeFile(path.join(workspace, "file.txt"), "unstaged");
    await writeFile(path.join(workspace, "new.txt"), "untracked");
    const pointerFile = path.join(workspace, ".git"), pointer = await readFile(pointerFile, "utf8");
    const metadata = path.resolve(workspace, pointer.slice(8).trim());
    const status = await git(["-C", workspace, "status", "--porcelain"]);
    const rename = fs.rename, failure = new Error("registration move failed");
    context.mock.method(fs, "rename", (...args: Parameters<typeof fs.rename>) => {
      if (args[0] === metadata) return Promise.reject(failure);
      return rename(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(isolateIssueWorktree(shared, privateStore, workspace, branch), error => error === failure);
    context.mock.restoreAll(); syncBuiltinESMExports();
    assert.equal(await readFile(pointerFile, "utf8"), pointer);
    assert.equal(await git(["-C", workspace, "status", "--porcelain"]), status);
    await isolateIssueWorktree(shared, privateStore, workspace, branch);
    await isolateIssueWorktree(shared, privateStore, workspace, branch);
    assert.equal(await git(["-C", workspace, "status", "--porcelain"]), status);
    assert.equal(await git(["-C", workspace, "show", ":file.txt"]), "staged");
    await git(["-C", shared, "reflog", "expire", "--expire=now", "--all"]);
    await git(["-C", shared, "gc", "--prune=now"]);
    assert.equal(await git(["-C", workspace, "show", ":file.txt"]), "staged");
    assert.equal(await readFile(path.join(workspace, "file.txt"), "utf8"), "unstaged");
    assert.equal(await readFile(path.join(workspace, "new.txt"), "utf8"), "untracked");
    await git(["-C", workspace, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "staged change"]);
    const markerFile = path.join(privateStore, publishedIssueBranchFile), marker = await readFile(markerFile, "utf8");
    const publicationFailure = new Error("checkpoint rename failed");
    context.mock.method(fs, "rename", (...args: Parameters<typeof fs.rename>) => args[1] === markerFile ? Promise.reject(publicationFailure) : rename(...args));
    syncBuiltinESMExports();
    await assert.rejects(publishIssueBranch(shared, privateStore, branch), error => error === publicationFailure);
    context.mock.restoreAll(); syncBuiltinESMExports();
    assert.equal(await readFile(markerFile, "utf8"), marker);
    await publishIssueBranch(shared, privateStore, branch);
    await publishIssueBranch(shared, privateStore, branch);
    const original = await git(["-C", shared, "rev-parse", `refs/heads/${branch}`]);
    assert.equal(JSON.parse(await readFile(markerFile, "utf8")).commit, original);
    // A different valid commit in the shared branch must survive a publication attempt.
    const changed = await git(["-C", shared, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit-tree", `${original}^{tree}`, "-p", original, "-m", "external change"]);
    await git(["-C", shared, "update-ref", `refs/heads/${branch}`, changed]);
    await assert.rejects(publishIssueBranch(shared, privateStore, branch), /working_branch_changed_outside_issue/);
    assert.equal(await git(["-C", shared, "rev-parse", `refs/heads/${branch}`]), changed);
  } finally {
    context.mock.restoreAll(); syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});
