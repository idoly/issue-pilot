import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { assertManagedIssueWorkspaceLayout, classifyRepositoryState, pruneState, repositoriesRoot, sharedCheckoutsRoot } from "../../src/workspace/state.ts";

const exec = promisify(execFile);

async function createSharedCheckout(root: string, repositoryKey = "a".repeat(20)): Promise<string> {
  const source = path.join(root, `checkout-source-${repositoryKey}`);
  await mkdir(source, { recursive: true });
  await exec("git", ["init", "-b", "main", source]);
  await Promise.all([
    writeFile(path.join(source, "README.md"), "shared checkout\n", "utf8"),
    writeFile(path.join(source, ".gitignore"), "ignored-evidence.txt\n", "utf8"),
  ]);
  await exec("git", ["-C", source, "add", "."]);
  await exec("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "initial"]);
  const commit = (await exec("git", ["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  const repository = path.join(repositoriesRoot(root), repositoryKey);
  const checkout = path.join(sharedCheckoutsRoot(root), repositoryKey, commit);
  await Promise.all([mkdir(path.dirname(checkout), { recursive: true }), mkdir(path.dirname(repository), { recursive: true })]);
  await exec("git", ["clone", "--bare", "--quiet", source, repository]);
  await exec("git", ["-C", repository, "worktree", "add", "--detach", checkout, commit]);
  return checkout;
}

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

test("requires workspace layouts to exactly match registered repository directories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-workspace-layout-"));
  const workspaceRoot = path.join(root, "workspaces", "issue-20260810-001");
  const alpha = path.join(workspaceRoot, "alpha");
  const beta = path.join(workspaceRoot, "beta");
  try {
    await Promise.all([mkdir(alpha, { recursive: true }), mkdir(beta, { recursive: true })]);
    await assertManagedIssueWorkspaceLayout(workspaceRoot, [alpha, beta]);

    await rm(beta, { recursive: true });
    await assert.rejects(assertManagedIssueWorkspaceLayout(workspaceRoot, [alpha, beta]), /workspace_repository_missing/);
    await writeFile(beta, "not a repository directory\n", "utf8");
    await assert.rejects(assertManagedIssueWorkspaceLayout(workspaceRoot, [alpha, beta]), /workspace_repository_missing/);
    await rm(beta);

    const extra = path.join(workspaceRoot, "extra");
    await mkdir(extra);
    await assert.rejects(assertManagedIssueWorkspaceLayout(workspaceRoot, [alpha]), /workspace_has_untracked_files/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves unmanaged issue state before pruning generated resources", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-state-"));
  const activeKey = "issue-20260807-001";
  const unmanagedKey = "issue-20260807-002";
  const unmanagedWorkspaceFile = path.join(root, "workspaces", unmanagedKey, "uncommitted.txt");
  const unmanagedAttachment = path.join(root, "issues", unmanagedKey, "attachments", "evidence.txt");
  const checkoutRoot = sharedCheckoutsRoot(root);
  try {
    await Promise.all([
      mkdir(path.join(root, "workspaces", activeKey, "repository"), { recursive: true }),
      mkdir(path.dirname(unmanagedWorkspaceFile), { recursive: true }),
      mkdir(path.join(root, "issues", activeKey, "runtime"), { recursive: true }),
      mkdir(path.join(root, "issues", activeKey, ".runtime-12345678-1234-4234-9234-123456789abc"), { recursive: true }),
      mkdir(path.join(root, "issues", activeKey, ".runtime-previous-12345678-1234-4234-9234-123456789abc"), { recursive: true }),
      mkdir(path.join(root, "issues", activeKey, ".runtime-operator-evidence"), { recursive: true }),
      mkdir(path.join(root, "issues", activeKey, "agent"), { recursive: true }),
      mkdir(path.join(root, "issues", activeKey, "attachments"), { recursive: true }),
      mkdir(path.dirname(unmanagedAttachment), { recursive: true }),
      mkdir(repositoriesRoot(root), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(unmanagedWorkspaceFile, "preserve workspace\n", "utf8"),
      writeFile(unmanagedAttachment, "preserve attachment\n", "utf8"),
      exec("git", ["init", "--bare", path.join(repositoriesRoot(root), "repository")]),
    ]);
    await createSharedCheckout(root);

    const checkoutRootInode = (await stat(checkoutRoot)).ino;
    await assert.rejects(pruneState(root, ["ISSUE-20260807-001"]), /unmanaged_issue_state:issues\/issue-20260807-002,workspaces\/issue-20260807-002/);
    assert.equal(await readFile(unmanagedWorkspaceFile, "utf8"), "preserve workspace\n");
    assert.equal(await readFile(unmanagedAttachment, "utf8"), "preserve attachment\n");
    assert.equal((await stat(path.join(root, "issues", activeKey, "runtime"))).isDirectory(), true);
    assert.equal((await stat(checkoutRoot)).isDirectory(), true);

    await Promise.all([
      rm(path.join(root, "workspaces", unmanagedKey), { recursive: true }),
      rm(path.join(root, "issues", unmanagedKey), { recursive: true }),
    ]);
    await pruneState(root, ["ISSUE-20260807-001"]);
    assert.equal((await stat(path.join(root, "workspaces", activeKey, "repository"))).isDirectory(), true);
    assert.equal((await stat(path.join(root, "issues", activeKey, "agent"))).isDirectory(), true);
    assert.equal((await stat(path.join(root, "issues", activeKey, "attachments"))).isDirectory(), true);
    await Promise.all([
      assert.rejects(stat(path.join(root, "issues", activeKey, "runtime"))),
      assert.rejects(stat(path.join(root, "issues", activeKey, ".runtime-12345678-1234-4234-9234-123456789abc"))),
      assert.rejects(stat(path.join(root, "issues", activeKey, ".runtime-previous-12345678-1234-4234-9234-123456789abc"))),
    ]);
    assert.equal((await stat(path.join(root, "issues", activeKey, ".runtime-operator-evidence"))).isDirectory(), true);
    assert.equal((await stat(checkoutRoot)).ino, checkoutRootInode);
    assert.deepEqual(await readdir(checkoutRoot), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves unowned repositories disguised as shared checkouts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-unowned-checkout-state-"));
  const issueRuntime = path.join(root, "issues", "issue-20260807-001", "runtime");
  try {
    await Promise.all([mkdir(issueRuntime, { recursive: true }), mkdir(path.join(root, "workspaces"), { recursive: true })]);
    const managedCheckout = await createSharedCheckout(root);
    const repositoryKey = path.basename(path.dirname(managedCheckout));
    const commit = path.basename(managedCheckout);
    const repository = path.join(repositoriesRoot(root), repositoryKey);
    await exec("git", ["-C", repository, "worktree", "remove", managedCheckout]);
    await exec("git", ["clone", "--quiet", repository, managedCheckout]);
    await exec("git", ["-C", managedCheckout, "checkout", "--detach", commit]);
    await writeFile(path.join(issueRuntime, "manifest.json"), "preserve runtime evidence\n", "utf8");

    await assert.rejects(pruneState(root, ["ISSUE-20260807-001"]), /shared_checkout_changed/);
    assert.equal(await readFile(path.join(managedCheckout, "README.md"), "utf8"), "shared checkout\n");
    assert.equal(await readFile(path.join(issueRuntime, "manifest.json"), "utf8"), "preserve runtime evidence\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves changed shared checkouts and generated runtimes as evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-shared-checkout-state-"));
  const issueRuntime = path.join(root, "issues", "issue-20260807-001", "runtime");
  try {
    await Promise.all([
      mkdir(issueRuntime, { recursive: true }),
      mkdir(repositoriesRoot(root), { recursive: true }),
      mkdir(path.join(root, "workspaces"), { recursive: true }),
    ]);
    const checkout = await createSharedCheckout(root);
    const cleanCheckout = await createSharedCheckout(root, "b".repeat(20));
    const evidence = path.join(checkout, "ignored-evidence.txt");
    await writeFile(evidence, "preserve checkout evidence\n", "utf8");
    await writeFile(path.join(issueRuntime, "manifest.json"), "preserve runtime evidence\n", "utf8");

    await assert.rejects(pruneState(root, ["ISSUE-20260807-001"]), /shared_checkout_changed/);
    assert.equal(await readFile(evidence, "utf8"), "preserve checkout evidence\n");
    assert.equal(await readFile(path.join(cleanCheckout, "README.md"), "utf8"), "shared checkout\n");
    assert.equal(await readFile(path.join(issueRuntime, "manifest.json"), "utf8"), "preserve runtime evidence\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
