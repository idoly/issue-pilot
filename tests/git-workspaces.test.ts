import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, test } from "node:test";

import { GitWorkspaceManager } from "../src/git-workspaces.ts";

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

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
