import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { prepareIssueRuntime } from "../../src/workspace/runtime.ts";
import { claimIssueRoot, issueRoot, sharedCheckoutsRoot } from "../../src/workspace/state.ts";

test("prepares the same issue runtime shape for read-only checkouts and writable worktrees", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-runtime-"));
  const readOnlyIssue = "ISSUE-20260810-001";
  const writableIssue = "ISSUE-20260810-002";
  try {
    const checkout = path.join(sharedCheckoutsRoot(root), "repository", "commit");
    await mkdir(checkout, { recursive: true });
    await writeFile(path.join(checkout, "README.md"), "shared checkout\n", "utf8");

    await claimIssueRoot(root, readOnlyIssue);
    const readOnlyRuntime = await prepareIssueRuntime(root, readOnlyIssue, [{ name: "orders", repositoryPath: checkout }], "read");
    assert.equal(readOnlyRuntime, issueRoot(root, readOnlyIssue));
    assert.equal((await lstat(path.join(readOnlyRuntime, "orders"))).isSymbolicLink(), true);
    const readOnlyLink = await readlink(path.join(readOnlyRuntime, "orders"));
    assert.equal(path.isAbsolute(readOnlyLink), false);
    assert.equal(path.resolve(readOnlyRuntime, readOnlyLink), checkout);
    assert.equal(await readFile(path.join(readOnlyRuntime, "orders", "README.md"), "utf8"), "shared checkout\n");
    assert.equal((await lstat(issueRoot(root, readOnlyIssue))).isDirectory(), true);

    const worktree = path.join(issueRoot(root, writableIssue), "orders");
    await mkdir(worktree, { recursive: true });
    await writeFile(path.join(worktree, "README.md"), "writable worktree\n", "utf8");
    const writableRuntime = await prepareIssueRuntime(root, writableIssue, [{ name: "orders", repositoryPath: worktree }], "write");
    assert.equal(writableRuntime, issueRoot(root, writableIssue));
    assert.equal((await lstat(path.join(writableRuntime, "orders"))).isDirectory(), true);
    await writeFile(path.join(writableRuntime, "orders", "created-through-runtime.txt"), "writable\n", "utf8");
    assert.equal(await readFile(path.join(worktree, "created-through-runtime.txt"), "utf8"), "writable\n");

    const relatedDirectory = issueRoot(root, "ISSUE-20260809-099");
    await mkdir(relatedDirectory, { recursive: true });
    const conversation = path.join(relatedDirectory, ".session-related.jsonl");
    await writeFile(conversation, '{"type":"session"}\n', "utf8");
    const prepareRelated = () =>
      prepareIssueRuntime(root, readOnlyIssue, [{ name: "orders", repositoryPath: checkout }], "read", [
        {
          key: "ISSUE-20260809-099",
          metadata: { key: "ISSUE-20260809-099", title: "Earlier development" },
          conversationPath: conversation,
          workDirectory: relatedDirectory,
        },
      ]);
    const relatedRuntime = await prepareRelated();
    assert.deepEqual(JSON.parse(await readFile(path.join(relatedRuntime, ".related-issue-20260809-099.json"), "utf8")), { key: "ISSUE-20260809-099", title: "Earlier development" });
    assert.equal(await readFile(path.join(relatedRuntime, ".related-issue-20260809-099.jsonl"), "utf8"), '{"type":"session"}\n');
    assert.equal(await readlink(path.join(relatedRuntime, ".related-issue-20260809-099")), path.relative(relatedRuntime, relatedDirectory));

    const manifest = path.join(relatedRuntime, ".issue-runtime.json");
    const metadata = path.join(relatedRuntime, ".related-issue-20260809-099.json");
    const link = path.join(relatedRuntime, "orders");
    const entries = [manifest, metadata, link];
    const inodes = async () => Promise.all(entries.map(async (entry) => (await lstat(entry)).ino));
    const previousInodes = await inodes();
    await prepareRelated();
    assert.deepEqual(await inodes(), previousInodes);
    await chmod(metadata, 0o640);
    await chmod(manifest, 0o644);
    await prepareRelated();
    assert.equal((await lstat(metadata)).mode & 0o777, 0o400);
    assert.equal((await lstat(manifest)).mode & 0o777, 0o600);

    await assert.rejects(prepareIssueRuntime(root, writableIssue, [{ name: "outside", repositoryPath: checkout }], "write"), /repository_workspace_outside_issue_root/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing durable Issue roots are not recreated by generated runtime recovery", async () => {
  const state = await mkdtemp(path.join(tmpdir(), "issue-pilot-missing-runtime-root-"));
  const key = "ISSUE-20261107-901";
  const root = issueRoot(state, key);
  try {
    for (const access of ["read", "write"] as const) {
      await assert.rejects(prepareIssueRuntime(state, key, [], access), { message: "issue_root_missing" });
      await assert.rejects(lstat(root), { code: "ENOENT" });
    }
    await claimIssueRoot(state, key);
    await writeFile(path.join(root, "notes.txt"), "durable evidence");
    await prepareIssueRuntime(state, key, [], "read");
    await rm(path.join(root, ".issue-runtime.json"));
    await prepareIssueRuntime(state, key, [], "read");
    assert.equal(await readFile(path.join(root, "notes.txt"), "utf8"), "durable evidence");
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});
