import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { pruneState, repositoriesRoot, sharedCheckoutsRoot } from "../../src/workspace/state.ts";

const exec = promisify(execFile);

test("prunes state for issues that no longer exist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-state-"));
  try {
    await Promise.all([
      mkdir(path.join(root, "workspaces", "issue-20260807-001", ".issue-pilot", "bin"), { recursive: true }),
      mkdir(path.join(root, "workspaces", "issue-20260807-002"), { recursive: true }),
      mkdir(path.join(root, "issues", "issue-20260807-001", "runtime"), { recursive: true }),
      mkdir(path.join(root, "issues", "issue-20260807-001", "agent"), { recursive: true }),
      mkdir(path.join(root, "issues", "issue-20260807-001", "attachments"), { recursive: true }),
      mkdir(path.join(root, "issues", "issue-20260807-002"), { recursive: true }),
      mkdir(repositoriesRoot(root), { recursive: true }),
      mkdir(path.join(sharedCheckoutsRoot(root), "repository", "commit"), { recursive: true }),
    ]);
    await exec("git", ["init", "--bare", path.join(repositoriesRoot(root), "repository")]);
    await pruneState(root, ["ISSUE-20260807-001"]);
    assert.equal((await stat(path.join(root, "workspaces", "issue-20260807-001"))).isDirectory(), true);
    assert.equal((await stat(path.join(root, "workspaces", "issue-20260807-001", ".issue-pilot"))).isDirectory(), true);
    await assert.rejects(stat(path.join(root, "workspaces", "issue-20260807-002")));
    await assert.rejects(stat(path.join(root, "issues", "issue-20260807-002")));
    assert.equal((await stat(path.join(root, "issues", "issue-20260807-001", "agent"))).isDirectory(), true);
    assert.equal((await stat(path.join(root, "issues", "issue-20260807-001", "attachments"))).isDirectory(), true);
    await assert.rejects(stat(path.join(root, "issues", "issue-20260807-001", "runtime")));
    await assert.rejects(stat(sharedCheckoutsRoot(root)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
