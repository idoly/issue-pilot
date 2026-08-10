import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";

import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { agentSessions, environments, issueRepositories, issues, issueWorkspaces, serviceDeployments, serviceRepositories, services, subjects } from "../../src/db/schema.ts";
import { WorktreeManager } from "../../src/workspace/git.ts";
import { migrateReadOnlyIssueWorkspaces, prepareReadOnlyIssueRuntimes } from "../../src/workspace/read-only.ts";
import { issueRuntimeRoot } from "../../src/workspace/state.ts";

const execFileAsync = promisify(execFile);

async function git(args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { encoding: "utf8" })).stdout.trim();
}

async function createRemote(root: string): Promise<string> {
  const source = path.join(root, "source");
  const remote = path.join(root, "remote.git");
  await git(["init", "-b", "main", source]);
  await writeFile(path.join(source, "README.md"), "baseline\n", "utf8");
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "initial"]);
  await git(["clone", "--bare", source, remote]);
  return remote;
}

test("startup migration removes only clean legacy read-only workspaces", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-read-only-migration-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  try {
    const remote = await createRemote(root);
    const [prod] = await database.db.select().from(environments).where(eq(environments.kind, "prod")).limit(1);
    await database.db.insert(subjects).values({ subject: "tester" });
    const [service] = await database.db.insert(services).values({ key: "orders", name: "Orders" }).returning();
    await database.db.insert(serviceRepositories).values({ serviceId: service!.id, url: remote });
    await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: prod!.id, baseBranch: "main", config: {} });
    const [cleanIssue, dirtyIssue] = await database.db.insert(issues).values([
      { key: "ISSUE-20260810-201", title: "Clean", type: "smart_analysis", serviceId: service!.id, environmentId: prod!.id, reporterSubject: "tester" },
      { key: "ISSUE-20260810-202", title: "Dirty", type: "smart_analysis", serviceId: service!.id, environmentId: prod!.id, reporterSubject: "tester" },
    ]).returning();
    await database.db.insert(issueWorkspaces).values([
      { issueId: cleanIssue!.id, status: "ready", codeServerReady: true },
      { issueId: dirtyIssue!.id, status: "ready", codeServerReady: true },
    ]);

    const worktrees = new WorktreeManager(root);
    const clean = await worktrees.prepare({ issueKey: cleanIssue!.key, workspaceName: "orders", url: remote, baseBranch: "main", mode: "detached" });
    const dirty = await worktrees.prepare({ issueKey: dirtyIssue!.key, workspaceName: "orders", url: remote, baseBranch: "main", mode: "detached" });
    await writeFile(path.join(dirty.workspacePath, "untracked.txt"), "preserve\n", "utf8");
    await database.db.insert(issueRepositories).values([
      { issueId: cleanIssue!.id, url: remote, baseBranch: "main", localPath: clean.workspacePath, commitBefore: clean.baseCommit },
      { issueId: dirtyIssue!.id, url: remote, baseBranch: "main", localPath: dirty.workspacePath, commitBefore: dirty.baseCommit },
    ]);
    await database.db.insert(agentSessions).values({ issueId: cleanIssue!.id, sessionFile: path.join(root, "clean-session.jsonl"), workspacePath: path.dirname(clean.workspacePath) });

    const result = await migrateReadOnlyIssueWorkspaces(database.db, root);
    assert.deepEqual(result.migrated, [cleanIssue!.key]);
    assert.equal(result.blocked.length, 1);
    assert.deepEqual(result.blocked[0], { issueKey: dirtyIssue!.key, reason: "obsolete_workspace_has_changes" });
    await assert.rejects(access(clean.workspacePath));
    await access(dirty.workspacePath);

    const [cleanRepository] = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, cleanIssue!.id));
    const [dirtyRepository] = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, dirtyIssue!.id));
    const [cleanWorkspace] = await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, cleanIssue!.id));
    const [cleanSession] = await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, cleanIssue!.id));
    const [dirtyWorkspace] = await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, dirtyIssue!.id));
    assert.equal(cleanRepository!.localPath, null);
    assert.equal(cleanWorkspace!.codeServerReady, false);
    assert.equal(cleanSession!.workspacePath, issueRuntimeRoot(root, cleanIssue!.key));
    assert.equal(dirtyRepository!.localPath, dirty.workspacePath);
    assert.equal(dirtyWorkspace!.codeServerReady, true);

    let codeServerPath = "";
    const runtimes = await prepareReadOnlyIssueRuntimes(database.db, root, { async ensure(_issueKey, workspacePath) { codeServerPath = workspacePath; return "http://127.0.0.1:18080"; } });
    assert.deepEqual(runtimes, { prepared: [cleanIssue!.key], blocked: [] });
    assert.equal(codeServerPath, issueRuntimeRoot(root, cleanIssue!.key));
    const [hydratedWorkspace] = await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, cleanIssue!.id));
    assert.equal(hydratedWorkspace!.codeServerReady, true);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
