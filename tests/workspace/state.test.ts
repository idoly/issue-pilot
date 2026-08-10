import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { classifyRepositoryState, pruneState, repositoriesRoot, sharedCheckoutsRoot } from "../../src/workspace/state.ts";

const exec = promisify(execFile);

test("classifies repository persistence states without mixed-mode fallbacks", () => {
  assert.equal(classifyRepositoryState([]), "invalid");
  assert.equal(classifyRepositoryState([{ localPath: null, workingBranch: null }]), "read_only");
  assert.equal(classifyRepositoryState([{ localPath: "/workspace/repository", workingBranch: "hotfix-issue-20260810-001" }]), "development_workspace");
  assert.equal(classifyRepositoryState([{ localPath: null, workingBranch: "hotfix-issue-20260810-001" }]), "development_snapshot");
  assert.equal(classifyRepositoryState([
    { localPath: null, workingBranch: "hotfix-issue-20260810-001" },
    { localPath: "/workspace/other", workingBranch: "hotfix-issue-20260810-001" },
  ]), "invalid");
  assert.equal(classifyRepositoryState([{ localPath: null, workingBranch: "" }]), "invalid");
});

test("preserves unmanaged issue state before pruning generated resources", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-state-"));
  const activeKey = "issue-20260807-001";
  const unmanagedKey = "issue-20260807-002";
  const unmanagedWorkspaceFile = path.join(root, "workspaces", unmanagedKey, "uncommitted.txt");
  const unmanagedAttachment = path.join(root, "issues", unmanagedKey, "attachments", "evidence.txt");
  try {
    await Promise.all([
      mkdir(path.join(root, "workspaces", activeKey, "repository"), { recursive: true }),
      mkdir(path.dirname(unmanagedWorkspaceFile), { recursive: true }),
      mkdir(path.join(root, "issues", activeKey, "runtime"), { recursive: true }),
      mkdir(path.join(root, "issues", activeKey, "agent"), { recursive: true }),
      mkdir(path.join(root, "issues", activeKey, "attachments"), { recursive: true }),
      mkdir(path.dirname(unmanagedAttachment), { recursive: true }),
      mkdir(repositoriesRoot(root), { recursive: true }),
      mkdir(path.join(sharedCheckoutsRoot(root), "repository", "commit"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(unmanagedWorkspaceFile, "preserve workspace\n", "utf8"),
      writeFile(unmanagedAttachment, "preserve attachment\n", "utf8"),
      exec("git", ["init", "--bare", path.join(repositoriesRoot(root), "repository")]),
    ]);

    await assert.rejects(pruneState(root, ["ISSUE-20260807-001"]), /unmanaged_issue_state:issues\/issue-20260807-002,workspaces\/issue-20260807-002/);
    assert.equal(await readFile(unmanagedWorkspaceFile, "utf8"), "preserve workspace\n");
    assert.equal(await readFile(unmanagedAttachment, "utf8"), "preserve attachment\n");
    assert.equal((await stat(path.join(root, "issues", activeKey, "runtime"))).isDirectory(), true);
    assert.equal((await stat(sharedCheckoutsRoot(root))).isDirectory(), true);

    await Promise.all([
      rm(path.join(root, "workspaces", unmanagedKey), { recursive: true }),
      rm(path.join(root, "issues", unmanagedKey), { recursive: true }),
    ]);
    await pruneState(root, ["ISSUE-20260807-001"]);
    assert.equal((await stat(path.join(root, "workspaces", activeKey, "repository"))).isDirectory(), true);
    assert.equal((await stat(path.join(root, "issues", activeKey, "agent"))).isDirectory(), true);
    assert.equal((await stat(path.join(root, "issues", activeKey, "attachments"))).isDirectory(), true);
    await assert.rejects(stat(path.join(root, "issues", activeKey, "runtime")));
    await assert.rejects(stat(sharedCheckoutsRoot(root)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
