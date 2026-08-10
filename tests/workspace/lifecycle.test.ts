import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";

import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { agentSessions, environments, issueAttachments, issueRepositories, issues, issueWorkspaces, services, subjects } from "../../src/db/schema.ts";
import { prepareDevelopmentIssueRuntimes } from "../../src/workspace/development.ts";
import { WorktreeManager } from "../../src/workspace/git.ts";
import { WorkspaceLifecycleManager, WorkspaceReleaseRefusal, workspacePolicyFromEnvironment } from "../../src/workspace/lifecycle.ts";
import { issueAttachmentRoot, issueRoot, issueRuntimeRoot, issueSessionRoot, issueWorkspaceLink } from "../../src/workspace/state.ts";

const execFileAsync = promisify(execFile);

async function git(args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { encoding: "utf8" })).stdout.trim();
}

async function createRemote(root: string, name: string): Promise<string> {
  const source = path.join(root, `${name}-source`);
  const remote = path.join(root, `${name}.git`);
  await git(["init", "-b", "main", source]);
  await writeFile(path.join(source, "README.md"), `${name}\n`, "utf8");
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "initial"]);
  await git(["clone", "--bare", source, remote]);
  return remote;
}

test("validates workspace retention and quota environment settings", () => {
  const policy = workspacePolicyFromEnvironment({
    ISSUE_PILOT_WORKSPACE_RETENTION_HOURS: "off",
    ISSUE_PILOT_WORKSPACE_HIGH_WATER_BYTES: "1000",
    ISSUE_PILOT_WORKSPACE_MAINTENANCE_MINUTES: "0",
  });
  assert.equal(policy.retentionMs, Number.POSITIVE_INFINITY);
  assert.equal(policy.highWaterBytes, 1000);
  assert.equal(policy.targetBytes, 800);
  assert.equal(policy.maintenanceIntervalMs, 0);
  assert.throws(() => workspacePolicyFromEnvironment({
    ISSUE_PILOT_WORKSPACE_HIGH_WATER_BYTES: "1000",
    ISSUE_PILOT_WORKSPACE_TARGET_BYTES: "1000",
  }), /workspace_target_must_be_below_high_water/);
});

const engine = {
  running: new Set<string>(),
  closed: [] as string[],
  enqueue() {},
  async send() {},
  isRunning(issueId: string) { return this.running.has(issueId); },
  async closeSession(issueId: string) { this.closed.push(issueId); },
};

test("releases clean workspaces while preserving attachments, sessions, and branches", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-lifecycle-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  try {
    const [environment] = await database.db.select().from(environments).where(eq(environments.key, "dev")).limit(1);
    assert.ok(environment);
    await database.db.insert(subjects).values({ subject: "tester", username: "tester", displayName: "Tester", email: "tester@example.test" });
    const [service] = await database.db.insert(services).values({ key: "workspace-test", name: "Workspace Test" }).returning();
    const [issue] = await database.db.insert(issues).values({
      key: "ISSUE-20260810-001",
      title: "Workspace lifecycle",
      description: "",
      status: "resolved",
      priority: "p2",
      type: "defect_fix",
      serviceId: service!.id,
      environmentId: environment.id,
      reporterSubject: "tester",
      resolvedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    }).returning();
    await database.db.insert(issueWorkspaces).values({ issueId: issue!.id, status: "ready", codeServerReady: true });

    const remotes = await Promise.all([createRemote(root, "alpha"), createRemote(root, "beta")]);
    const worktrees = new WorktreeManager(root);
    const prepared = [];
    for (const [index, remote] of remotes.entries()) {
      const worktree = await worktrees.prepare({ issueKey: issue!.key, workspaceName: index === 0 ? "alpha" : "beta", url: remote, baseBranch: "main", mode: "hotfix" });
      prepared.push(worktree);
      await database.db.insert(issueRepositories).values({
        issueId: issue!.id,
        url: remote,
        baseBranch: worktree.baseBranch,
        workingBranch: worktree.workingBranch,
        localPath: worktree.workspacePath,
        commitBefore: worktree.baseCommit,
      });
    }

    const sessionRoot = issueSessionRoot(root, issue!.key);
    const sessionFile = path.join(sessionRoot, "session.jsonl");
    await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
    await writeFile(sessionFile, "{}\n", { mode: 0o600 });
    await database.db.insert(agentSessions).values({ issueId: issue!.id, sessionFile, workspacePath: path.dirname(prepared[0]!.workspacePath) });

    const attachmentContent = "preserved evidence\n";
    const attachmentHash = createHash("sha256").update(attachmentContent).digest("hex");
    const attachmentRoot = issueAttachmentRoot(root, issue!.key);
    const durableAttachment = path.join(attachmentRoot, "attachment-evidence.txt");
    await mkdir(attachmentRoot, { recursive: true, mode: 0o700 });
    await writeFile(durableAttachment, attachmentContent, { mode: 0o400 });
    await database.db.insert(issueAttachments).values({
      issueId: issue!.id,
      fileName: "evidence.txt",
      mediaType: "text/plain",
      size: Buffer.byteLength(attachmentContent),
      objectKey: durableAttachment,
      sha256: attachmentHash,
      uploadedBy: "tester",
    });
    assert.equal(await readFile(durableAttachment, "utf8"), attachmentContent);
    assert.equal((await stat(durableAttachment)).mode & 0o777, 0o400);

    const runtimePreparation = await prepareDevelopmentIssueRuntimes(database.db, root);
    assert.deepEqual(runtimePreparation, { prepared: [issue!.key], blocked: [] });
    const wrapperRoot = path.join(issueRuntimeRoot(root, issue!.key), "bin");
    assert.equal((await stat(wrapperRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(wrapperRoot, "node-project"))).mode & 0o777, 0o700);
    assert.equal(path.resolve(issueRoot(root, issue!.key), await readlink(issueWorkspaceLink(root, issue!.key))), path.dirname(prepared[0]!.workspacePath));

    const unknownMetadata = path.join(path.dirname(prepared[0]!.workspacePath), ".issue-pilot", "unknown.txt");
    await mkdir(path.dirname(unknownMetadata), { recursive: true });
    await writeFile(unknownMetadata, "preserve\n", "utf8");
    const blockedPreparation = await prepareDevelopmentIssueRuntimes(database.db, root);
    assert.deepEqual(blockedPreparation, { prepared: [], blocked: [{ issueKey: issue!.key, reason: "workspace_has_untracked_files" }] });
    assert.equal(await readFile(unknownMetadata, "utf8"), "preserve\n");
    await rm(path.dirname(unknownMetadata), { recursive: true });
    assert.deepEqual(await prepareDevelopmentIssueRuntimes(database.db, root), { prepared: [issue!.key], blocked: [] });

    const lifecycle = new WorkspaceLifecycleManager(database.db, root, engine as never, {
      retentionMs: Number.POSITIVE_INFINITY,
      highWaterBytes: 0,
      targetBytes: 0,
      maintenanceIntervalMs: 0,
    });
    await writeFile(path.join(prepared[1]!.workspacePath, "untracked.txt"), "do not delete\n", "utf8");
    const dirtyInspection = await lifecycle.inspectIssue(issue!.id);
    assert.equal(dirtyInspection.releasable, false);
    assert.equal(dirtyInspection.blockedReason, "workspace_has_changes");
    await assert.rejects(lifecycle.releaseIssue(issue!.id), (error: unknown) => error instanceof WorkspaceReleaseRefusal && error.reason === "workspace_has_changes");
    await Promise.all(prepared.map((worktree) => access(worktree.workspacePath)));
    const dirtyRows = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    assert.equal(dirtyRows.every((repository) => repository.localPath !== null), true);

    await unlink(path.join(prepared[1]!.workspacePath, "untracked.txt"));
    const statsBeforeRelease = await lifecycle.stats();
    assert.equal(statsBeforeRelease.totalBytes > 0, true);
    assert.equal(statsBeforeRelease.workspaces[0]?.releasable, true);
    const released = await lifecycle.releaseIssue(issue!.id);
    assert.equal(released.alreadyReleased, false);
    assert.equal(released.releasedBytes > 0, true);
    await assert.rejects(access(path.dirname(prepared[0]!.workspacePath)));
    await assert.rejects(lstat(issueWorkspaceLink(root, issue!.key)));
    assert.equal(await readFile(durableAttachment, "utf8"), attachmentContent);
    assert.equal(await readFile(sessionFile, "utf8"), "{}\n");
    assert.deepEqual(engine.closed, [issue!.id]);

    const releasedRows = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    assert.equal(releasedRows.every((repository) => repository.localPath === null), true);
    assert.equal(releasedRows.every((repository) => repository.workingBranch?.startsWith("hotfix-") && repository.commitBefore), true);
    const [releasedWorkspace] = await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, issue!.id));
    assert.equal(releasedWorkspace!.status, "stopped");
    assert.equal(releasedWorkspace!.codeServerReady, false);
    const [sessionBinding] = await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue!.id));
    assert.equal(sessionBinding!.sessionFile, sessionFile);
    assert.equal((await lifecycle.releaseIssue(issue!.id)).alreadyReleased, true);

    const reconstruct = async () => {
      const repository = (await database.db.select().from(issueRepositories).where(eq(issueRepositories.url, remotes[0]!)).limit(1))[0]!;
      const restored = await worktrees.prepare({
        issueKey: issue!.key,
        workspaceName: "alpha",
        url: repository.url,
        baseBranch: repository.baseBranch,
        mode: "hotfix",
        workingBranch: repository.workingBranch!,
        existingBaseCommit: repository.commitBefore!,
      });
      await database.db.update(issueRepositories).set({ localPath: restored.workspacePath }).where(eq(issueRepositories.id, repository.id));
      assert.equal(await git(["-C", restored.workspacePath, "branch", "--show-current"]), repository.workingBranch);
      return restored;
    };

    await reconstruct();
    const retentionLifecycle = new WorkspaceLifecycleManager(database.db, root, engine as never, {
      retentionMs: 0,
      highWaterBytes: 0,
      targetBytes: 0,
      maintenanceIntervalMs: 0,
    });
    const retention = await retentionLifecycle.maintain();
    assert.deepEqual(retention.released.map(({ issueKey }) => issueKey), [issue!.key]);

    await reconstruct();
    const quotaLifecycle = new WorkspaceLifecycleManager(database.db, root, engine as never, {
      retentionMs: Number.POSITIVE_INFINITY,
      highWaterBytes: 1,
      targetBytes: 0,
      maintenanceIntervalMs: 0,
    });
    const quota = await quotaLifecycle.maintain();
    assert.deepEqual(quota.released.map(({ issueKey }) => issueKey), [issue!.key]);
    await assert.rejects(access(path.dirname(prepared[0]!.workspacePath)));

    const [prodEnvironment] = await database.db.select().from(environments).where(eq(environments.kind, "prod")).limit(1);
    const [readOnlyIssue] = await database.db.insert(issues).values({
      key: "ISSUE-20260810-099",
      title: "Read-only runtime",
      status: "resolved",
      type: "smart_analysis",
      serviceId: service!.id,
      environmentId: prodEnvironment!.id,
      reporterSubject: "tester",
      resolvedAt: new Date(0),
    }).returning();
    await database.db.insert(issueWorkspaces).values({ issueId: readOnlyIssue!.id, status: "ready", codeServerReady: true });
    await database.db.insert(issueRepositories).values({ issueId: readOnlyIssue!.id, url: remotes[0]!, baseBranch: "main", workingBranch: null, localPath: null, commitBefore: "a".repeat(40) });
    const readOnlyMaintenance = await retentionLifecycle.maintain();
    assert.equal(readOnlyMaintenance.released.some((entry) => entry.issueKey === readOnlyIssue!.key), false);
    const [readOnlyWorkspace] = await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, readOnlyIssue!.id));
    assert.equal(readOnlyWorkspace!.codeServerReady, true);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
