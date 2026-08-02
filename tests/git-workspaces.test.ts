import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { GitWorkspaceManager } from "../src/git-workspaces.ts";

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

test("prefers the latest prod branch for a new issue workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "git-workspaces-prod-"));
  directories.push(root);
  const source = join(root, "source");
  await exec("git", ["init", "-b", "main", source]);
  await exec("git", ["-C", source, "config", "user.name", "Issue Agent Test"]);
  await exec("git", ["-C", source, "config", "user.email", "issue-agent@example.test"]);
  await writeFile(join(source, "README.md"), "main\n", "utf8");
  await exec("git", ["-C", source, "add", "README.md"]);
  await exec("git", ["-C", source, "commit", "-m", "main baseline"]);
  await exec("git", ["-C", source, "checkout", "-b", "prod"]);
  await writeFile(join(source, "README.md"), "prod\n", "utf8");
  await exec("git", ["-C", source, "commit", "-am", "prod baseline"]);
  const prodCommit = (await exec("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();

  const manager = new GitWorkspaceManager(join(root, "state"));
  const prepared = await manager.prepare({ issueId: "ISSUE-0003", repositoryId: "app", url: source, baseBranch: "main", preferredBaseBranch: "prod" });

  assert.equal(prepared.baseBranch, "prod");
  assert.equal(prepared.baseCommit, prodCommit);
  assert.equal((await exec("git", ["-C", prepared.workspacePath, "branch", "--show-current"])).stdout.trim(), "issue/ISSUE-0003/app");
  assert.equal(await readFile(join(prepared.workspacePath, "README.md"), "utf8"), "prod\n");
});

test("prepares isolated branches for concurrent issues on one repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "git-workspaces-"));
  directories.push(root);
  const source = join(root, "source");
  await exec("git", ["init", "-b", "main", source]);
  await exec("git", ["-C", source, "config", "user.name", "Issue Agent Test"]);
  await exec("git", ["-C", source, "config", "user.email", "issue-agent@example.test"]);
  await writeFile(join(source, "README.md"), "base\n", "utf8");
  await exec("git", ["-C", source, "add", "README.md"]);
  await exec("git", ["-C", source, "commit", "-m", "initial"]);

  const manager = new GitWorkspaceManager(join(root, "state"));
  const [first, second] = await Promise.all([
    manager.prepare({ issueId: "ISSUE-0001", repositoryId: "app", url: source, baseBranch: "main" }),
    manager.prepare({ issueId: "ISSUE-0002", repositoryId: "app", url: source, baseBranch: "main" }),
  ]);

  assert.notEqual(first.workspacePath, second.workspacePath);
  assert.equal(first.baseCommit, second.baseCommit);
  assert.equal((await exec("git", ["-C", first.workspacePath, "branch", "--show-current"])).stdout.trim(), "issue/ISSUE-0001/app");
  assert.equal((await exec("git", ["-C", second.workspacePath, "branch", "--show-current"])).stdout.trim(), "issue/ISSUE-0002/app");
});

test("reuses a dirty persisted worktree when the service repository ID changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "git-workspaces-reuse-"));
  directories.push(root);
  const source = join(root, "source");
  await exec("git", ["init", "-b", "main", source]);
  await exec("git", ["-C", source, "config", "user.name", "Issue Agent Test"]);
  await exec("git", ["-C", source, "config", "user.email", "issue-agent@example.test"]);
  await writeFile(join(source, "README.md"), "base\n", "utf8");
  await exec("git", ["-C", source, "add", "README.md"]);
  await exec("git", ["-C", source, "commit", "-m", "initial"]);

  const manager = new GitWorkspaceManager(join(root, "state"));
  const first = await manager.prepare({ issueId: "ISSUE-0004", repositoryId: "old-id", url: source, baseBranch: "main" });
  await writeFile(join(first.workspacePath, "README.md"), "dirty issue fix\n", "utf8");
  const reused = await manager.prepare({
    issueId: "ISSUE-0004",
    repositoryId: "replacement-id",
    url: source,
    baseBranch: "main",
    workingBranch: first.workingBranch,
    existingWorkspacePath: first.workspacePath,
  });

  assert.equal(reused.workspacePath, first.workspacePath);
  assert.equal(reused.workingBranch, first.workingBranch);
  assert.equal(await readFile(join(reused.workspacePath, "README.md"), "utf8"), "dirty issue fix\n");
  assert.match((await exec("git", ["-C", reused.workspacePath, "status", "--short"])).stdout, /^ M README\.md/m);
});
