import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs, { mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  assertIssueRoot,
  claimIssueRoot,
  issueRoot,
  assertManagedIssueWorkspaceLayout,
  classifyRepositoryState,
  pathExists,
  assertIssueStateLayout,
  repositoriesRoot,
  sharedCheckoutsRoot,
} from "../../src/workspace/state.ts";

import { WorktreeManager } from "../../src/workspace/git.ts";

const exec = promisify(execFile);

test("path probes distinguish missing paths from invalid directory structure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-path-probe-"));
  try {
    assert.equal(await pathExists(root), true);
    assert.equal(await pathExists(path.join(root, "missing")), false);
    const file = path.join(root, "file");
    await writeFile(file, "evidence");
    await assert.rejects(pathExists(path.join(file, "child")), { code: "ENOTDIR" });
    assert.equal(await readFile(file, "utf8"), "evidence");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("path probes propagate permission and I/O failures instead of reporting missing state", async (context) => {
  try {
    for (const code of ["EACCES", "EIO"]) {
      const failure = Object.assign(new Error("fixture filesystem failure"), { code });
      context.mock.method(fs, "access", async () => {
        throw failure;
      });
      syncBuiltinESMExports();
      await assert.rejects(pathExists("/unused-fixture-path"), (error) => error === failure);
      context.mock.restoreAll();
    }
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

async function createSharedCheckout(root: string, repositoryKey = "a".repeat(20)): Promise<string> {
  const source = path.join(root, `checkout-source-${repositoryKey}`);
  await mkdir(source, { recursive: true });
  await exec("git", ["init", "-b", "main", source]);
  await Promise.all([writeFile(path.join(source, "README.md"), "shared checkout\n", "utf8"), writeFile(path.join(source, ".gitignore"), "ignored-evidence.txt\n", "utf8")]);
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
  assert.equal(
    classifyRepositoryState([
      { localPath: null, workingBranch: "hotfix-issue-20260810-001" },
      { localPath: "/workspace/other", workingBranch: "hotfix-issue-20260810-001" },
    ]),
    "invalid",
  );
  assert.equal(classifyRepositoryState([{ localPath: null, workingBranch: "" }]), "invalid");
});

test("validates registered repositories while allowing Issue working files and directories", async () => {
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
    await writeFile(path.join(workspaceRoot, "checkpoint.json"), "{}\n");
    await assertManagedIssueWorkspaceLayout(workspaceRoot, [alpha]);
    assert.equal(await readFile(path.join(workspaceRoot, "checkpoint.json"), "utf8"), "{}\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves unmanaged Issue state and checks shared snapshots without changing them", async () => {
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
      mkdir(path.join(root, "workspaces", activeKey, "operator-evidence"), { recursive: true }),
      mkdir(path.dirname(unmanagedAttachment), { recursive: true }),
      mkdir(repositoriesRoot(root), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(root, "workspaces", activeKey, ".session-test.jsonl"), "session evidence\n"),
      writeFile(path.join(root, "workspaces", activeKey, ".attachment-test.txt"), "attachment evidence\n", { mode: 0o400 }),
      writeFile(unmanagedWorkspaceFile, "preserve workspace\n", "utf8"),
      writeFile(unmanagedAttachment, "preserve attachment\n", "utf8"),
      exec("git", ["init", "--bare", path.join(repositoriesRoot(root), "repository")]),
    ]);
    const checkout = await createSharedCheckout(root);
    const checkoutInode = (await stat(checkout)).ino;

    const checkoutRootInode = (await stat(checkoutRoot)).ino;
    await assert.rejects(assertIssueStateLayout(root, ["ISSUE-20260807-001"]), /unmanaged_issue_state:issues\/issue-20260807-002,workspaces\/issue-20260807-002/);
    assert.equal(await readFile(unmanagedWorkspaceFile, "utf8"), "preserve workspace\n");
    assert.equal(await readFile(unmanagedAttachment, "utf8"), "preserve attachment\n");
    assert.equal((await stat(path.join(root, "workspaces", activeKey, "operator-evidence"))).isDirectory(), true);
    assert.equal((await stat(checkoutRoot)).isDirectory(), true);

    await Promise.all([rm(path.join(root, "workspaces", unmanagedKey), { recursive: true }), rm(path.join(root, "issues", unmanagedKey), { recursive: true })]);
    await assertIssueStateLayout(root, ["ISSUE-20260807-001"]);
    await WorktreeManager.assertSharedState(root);
    assert.equal((await stat(path.join(root, "workspaces", activeKey, "repository"))).isDirectory(), true);
    assert.equal(await readFile(path.join(root, "workspaces", activeKey, ".session-test.jsonl"), "utf8"), "session evidence\n");
    assert.equal(await readFile(path.join(root, "workspaces", activeKey, ".attachment-test.txt"), "utf8"), "attachment evidence\n");
    assert.equal((await stat(path.join(root, "workspaces", activeKey, "operator-evidence"))).isDirectory(), true);
    assert.equal((await stat(checkoutRoot)).ino, checkoutRootInode);
    assert.equal((await stat(checkout)).ino, checkoutInode);
    assert.equal(await readFile(path.join(checkout, "README.md"), "utf8"), "shared checkout\n");
    assert.deepEqual(await readdir(checkoutRoot), [path.basename(path.dirname(checkout))]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves unowned repositories disguised as shared checkouts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-unowned-checkout-state-"));
  const issueRuntime = path.join(root, "workspaces", "issue-20260807-001");
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

    await assert.rejects(WorktreeManager.assertSharedState(root), /shared_checkout_changed/);
    assert.equal(await readFile(path.join(managedCheckout, "README.md"), "utf8"), "shared checkout\n");
    assert.equal(await readFile(path.join(issueRuntime, "manifest.json"), "utf8"), "preserve runtime evidence\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves changed shared checkouts and generated runtimes as evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-shared-checkout-state-"));
  const issueRuntime = path.join(root, "workspaces", "issue-20260807-001");
  try {
    await Promise.all([mkdir(issueRuntime, { recursive: true }), mkdir(repositoriesRoot(root), { recursive: true }), mkdir(path.join(root, "workspaces"), { recursive: true })]);
    const checkout = await createSharedCheckout(root);
    const cleanCheckout = await createSharedCheckout(root, "b".repeat(20));
    const evidence = path.join(checkout, "ignored-evidence.txt");
    await writeFile(evidence, "preserve checkout evidence\n", "utf8");
    await writeFile(path.join(issueRuntime, "manifest.json"), "preserve runtime evidence\n", "utf8");

    await assert.rejects(WorktreeManager.assertSharedState(root), /shared_checkout_changed/);
    assert.equal(await readFile(evidence, "utf8"), "preserve checkout evidence\n");
    assert.equal(await readFile(path.join(cleanCheckout, "README.md"), "utf8"), "shared checkout\n");
    assert.equal(await readFile(path.join(issueRuntime, "manifest.json"), "utf8"), "preserve runtime evidence\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a shared snapshot with a changed registration and preserves both pointers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-shared-checkout-binding-"));
  try {
    const checkout = await createSharedCheckout(root);
    const gitDirectory = (await exec("git", ["-C", checkout, "rev-parse", "--absolute-git-dir"])).stdout.trim();
    const backPointer = path.join(gitDirectory, "gitdir");
    const wrongPointer = path.join(root, "preserve-other-registration", ".git") + "\n";
    const checkoutPointer = await readFile(path.join(checkout, ".git"), "utf8");
    await writeFile(backPointer, wrongPointer);
    await assert.rejects(WorktreeManager.assertSharedState(root), /shared_checkout_changed/);
    assert.equal(await readFile(backPointer, "utf8"), wrongPointer);
    assert.equal(await readFile(path.join(checkout, ".git"), "utf8"), checkoutPointer);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable Issue root validation rejects redirected and non-directory roots without changing their targets", async () => {
  const state = await mkdtemp(path.join(tmpdir(), "issue-pilot-root-validation-"));
  const key = "ISSUE-20261107-801";
  const root = issueRoot(state, key),
    target = path.join(state, "evidence");
  try {
    await assert.rejects(assertIssueRoot(state, key), { message: "issue_root_missing" });
    await claimIssueRoot(state, key);
    assert.equal(await assertIssueRoot(state, key), root);
    await rm(root, { recursive: true });
    await writeFile(root, "preserve file");
    await assert.rejects(assertIssueRoot(state, key), { message: "invalid_issue_root" });
    assert.equal(await readFile(root, "utf8"), "preserve file");
    await rm(root);
    await mkdir(target, { mode: 0o750 });
    await writeFile(path.join(target, "evidence.txt"), "preserve target");
    const mode = (await stat(target)).mode;
    await symlink(target, root);
    await assert.rejects(assertIssueRoot(state, key), { message: "invalid_issue_root" });
    await rm(root);
    await rmdir(path.dirname(root));
    await mkdir(path.join(target, path.basename(root)));
    await symlink(target, path.dirname(root));
    await assert.rejects(assertIssueRoot(state, key), { message: "invalid_issue_root" });
    assert.equal((await stat(target)).mode, mode);
    assert.equal(await readFile(path.join(target, "evidence.txt"), "utf8"), "preserve target");
  } finally {
    await rm(state, { recursive: true, force: true });
  }
});

test("durable Issue root validation preserves filesystem errors other than missing state", async (context) => {
  try {
    for (const code of ["EACCES", "EIO", "ENOTDIR"]) {
      const failure = Object.assign(new Error("fixture filesystem failure"), { code });
      context.mock.method(fs, "lstat", async () => {
        throw failure;
      });
      syncBuiltinESMExports();
      await assert.rejects(assertIssueRoot("/unused-fixture", "ISSUE-20261107-801"), (error) => error === failure);
      context.mock.restoreAll();
    }
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
