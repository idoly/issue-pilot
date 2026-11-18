import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs, { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { environments, issueRepositories, issues, serviceDeployments, services } from "../../src/db/schema.ts";
import { repositoryStorePath, WorktreeManager } from "../../src/workspace/git.ts";
import { publishIssueBranch, publishedIssueBranchFile } from "../../src/workspace/issue-git.ts";
import { claimIssueRoot, issueRoot } from "../../src/workspace/state.ts";
import { git } from "../helpers/git.ts";

const exec = promisify(execFile);

test("development Git audit distinguishes a verified legacy worktree from a released mirror with no private store", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-git-audit-"));
  try {
    const source = path.join(root, "source");
    const state = path.join(root, "state");
    await git(["init", "-b", "main", source]);
    await git(["-C", source, "commit", "--allow-empty", "-m", "initial"]);
    const manager = new WorktreeManager(state);
    const input = { issueKey: "ISSUE-20261023-001", workspaceName: "repo", url: source, baseBranch: "main", mode: "hotfix" as const };
    await claimIssueRoot(state, input.issueKey);
    const own = await manager.prepare(input);
    const releasedKey = "ISSUE-20261023-002";
    await claimIssueRoot(state, releasedKey);
    const released = await manager.prepare({ ...input, issueKey: releasedKey });
    await writeFile(path.join(released.workspacePath, "release-only.txt"), "reviewed released change");
    await git(["-C", released.workspacePath, "add", "release-only.txt"]);
    await git(["-C", released.workspacePath, "commit", "-m", "released change"]);
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
    await git(["-C", own.workspacePath, "commit", "--allow-empty", "-m", "private-only"]);
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
    const run = () => exec(process.execPath, ["scripts/check-issue-state.ts", "--state-root", state, "--development-git"]);
    await assert.rejects(run(), (error: Error & { code?: unknown; stderr?: string; stdout?: string }) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr ?? "", /ISSUE-20261023-003 [a-f0-9]{20} sharedWorktreeOnly/);
      const first = JSON.parse(error.stdout!);
      assert.equal(first.privateVerified, 2);
      assert.equal(first.sharedWorktreeOnly, 1);
      assert.equal(first.mirrorUnavailable, 1);
      return true;
    });

    await rename(released.cachePath, path.join(root, "preserved-private-store"));
    await assert.rejects(run(), (error: Error & { code?: unknown; stderr?: string; stdout?: string }) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr ?? "", /ISSUE-20261023-002 [a-f0-9]{20} sharedRefOnly/);
      const second = JSON.parse(error.stdout!);
      assert.equal(second.privateVerified, 1);
      assert.equal(second.sharedWorktreeOnly, 1);
      assert.equal(second.sharedRefOnly, 1);
      return true;
    });
    assert.equal(await git(["-C", shared, "rev-parse", `refs/heads/${released.workingBranch}`]), mirrorTip);
    await assert.rejects(git(["-C", shared, "show-ref", "--exists", `refs/heads/${own.workingBranch}`]), { code: 2 });
    assert.equal(await git(["-C", legacyPath, "branch", "--show-current"]), legacyBranch);
    // The legacy worktree is evidence: none of the audit checks or reads modified it.
    assert.equal(await git(["-C", legacyPath, "status", "--porcelain"]), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publication survives a failed marker write and never overwrites a changed shared ref", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-publication-"));
  try {
    const source = path.join(root, "source"),
      state = path.join(root, "state"),
      issueKey = "ISSUE-20261023-003";
    await git(["init", "-b", "main", source]);
    await git(["-C", source, "commit", "--allow-empty", "-m", "initial"]);
    await claimIssueRoot(state, issueKey);
    const prepared = await new WorktreeManager(state).prepare({ issueKey, workspaceName: "repo", mode: "hotfix", url: source, baseBranch: "main" });
    const shared = repositoryStorePath(state, source),
      privateStore = prepared.cachePath,
      branch = prepared.workingBranch!;
    await git(["-C", prepared.workspacePath, "commit", "--allow-empty", "-m", "private change"]);
    const rename = fs.rename;
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
    const changed = await git(["-C", shared, "commit-tree", `${original}^{tree}`, "-p", original, "-m", "external change"]);
    await git(["-C", shared, "update-ref", `refs/heads/${branch}`, changed]);
    await assert.rejects(publishIssueBranch(shared, privateStore, branch), /working_branch_changed_outside_issue/);
    assert.equal(await git(["-C", shared, "rev-parse", `refs/heads/${branch}`]), changed);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});
