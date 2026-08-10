import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { prepareIssueRuntime } from "../../src/workspace/runtime.ts";
import { issueRuntimeRoot, issueRuntimeWorkspaceFile, issueWorkspaceRoot, sharedCheckoutsRoot } from "../../src/workspace/state.ts";

test("prepares the same issue runtime shape for read-only checkouts and writable worktrees", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-runtime-"));
  const readOnlyIssue = "ISSUE-20260810-001";
  const writableIssue = "ISSUE-20260810-002";
  try {
    const checkout = path.join(sharedCheckoutsRoot(root), "repository", "commit");
    await mkdir(checkout, { recursive: true });
    await writeFile(path.join(checkout, "README.md"), "shared checkout\n", "utf8");

    const readOnlyRuntime = await prepareIssueRuntime(root, readOnlyIssue, [{ name: "orders", repositoryPath: checkout }], "read");
    assert.equal(readOnlyRuntime, issueRuntimeRoot(root, readOnlyIssue));
    assert.equal((await lstat(path.join(readOnlyRuntime, "orders"))).isSymbolicLink(), true);
    const readOnlyLink = await readlink(path.join(readOnlyRuntime, "orders"));
    assert.equal(path.isAbsolute(readOnlyLink), false);
    assert.equal(path.resolve(readOnlyRuntime, readOnlyLink), checkout);
    assert.equal(await readFile(path.join(readOnlyRuntime, "orders", "README.md"), "utf8"), "shared checkout\n");
    await assert.rejects(access(issueWorkspaceRoot(root, readOnlyIssue)));

    const worktree = path.join(issueWorkspaceRoot(root, writableIssue), "orders");
    await mkdir(worktree, { recursive: true });
    await writeFile(path.join(worktree, "README.md"), "writable worktree\n", "utf8");
    const writableRuntime = await prepareIssueRuntime(root, writableIssue, [{ name: "orders", repositoryPath: worktree }], "write");
    const writableLink = await readlink(path.join(writableRuntime, "orders"));
    assert.equal(path.isAbsolute(writableLink), false);
    assert.equal(path.resolve(writableRuntime, writableLink), worktree);
    await writeFile(path.join(writableRuntime, "orders", "created-through-runtime.txt"), "writable\n", "utf8");
    assert.equal(await readFile(path.join(worktree, "created-through-runtime.txt"), "utf8"), "writable\n");

    for (const issueKey of [readOnlyIssue, writableIssue]) {
      const workspaceFile = issueRuntimeWorkspaceFile(root, issueKey);
      assert.deepEqual(JSON.parse(await readFile(workspaceFile, "utf8")), { folders: [{ name: "orders", path: "orders" }] });
      assert.equal((await stat(workspaceFile)).mode & 0o777, 0o400);
    }
    await assert.rejects(
      prepareIssueRuntime(root, writableIssue, [{ name: "outside", repositoryPath: checkout }], "write"),
      /repository_workspace_outside_issue_root/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
