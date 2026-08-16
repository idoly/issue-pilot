import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readlink, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { agentSessions, environments, issueAttachments, issueComments, issueRepositories, issues, issueWorkspaces, serviceDeploymentRepositories, serviceDeployments, serviceRepositories, services, subjects } from "../../src/db/schema.ts";
import { prepareDevelopmentIssueRuntime, prepareDevelopmentIssueRuntimes } from "../../src/workspace/development.ts";
import { WorktreeManager } from "../../src/workspace/git.ts";
import { WorkspaceConversionRefusal, WorkspaceLifecycleManager, WorkspaceReleaseRefusal, WorkspaceRestoreRefusal, type WorkspaceInspection } from "../../src/workspace/lifecycle.ts";
import { IssueProjectManager } from "../../src/workspace/project.ts";
import { classifyRepositoryState, issueAttachmentRoot, issueRuntimeRoot, issueSessionRoot, issueWorkspaceRoot } from "../../src/workspace/state.ts";

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

test("uses the central workspace retention and quota configuration", () => {
  assert.deepEqual(issuePilotConfig.workspace, {
    retentionMs: 7 * 24 * 60 * 60 * 1000,
    highWaterBytes: 20 * 1024 ** 3,
    targetBytes: 16 * 1024 ** 3,
    maintenanceIntervalMs: 15 * 60 * 1000,
  });
});

const engine = {
  running: new Set<string>(),
  closed: [] as string[],
  closeError: undefined as Error | undefined,
  enqueue() {},
  async send() {},
  isRunning(issueId: string) { return this.running.has(issueId); },
  async runExclusive<T>(_issueIds: string[], operation: (reservation: { enqueue(): void; closeSession(issueId: string): Promise<void> }) => Promise<T>) {
    return operation({ enqueue() {}, closeSession: (issueId) => this.closeSession(issueId) });
  },
  async closeSession(issueId: string) { this.closed.push(issueId); if (this.closeError) throw this.closeError; },
};

test("stops maintenance only after the active exclusive operation drains", async () => {
  const manager = new WorkspaceLifecycleManager({} as never, ".", engine as never, {
    retentionMs: Number.POSITIVE_INFINITY,
    highWaterBytes: 0,
    targetBytes: 0,
    maintenanceIntervalMs: 0,
  });
  const internal = manager as unknown as { exclusive<T>(operation: () => Promise<T>): Promise<T> };
  let operationStarted!: () => void;
  let releaseOperation!: () => void;
  const started = new Promise<void>((resolve) => { operationStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseOperation = resolve; });
  const operation = internal.exclusive(async () => {
    operationStarted();
    await gate;
  });
  await started;

  let stopped = false;
  const stop = manager.start();
  const firstStop = stop();
  assert.equal(stop(), firstStop);
  const stopping = firstStop.then(() => { stopped = true; });
  await assert.rejects(internal.exclusive(async () => undefined), /workspace_lifecycle_closing/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  releaseOperation();
  await Promise.all([operation, stopping]);
  assert.equal(stopped, true);
});

test("serializes deep inspection per Issue without blocking other Issues", async () => {
  const manager = new WorkspaceLifecycleManager({} as never, ".", engine as never, {
    retentionMs: Number.POSITIVE_INFINITY,
    highWaterBytes: 0,
    targetBytes: 0,
    maintenanceIntervalMs: 0,
  });
  const internal = manager as unknown as {
    issueRow(issueId: string): Promise<{ issue: { id: string; key: string }; workspace: null }>;
    inspectLocked(issue: { id: string; key: string }, workspace: null): Promise<WorkspaceInspection>;
  };
  internal.issueRow = async (issueId) => ({ issue: { id: issueId, key: issueId }, workspace: null });
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const inspected: string[] = [];
  internal.inspectLocked = async (issue) => {
    inspected.push(issue.id);
    if (issue.id === "issue-a" && inspected.filter((id) => id === "issue-a").length === 1) await firstGate;
    return { issueId: issue.id, issueKey: issue.key, issueStatus: "open", workspaceStatus: "not_created", resolvedAt: null, bytes: 0, releasable: false, blockedReason: "issue_not_resolved" };
  };

  const first = manager.inspectIssue("issue-a");
  const sameIssue = manager.inspectIssue("issue-a");
  const otherIssue = manager.inspectIssue("issue-b");
  await otherIssue;
  assert.deepEqual(inspected, ["issue-a", "issue-b"]);
  let stopped = false;
  const stopping = manager.start()().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  releaseFirst();
  await Promise.all([first, sameIssue, stopping]);
  assert.deepEqual(inspected, ["issue-a", "issue-b", "issue-a"]);
  assert.equal(stopped, true);
});

test("shares one active Workspace statistics scan across concurrent callers", async () => {
  const manager = new WorkspaceLifecycleManager({} as never, ".", engine as never, {
    retentionMs: Number.POSITIVE_INFINITY,
    highWaterBytes: 0,
    targetBytes: 0,
    maintenanceIntervalMs: 0,
  });
  const internal = manager as unknown as {
    issueRows(): Promise<Array<{ issue: { id: string; key: string }; workspace: null }>>;
    inspectLocked(issue: { id: string; key: string }, workspace: null): Promise<WorkspaceInspection>;
  };
  internal.issueRows = async () => [{ issue: { id: "issue-a", key: "ISSUE-20260814-001" }, workspace: null }];
  let releaseFirst!: () => void;
  let markStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let inspections = 0;
  internal.inspectLocked = async (issue) => {
    inspections += 1;
    if (inspections === 1) {
      markStarted();
      await firstGate;
    }
    return { issueId: issue.id, issueKey: issue.key, issueStatus: "open", workspaceStatus: "not_created", resolvedAt: null, bytes: 0, releasable: false, blockedReason: "issue_not_resolved" };
  };

  const first = manager.stats();
  const second = manager.stats();
  await started;
  assert.equal(inspections, 1);
  releaseFirst();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(secondResult, firstResult);
  assert.equal(inspections, 1);

  await manager.stats();
  assert.equal(inspections, 2);
});

test("isolates maintenance reporter failures", async () => {
  const manager = new WorkspaceLifecycleManager({} as never, ".", engine as never, {
    retentionMs: Number.POSITIVE_INFINITY,
    highWaterBytes: 0,
    targetBytes: 0,
    maintenanceIntervalMs: 1,
  });
  let reports = 0;
  const stop = manager.start(() => {
    reports += 1;
    throw new Error("logger_failed");
  });
  while (!reports) await new Promise((resolve) => setTimeout(resolve, 1));
  await stop();
  assert.ok(reports >= 1);
});

test("releases clean workspaces while preserving attachments, sessions, and branches", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-lifecycle-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  try {
    const [environment] = await database.db.select().from(environments).where(eq(environments.key, "dev")).limit(1);
    assert.ok(environment);
    await database.db.insert(subjects).values({ subject: "tester", displayName: "Tester", email: "tester@example.test" });
    const [service] = await database.db.insert(services).values({ key: "workspace-test", name: "Workspace Test" }).returning();
    await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: environment.id, config: {} });
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
    await database.db.insert(issueWorkspaces).values({ issueId: issue!.id, status: "ready", runtimeReady: true });

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

    const prepareRuntime = (candidate: { id: string; key: string }) => prepareDevelopmentIssueRuntime(database.db, root, candidate);
    const runtimePreparation = await prepareDevelopmentIssueRuntimes(database.db, root);
    assert.deepEqual(runtimePreparation, { prepared: [issue!.key], blocked: [] });
    const wrapperRoot = path.join(issueRuntimeRoot(root, issue!.key), "bin");
    assert.equal((await stat(wrapperRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(wrapperRoot, "node-project"))).mode & 0o777, 0o700);
    const activeRuntime = issueRuntimeRoot(root, issue!.key);
    assert.equal(path.resolve(activeRuntime, await readlink(path.join(activeRuntime, "alpha"))), prepared[0]!.workspacePath);
    assert.equal(path.resolve(activeRuntime, await readlink(path.join(activeRuntime, "beta"))), prepared[1]!.workspacePath);

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
    }, prepareRuntime);
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
    assert.equal(await readFile(durableAttachment, "utf8"), attachmentContent);
    assert.equal(await readFile(sessionFile, "utf8"), "{}\n");
    assert.deepEqual(engine.closed, [issue!.id]);

    const releasedRows = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    assert.equal(releasedRows.every((repository) => repository.localPath === null), true);
    assert.deepEqual(releasedRows.map((repository) => repository.workspaceName), ["alpha", "beta"]);
    assert.equal(releasedRows.every((repository) => repository.workingBranch?.startsWith("hotfix-") && repository.commitBefore), true);
    const [releasedWorkspace] = await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, issue!.id));
    assert.equal(releasedWorkspace!.status, "stopped");
    assert.equal(releasedWorkspace!.runtimeReady, true);
    for (const [index, repository] of releasedRows.entries()) {
      const runtimeRepository = path.join(issueRuntimeRoot(root, issue!.key), index === 0 ? "alpha" : "beta");
      const repositoryRoot = path.join(root, "git", "repositories", createHash("sha256").update(repository.url).digest("hex").slice(0, 20));
      assert.equal(await git(["-C", runtimeRepository, "rev-parse", "HEAD"]), await git(["-C", repositoryRoot, "rev-parse", `refs/heads/${repository.workingBranch}`]));
    }
    const [sessionBinding] = await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue!.id));
    assert.equal(sessionBinding!.sessionFile, sessionFile);
    engine.closeError = new Error("stop_failed");
    await assert.rejects(lifecycle.releaseIssue(issue!.id), /stop_failed/);
    assert.equal(classifyRepositoryState(await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id))), "development_snapshot");
    assert.equal((await database.db.select().from(issues).where(eq(issues.id, issue!.id)).limit(1))[0]!.status, "resolved");
    engine.closeError = undefined;
    assert.equal((await lifecycle.releaseIssue(issue!.id)).alreadyReleased, true);

    engine.closeError = new Error("stop_failed");
    await assert.rejects(lifecycle.reopenIssue(issue!.id), /stop_failed/);
    assert.equal((await database.db.select().from(issues).where(eq(issues.id, issue!.id)).limit(1))[0]!.status, "resolved");
    await assert.rejects(access(issueWorkspaceRoot(root, issue!.key)));
    engine.closeError = undefined;

    const lifecycleDatabase = (lifecycle as unknown as { database: { transaction<T>(operation: (transaction: unknown) => Promise<T>): Promise<T> } }).database;
    const runTransaction = lifecycleDatabase.transaction.bind(lifecycleDatabase);
    let failRestoreTransaction = true;
    lifecycleDatabase.transaction = (async (operation) => {
      if (failRestoreTransaction) {
        failRestoreTransaction = false;
        throw new Error("simulated_restore_transaction_failure");
      }
      return runTransaction(operation);
    }) as typeof lifecycleDatabase.transaction;
    await assert.rejects(lifecycle.reopenIssue(issue!.id), (error: unknown) => error instanceof WorkspaceRestoreRefusal && error.reason === "simulated_restore_transaction_failure");
    lifecycleDatabase.transaction = runTransaction;
    await assert.rejects(access(issueWorkspaceRoot(root, issue!.key)));
    assert.equal((await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id))).every((repository) => repository.localPath === null), true);

    const reopenedIssue = await lifecycle.reopenIssue(issue!.id);
    assert.equal(reopenedIssue.status, "open");
    assert.equal(reopenedIssue.resolvedAt, null);
    const restoredRows = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    assert.equal(restoredRows.every((repository) => repository.localPath?.startsWith(issueWorkspaceRoot(root, issue!.key))), true);
    assert.deepEqual(restoredRows.map((repository) => repository.workspaceName), ["alpha", "beta"]);
    for (const repository of restoredRows) {
      assert.equal(await git(["-C", repository.localPath!, "branch", "--show-current"]), repository.workingBranch);
    }
    const restoredFile = path.join(issueRuntimeRoot(root, issue!.key), "alpha", "restored.txt");
    await writeFile(restoredFile, "writable again\n", "utf8");
    assert.equal(await readFile(path.join(issueWorkspaceRoot(root, issue!.key), "alpha", "restored.txt"), "utf8"), "writable again\n");
    await unlink(restoredFile);
    const [restoredWorkspace] = await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, issue!.id));
    assert.equal(restoredWorkspace!.status, "ready");
    assert.equal(restoredWorkspace!.runtimeReady, true);
    assert.equal((await lifecycle.inspectIssue(issue!.id)).blockedReason, "issue_not_resolved");
    await assert.rejects(lifecycle.releaseIssue(issue!.id), (error: unknown) => error instanceof WorkspaceReleaseRefusal && error.reason === "issue_not_resolved");
    await Promise.all(restoredRows.map((repository) => access(repository.localPath!)));

    await database.db.update(issueRepositories).set({ workspaceName: "mismatched-name" }).where(eq(issueRepositories.id, restoredRows[0]!.id));
    await database.db.update(issues).set({ status: "resolved", resolvedAt: new Date(0) }).where(eq(issues.id, issue!.id));
    assert.equal((await lifecycle.inspectIssue(issue!.id)).blockedReason, "workspace_path_does_not_match_repository");
    await assert.rejects(lifecycle.releaseIssue(issue!.id), (error: unknown) => error instanceof WorkspaceReleaseRefusal && error.reason === "workspace_path_does_not_match_repository");
    await database.db.update(issueRepositories).set({ workspaceName: "alpha" }).where(eq(issueRepositories.id, restoredRows[0]!.id));
    const lifecycleWorktrees = (lifecycle as unknown as { worktrees: WorktreeManager }).worktrees;
    const removeWorktree = lifecycleWorktrees.remove.bind(lifecycleWorktrees);
    let removalCount = 0;
    lifecycleWorktrees.remove = async (url, workspacePath) => {
      removalCount += 1;
      if (removalCount === 2) await writeFile(path.join(workspacePath, "concurrent-change.txt"), "preserve\n", "utf8");
      return removeWorktree(url, workspacePath);
    };
    await assert.rejects(lifecycle.releaseIssue(issue!.id), (error: unknown) => error instanceof WorkspaceReleaseRefusal && error.reason === "workspace_has_changes");
    lifecycleWorktrees.remove = removeWorktree;
    for (const repository of restoredRows) {
      await access(repository.localPath!);
      assert.equal(await git(["-C", repository.localPath!, "branch", "--show-current"]), repository.workingBranch);
    }
    const concurrentChange = path.join(restoredRows[1]!.localPath!, "concurrent-change.txt");
    assert.equal(await readFile(concurrentChange, "utf8"), "preserve\n");
    await unlink(concurrentChange);
    const rowsAfterRollback = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    assert.deepEqual(rowsAfterRollback.map((repository) => repository.localPath).sort(), restoredRows.map((repository) => repository.localPath).sort());

    removalCount = 0;
    const concurrentRootEntry = path.join(issueWorkspaceRoot(root, issue!.key), "concurrent-root.txt");
    lifecycleWorktrees.remove = async (url, workspacePath) => {
      removalCount += 1;
      const commit = await removeWorktree(url, workspacePath);
      if (removalCount === restoredRows.length) await writeFile(concurrentRootEntry, "preserve root entry\n", "utf8");
      return commit;
    };
    await assert.rejects(lifecycle.releaseIssue(issue!.id), (error: unknown) => error instanceof WorkspaceReleaseRefusal && error.reason === "workspace_has_untracked_files");
    lifecycleWorktrees.remove = removeWorktree;
    assert.equal(await readFile(concurrentRootEntry, "utf8"), "preserve root entry\n");
    await Promise.all(restoredRows.map((repository) => access(repository.localPath!)));
    await unlink(concurrentRootEntry);

    const lifecycleInternal = lifecycle as unknown as { markReleased(issueId: string): Promise<void> };
    const markReleased = lifecycleInternal.markReleased.bind(lifecycle);
    lifecycleInternal.markReleased = async () => { throw new Error("simulated_release_transaction_failure"); };
    await assert.rejects(lifecycle.releaseIssue(issue!.id), /simulated_release_transaction_failure/);
    lifecycleInternal.markReleased = markReleased;
    for (const repository of restoredRows) {
      await access(repository.localPath!);
      assert.equal(await git(["-C", repository.localPath!, "branch", "--show-current"]), repository.workingBranch);
    }
    const rowsAfterTransactionRollback = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    assert.deepEqual(rowsAfterTransactionRollback.map((repository) => repository.localPath).sort(), restoredRows.map((repository) => repository.localPath).sort());

    const restoredByUrl = new Map(restoredRows.map((repository) => [repository.url, repository]));
    const missingRepository = restoredByUrl.get(remotes[1]!)!;
    await worktrees.remove(missingRepository.url, missingRepository.localPath!);
    assert.equal((await lifecycle.inspectIssue(issue!.id)).blockedReason, "workspace_repository_missing");
    await assert.rejects(lifecycle.releaseIssue(issue!.id), (error: unknown) => error instanceof WorkspaceReleaseRefusal && error.reason === "workspace_repository_missing");
    await access(restoredByUrl.get(remotes[0]!)!.localPath!);
    const repairedRepository = await worktrees.prepare({
      issueKey: issue!.key,
      workspaceName: "beta",
      url: missingRepository.url,
      baseBranch: missingRepository.baseBranch,
      mode: "hotfix",
      workingBranch: missingRepository.workingBranch!,
      existingBaseCommit: missingRepository.commitBefore!,
    });
    assert.equal(repairedRepository.workspacePath, missingRepository.localPath);

    await database.db.update(issueRepositories).set({ localPath: null }).where(eq(issueRepositories.id, missingRepository.id));
    assert.equal((await lifecycle.inspectIssue(issue!.id)).blockedReason, "development_repository_state_invalid");
    await assert.rejects(lifecycle.releaseIssue(issue!.id), (error: unknown) => error instanceof WorkspaceReleaseRefusal && error.reason === "development_repository_state_invalid");
    await Promise.all(restoredRows.map((repository) => access(repository.localPath!)));
    await database.db.update(issueRepositories).set({ localPath: missingRepository.localPath }).where(eq(issueRepositories.id, missingRepository.id));

    await database.db.delete(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    assert.equal((await lifecycle.inspectIssue(issue!.id)).blockedReason, "development_repository_state_invalid");
    await assert.rejects(lifecycle.releaseIssue(issue!.id), (error: unknown) => error instanceof WorkspaceReleaseRefusal && error.reason === "development_repository_state_invalid");
    await Promise.all(restoredRows.map((repository) => access(repository.localPath!)));
    await database.db.insert(issueRepositories).values(restoredRows);

    await database.db.update(issues).set({ status: "resolved", resolvedAt: new Date(0) }).where(eq(issues.id, issue!.id));
    for (const repository of restoredRows) await worktrees.remove(repository.url, repository.localPath!);
    await rm(issueWorkspaceRoot(root, issue!.key), { recursive: true, force: true });
    await database.db.update(issueWorkspaces).set({ status: "running" }).where(eq(issueWorkspaces.issueId, issue!.id));
    await assert.rejects(lifecycle.releaseIssue(issue!.id), (error: unknown) => error instanceof WorkspaceReleaseRefusal && error.reason === "workspace_busy");
    assert.equal(classifyRepositoryState(await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id))), "development_workspace");
    await database.db.update(issueWorkspaces).set({ status: "ready" }).where(eq(issueWorkspaces.issueId, issue!.id));
    assert.equal((await lifecycle.releaseIssue(issue!.id)).alreadyReleased, true);
    const interruptedRows = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    assert.equal(classifyRepositoryState(interruptedRows), "development_snapshot");
    assert.equal((await lifecycle.reopenIssue(issue!.id)).status, "open");

    await database.db.update(issues).set({ status: "resolved", resolvedAt: new Date(0) }).where(eq(issues.id, issue!.id));
    assert.equal((await lifecycle.releaseIssue(issue!.id)).alreadyReleased, false);

    const reconstruct = async () => {
      const repositories = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
      const reconstructed = [];
      for (const repository of repositories) {
        const workspaceName = repository.url === remotes[0] ? "alpha" : "beta";
        const restored = await worktrees.prepare({
          issueKey: issue!.key,
          workspaceName,
          url: repository.url,
          baseBranch: repository.baseBranch,
          mode: "hotfix",
          workingBranch: repository.workingBranch!,
          existingBaseCommit: repository.commitBefore!,
        });
        await database.db.update(issueRepositories).set({ localPath: restored.workspacePath }).where(eq(issueRepositories.id, repository.id));
        assert.equal(await git(["-C", restored.workspacePath, "branch", "--show-current"]), repository.workingBranch);
        reconstructed.push(restored);
      }
      return reconstructed;
    };

    await reconstruct();
    const retentionLifecycle = new WorkspaceLifecycleManager(database.db, root, engine as never, {
      retentionMs: 0,
      highWaterBytes: 0,
      targetBytes: 0,
      maintenanceIntervalMs: 0,
    }, prepareRuntime);
    const retention = await retentionLifecycle.maintain();
    assert.deepEqual(retention.released.map(({ issueKey }) => issueKey), [issue!.key]);

    await reconstruct();
    const quotaLifecycle = new WorkspaceLifecycleManager(database.db, root, engine as never, {
      retentionMs: Number.POSITIVE_INFINITY,
      highWaterBytes: 1,
      targetBytes: 0,
      maintenanceIntervalMs: 0,
    }, prepareRuntime);
    const quota = await quotaLifecycle.maintain();
    assert.deepEqual(quota.released.map(({ issueKey }) => issueKey), [issue!.key]);
    await assert.rejects(access(path.dirname(prepared[0]!.workspacePath)));

    const [prodEnvironment] = await database.db.select().from(environments).where(eq(environments.kind, "prod")).limit(1);
    await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: prodEnvironment!.id, config: {} });
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
    await database.db.insert(issueWorkspaces).values({ issueId: readOnlyIssue!.id, status: "ready", runtimeReady: true });
    await database.db.insert(issueRepositories).values({ issueId: readOnlyIssue!.id, url: remotes[0]!, baseBranch: "main", workingBranch: null, localPath: null, commitBefore: "a".repeat(40) });
    const readOnlyMaintenance = await retentionLifecycle.maintain();
    assert.equal(readOnlyMaintenance.released.some((entry) => entry.issueKey === readOnlyIssue!.key), false);
    await assert.rejects(retentionLifecycle.releaseIssue(readOnlyIssue!.id), (error: unknown) => error instanceof WorkspaceReleaseRefusal && error.reason === "workspace_not_development");
    const [readOnlyWorkspace] = await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, readOnlyIssue!.id));
    assert.equal(readOnlyWorkspace!.runtimeReady, true);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("converts a completed production analysis to a development defect while preserving Issue evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-conversion-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  try {
    const [prodEnvironment] = await database.db.select().from(environments).where(eq(environments.kind, "prod")).limit(1);
    const [devEnvironment] = await database.db.select().from(environments).where(eq(environments.kind, "dev")).limit(1);
    assert.ok(prodEnvironment && devEnvironment);
    await database.db.insert(subjects).values({ subject: "conversion-tester", displayName: "Conversion Tester", email: "conversion@example.test" });
    const [service] = await database.db.insert(services).values({ key: "conversion-service", name: "Conversion Service" }).returning();
    const remote = await createRemote(root, "conversion");
    const [serviceRepository] = await database.db.insert(serviceRepositories).values({ serviceId: service!.id, alias: "conversion", url: remote }).returning();
    const [prodDeployment] = await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: prodEnvironment.id, config: {} }).returning();
    const [devDeployment] = await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: devEnvironment.id, config: {} }).returning();
    await database.db.insert(serviceDeploymentRepositories).values([
      { deploymentId: prodDeployment!.id, repositoryId: serviceRepository!.id, baseBranch: "main" },
      { deploymentId: devDeployment!.id, repositoryId: serviceRepository!.id, baseBranch: "main" },
    ]);
    const [issue] = await database.db.insert(issues).values({
      key: "ISSUE-20260814-101",
      title: "Production analysis found a code defect",
      description: "Preserve this analysis",
      status: "pending",
      priority: "p1",
      type: "smart_analysis",
      serviceId: service!.id,
      environmentId: prodEnvironment.id,
      reporterSubject: "conversion-tester",
    }).returning();
    await database.db.insert(issueWorkspaces).values({ issueId: issue!.id, status: "ready", runtimeReady: true });

    const worktrees = new WorktreeManager(root);
    const projects = new IssueProjectManager(database.db, root, worktrees);
    const runtimeRoot = await projects.hydrateReadOnlyRuntime(issue!, "prod");
    const sessionRoot = issueSessionRoot(root, issue!.key);
    const sessionFile = path.join(sessionRoot, "analysis.jsonl");
    await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
    await writeFile(sessionFile, "{\"type\":\"session\"}\n", { mode: 0o600 });
    await database.db.insert(agentSessions).values({ issueId: issue!.id, sessionFile, workspacePath: runtimeRoot });
    const attachmentRoot = issueAttachmentRoot(root, issue!.key);
    const attachmentFile = path.join(attachmentRoot, "evidence.txt");
    const attachmentContent = "production evidence\n";
    await mkdir(attachmentRoot, { recursive: true, mode: 0o700 });
    await writeFile(attachmentFile, attachmentContent, { mode: 0o400 });
    await database.db.insert(issueAttachments).values({
      issueId: issue!.id,
      fileName: "evidence.txt",
      mediaType: "text/plain",
      size: Buffer.byteLength(attachmentContent),
      objectKey: attachmentFile,
      sha256: createHash("sha256").update(attachmentContent).digest("hex"),
      uploadedBy: "conversion-tester",
    });
    await database.db.insert(issueComments).values({ issueId: issue!.id, authorSubject: "conversion-tester", body: "Keep this comment" });

    const conversionEngine = {
      closed: [] as string[],
      enqueued: [] as string[],
      enqueue(issueId: string) { this.enqueued.push(issueId); }, async send() {}, isRunning() { return false; },
      async runExclusive<T>(_issueIds: string[], operation: (reservation: { enqueue(issueId: string): void; closeSession(issueId: string): Promise<void> }) => Promise<T>) {
        return operation({ enqueue: (issueId) => { this.enqueue(issueId); }, closeSession: async (issueId) => { this.closed.push(issueId); } });
      },
    };
    const lifecycle = new WorkspaceLifecycleManager(database.db, root, conversionEngine as never, {
      retentionMs: Number.POSITIVE_INFINITY,
      highWaterBytes: 0,
      targetBytes: 0,
      maintenanceIntervalMs: 0,
    });

    const mutableDatabase = database.db as typeof database.db & { transaction: typeof database.db.transaction };
    const transaction = mutableDatabase.transaction.bind(mutableDatabase);
    let failFinalize = true;
    mutableDatabase.transaction = (async (operation: Parameters<typeof database.db.transaction>[0]) => {
      if (failFinalize) {
        failFinalize = false;
        throw new Error("simulated_conversion_transaction_failure");
      }
      return transaction(operation);
    }) as typeof database.db.transaction;
    await assert.rejects(lifecycle.convertIssueToDevelopment(issue!.id), (error: unknown) => error instanceof WorkspaceConversionRefusal && error.reason === "simulated_conversion_transaction_failure");
    mutableDatabase.transaction = transaction;

    const [rolledBackIssue] = await database.db.select().from(issues).where(eq(issues.id, issue!.id)).limit(1);
    const rolledBackRepositories = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    assert.equal(rolledBackIssue!.environmentId, prodEnvironment.id);
    assert.equal(rolledBackIssue!.type, "smart_analysis");
    assert.equal(classifyRepositoryState(rolledBackRepositories), "read_only");
    await assert.rejects(access(issueWorkspaceRoot(root, issue!.key)));
    assert.equal(path.resolve(runtimeRoot, await readlink(path.join(runtimeRoot, "conversion"))).startsWith(path.join(root, "git", "checkouts")), true);
    assert.equal(await readFile(sessionFile, "utf8"), "{\"type\":\"session\"}\n");
    assert.equal(await readFile(attachmentFile, "utf8"), attachmentContent);
    assert.deepEqual(conversionEngine.enqueued, []);

    const converted = await lifecycle.convertIssueToDevelopment(issue!.id);
    assert.equal(converted.environmentId, devEnvironment.id);
    assert.equal(converted.type, "defect_fix");
    assert.equal(converted.status, "pending");
    const convertedRepositories = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    assert.equal(classifyRepositoryState(convertedRepositories), "development_workspace");
    assert.equal(convertedRepositories[0]!.workingBranch, "hotfix-issue-20260814-101");
    assert.equal(await git(["-C", convertedRepositories[0]!.localPath!, "branch", "--show-current"]), "hotfix-issue-20260814-101");
    assert.equal(await git(["-C", convertedRepositories[0]!.localPath!, "status", "--porcelain"]), "");
    assert.equal(path.resolve(runtimeRoot, await readlink(path.join(runtimeRoot, "conversion"))), convertedRepositories[0]!.localPath);
    assert.equal((await stat(path.join(runtimeRoot, "bin", "node-project"))).mode & 0o777, 0o700);
    const [session] = await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue!.id));
    assert.equal(session!.sessionFile, sessionFile);
    assert.equal(session!.workspacePath, runtimeRoot);
    assert.equal(await readFile(sessionFile, "utf8"), "{\"type\":\"session\"}\n");
    assert.equal(await readFile(attachmentFile, "utf8"), attachmentContent);
    assert.equal((await stat(attachmentFile)).mode & 0o777, 0o400);
    assert.equal((await database.db.select().from(issueComments).where(eq(issueComments.issueId, issue!.id))).length, 1);
    assert.deepEqual(conversionEngine.closed, [issue!.id, issue!.id]);
    assert.deepEqual(conversionEngine.enqueued, [issue!.id]);
    await assert.rejects(lifecycle.convertIssueToDevelopment(issue!.id), (error: unknown) => error instanceof WorkspaceConversionRefusal && error.reason === "issue_not_convertible_to_development");
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
