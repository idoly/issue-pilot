import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs, { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { environments, issueRepositories, issues, serviceDeployments, services } from "../../src/db/schema.ts";
import { issueRepositoryStorePath, repositoryStorePath, retainedSnapshotRef, WorktreeManager } from "../../src/workspace/git.ts";
import { isolateIssueWorktree, publishIssueBranch, publishedIssueBranchFile } from "../../src/workspace/issue-git.ts";
import { ApplicationStateLease } from "../../src/workspace/state-lease.ts";
import { issueRoot } from "../../src/workspace/state.ts";

const exec = promisify(execFile);
const git = async (args: string[]) => (await exec("git", args)).stdout.trim();

test("development Git audit distinguishes a verified legacy worktree from a released mirror with no private store", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-git-audit-"));
  try {
    const source = path.join(root, "source");
    const state = path.join(root, "state");
    await git(["init", "-b", "main", source]);
    await git(["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "initial"]);
    const manager = new WorktreeManager(state);
    const input = { issueKey: "ISSUE-20261023-001", workspaceName: "repo", url: source, baseBranch: "main", mode: "hotfix" as const };
    const own = await manager.prepare(input);
    const releasedKey = "ISSUE-20261023-002";
    const released = await manager.prepare({ ...input, issueKey: releasedKey });
    await writeFile(path.join(released.workspacePath, "release-only.txt"), "reviewed released change");
    await git(["-C", released.workspacePath, "add", "release-only.txt"]);
    await git(["-C", released.workspacePath, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "released change"]);
    const mirrorTip = await manager.remove(source, released.workspacePath, released.workingBranch!);
    const shared = repositoryStorePath(state, source);
    const legacyKey = "ISSUE-20261023-003";
    const legacyPath = path.join(issueRoot(state, legacyKey), "repo");
    const legacyBranch = "hotfix-issue-20261023-003";
    await mkdir(path.dirname(legacyPath));
    await git(["-C", shared, "worktree", "add", "--relative-paths", "-b", legacyBranch, legacyPath, own.baseCommit]);
    await git(["-C", shared, "config", `branch.${legacyBranch}.remote`, "origin"]);
    await git(["-C", shared, "config", `branch.${legacyBranch}.merge`, "refs/heads/main"]);
    await git(["-C", shared, "config", `branch.${legacyBranch}.vscode-merge-base`, "origin/main"]);
    await git(["-C", shared, "config", "core.logallrefupdates", "true"]);
    await git(["-C", shared, "config", "core.hooksPath", "legacy-hooks"]);
    await git(["-C", shared, "config", "user.name", "Legacy operator"]);
    await git(["-C", own.workspacePath, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "private-only"]);
    const privateTip = await git(["-C", own.cachePath, "rev-parse", `refs/heads/${own.workingBranch}`]);
    assert.notEqual(privateTip, own.baseCommit);
    const database = await openApplicationDatabase(path.join(state, "issues.db"));
    try {
      const [environment] = await database.db.select().from(environments).where(eq(environments.key, "dev"));
      const [service] = await database.db.insert(services).values({ key: "audit", name: "Audit" }).returning();
      await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: environment!.id, config: {} });
      for (const [key, workingBranch, localPath] of [
        [input.issueKey, own.workingBranch, own.workspacePath],
        [releasedKey, released.workingBranch, null],
        [legacyKey, legacyBranch, legacyPath],
      ] as const) {
        const [issue] = await database.db
          .insert(issues)
          .values({ key, title: key, type: "defect_fix", serviceId: service!.id, environmentId: environment!.id, reporterSubject: issuePilotConfig.bootstrapUser.subject })
          .returning();
        await database.db.insert(issueRepositories).values({ issueId: issue!.id, url: source, baseBranch: "main", workingBranch, localPath, workspaceName: "repo", commitBefore: own.baseCommit });
      }
    } finally {
      await database.close();
    }
    const run = () => exec(process.execPath, ["--experimental-strip-types", "scripts/check-issue-state.ts", "--state-root", state, "--development-git"]);
    const { stdout, stderr } = await run();
    assert.equal(stderr, "");
    const first = JSON.parse(stdout);
    assert.equal(first.privateVerified, 2);
    assert.equal(first.sharedWorktreeVerified, 1);
    assert.equal(first.mirrorUnavailable, 1);

    await rename(released.cachePath, path.join(root, "preserved-private-store"));
    await assert.rejects(run(), (error: Error & { code?: unknown; stderr?: string; stdout?: string }) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr ?? "", /ISSUE-20261023-002 [a-f0-9]{20} sharedRefOnly/);
      const second = JSON.parse(error.stdout!);
      assert.equal(second.privateVerified, 1);
      assert.equal(second.sharedWorktreeVerified, 1);
      assert.equal(second.sharedRefOnly, 1);
      return true;
    });
    assert.equal(await git(["-C", shared, "rev-parse", `refs/heads/${released.workingBranch}`]), mirrorTip);
    await assert.rejects(git(["-C", shared, "show-ref", "--exists", `refs/heads/${own.workingBranch}`]), { code: 2 });
    assert.equal(await git(["-C", legacyPath, "branch", "--show-current"]), legacyBranch);

    await writeFile(path.join(legacyPath, "dirty.txt"), "staged");
    await git(["-C", legacyPath, "add", "dirty.txt"]);
    await writeFile(path.join(legacyPath, "dirty.txt"), "unstaged");
    await writeFile(path.join(legacyPath, "untracked.txt"), "untracked");
    const status = await git(["-C", legacyPath, "status", "--porcelain"]);
    const pointerFile = path.join(legacyPath, ".git");
    const pointer = await readFile(pointerFile, "utf8");
    const legacyStore = issueRepositoryStorePath(state, legacyKey, source);
    const manifest = path.join(root, "manifest.json");
    const migrate = (...args: string[]) => exec(process.execPath, ["--experimental-strip-types", "scripts/migrate-development-git.ts", "--state-root", state, "--manifest", manifest, ...args]);
    const legacyEntry = { issue: legacyKey, repository: path.basename(shared), branch: legacyBranch, sharedCommit: own.baseCommit };
    const releasedEntry = { issue: releasedKey, repository: path.basename(shared), branch: released.workingBranch, sharedCommit: mirrorTip };
    const approvedReleased = { ...releasedEntry, releasedEvidence: "Fixture release record includes this exact commit" };
    const setManifest = (...entries: object[]) => writeFile(manifest, JSON.stringify(entries));
    const noWrites = async () => {
      assert.equal(await readFile(pointerFile, "utf8"), pointer);
      await assert.rejects(lstat(legacyStore), { code: "ENOENT" });
      await assert.rejects(lstat(released.cachePath), { code: "ENOENT" });
    };
    await setManifest(legacyEntry, releasedEntry);
    await assert.rejects(migrate("--apply"), /released_branch_evidence_required/);
    await noWrites();
    await setManifest(legacyEntry, { ...approvedReleased, sharedCommit: own.baseCommit });
    await assert.rejects(migrate("--apply"), /legacy_issue_branch_changed/);
    await noWrites();
    await setManifest(legacyEntry, approvedReleased);
    await git(["-C", shared, "config", "core.fsmonitor", "legacy-untrusted-command"]);
    await assert.rejects(migrate("--apply"), /workspace_git_configuration_invalid/);
    await noWrites();
    await git(["-C", shared, "config", "--unset", "core.fsmonitor"]);
    const dryRun = JSON.parse((await migrate()).stdout);
    assert.equal(dryRun.mode, "dry-run");
    assert.deepEqual(
      dryRun.entries.map((entry: { action: string }) => entry.action),
      ["isolate-worktree", "preserve-released"],
    );
    await noWrites();
    const lease = new ApplicationStateLease(state);
    await lease.start();
    try {
      await assert.rejects(migrate("--apply"), /application_state_lease_exists/);
      await noWrites();
    } finally {
      await lease.close();
    }
    // Branch drift requires inspection even when the recorded shared ref still matches the manifest.
    const metadata = path.resolve(legacyPath, pointer.slice(8).trim());
    await git(["-C", shared, "branch", "revert-fixture", own.baseCommit]);
    await writeFile(path.join(metadata, "HEAD"), "ref: refs/heads/revert-fixture\n");
    await assert.rejects(migrate("--apply"), /workspace_branch_does_not_match_issue_policy/);
    await noWrites();
    assert.equal(await git(["-C", legacyPath, "branch", "--show-current"]), "revert-fixture");
    await writeFile(path.join(metadata, "HEAD"), `ref: refs/heads/${legacyBranch}\n`);

    const databaseBefore = await readFile(path.join(state, "issues.db"));
    const apply = await migrate("--apply");
    assert.equal(apply.stdout.match(/"status":"migrated"/g)?.length, 2);
    assert.equal(await git(["-C", legacyPath, "status", "--porcelain"]), status);
    assert.equal(await git(["-C", legacyPath, "show", ":dirty.txt"]), "staged");
    assert.equal(await readFile(path.join(legacyPath, "dirty.txt"), "utf8"), "unstaged");
    assert.equal(await readFile(path.join(legacyPath, "untracked.txt"), "utf8"), "untracked");
    assert.equal(await git(["-C", shared, "rev-parse", `refs/heads/${released.workingBranch}`]), mirrorTip);
    assert.equal(await git(["-C", released.cachePath, "show", `${mirrorTip}:release-only.txt`]), "reviewed released change");
    await assert.rejects(lstat(released.workspacePath), { code: "ENOENT" });
    assert.deepEqual(await readFile(path.join(state, "issues.db")), databaseBefore);
    const repeat = JSON.parse((await migrate("--apply")).stdout);
    assert.deepEqual(
      repeat.entries.map((entry: { action: string }) => entry.action),
      ["already-private", "already-private"],
    );
    // Simulate shared ref loss and GC in the fixture. Issue-owned data still resolves locally.
    await git(["-C", shared, "update-ref", "-d", `refs/heads/${released.workingBranch}`]);
    await git(["-C", shared, "update-ref", "-d", retainedSnapshotRef(mirrorTip)]);
    await git(["-C", shared, "reflog", "expire", "--expire=now", "--all"]);
    await git(["-C", shared, "gc", "--prune=now"]);
    await assert.rejects(git(["-C", shared, "cat-file", "-t", mirrorTip]));
    assert.equal(await git(["-C", released.cachePath, "show", `${mirrorTip}:release-only.txt`]), "reviewed released change");
    assert.equal(await git(["-C", legacyPath, "show", ":dirty.txt"]), "staged");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy worktree isolation rolls back a failed switch and preserves staged, unstaged and untracked files on retry", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-git-migration-"));
  try {
    const shared = path.join(root, "shared"),
      workspace = path.join(root, "issue", "repo"),
      privateStore = path.join(root, "issue", ".issue-git-fixture");
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
    const pointerFile = path.join(workspace, ".git"),
      pointer = await readFile(pointerFile, "utf8");
    const metadata = path.resolve(workspace, pointer.slice(8).trim());
    const status = await git(["-C", workspace, "status", "--porcelain"]);
    const base = await git(["-C", shared, "rev-parse", "refs/heads/main"]);
    const rename = fs.rename,
      failure = new Error("registration move failed");
    context.mock.method(fs, "rename", (...args: Parameters<typeof fs.rename>) => {
      if (args[0] === metadata) return Promise.reject(failure);
      return rename(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(isolateIssueWorktree(shared, privateStore, workspace, branch, base), (error) => error === failure);
    context.mock.restoreAll();
    syncBuiltinESMExports();
    assert.equal(await readFile(pointerFile, "utf8"), pointer);
    assert.equal(await git(["-C", workspace, "status", "--porcelain"]), status);
    await isolateIssueWorktree(shared, privateStore, workspace, branch, base);
    await isolateIssueWorktree(shared, privateStore, workspace, branch, base);
    assert.equal(await git(["-C", workspace, "status", "--porcelain"]), status);
    assert.equal(await git(["-C", workspace, "show", ":file.txt"]), "staged");
    await git(["-C", shared, "reflog", "expire", "--expire=now", "--all"]);
    await git(["-C", shared, "gc", "--prune=now"]);
    assert.equal(await git(["-C", workspace, "show", ":file.txt"]), "staged");
    assert.equal(await readFile(path.join(workspace, "file.txt"), "utf8"), "unstaged");
    assert.equal(await readFile(path.join(workspace, "new.txt"), "utf8"), "untracked");
    await git(["-C", workspace, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "staged change"]);
    const markerFile = path.join(privateStore, publishedIssueBranchFile),
      marker = await readFile(markerFile, "utf8");
    const publicationFailure = new Error("checkpoint rename failed");
    context.mock.method(fs, "rename", (...args: Parameters<typeof fs.rename>) => (args[1] === markerFile ? Promise.reject(publicationFailure) : rename(...args)));
    syncBuiltinESMExports();
    await assert.rejects(publishIssueBranch(shared, privateStore, branch), (error) => error === publicationFailure);
    context.mock.restoreAll();
    syncBuiltinESMExports();
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
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});
