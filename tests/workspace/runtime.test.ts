import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { prepareIssueRuntime, prepareIssueRuntimeBatch } from "../../src/workspace/runtime.ts";
import { issueRuntimeRoot, issueWorkspaceRoot, sharedCheckoutsRoot } from "../../src/workspace/state.ts";

test("bounds runtime preparation concurrency and preserves Issue result order", async () => {
  const issues = ["001", "002", "003", "004"].map((suffix) => ({ id: suffix, key: `ISSUE-20260816-${suffix}` }));
  let active = 0;
  let maximumActive = 0;
  let failedUpdates = 0;
  const database = {
    update() {
      failedUpdates += 1;
      return { set: () => ({ where: async () => undefined }) };
    },
  };
  const result = await prepareIssueRuntimeBatch(database as never, issues, async (issue) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, issue.id === "001" ? 15 : 2));
      if (issue.id === "002") throw new Error("runtime_blocked");
    } finally {
      active -= 1;
    }
  }, { concurrency: 2 });

  assert.equal(maximumActive, 2);
  assert.equal(failedUpdates, 1);
  assert.deepEqual(result, {
    prepared: ["ISSUE-20260816-001", "ISSUE-20260816-003", "ISSUE-20260816-004"],
    blocked: [{ issueKey: "ISSUE-20260816-002", reason: "runtime_blocked" }],
  });
});

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

    await assert.rejects(
      prepareIssueRuntime(root, writableIssue, [{ name: "outside", repositoryPath: checkout }], "write"),
      /repository_workspace_outside_issue_root/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
