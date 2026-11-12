import { buildApi } from "../../src/http/api.ts";
import { modelCatalog, TestAgentController } from "../http/fixture.ts";
import { prepareIssueRuntime } from "../../src/workspace/runtime.ts";
import { registerTestRepositories } from "../helpers/repositories.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import {
  agentSessions,
  environments,
  issueAttachments,
  issueComments,
  issueRepositories,
  issueScopeTransitions,
  issues,
  issueWorkspaces,
  serviceDeploymentRepositories,
  serviceDeployments,
  serviceRepositories,
  services,
  subjects,
} from "../../src/db/schema.ts";
import { retainedSnapshotRef, WorktreeManager } from "../../src/workspace/git.ts";
import { SourceBrowser } from "../../src/workspace/source-browser.ts";
import {
  WorkspaceConversionRefusal,
  WorkspaceLifecycleManager,
  workspaceLifecyclePolicy,
  WorkspaceReleaseRefusal,
  WorkspaceRestoreRefusal,
  WorkspaceScopeMigrationRefusal,
  type WorkspaceInspection,
} from "../../src/workspace/lifecycle.ts";
import { IssueProjectManager } from "../../src/workspace/project.ts";
import { IssueScopeTransitionManager, ScopeTransitionRefusal } from "../../src/workspace/scope-transition.ts";
import { claimIssueRoot, classifyRepositoryState, gitRoot, issueRoot } from "../../src/workspace/state.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

test("uses the central Workspace lifecycle configuration", () => {
  assert.deepEqual(workspaceLifecyclePolicy(), {
    retentionMs: 7 * 24 * 60 * 60 * 1000,
    highWaterBytes: 20 * 1024 ** 3,
    targetBytes: 16 * 1024 ** 3,
    maintenanceIntervalMs: 15 * 60 * 1000,
    taskConcurrency: 4,
  });
});

const engine = {
  running: new Set<string>(),
  closed: [] as string[],
  closeError: undefined as Error | undefined,
  enqueue() {},
  async send() {},
  isRunning(issueId: string) {
    return this.running.has(issueId);
  },
  async runExclusive<T>(_issueIds: string[], operation: (reservation: { enqueue(): void; closeSession(issueId: string): Promise<void> }) => Promise<T>) {
    return operation({ enqueue() {}, closeSession: (issueId) => this.closeSession(issueId) });
  },
  async closeSession(issueId: string) {
    this.closed.push(issueId);
    if (this.closeError) throw this.closeError;
  },
};

// The stub is shared by every test in this file; reset its mutable state so failures cannot leak.
beforeEach(() => {
  engine.running.clear();
  engine.closed.length = 0;
  engine.closeError = undefined;
});

for (const failureStage of ["session", "runtime"] as const)
  test(`automatic release isolates a ${failureStage} failure, preserves unresolved failures and retries`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-maintenance-retry-"));
    const database = await openApplicationDatabase(path.join(root, "issues.db"));
    try {
      const [environment] = await database.db.select().from(environments).where(eq(environments.kind, "dev"));
      await database.db.insert(subjects).values({ subject: "maintenance-owner", role: "developer" });
      const [service] = await database.db.insert(services).values({ key: "maintenance-retry", name: "Maintenance retry" }).returning();
      await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: environment!.id, config: {} });
      const remote = await createRemote(root, "retry");
      const worktrees = new WorktreeManager(root);
      const created: Array<typeof issues.$inferSelect> = [],
        paths: string[] = [];
      for (const index of [0, 1, 2]) {
        const [issue] = await database.db
          .insert(issues)
          .values({
            key: `ISSUE-20261024-${940 + index}`,
            title: "Maintenance retry",
            status: index === 2 ? "open" : "resolved",
            resolvedAt: index === 2 ? null : new Date(0),
            type: "defect_fix",
            serviceId: service!.id,
            environmentId: environment!.id,
            reporterSubject: "maintenance-owner",
            updatedAt: new Date(index),
          })
          .returning();
        await database.db.insert(issueWorkspaces).values({ issueId: issue!.id, status: "failed", runtimeReady: true });
        const prepared = await worktrees.prepare({ issueKey: issue!.key, workspaceName: "repo", url: remote, baseBranch: "main", mode: "hotfix" });
        await database.db.insert(issueRepositories).values({
          issueId: issue!.id,
          url: remote,
          baseBranch: "main",
          workingBranch: prepared.workingBranch,
          localPath: prepared.workspacePath,
          workspaceName: "repo",
          commitBefore: prepared.baseCommit,
        });
        created.push(issue!);
        paths.push(prepared.workspacePath);
      }
      const failure = new Error("fixture_maintenance_failed");
      let fail = true;
      const scopedEngine = {
        ...engine,
        running: new Set<string>(),
        closed: [] as string[],
        async closeSession(id: string) {
          this.closed.push(id);
          if (fail && failureStage === "session" && id === created[0]!.id) throw failure;
        },
      };
      const projects = new IssueProjectManager(database.db, root);
      const manager = new WorkspaceLifecycleManager(
        database.db,
        root,
        scopedEngine as never,
        { retentionMs: 0, highWaterBytes: 0, targetBytes: 0, maintenanceIntervalMs: 0, taskConcurrency: 1 },
        async (issue) => {
          if (fail && failureStage === "runtime" && issue.id === created[0]!.id) throw failure;
          return projects.hydrateDevelopmentRuntime(issue);
        },
      );
      const first = await manager.maintain();
      assert.deepEqual(
        first.released.map((row) => row.issueKey),
        [created[1]!.key],
      );
      assert.equal(first.failures.length, 1);
      assert.equal(first.failures[0]!.issueKey, created[0]!.key);
      assert.ok(first.failures[0]!.error === failure || (first.failures[0]!.error instanceof Error && first.failures[0]!.error.cause === failure));
      const independentlyMeasured = await new WorkspaceLifecycleManager(database.db, root, scopedEngine as never, manager.policy).stats();
      assert.equal(first.totalBytes, independentlyMeasured.totalBytes);
      assert.equal((await manager.stats()).totalBytes, independentlyMeasured.totalBytes);
      await access(paths[2]!);
      assert.equal(scopedEngine.closed.includes(created[2]!.id), false);
      if (failureStage === "session") await access(paths[0]!);
      else {
        assert.equal((await manager.inspectIssue(created[0]!.id)).blockedReason, "workspace_runtime_restore_failed");
        const [state] = await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, created[0]!.id));
        assert.equal(state!.runtimeReady, false);
      }
      fail = false;
      if (failureStage === "runtime") {
        // A stopped but still active checkout must not be deleted by view recovery.
        await database.db.update(issues).set({ status: "resolved", resolvedAt: new Date() }).where(eq(issues.id, created[2]!.id));
        await database.db.update(issueWorkspaces).set({ status: "stopped", runtimeReady: false }).where(eq(issueWorkspaces.issueId, created[2]!.id));
      }
      const retryManager =
        failureStage === "runtime"
          ? new WorkspaceLifecycleManager(database.db, root, scopedEngine as never, { retentionMs: Infinity, highWaterBytes: 0, targetBytes: 0, maintenanceIntervalMs: 0, taskConcurrency: 1 })
          : manager;
      const retried = await retryManager.maintain();
      assert.deepEqual(retried.failures, []);
      assert.equal((await retryManager.inspectIssue(created[0]!.id)).blockedReason, "workspace_released");
      await access(paths[2]!);
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

test("HTTP stays healthy during scheduled maintenance and a failed release preserves its checkout", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-startup-release-failure-"));
  const databaseFile = path.join(root, "issues.db");
  const database = await openApplicationDatabase(databaseFile);
  let closedDatabase = false;
  let app: Awaited<ReturnType<typeof buildApi>> | undefined;
  const started = deferred();
  const finish = deferred();
  try {
    const [environment] = await database.db.select().from(environments).where(eq(environments.kind, "dev"));
    await database.db.insert(subjects).values({ subject: "startup-owner", role: "developer" });
    const [service] = await database.db.insert(services).values({ key: "startup-release", name: "Startup release" }).returning();
    await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: environment!.id, config: {} });
    const [issue] = await database.db
      .insert(issues)
      .values({
        key: "ISSUE-20261024-961",
        title: "Startup release",
        status: "resolved",
        resolvedAt: new Date(0),
        type: "defect_fix",
        serviceId: service!.id,
        environmentId: environment!.id,
        reporterSubject: "startup-owner",
      })
      .returning();
    await database.db.insert(issueWorkspaces).values({ issueId: issue!.id, status: "failed", runtimeReady: true });
    const remote = await createRemote(root, "startup");
    const prepared = await new WorktreeManager(root).prepare({ issueKey: issue!.key, workspaceName: "repo", url: remote, baseBranch: "main", mode: "hotfix" });
    await database.db.insert(issueRepositories).values({
      issueId: issue!.id,
      url: remote,
      baseBranch: "main",
      workingBranch: prepared.workingBranch,
      localPath: prepared.workspacePath,
      workspaceName: "repo",
      commitBefore: prepared.baseCommit,
    });
    await database.close();
    closedDatabase = true;
    const controller = new TestAgentController();
    controller.closeSessionHook = async () => {
      started.resolve();
      await finish.promise;
      throw new Error("fixture_session_close_failed");
    };
    app = await buildApi({
      stateRoot: root,
      databaseFile,
      engine: controller,
      modelCatalog,
      logger: false,
      workspacePolicy: { retentionMs: 0, highWaterBytes: 0, targetBytes: 0, maintenanceIntervalMs: 10, taskConcurrency: 1 },
    });
    assert.deepEqual(controller.closedSessions, []);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    await started.promise;
    const response = await fetch(`${address}/health`);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(controller.closedSessions, [issue!.id]);

    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    finish.resolve();
    await closing;
    app = undefined;
    assert.equal(await readFile(path.join(prepared.workspacePath, "README.md"), "utf8"), "startup\n");
  } finally {
    finish.resolve();
    await app?.close();
    if (!closedDatabase) await database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("records an unmeasurable workspace instead of aborting the maintenance cycle", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-measure-failure-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  const measurementEngine = { ...engine, running: new Set<string>(), closed: [] as string[] };
  const originalPath = process.env.PATH;
  try {
    const [environment] = await database.db.select().from(environments).where(eq(environments.kind, "dev")).limit(1);
    await database.db.insert(subjects).values({ subject: "measure-owner", role: "developer" });
    const [service] = await database.db.insert(services).values({ key: "measure", name: "Measure" }).returning();
    await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: environment!.id, config: {} });
    const remote = await createRemote(root, "measure");
    const created: Array<typeof issues.$inferSelect> = [];
    for (const suffix of [977, 978]) {
      const [issue] = await database.db
        .insert(issues)
        .values({
          key: `ISSUE-20261026-${suffix}`,
          title: "Measurement failure",
          status: "resolved",
          resolvedAt: new Date(0),
          type: "defect_fix",
          serviceId: service!.id,
          environmentId: environment!.id,
          reporterSubject: "measure-owner",
        })
        .returning();
      await database.db.insert(issueWorkspaces).values({ issueId: issue!.id, status: "ready", runtimeReady: true });
      const prepared = await new WorktreeManager(root).prepare({ issueKey: issue!.key, workspaceName: "repo", url: remote, baseBranch: "main", mode: "hotfix" });
      await database.db.insert(issueRepositories).values({
        issueId: issue!.id,
        url: remote,
        baseBranch: "main",
        workingBranch: prepared.workingBranch,
        localPath: prepared.workspacePath,
        workspaceName: "repo",
        commitBefore: prepared.baseCommit,
      });
      created.push(issue!);
    }
    // `du` fails for the first Issue only; a single unreadable tree must not abort the whole cycle.
    const bin = path.join(root, "bin");
    await mkdir(bin, { recursive: true });
    const du = path.join(bin, "du");
    await writeFile(du, `#!/bin/sh\ncase "$3" in\n  *issue-20261026-977) echo "du unavailable" >&2; exit 2;;\nesac\nexec /usr/bin/du "$@"\n`);
    await chmod(du, 0o755);
    process.env.PATH = `${bin}:${originalPath ?? ""}`;

    const manager = new WorkspaceLifecycleManager(database.db, root, measurementEngine as never, {
      retentionMs: 0,
      highWaterBytes: 0,
      targetBytes: 0,
      maintenanceIntervalMs: 0,
      taskConcurrency: 1,
    });
    const result = await manager.maintain();
    assert.deepEqual(
      result.failures.map((failure) => failure.issueKey),
      [created[0]!.key],
    );
    assert.deepEqual(
      result.released.map((release) => release.issueKey),
      [created[1]!.key],
    );
    // Once `du` works again the next cycle is complete again.
    process.env.PATH = originalPath;
    const refreshed = await manager.maintain();
    assert.deepEqual(refreshed.failures, []);
  } finally {
    process.env.PATH = originalPath;
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("quota maintenance keeps retained Issue bytes and continues to the next worktree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-quota-accounting-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  const quotaEngine = { ...engine, running: new Set<string>(), closed: [] as string[] };
  try {
    const [environment] = await database.db.select().from(environments).where(eq(environments.kind, "dev")).limit(1);
    await database.db.insert(subjects).values({ subject: "quota-owner", role: "developer" });
    const [service] = await database.db.insert(services).values({ key: "quota", name: "Quota" }).returning();
    await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: environment!.id, config: {} });
    const remote = await createRemote(root, "quota");
    const worktrees = new WorktreeManager(root);
    const created: Array<typeof issues.$inferSelect> = [];
    for (const index of [0, 1]) {
      const [issue] = await database.db
        .insert(issues)
        .values({
          key: `ISSUE-20261023-${910 + index}`,
          title: "Quota accounting",
          status: "resolved",
          resolvedAt: new Date(0),
          type: "defect_fix",
          serviceId: service!.id,
          environmentId: environment!.id,
          reporterSubject: "quota-owner",
        })
        .returning();
      await database.db.insert(issueWorkspaces).values({ issueId: issue!.id, status: "ready", runtimeReady: true, updatedAt: new Date(index) });
      const prepared = await worktrees.prepare({ issueKey: issue!.key, workspaceName: "repo", url: remote, baseBranch: "main", mode: "hotfix" });
      await database.db.insert(issueRepositories).values({
        issueId: issue!.id,
        url: remote,
        baseBranch: "main",
        workingBranch: prepared.workingBranch,
        localPath: prepared.workspacePath,
        workspaceName: "repo",
        commitBefore: prepared.baseCommit,
      });
      if (index === 0) await writeFile(path.join(issueRoot(root, issue!.key), "retained.bin"), Buffer.alloc(4 * 1024 ** 2, 7));
      else {
        await writeFile(path.join(prepared.workspacePath, "committed.bin"), Buffer.alloc(3 * 1024 ** 2, 7));
        await git(["-C", prepared.workspacePath, "add", "committed.bin"]);
        await git(["-C", prepared.workspacePath, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "large committed file"]);
      }
      created.push(issue!);
    }
    const policy = { retentionMs: Infinity, highWaterBytes: 0, targetBytes: 0, maintenanceIntervalMs: 0, taskConcurrency: 1 };
    await writeFile(path.join(gitRoot(root), "shared-accounting-probe"), Buffer.alloc(2 * 1024 ** 2, 11));
    const initial = await new WorkspaceLifecycleManager(database.db, root, quotaEngine as never, policy).stats();
    const sharedUsage = await execFileAsync("du", ["-sk", "--", gitRoot(root)]);
    assert.equal(initial.sharedGitBytes, Number(sharedUsage.stdout.trim().split(/\s+/, 1)[0]) * 1024);
    assert.ok(initial.sharedGitBytes >= 2 * 1024 ** 2);
    assert.equal(
      initial.totalBytes,
      initial.workspaces.reduce((total, item) => total + item.bytes, 0),
    );
    const manager = new WorkspaceLifecycleManager(database.db, root, quotaEngine as never, {
      ...policy,
      highWaterBytes: initial.totalBytes - 1,
      targetBytes: initial.workspaces.find((item) => item.issueId === created[1]!.id)!.bytes,
    });
    const result = await manager.maintain();
    assert.deepEqual(
      result.released.map((item) => item.issueKey),
      created.map((item) => item.key),
    );
    const fresh = await new WorkspaceLifecycleManager(database.db, root, quotaEngine as never, policy).stats();
    assert.equal(result.totalBytes, fresh.totalBytes);
    assert.equal((await manager.stats()).totalBytes, fresh.totalBytes);
    assert.equal((await manager.stats()).sharedGitBytes, fresh.sharedGitBytes);
    assert.ok(fresh.workspaces.find((item) => item.issueId === created[0]!.id)!.bytes >= 4 * 1024 ** 2);
    assert.equal((await readFile(path.join(issueRoot(root, created[0]!.key), "retained.bin"))).length, 4 * 1024 ** 2);
    const repeated = await manager.maintain();
    assert.deepEqual(repeated.released, []);
    assert.equal(repeated.totalBytes, fresh.totalBytes);
    assert.deepEqual(Object.keys(await manager.releaseIssue(created[0]!.id)).sort(), ["alreadyReleased", "issueKey", "releasedBytes"]);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid Workspace task concurrency", () => {
  assert.throws(() => new WorkspaceLifecycleManager({} as never, ".", engine as never, { ...workspaceLifecyclePolicy(), taskConcurrency: 0 }), /workspace_task_concurrency_invalid/);
});

test("applies an updated policy to the maintenance timer without restarting the manager", async () => {
  const disabled = { retentionMs: Number.POSITIVE_INFINITY, highWaterBytes: 0, targetBytes: 0, maintenanceIntervalMs: 0, taskConcurrency: 1 };
  const manager = new WorkspaceLifecycleManager({} as never, ".", engine as never, disabled);
  let cycles = 0;
  (manager as unknown as { maintain(): Promise<unknown> }).maintain = async () => {
    cycles++;
    return { totalBytes: 0, released: [], blocked: [], failures: [] };
  };
  manager.start();
  try {
    assert.throws(() => manager.updatePolicy({ ...disabled, highWaterBytes: 10, targetBytes: 10 }), /workspace_target_must_be_below_high_water/);
    assert.deepEqual(manager.policy, disabled);
    // Listening with periodic maintenance disabled must not run an initial scan.
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(cycles, 0);
    manager.updatePolicy({ ...disabled, maintenanceIntervalMs: 5 });
    const deadline = Date.now() + 2_000;
    while (cycles < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(cycles >= 2);
    manager.updatePolicy(disabled);
    const stoppedAt = cycles;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(cycles, stoppedAt);
  } finally {
    await manager.stop();
  }
});

test("a slow maintenance pass does not start or accumulate timer work", async () => {
  const policy = { retentionMs: Infinity, highWaterBytes: 0, targetBytes: 0, maintenanceIntervalMs: 5, taskConcurrency: 1 };
  const manager = new WorkspaceLifecycleManager({} as never, ".", engine as never, policy);
  const firstPass = deferred();
  const completed = deferred();
  let cycles = 0;
  manager.maintain = async () => {
    cycles++;
    await firstPass.promise;
    return { totalBytes: 0, released: [], blocked: [], failures: [] };
  };
  manager.start(undefined, () => completed.resolve());
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(cycles, 1);
    manager.updatePolicy({ ...policy, maintenanceIntervalMs: 0 });
    firstPass.resolve();
    await completed.promise;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(cycles, 1);
  } finally {
    firstPass.resolve();
    await manager.stop();
  }
});

test("stops maintenance only after the active exclusive operation drains", async () => {
  const manager = new WorkspaceLifecycleManager({} as never, ".", engine as never, {
    retentionMs: Number.POSITIVE_INFINITY,
    highWaterBytes: 0,
    targetBytes: 0,
    maintenanceIntervalMs: 0,
    taskConcurrency: 1,
  });
  const internal = manager as unknown as { exclusive<T>(operation: () => Promise<T>): Promise<T> };
  let operationStarted!: () => void;
  let releaseOperation!: () => void;
  const started = new Promise<void>((resolve) => {
    operationStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseOperation = resolve;
  });
  const operation = internal.exclusive(async () => {
    operationStarted();
    await gate;
  });
  await started;

  let stopped = false;
  const firstStop = manager.stop();
  assert.equal(manager.stop(), firstStop);
  const stopping = firstStop.then(() => {
    stopped = true;
  });
  await assert.rejects(
    internal.exclusive(async () => undefined),
    /workspace_lifecycle_closing/,
  );
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
    taskConcurrency: 1,
  });
  const internal = manager as unknown as {
    issueRow(issueId: string): Promise<{ issue: { id: string; key: string }; workspace: null }>;
    inspectLocked(row: { issue: { id: string; key: string } }): Promise<WorkspaceInspection>;
  };
  internal.issueRow = async (issueId) => ({ issue: { id: issueId, key: issueId }, workspace: null });
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const inspected: string[] = [];
  internal.inspectLocked = async ({ issue }) => {
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
  const stopping = manager.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  releaseFirst();
  await Promise.all([first, sameIssue, stopping]);
  assert.deepEqual(inspected, ["issue-a", "issue-b", "issue-a"]);
  assert.equal(stopped, true);
});

test("shares one statistics scan, caches completed results and refreshes on request or expiry", async (context) => {
  const manager = new WorkspaceLifecycleManager({ select: () => ({ from: async () => [] }) } as never, ".", engine as never, {
    retentionMs: Number.POSITIVE_INFINITY,
    highWaterBytes: 0,
    targetBytes: 0,
    maintenanceIntervalMs: 0,
    taskConcurrency: 1,
  });
  const internal = manager as unknown as {
    issueRows(): Promise<Array<{ issue: { id: string; key: string }; workspace: null }>>;
    inspectLocked(row: { issue: { id: string; key: string } }, repositories?: unknown, knownBytes?: number): Promise<WorkspaceInspection>;
  };
  internal.issueRows = async () => [{ issue: { id: "issue-a", key: "ISSUE-20260814-001" }, workspace: null }];
  let releaseFirst!: () => void;
  let markStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let inspections = 0;
  const knownMeasurements: Array<number | undefined> = [];
  internal.inspectLocked = async ({ issue }, _repositories, knownBytes) => {
    inspections += 1;
    knownMeasurements.push(knownBytes);
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

  const cached = await manager.stats();
  assert.equal(inspections, 1);
  assert.equal(cached.sampledAt, firstResult.sampledAt);
  await manager.stats(true);
  assert.equal(inspections, 2);
  assert.deepEqual(knownMeasurements, [undefined, undefined]);
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  context.mock.timers.tick(5_001);
  await manager.stats();
  assert.equal(inspections, 3);
});

test("bounds concurrent Workspace inspections while preserving Issue order", async () => {
  const manager = new WorkspaceLifecycleManager({ select: () => ({ from: async () => [] }) } as never, ".", engine as never, {
    retentionMs: Number.POSITIVE_INFINITY,
    highWaterBytes: 0,
    targetBytes: 0,
    maintenanceIntervalMs: 0,
    taskConcurrency: 2,
  });
  const issueRows = Array.from({ length: 5 }, (_, index) => ({ issue: { id: `issue-${index}`, key: `ISSUE-20260814-10${index}` }, workspace: null }));
  const internal = manager as unknown as {
    issueRows(): Promise<typeof issueRows>;
    inspectLocked(row: { issue: { id: string; key: string } }): Promise<WorkspaceInspection>;
  };
  internal.issueRows = async () => issueRows;
  let active = 0;
  let maximumActive = 0;
  let started = 0;
  let releaseInspections!: () => void;
  let markConcurrencyReached!: () => void;
  const inspectionGate = new Promise<void>((resolve) => {
    releaseInspections = resolve;
  });
  const concurrencyReached = new Promise<void>((resolve) => {
    markConcurrencyReached = resolve;
  });
  internal.inspectLocked = async ({ issue }) => {
    active += 1;
    started += 1;
    maximumActive = Math.max(maximumActive, active);
    if (active === 2) markConcurrencyReached();
    await inspectionGate;
    active -= 1;
    return { issueId: issue.id, issueKey: issue.key, issueStatus: "open", workspaceStatus: "not_created", resolvedAt: null, bytes: 0, releasable: false, blockedReason: "issue_not_resolved" };
  };

  const statistics = manager.stats();
  await concurrencyReached;
  assert.equal(started, 2);
  assert.equal(active, 2);
  releaseInspections();
  const result = await statistics;
  assert.equal(maximumActive, 2);
  assert.deepEqual(
    result.workspaces.map(({ issueId }) => issueId),
    issueRows.map(({ issue }) => issue.id),
  );
});

test("isolates maintenance reporter failures", async () => {
  const manager = new WorkspaceLifecycleManager({} as never, ".", engine as never, {
    retentionMs: Number.POSITIVE_INFINITY,
    highWaterBytes: 0,
    targetBytes: 0,
    maintenanceIntervalMs: 1,
    taskConcurrency: 1,
  });
  let reports = 0;
  manager.start(() => {
    reports += 1;
    throw new Error("logger_failed");
  });
  for (let attempt = 0; !reports && attempt < 2_000; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(reports, "maintenance did not report");
  await manager.stop();
  assert.ok(reports >= 1);
});

test("maintenance reports each failed Issue even when the reporter itself fails", async () => {
  const manager = new WorkspaceLifecycleManager({} as never, ".", engine as never, { retentionMs: Infinity, highWaterBytes: 0, targetBytes: 0, maintenanceIntervalMs: 1, taskConcurrency: 1 });
  const first = new Error("first failure"),
    second = new Error("second failure");
  manager.maintain = async () => ({
    totalBytes: 0,
    released: [],
    blocked: [],
    failures: [
      { issueKey: "ISSUE-20261024-951", error: first },
      { issueKey: "ISSUE-20261024-952", error: second },
    ],
  });
  const reported: Error[] = [];
  manager.start((error) => {
    assert(error instanceof Error);
    reported.push(error);
    throw new Error("reporter failed");
  });
  for (let attempt = 0; reported.length < 2 && attempt < 2_000; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(reported.length, 2, "maintenance did not report both failures");
  await manager.stop();
  assert.match(reported[0]!.message, /ISSUE-20261024-951/);
  assert.equal(reported[0]!.cause, first);
  assert.match(reported[1]!.message, /ISSUE-20261024-952/);
  assert.equal(reported[1]!.cause, second);
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
    const [issue] = await database.db
      .insert(issues)
      .values({
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
      })
      .returning();
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

    const sessionRoot = issueRoot(root, issue!.key);
    const sessionFile = path.join(sessionRoot, "session.jsonl");
    await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
    await writeFile(sessionFile, "{}\n", { mode: 0o600 });
    await database.db.insert(agentSessions).values({ issueId: issue!.id, sessionFile, workspacePath: path.dirname(prepared[0]!.workspacePath) });

    const attachmentContent = "preserved evidence\n";
    const attachmentHash = createHash("sha256").update(attachmentContent).digest("hex");
    const attachmentRoot = issueRoot(root, issue!.key);
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

    const runtimeProjects = new IssueProjectManager(database.db, root);
    const prepareRuntime = (candidate: Pick<typeof issues.$inferSelect, "id" | "key" | "type">) => runtimeProjects.hydrateDevelopmentRuntime(candidate);
    assert.equal(await prepareRuntime(issue!), issueRoot(root, issue!.key));
    const wrapperRoot = issueRoot(root, issue!.key);
    assert.equal((await stat(wrapperRoot)).mode & 0o777, 0o700);
    await assert.rejects(access(path.join(wrapperRoot, "npm")), { code: "ENOENT" });
    const activeRuntime = issueRoot(root, issue!.key);
    assert.equal(path.join(activeRuntime, "alpha"), prepared[0]!.workspacePath);
    assert.equal(path.join(activeRuntime, "beta"), prepared[1]!.workspacePath);

    const unknownMetadata = path.join(path.dirname(prepared[0]!.workspacePath), ".issue-pilot", "unknown.txt");
    await mkdir(path.dirname(unknownMetadata), { recursive: true });
    await writeFile(unknownMetadata, "preserve\n", "utf8");
    assert.equal(await prepareRuntime(issue!), wrapperRoot);
    assert.equal(await readFile(unknownMetadata, "utf8"), "preserve\n");
    await rm(path.dirname(unknownMetadata), { recursive: true });
    assert.equal(await prepareRuntime(issue!), wrapperRoot);

    const lifecycle = new WorkspaceLifecycleManager(
      database.db,
      root,
      engine as never,
      {
        retentionMs: Number.POSITIVE_INFINITY,
        highWaterBytes: 0,
        targetBytes: 0,
        maintenanceIntervalMs: 0,
        taskConcurrency: 1,
      },
      prepareRuntime,
    );
    await writeFile(path.join(prepared[1]!.workspacePath, "untracked.txt"), "do not delete\n", "utf8");
    const dirtyInspection = await lifecycle.inspectIssue(issue!.id);
    assert.equal(dirtyInspection.releasable, false);
    assert.equal(dirtyInspection.blockedReason, "workspace_has_changes");
    await assert.rejects(lifecycle.releaseIssue(issue!.id), (error: unknown) => error instanceof WorkspaceReleaseRefusal && error.reason === "workspace_has_changes");
    await Promise.all(prepared.map((worktree) => access(worktree.workspacePath)));
    const dirtyRows = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    assert.equal(
      dirtyRows.every((repository) => repository.localPath !== null),
      true,
    );

    await unlink(path.join(prepared[1]!.workspacePath, "untracked.txt"));
    await writeFile(path.join(prepared[1]!.cachePath, "info/exclude"), "ignored-evidence.txt\n");
    const ignoredEvidence = path.join(prepared[1]!.workspacePath, "ignored-evidence.txt");
    await writeFile(ignoredEvidence, "uncommitted evidence");
    assert.equal((await lifecycle.inspectIssue(issue!.id)).blockedReason, "workspace_has_changes");
    await assert.rejects(lifecycle.releaseIssue(issue!.id), (error) => error instanceof WorkspaceReleaseRefusal && error.reason === "workspace_has_changes");
    assert.equal(await readFile(ignoredEvidence, "utf8"), "uncommitted evidence");
    assert.equal(
      (await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id))).every((repository) => repository.localPath !== null),
      true,
    );
    await unlink(ignoredEvidence);
    const statsBeforeRelease = await lifecycle.stats();
    assert.equal(statsBeforeRelease.totalBytes > 0, true);
    assert.equal(statsBeforeRelease.workspaces[0]?.releasable, true);
    const checkpoint = path.join(path.dirname(prepared[0]!.workspacePath), "checkpoint.json");
    await writeFile(checkpoint, '{"remaining":10}\n');
    const released = await lifecycle.releaseIssue(issue!.id);
    assert.equal(released.alreadyReleased, false);
    assert.equal((await lifecycle.inspectIssue(issue!.id)).blockedReason, "workspace_released");
    const manifestPath = path.join(issueRoot(root, issue!.key), ".issue-runtime.json");
    const originalManifest = await readFile(manifestPath);
    await writeFile(manifestPath, JSON.stringify({ version: 1, entries: [{ name: "missing-reference", kind: "file", value: "a".repeat(64) }] }));
    assert.equal((await lifecycle.inspectIssue(issue!.id)).blockedReason, "issue_runtime_entry_missing");
    await assert.rejects(lifecycle.releaseIssue(issue!.id), (error) => error instanceof WorkspaceReleaseRefusal && error.reason === "issue_runtime_entry_missing");
    await writeFile(manifestPath, originalManifest);
    assert.equal(released.releasedBytes > 0, true);
    assert.equal(await readFile(checkpoint, "utf8"), '{"remaining":10}\n');
    await Promise.all(prepared.map(async (worktree) => assert.equal((await lstat(worktree.workspacePath)).isSymbolicLink(), true)));
    assert.equal(await readFile(durableAttachment, "utf8"), attachmentContent);
    assert.equal(await readFile(sessionFile, "utf8"), "{}\n");
    assert.deepEqual(engine.closed, [issue!.id]);

    const releasedRows = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    assert.equal(
      releasedRows.every((repository) => repository.localPath === null),
      true,
    );
    assert.deepEqual(
      releasedRows.map((repository) => repository.workspaceName),
      ["alpha", "beta"],
    );
    assert.equal(
      releasedRows.every((repository) => repository.workingBranch?.startsWith("hotfix-") && repository.commitBefore),
      true,
    );
    const [releasedWorkspace] = await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, issue!.id));
    assert.equal(releasedWorkspace!.status, "stopped");
    assert.equal(releasedWorkspace!.runtimeReady, true);
    const browser = new SourceBrowser(database.db, root);
    for (const repository of releasedRows) {
      const name = repository.workspaceName!;
      const runtimeRepository = path.join(issueRoot(root, issue!.key), name);
      const repositoryRoot = path.join(root, "git", "repositories", createHash("sha256").update(repository.url).digest("hex").slice(0, 20));
      const commit = await git(["-C", repositoryRoot, "rev-parse", `refs/heads/${repository.workingBranch}`]);
      assert.equal(await git(["-C", repositoryRoot, "rev-parse", retainedSnapshotRef(commit)]), commit);
      assert.equal((await browser.file(issue!, name, "README.md")).content.trimEnd(), await git(["-C", repositoryRoot, "show", `${commit}:README.md`]));
      await assert.rejects(access(runtimeRepository), { code: "ENOENT" });
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
    assert.equal(await readFile(checkpoint, "utf8"), '{"remaining":10}\n');
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
    assert.equal(await readFile(checkpoint, "utf8"), '{"remaining":10}\n');
    assert.equal(
      (await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id))).every((repository) => repository.localPath === null),
      true,
    );

    const reopenedIssue = await lifecycle.reopenIssue(issue!.id);
    assert.equal(reopenedIssue.status, "open");
    assert.equal(reopenedIssue.resolvedAt, null);
    const restoredRows = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    assert.equal(
      restoredRows.every((repository) => repository.localPath?.startsWith(issueRoot(root, issue!.key))),
      true,
    );
    assert.deepEqual(
      restoredRows.map((repository) => repository.workspaceName),
      ["alpha", "beta"],
    );
    for (const repository of restoredRows) {
      assert.equal(await git(["-C", repository.localPath!, "branch", "--show-current"]), repository.workingBranch);
    }
    const restoredFile = path.join(issueRoot(root, issue!.key), "alpha", "restored.txt");
    await writeFile(restoredFile, "writable again\n", "utf8");
    assert.equal(await readFile(path.join(issueRoot(root, issue!.key), "alpha", "restored.txt"), "utf8"), "writable again\n");
    await unlink(restoredFile);
    const [restoredWorkspace] = await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, issue!.id));
    assert.equal(restoredWorkspace!.status, "ready");
    assert.equal(restoredWorkspace!.runtimeReady, true);
    assert.equal((await lifecycle.inspectIssue(issue!.id)).blockedReason, "issue_not_resolved");
    await assert.rejects(lifecycle.releaseIssue(issue!.id), (error: unknown) => error instanceof WorkspaceReleaseRefusal && error.reason === "issue_not_resolved");
    await Promise.all(restoredRows.map((repository) => access(repository.localPath!)));

    await database.db
      .update(issues)
      .set({ status: "resolved", resolvedAt: new Date(0) })
      .where(eq(issues.id, issue!.id));
    const unmanagedRootEntry = path.join(issueRoot(root, issue!.key), "unmanaged-root.sql");
    await writeFile(unmanagedRootEntry, "select 1;\n", "utf8");
    await lifecycle.reopenIssue(issue!.id);
    assert.equal(await readFile(unmanagedRootEntry, "utf8"), "select 1;\n");
    await unlink(unmanagedRootEntry);
    await database.db
      .update(issues)
      .set({ status: "resolved", resolvedAt: new Date(0) })
      .where(eq(issues.id, issue!.id));

    await database.db.update(issueRepositories).set({ workspaceName: "mismatched-name" }).where(eq(issueRepositories.id, restoredRows[0]!.id));
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
    const concurrentRootEntry = path.join(issueRoot(root, issue!.key), "concurrent-root.txt");
    lifecycleWorktrees.remove = async (url, workspacePath) => {
      removalCount += 1;
      const commit = await removeWorktree(url, workspacePath);
      if (removalCount === restoredRows.length) await writeFile(concurrentRootEntry, "preserve root entry\n", "utf8");
      return commit;
    };
    await lifecycle.releaseIssue(issue!.id);
    lifecycleWorktrees.remove = removeWorktree;
    assert.equal(await readFile(concurrentRootEntry, "utf8"), "preserve root entry\n");
    await Promise.all(restoredRows.map(async (repository) => assert.equal((await lstat(repository.localPath!)).isSymbolicLink(), true)));
    await lifecycle.reopenIssue(issue!.id);
    await database.db
      .update(issues)
      .set({ status: "resolved", resolvedAt: new Date(0) })
      .where(eq(issues.id, issue!.id));
    await Promise.all(restoredRows.map((repository) => access(repository.localPath!)));
    await unlink(concurrentRootEntry);

    const lifecycleInternal = lifecycle as unknown as { markReleased(issueId: string): Promise<void> };
    const markReleased = lifecycleInternal.markReleased.bind(lifecycle);
    lifecycleInternal.markReleased = async () => {
      throw new Error("simulated_release_transaction_failure");
    };
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

    await database.db
      .update(issues)
      .set({ status: "resolved", resolvedAt: new Date(0) })
      .where(eq(issues.id, issue!.id));
    for (const repository of restoredRows) await worktrees.remove(repository.url, repository.localPath!);
    const preservedRoot = path.join(root, "preserved-issue-root");
    await rename(issueRoot(root, issue!.key), preservedRoot);
    await database.db.update(issueWorkspaces).set({ status: "running" }).where(eq(issueWorkspaces.issueId, issue!.id));
    await assert.rejects(lifecycle.releaseIssue(issue!.id), (error: unknown) => error instanceof WorkspaceReleaseRefusal && error.reason === "workspace_busy");
    assert.equal(classifyRepositoryState(await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id))), "development_workspace");
    await database.db.update(issueWorkspaces).set({ status: "ready" }).where(eq(issueWorkspaces.issueId, issue!.id));
    // The root held the private Git store; neither release nor reopen may rebuild from an older shared ref.
    await assert.rejects(lifecycle.releaseIssue(issue!.id), (error: unknown) => error instanceof WorkspaceReleaseRefusal && error.reason === "workspace_missing");
    assert.equal(classifyRepositoryState(await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id))), "development_workspace");
    assert.equal((await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, issue!.id)))[0]!.status, "ready");
    await assert.rejects(lifecycle.reopenIssue(issue!.id), (error: unknown) => error instanceof WorkspaceRestoreRefusal && error.reason === "workspace_missing");

    const reconstruct = async () => {
      await prepareIssueRuntime(root, issue!.key, [], "write");
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

    // Restore the exact durable root before rebuilding generated runtime and worktrees.
    await rename(preservedRoot, issueRoot(root, issue!.key));
    await reconstruct();
    assert.equal((await lifecycle.releaseIssue(issue!.id)).alreadyReleased, false);

    await reconstruct();
    await writeFile(checkpoint, '{"remaining":10}\n');
    const retentionLifecycle = new WorkspaceLifecycleManager(
      database.db,
      root,
      engine as never,
      {
        retentionMs: 0,
        highWaterBytes: 0,
        targetBytes: 0,
        maintenanceIntervalMs: 0,
        taskConcurrency: 1,
      },
      prepareRuntime,
    );
    const retention = await retentionLifecycle.maintain();
    assert.deepEqual(
      retention.released.map(({ issueKey }) => issueKey),
      [issue!.key],
    );

    await reconstruct();
    const quotaLifecycle = new WorkspaceLifecycleManager(
      database.db,
      root,
      engine as never,
      {
        retentionMs: Number.POSITIVE_INFINITY,
        highWaterBytes: 1,
        targetBytes: 0,
        maintenanceIntervalMs: 0,
        taskConcurrency: 1,
      },
      prepareRuntime,
    );
    const quota = await quotaLifecycle.maintain();
    assert.deepEqual(
      quota.released.map(({ issueKey }) => issueKey),
      [issue!.key],
    );
    assert.equal(await readFile(checkpoint, "utf8"), '{"remaining":10}\n');
    await Promise.all(prepared.map(async (worktree) => assert.equal((await lstat(worktree.workspacePath)).isSymbolicLink(), true)));

    const [prodEnvironment] = await database.db.select().from(environments).where(eq(environments.kind, "prod")).limit(1);
    await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: prodEnvironment!.id, config: {} });
    const [readOnlyIssue] = await database.db
      .insert(issues)
      .values({
        key: "ISSUE-20260810-099",
        title: "Read-only runtime",
        status: "resolved",
        type: "smart_analysis",
        serviceId: service!.id,
        environmentId: prodEnvironment!.id,
        reporterSubject: "tester",
        resolvedAt: new Date(0),
      })
      .returning();
    await database.db.insert(issueWorkspaces).values({ issueId: readOnlyIssue!.id, status: "ready", runtimeReady: true });
    await database.db.insert(issueRepositories).values({ issueId: readOnlyIssue!.id, url: remotes[0]!, baseBranch: "main", workingBranch: null, localPath: null, commitBefore: "a".repeat(40) });
    const readOnlyMaintenance = await retentionLifecycle.maintain();
    assert.equal((await retentionLifecycle.inspectIssue(readOnlyIssue!.id)).blockedReason, "workspace_not_development");
    assert.equal(
      readOnlyMaintenance.released.some((entry) => entry.issueKey === readOnlyIssue!.key),
      false,
    );
    await assert.rejects(retentionLifecycle.releaseIssue(readOnlyIssue!.id), (error: unknown) => error instanceof WorkspaceReleaseRefusal && error.reason === "workspace_not_development");
    const [readOnlyWorkspace] = await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, readOnlyIssue!.id));
    assert.equal(readOnlyWorkspace!.runtimeReady, true);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("converts a ready test analysis to a development defect while preserving Issue evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-conversion-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  try {
    const [testEnvironment] = await database.db.select().from(environments).where(eq(environments.kind, "test")).limit(1);
    const [devEnvironment] = await database.db.select().from(environments).where(eq(environments.kind, "dev")).limit(1);
    assert.ok(testEnvironment && devEnvironment);
    await database.db.insert(subjects).values({ subject: "conversion-tester", displayName: "Conversion Tester", email: "conversion@example.test" });
    const [service] = await database.db.insert(services).values({ key: "conversion-service", name: "Conversion Service" }).returning();
    const remote = await createRemote(root, "conversion");
    await registerTestRepositories(database.db, [remote]);
    const [serviceRepository] = await database.db.insert(serviceRepositories).values({ serviceId: service!.id, alias: "conversion", url: remote }).returning();
    const [testDeployment] = await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: testEnvironment.id, config: {} }).returning();
    const [productionEnvironment] = await database.db.select().from(environments).where(eq(environments.kind, "prod"));
    await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: devEnvironment.id, config: {} });
    const [devDeployment] = await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: productionEnvironment!.id, config: {} }).returning();
    await database.db.insert(serviceDeploymentRepositories).values([
      { deploymentId: testDeployment!.id, repositoryId: serviceRepository!.id, baseBranch: "main" },
      { deploymentId: devDeployment!.id, repositoryId: serviceRepository!.id, baseBranch: "main" },
    ]);
    const [issue] = await database.db
      .insert(issues)
      .values({
        key: "ISSUE-20260814-101",
        title: "Test analysis found a code defect",
        description: "Preserve this analysis",
        status: "open",
        priority: "p1",
        type: "smart_analysis",
        serviceId: service!.id,
        environmentId: testEnvironment.id,
        reporterSubject: "conversion-tester",
      })
      .returning();
    await database.db.insert(issueWorkspaces).values({ issueId: issue!.id, status: "ready", runtimeReady: true });

    const worktrees = new WorktreeManager(root);
    const projects = new IssueProjectManager(database.db, root, worktrees);
    await claimIssueRoot(root, issue!.key);
    const runtimeRoot = await projects.hydrateReadOnlyRuntime(issue!);
    const sessionRoot = issueRoot(root, issue!.key);
    const sessionFile = path.join(sessionRoot, "analysis.jsonl");
    await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
    await writeFile(sessionFile, '{"type":"session"}\n', { mode: 0o600 });
    await database.db.insert(agentSessions).values({ issueId: issue!.id, sessionFile, workspacePath: runtimeRoot });
    const attachmentRoot = issueRoot(root, issue!.key);
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
      enqueue(issueId: string) {
        this.enqueued.push(issueId);
      },
      async send() {},
      isRunning() {
        return false;
      },
      async runExclusive<T>(_issueIds: string[], operation: (reservation: { enqueue(issueId: string): void; closeSession(issueId: string): Promise<void> }) => Promise<T>) {
        return operation({
          enqueue: (issueId) => {
            this.enqueue(issueId);
          },
          closeSession: async (issueId) => {
            this.closed.push(issueId);
          },
        });
      },
    };
    const lifecycle = new WorkspaceLifecycleManager(database.db, root, conversionEngine as never, {
      retentionMs: Number.POSITIVE_INFINITY,
      highWaterBytes: 0,
      targetBytes: 0,
      maintenanceIntervalMs: 0,
      taskConcurrency: 1,
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
    await assert.rejects(
      lifecycle.convertIssueToDevelopment(issue!.id),
      (error: unknown) => error instanceof WorkspaceConversionRefusal && error.reason === "simulated_conversion_transaction_failure",
    );
    mutableDatabase.transaction = transaction;

    const [rolledBackIssue] = await database.db.select().from(issues).where(eq(issues.id, issue!.id)).limit(1);
    const rolledBackRepositories = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    assert.equal(rolledBackIssue!.environmentId, testEnvironment.id);
    assert.equal(rolledBackIssue!.type, "smart_analysis");
    assert.equal(classifyRepositoryState(rolledBackRepositories), "read_only");
    assert.equal((await stat(issueRoot(root, issue!.key))).isDirectory(), true);
    assert.equal(path.resolve(runtimeRoot, await readlink(path.join(runtimeRoot, "conversion"))).startsWith(path.join(root, "git", "checkouts")), true);
    assert.equal(await readFile(sessionFile, "utf8"), '{"type":"session"}\n');
    assert.equal(await readFile(attachmentFile, "utf8"), attachmentContent);
    assert.deepEqual(conversionEngine.enqueued, []);

    const converted = await lifecycle.convertIssueToDevelopment(issue!.id);
    assert.equal(converted.environmentId, devEnvironment.id);
    assert.equal(converted.type, "defect_fix");
    assert.equal(converted.status, "open");
    const convertedRepositories = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    assert.equal(classifyRepositoryState(convertedRepositories), "development_workspace");
    assert.equal(convertedRepositories[0]!.workingBranch, "hotfix-issue-20260814-101");
    assert.equal(await git(["-C", convertedRepositories[0]!.localPath!, "branch", "--show-current"]), "hotfix-issue-20260814-101");
    assert.equal(await git(["-C", convertedRepositories[0]!.localPath!, "status", "--porcelain"]), "");
    assert.equal(path.join(runtimeRoot, "conversion"), convertedRepositories[0]!.localPath);
    assert.equal((await stat(path.join(runtimeRoot, "conversion"))).isDirectory(), true);
    await assert.rejects(access(path.join(runtimeRoot, "npm")), { code: "ENOENT" });
    const [session] = await database.db.select().from(agentSessions).where(eq(agentSessions.issueId, issue!.id));
    assert.equal(session!.sessionFile, sessionFile);
    assert.equal(session!.workspacePath, issueRoot(root, issue!.key));
    assert.equal(await readFile(sessionFile, "utf8"), '{"type":"session"}\n');
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

test("migrates ready development scopes while preserving retained changes and rolling back failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-scope-migration-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  try {
    const [devEnvironment] = await database.db.select().from(environments).where(eq(environments.kind, "dev")).limit(1);
    await database.db.insert(subjects).values({ subject: "migration-tester", displayName: "Migration Tester" });
    const [sourceService, targetService] = await database.db
      .insert(services)
      .values([
        { key: "scope-source", name: "Scope Source" },
        { key: "scope-target", name: "Scope Target" },
      ])
      .returning();
    const retainedRemote = await createRemote(root, "scope-retained");
    const removedRemote = await createRemote(root, "scope-removed");
    const addedRemote = await createRemote(root, "scope-added");
    await registerTestRepositories(database.db, [retainedRemote, removedRemote, addedRemote]);
    const sourceRepositories = await database.db
      .insert(serviceRepositories)
      .values([
        { serviceId: sourceService!.id, alias: "retained-source", url: retainedRemote },
        { serviceId: sourceService!.id, alias: "removed", url: removedRemote },
      ])
      .returning();
    const targetRepositories = await database.db
      .insert(serviceRepositories)
      .values([
        { serviceId: targetService!.id, alias: "retained-target", url: retainedRemote },
        { serviceId: targetService!.id, alias: "added", url: addedRemote },
      ])
      .returning();
    const [productionEnvironment] = await database.db.select().from(environments).where(eq(environments.kind, "prod"));
    await database.db.insert(serviceDeployments).values([
      { serviceId: sourceService!.id, environmentId: devEnvironment!.id, config: {} },
      { serviceId: targetService!.id, environmentId: devEnvironment!.id, config: {} },
    ]);
    const [sourceDeployment, targetDeployment] = await database.db
      .insert(serviceDeployments)
      .values([
        { serviceId: sourceService!.id, environmentId: productionEnvironment!.id, config: {} },
        { serviceId: targetService!.id, environmentId: productionEnvironment!.id, config: {} },
      ])
      .returning();
    await database.db
      .insert(serviceDeploymentRepositories)
      .values([
        ...sourceRepositories.map((repository) => ({ deploymentId: sourceDeployment!.id, repositoryId: repository.id, baseBranch: "main" })),
        ...targetRepositories.map((repository) => ({ deploymentId: targetDeployment!.id, repositoryId: repository.id, baseBranch: "main" })),
      ]);
    const [issue] = await database.db
      .insert(issues)
      .values({
        key: "ISSUE-20260814-102",
        title: "Migrate development scope",
        type: "defect_fix",
        serviceId: sourceService!.id,
        environmentId: devEnvironment!.id,
        reporterSubject: "migration-tester",
      })
      .returning();
    await database.db.insert(issueWorkspaces).values({ issueId: issue!.id });
    const projects = new IssueProjectManager(database.db, root);
    await claimIssueRoot(root, issue!.key);
    await projects.prepare(issue!, "dev");
    await database.db.update(issueWorkspaces).set({ status: "ready", runtimeReady: true }).where(eq(issueWorkspaces.issueId, issue!.id));

    const unchangedAt = new Date("2026-08-01T00:00:00Z");
    await database.db.update(issueRepositories).set({ updatedAt: unchangedAt }).where(eq(issueRepositories.issueId, issue!.id));
    const originalRepositories = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    const originalByUrl = new Map(originalRepositories.map((repository) => [repository.url, repository]));
    const retainedPath = originalByUrl.get(retainedRemote)!.localPath!;
    const removedPath = originalByUrl.get(removedRemote)!.localPath!;
    await writeFile(path.join(retainedPath, "README.md"), "retained staged change\n", "utf8");
    await git(["-C", retainedPath, "add", "README.md"]);
    await writeFile(path.join(retainedPath, "untracked.txt"), "retained untracked change\n", "utf8");

    const migrationEngine = {
      closed: [] as string[],
      enqueued: [] as string[],
      enqueue(issueId: string) {
        this.enqueued.push(issueId);
      },
      async send() {},
      isRunning() {
        return false;
      },
      async runExclusive<T>(_issueIds: string[], operation: (reservation: { enqueue(issueId: string): void; closeSession(issueId: string): Promise<void> }) => Promise<T>) {
        return operation({
          enqueue: (issueId) => {
            this.enqueue(issueId);
          },
          closeSession: async (issueId) => {
            this.closed.push(issueId);
          },
        });
      },
    };
    const lifecycle = new WorkspaceLifecycleManager(database.db, root, migrationEngine as never, {
      retentionMs: Number.POSITIVE_INFINITY,
      highWaterBytes: 0,
      targetBytes: 0,
      maintenanceIntervalMs: 0,
      taskConcurrency: 1,
    });
    const transitions = new IssueScopeTransitionManager(database.db, migrationEngine as never, lifecycle);
    await assert.rejects(
      transitions.plan(issue!.id, { serviceKey: targetService!.key, workMode: "development_feature" }),
      (error: unknown) => error instanceof ScopeTransitionRefusal && error.reason === "development_branch_mode_immutable",
    );
    const plan = await transitions.plan(issue!.id, { serviceKey: targetService!.key, workMode: "development_fix" });
    assert.equal(plan.action, "migrate_development");
    assert.equal(plan.branch, `hotfix-${issue!.key.toLowerCase()}`);
    assert.deepEqual(
      plan.repositories.retained.map(({ url }) => url),
      [retainedRemote],
    );
    assert.deepEqual(
      plan.repositories.added.map(({ url }) => url),
      [addedRemote],
    );
    assert.deepEqual(
      plan.repositories.removed.map(({ url }) => url),
      [removedRemote],
    );

    const dirtyRemovedFile = path.join(removedPath, "do-not-remove.txt");
    await writeFile(dirtyRemovedFile, "operator evidence\n", "utf8");
    await assert.rejects(
      transitions.apply(
        issue!.id,
        { serviceKey: targetService!.key, workMode: "development_fix" },
        { expectedIssueUpdatedAt: plan.expectedIssueUpdatedAt, expectedPlanHash: plan.planHash },
        "migration-tester",
      ),
      (error: unknown) => error instanceof WorkspaceScopeMigrationRefusal && error.reason === "scope_transition_removed_repository_changed",
    );
    assert.equal(await readFile(dirtyRemovedFile, "utf8"), "operator evidence\n");
    await unlink(dirtyRemovedFile);

    const mutableDatabase = database.db as typeof database.db & { transaction: typeof database.db.transaction };
    const transaction = mutableDatabase.transaction.bind(mutableDatabase);
    let failFinalize = true;
    mutableDatabase.transaction = (async (operation: Parameters<typeof database.db.transaction>[0]) => {
      if (failFinalize) {
        failFinalize = false;
        return transaction(async (transaction) => {
          await operation(transaction);
          throw new Error("simulated_scope_migration_transaction_failure");
        });
      }
      return transaction(operation);
    }) as typeof database.db.transaction;
    await assert.rejects(
      transitions.apply(
        issue!.id,
        { serviceKey: targetService!.key, workMode: "development_fix" },
        { expectedIssueUpdatedAt: plan.expectedIssueUpdatedAt, expectedPlanHash: plan.planHash },
        "migration-tester",
      ),
      (error: unknown) => error instanceof WorkspaceScopeMigrationRefusal && error.reason === "simulated_scope_migration_transaction_failure",
    );
    mutableDatabase.transaction = transaction;
    const rolledBackRepositories = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    assert.deepEqual(
      rolledBackRepositories.toSorted((left, right) => left.url.localeCompare(right.url)),
      originalRepositories.toSorted((left, right) => left.url.localeCompare(right.url)),
    );
    await Promise.all(rolledBackRepositories.map(({ localPath }) => access(localPath!)));
    assert.equal((await database.db.select().from(issues).where(eq(issues.id, issue!.id)).limit(1))[0]!.serviceId, sourceService!.id);
    assert.match(await git(["-C", retainedPath, "status", "--porcelain"]), /README\.md/);
    assert.match(await git(["-C", retainedPath, "status", "--porcelain"]), /untracked\.txt/);
    assert.equal((await database.db.select().from(issueScopeTransitions).where(eq(issueScopeTransitions.issueId, issue!.id))).length, 0);

    const retryPlan = await transitions.plan(issue!.id, { serviceKey: targetService!.key, workMode: "development_fix" });
    const migrated = await transitions.apply(
      issue!.id,
      { serviceKey: targetService!.key, workMode: "development_fix" },
      {
        expectedIssueUpdatedAt: retryPlan.expectedIssueUpdatedAt,
        expectedPlanHash: retryPlan.planHash,
      },
      "migration-tester",
    );
    assert.equal(migrated.serviceId, targetService!.id);
    const migratedRepositories = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    assert.deepEqual(migratedRepositories.map(({ url }) => url).sort(), [addedRemote, retainedRemote].sort());
    const migratedByUrl = new Map(migratedRepositories.map((repository) => [repository.url, repository]));
    assert.equal(migratedByUrl.get(retainedRemote)!.localPath, retainedPath);
    assert.equal(migratedByUrl.get(retainedRemote)!.workingBranch, originalByUrl.get(retainedRemote)!.workingBranch);
    assert.equal(migratedByUrl.get(retainedRemote)!.id, originalByUrl.get(retainedRemote)!.id);
    assert.equal(migratedByUrl.get(retainedRemote)!.baseBranch, originalByUrl.get(retainedRemote)!.baseBranch);
    assert.equal(migratedByUrl.get(retainedRemote)!.workspaceName, originalByUrl.get(retainedRemote)!.workspaceName);
    assert.equal(migratedByUrl.get(retainedRemote)!.commitBefore, originalByUrl.get(retainedRemote)!.commitBefore);
    assert.equal(migratedByUrl.get(retainedRemote)!.updatedAt.getTime(), unchangedAt.getTime());
    assert.match(await git(["-C", retainedPath, "status", "--porcelain"]), /README\.md/);
    assert.match(await git(["-C", retainedPath, "status", "--porcelain"]), /untracked\.txt/);
    await assert.rejects(access(removedPath));
    await access(migratedByUrl.get(addedRemote)!.localPath!);
    assert.equal(await git(["-C", migratedByUrl.get(addedRemote)!.localPath!, "branch", "--show-current"]), `hotfix-${issue!.key.toLowerCase()}`);
    assert.deepEqual(migrationEngine.enqueued, [issue!.id]);
    const transitionRows = await database.db.select().from(issueScopeTransitions).where(eq(issueScopeTransitions.issueId, issue!.id));
    assert.equal(transitionRows.length, 1);
    assert.equal(transitionRows[0]!.actorSubject, "migration-tester");
    assert.equal(transitionRows[0]!.action, "migrate_development");
    assert.equal(transitionRows[0]!.planHash, retryPlan.planHash);
    assert.deepEqual(transitionRows[0]!.repositories, { retained: [retainedRemote], added: [addedRemote], removed: [removedRemote] });
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("cached storage eligibility cannot release a subsequently changed checkout", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-stats-release-safety-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  try {
    const [environment] = await database.db.select().from(environments).where(eq(environments.kind, "dev"));
    const [service] = await database.db.insert(services).values({ key: "stats-safety", name: "Stats safety" }).returning();
    await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: environment!.id, config: {} });
    const [issue] = await database.db
      .insert(issues)
      .values({
        key: "ISSUE-20261025-991",
        title: "Stats safety",
        type: "defect_fix",
        status: "resolved",
        resolvedAt: new Date(0),
        reporterSubject: issuePilotConfig.bootstrapUser.subject,
        serviceId: service!.id,
        environmentId: environment!.id,
      })
      .returning();
    await database.db.insert(issueWorkspaces).values({ issueId: issue!.id, status: "ready", runtimeReady: true });
    const remote = await createRemote(root, "cache-safety");
    const prepared = await new WorktreeManager(root).prepare({ issueKey: issue!.key, workspaceName: "repo", url: remote, baseBranch: "main", mode: "hotfix" });
    await database.db.insert(issueRepositories).values({
      issueId: issue!.id,
      url: remote,
      baseBranch: "main",
      workingBranch: prepared.workingBranch,
      localPath: prepared.workspacePath,
      workspaceName: "repo",
      commitBefore: prepared.baseCommit,
    });
    const manager = new WorkspaceLifecycleManager(database.db, root, { ...engine, running: new Set(), closed: [] } as never, {
      retentionMs: Infinity,
      highWaterBytes: 0,
      targetBytes: 0,
      maintenanceIntervalMs: 0,
      taskConcurrency: 1,
    });
    const initial = await manager.stats();
    assert.equal(initial.workspaces[0]!.releasable, true);
    await writeFile(path.join(prepared.workspacePath, "README.md"), "new working changes\n");
    assert.equal((await manager.stats()).sampledAt, initial.sampledAt);
    assert.equal((await manager.stats()).workspaces[0]!.releasable, true);
    await assert.rejects(manager.releaseIssue(issue!.id), /workspace_has_changes/);
    assert.equal(await readFile(path.join(prepared.workspacePath, "README.md"), "utf8"), "new working changes\n");
    assert.equal((await manager.stats()).workspaces[0]!.blockedReason, "workspace_has_changes");
    const forced = await manager.stats(true);
    assert.equal(forced.workspaces[0]!.releasable, false);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("statistics reuse one sample across a maintenance cycle unless refreshed", async (context) => {
  const manager = new WorkspaceLifecycleManager({ select: () => ({ from: async () => [] }) } as never, ".", engine as never, {
    retentionMs: Number.POSITIVE_INFINITY,
    highWaterBytes: 0,
    targetBytes: 0,
    maintenanceIntervalMs: 15 * 60_000,
    taskConcurrency: 1,
  });
  const internal = manager as unknown as {
    issueRows(): Promise<Array<{ issue: { id: string; key: string }; workspace: null }>>;
    inspectLocked(row: { issue: { id: string; key: string } }, repositories?: unknown, knownBytes?: number): Promise<WorkspaceInspection>;
  };
  internal.issueRows = async () => [{ issue: { id: "issue-a", key: "ISSUE-20260814-001" }, workspace: null }];
  let inspections = 0;
  internal.inspectLocked = async ({ issue }) => {
    inspections += 1;
    return { issueId: issue.id, issueKey: issue.key, issueStatus: "open", workspaceStatus: "not_created", resolvedAt: null, bytes: 0, releasable: false, blockedReason: "issue_not_resolved" };
  };
  const first = await manager.stats();
  assert.equal(inspections, 1);
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  // A page revisit within the maintenance cycle serves the sampled snapshot instead of rescanning the fleet.
  context.mock.timers.tick(5 * 60_000);
  const cached = await manager.stats();
  assert.equal(inspections, 1);
  assert.equal(cached.sampledAt, first.sampledAt);
  // Automatic maintenance changes workspace state, so its cache must not outlive that pass.
  await manager.maintain();
  const maintained = await manager.stats();
  assert.equal(inspections, 2);
  assert.notEqual(maintained.sampledAt, first.sampledAt);
  // The explicit refresh still measures.
  await manager.stats(true);
  assert.equal(inspections, 3);
  // Expiry after one maintenance cycle measures again.
  context.mock.timers.tick(15 * 60_000 + 1);
  await manager.stats();
  assert.equal(inspections, 4);
});

test("overlapping refreshes share a fresh sample instead of the ordinary scan already in flight", async () => {
  const manager = new WorkspaceLifecycleManager({ select: () => ({ from: async () => [] }) } as never, ".", engine as never, {
    retentionMs: Number.POSITIVE_INFINITY,
    highWaterBytes: 0,
    targetBytes: 0,
    maintenanceIntervalMs: 0,
    taskConcurrency: 1,
  });
  const internal = manager as unknown as {
    issueRows(): Promise<Array<{ issue: { id: string; key: string }; workspace: null }>>;
    inspectLocked(row: { issue: { id: string; key: string } }, repositories?: unknown, knownBytes?: number): Promise<WorkspaceInspection>;
  };
  internal.issueRows = async () => [{ issue: { id: "issue-a", key: "ISSUE-20260814-001" }, workspace: null }];
  let releaseFirst!: () => void;
  let markStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let inspections = 0;
  internal.inspectLocked = async ({ issue }) => {
    inspections += 1;
    if (inspections === 1) {
      markStarted();
      await firstGate;
    }
    return {
      issueId: issue.id,
      issueKey: issue.key,
      issueStatus: "open",
      workspaceStatus: "not_created",
      resolvedAt: null,
      bytes: inspections,
      releasable: false,
      blockedReason: "issue_not_resolved",
    };
  };
  const first = manager.stats();
  await started;
  const refreshed = manager.stats(true);
  const alsoRefreshed = manager.stats(true);
  releaseFirst();
  const [firstResult, refreshedResult, alsoRefreshedResult] = await Promise.all([first, refreshed, alsoRefreshed]);
  assert.equal(inspections, 2);
  assert.equal(firstResult.totalBytes, 1);
  assert.equal(refreshedResult.totalBytes, 2);
  assert.equal(alsoRefreshedResult, refreshedResult);
});

test("statistics requested after a queued release see the released workspace", async () => {
  const manager = new WorkspaceLifecycleManager({ select: () => ({ from: async () => [] }) } as never, ".", engine as never, {
    retentionMs: Infinity,
    highWaterBytes: 0,
    targetBytes: 0,
    maintenanceIntervalMs: 0,
    taskConcurrency: 1,
  });
  const row = { issue: { id: "queued-release", key: "ISSUE-20261025-993" }, workspace: null };
  const internals = manager as unknown as {
    issueRows(): Promise<(typeof row)[]>;
    issueRow(): Promise<typeof row>;
    inspectLocked(): Promise<WorkspaceInspection>;
    releaseLocked(): Promise<{ issueKey: string; releasedBytes: number; remainingBytes: number; alreadyReleased: boolean }>;
  };
  internals.issueRows = async () => [row];
  internals.issueRow = async () => row;
  let start!: () => void,
    finish!: () => void,
    scans = 0,
    released = false;
  const started = new Promise<void>((resolve) => {
      start = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
  internals.inspectLocked = async () => {
    scans++;
    if (scans === 1) {
      start();
      await gate;
    }
    return {
      issueId: row.issue.id,
      issueKey: row.issue.key,
      issueStatus: "resolved",
      workspaceStatus: released ? "stopped" : "ready",
      resolvedAt: new Date(0).toISOString(),
      bytes: 0,
      releasable: !released,
      blockedReason: released ? "workspace_released" : null,
    };
  };
  internals.releaseLocked = async () => {
    released = true;
    return { issueKey: row.issue.key, releasedBytes: 0, remainingBytes: 0, alreadyReleased: false };
  };
  const statistics = manager.stats(true);
  await started;
  const release = manager.releaseIssue(row.issue.id);
  const afterRelease = manager.stats(true);
  finish();
  assert.equal((await statistics).workspaces[0]!.blockedReason, null);
  await release;
  const current = await afterRelease;
  assert.equal(scans, 2);
  assert.equal(current.workspaces[0]!.blockedReason, "workspace_released");
  assert.equal(await manager.stats(), current);
});

test("a failed release whose workspace cannot be measured does not stop maintenance of other candidates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-maintenance-measurement-"));
  const originalPath = process.env.PATH;
  try {
    const rows = ["ISSUE-20261103-001", "ISSUE-20261103-002"].map((key) => ({
      issue: { id: key.toLowerCase(), key, status: "resolved", resolvedAt: new Date(0), updatedAt: new Date(0) },
      workspace: null,
      environmentKind: "dev",
    }));
    for (const row of rows) {
      await mkdir(issueRoot(root, row.issue.key), { recursive: true });
      await writeFile(path.join(issueRoot(root, row.issue.key), "evidence.txt"), "x".repeat(8192));
    }
    const database = { select: () => ({ from: () => ({ where: async () => [] }) }) };
    const manager = new WorkspaceLifecycleManager(database as never, root, engine as never, { retentionMs: 0, highWaterBytes: 0, targetBytes: 0, maintenanceIntervalMs: 0, taskConcurrency: 1 });
    const internals = manager as unknown as {
      issueRows(): Promise<typeof rows>;
      issueRow(issueId: string): Promise<(typeof rows)[number]>;
      releaseLocked(row: (typeof rows)[number]): Promise<{ issueKey: string; releasedBytes: number; remainingBytes: number; alreadyReleased: boolean }>;
    };
    internals.issueRows = async () => rows;
    internals.issueRow = async (issueId) => rows.find((row) => row.issue.id === issueId)!;
    // While the first candidate fails, `du` resolves to a stub that exits without output so its follow-up measurement fails too.
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "du"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
    internals.releaseLocked = async (row) => {
      if (row === rows[0]) {
        process.env.PATH = `${bin}:${originalPath}`;
        throw new Error("simulated_release_failure");
      }
      process.env.PATH = originalPath;
      return { issueKey: row.issue.key, releasedBytes: 8192, remainingBytes: 0, alreadyReleased: false };
    };
    const result = await manager.maintain();
    assert.deepEqual(
      result.released.map((release) => release.issueKey),
      [rows[1]!.issue.key],
    );
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0]!.issueKey, rows[0]!.issue.key);
    assert.match(String((result.failures[0]!.error as Error).message), /workspace_maintenance_measurement_failed/);
  } finally {
    process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("releasing a development Issue whose root is missing is refused and leaves its records for inspection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-missing-root-release-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  try {
    const [environment] = await database.db.select().from(environments).where(eq(environments.kind, "dev"));
    const [service] = await database.db.insert(services).values({ key: "missing-root", name: "Missing root" }).returning();
    await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: environment!.id, config: {} });
    const [issue] = await database.db
      .insert(issues)
      .values({
        key: "ISSUE-20261103-992",
        title: "Missing root",
        type: "defect_fix",
        status: "resolved",
        resolvedAt: new Date(0),
        reporterSubject: issuePilotConfig.bootstrapUser.subject,
        serviceId: service!.id,
        environmentId: environment!.id,
      })
      .returning();
    await database.db.insert(issueWorkspaces).values({ issueId: issue!.id, status: "ready", runtimeReady: true });
    const remote = await createRemote(root, "missing-root");
    const prepared = await new WorktreeManager(root).prepare({ issueKey: issue!.key, workspaceName: "repo", url: remote, baseBranch: "main", mode: "hotfix" });
    await database.db.insert(issueRepositories).values({
      issueId: issue!.id,
      url: remote,
      baseBranch: "main",
      workingBranch: prepared.workingBranch,
      localPath: prepared.workspacePath,
      workspaceName: "repo",
      commitBefore: prepared.baseCommit,
    });
    // The root holds the private Git store; losing it loses any unpublished commits.
    await rm(issueRoot(root, issue!.key), { recursive: true, force: true });
    const before = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    const manager = new WorkspaceLifecycleManager(database.db, root, { ...engine, running: new Set(), closed: [] } as never, {
      retentionMs: Infinity,
      highWaterBytes: 0,
      targetBytes: 0,
      maintenanceIntervalMs: 0,
      taskConcurrency: 1,
    });
    await assert.rejects(manager.releaseIssue(issue!.id), (error) => error instanceof WorkspaceReleaseRefusal && error.reason === "workspace_missing");
    assert.deepEqual(await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id)), before);
    const [workspace] = await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, issue!.id));
    assert.equal(workspace!.status, "ready");
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a released Issue whose root is missing is never rebuilt from the shared branch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-released-root-missing-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  try {
    const [environment] = await database.db.select().from(environments).where(eq(environments.kind, "dev"));
    const [service] = await database.db.insert(services).values({ key: "released-root", name: "Released root" }).returning();
    await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: environment!.id, config: {} });
    const [issue] = await database.db
      .insert(issues)
      .values({
        key: "ISSUE-20261103-993",
        title: "Released root",
        type: "defect_fix",
        status: "resolved",
        resolvedAt: new Date(0),
        reporterSubject: issuePilotConfig.bootstrapUser.subject,
        serviceId: service!.id,
        environmentId: environment!.id,
      })
      .returning();
    await database.db.insert(issueWorkspaces).values({ issueId: issue!.id, status: "ready", runtimeReady: true });
    const remote = await createRemote(root, "released-root");
    const prepared = await new WorktreeManager(root).prepare({ issueKey: issue!.key, workspaceName: "repo", url: remote, baseBranch: "main", mode: "hotfix" });
    await database.db.insert(issueRepositories).values({
      issueId: issue!.id,
      url: remote,
      baseBranch: "main",
      workingBranch: prepared.workingBranch,
      localPath: prepared.workspacePath,
      workspaceName: "repo",
      commitBefore: prepared.baseCommit,
    });
    const manager = new WorkspaceLifecycleManager(database.db, root, { ...engine, running: new Set(), closed: [] } as never, {
      retentionMs: Infinity,
      highWaterBytes: 0,
      targetBytes: 0,
      maintenanceIntervalMs: 0,
      taskConcurrency: 1,
    });
    await manager.releaseIssue(issue!.id);
    assert.equal(classifyRepositoryState(await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id))), "development_snapshot");
    // The root held the private store and durable content; losing it must not be papered over.
    await rm(issueRoot(root, issue!.key), { recursive: true, force: true });
    await assert.rejects(new IssueProjectManager(database.db, root).hydrateDevelopmentRuntime(issue!), /workspace_missing/);
    await assert.rejects(access(issueRoot(root, issue!.key)), { code: "ENOENT" });
    await assert.rejects(manager.reopenIssue(issue!.id), (error) => error instanceof WorkspaceRestoreRefusal && error.reason === "workspace_missing");
    // A repeated release returns the same stable refusal rather than a generic restore failure.
    await assert.rejects(manager.releaseIssue(issue!.id), (error) => error instanceof WorkspaceReleaseRefusal && error.reason === "workspace_missing");
    assert.equal(classifyRepositoryState(await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id))), "development_snapshot");
    assert.equal((await database.db.select().from(issues).where(eq(issues.id, issue!.id)))[0]!.status, "resolved");
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});
