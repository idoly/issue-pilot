import { buildApi } from "../../src/http/api.ts";
import { modelCatalog, TestAgentController } from "../http/fixture.ts";
import { prepareIssueRuntime } from "../../src/workspace/runtime.ts";
import { waitFor } from "../helpers/async.ts";
import { createBareRemote, git } from "../helpers/git.ts";
import { registerTestRepositories } from "../helpers/repositories.ts";
import assert from "node:assert/strict";
import { OperationError } from "../../src/operation-error.ts";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, test, type TestContext } from "node:test";
import { setImmediate as nextImmediate } from "node:timers/promises";
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
  directoryBytes,
  WorkspaceConversionRefusal,
  WorkspaceLifecycleManager,
  workspaceLifecyclePolicy,
  WorkspaceReleaseRefusal,
  WorkspaceRestoreRefusal,
  WorkspaceScopeMigrationRefusal,
} from "../../src/workspace/lifecycle.ts";
import { IssueProjectManager } from "../../src/workspace/project.ts";
import { IssueScopeTransitionManager, ScopeTransitionRefusal } from "../../src/workspace/scope-transition.ts";
import { claimIssueRoot, classifyRepositoryState, gitRoot, issueRoot } from "../../src/workspace/state.ts";

const execFileAsync = promisify(execFile);

async function createRemote(root: string, name: string): Promise<string> {
  return (await createBareRemote(root, { source: `${name}-source`, remote: `${name}.git`, files: { "README.md": `${name}\n` } })).remote;
}

/** Real SQLite Issue rows with claimed roots, ordered by updatedAt, so lifecycle readers and inspection run unmodified. */
async function seededLifecycle(context: TestContext, keys: string[], environmentKind: "dev" | "test" = "dev") {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-lifecycle-rows-"));
  const database = await openApplicationDatabase(path.join(root, "issues.db"));
  context.after(async () => {
    await database.close();
    await rm(root, { recursive: true, force: true });
  });
  const [environment] = await database.db.select().from(environments).where(eq(environments.kind, environmentKind)).limit(1);
  await database.db.insert(subjects).values({ subject: "lifecycle-owner", role: "developer" });
  const [service] = await database.db.insert(services).values({ key: "lifecycle-rows", name: "Lifecycle rows" }).returning();
  await database.db.insert(serviceDeployments).values({ serviceId: service!.id, environmentId: environment!.id, config: {} });
  const seeded: Array<typeof issues.$inferSelect> = [];
  for (const [index, key] of keys.entries()) {
    const [issue] = await database.db
      .insert(issues)
      .values({ key, title: key, type: "defect_fix", serviceId: service!.id, environmentId: environment!.id, reporterSubject: "lifecycle-owner", updatedAt: new Date(index * 1000) })
      .returning();
    await database.db.insert(issueWorkspaces).values({ issueId: issue!.id });
    await claimIssueRoot(root, key);
    seeded.push(issue!);
  }
  return { root, database: database.db, issues: seeded };
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

test("automatic release isolates a session failure and retries without rebuilding released views", async () => {
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
      await claimIssueRoot(root, issue!.key);
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
        if (fail && id === created[0]!.id) throw failure;
      },
    };
    const manager = new WorkspaceLifecycleManager(database.db, root, scopedEngine as never, {
      retentionMs: 0,
      highWaterBytes: 0,
      targetBytes: 0,
      maintenanceIntervalMs: 0,
      taskConcurrency: 1,
    });
    const first = await manager.maintain();
    assert.deepEqual(
      first.released.map((row) => row.issueKey),
      [created[1]!.key],
    );
    assert.equal(first.failures.length, 1);
    assert.equal(first.failures[0]!.issueKey, created[0]!.key);
    assert.ok(first.failures[0]!.error === failure || (first.failures[0]!.error instanceof Error && first.failures[0]!.error.cause === failure));
    const independentlyMeasured = await new WorkspaceLifecycleManager(database.db, root, scopedEngine as never, manager.policy).sampleStats();
    assert.equal(first.totalBytes, independentlyMeasured.totalBytes);
    assert.equal((await manager.sampleStats()).totalBytes, independentlyMeasured.totalBytes);
    await access(paths[2]!);
    assert.equal(scopedEngine.closed.includes(created[2]!.id), false);
    await access(paths[0]!);
    await assert.rejects(lstat(paths[1]!), { code: "ENOENT" });
    fail = false;
    const retried = await manager.maintain();
    assert.deepEqual(retried.failures, []);
    assert.deepEqual(
      retried.released.map(({ issueKey }) => issueKey),
      [created[0]!.key],
    );
    assert.equal(scopedEngine.closed.filter((id) => id === created[1]!.id).length, 1);
    assert.equal((await manager.inspectIssue(created[0]!.id)).blockedReason, "workspace_released");
    for (const issue of created.slice(0, 2)) {
      const [state] = await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, issue.id));
      assert.ok(state!.releasedAt);
      assert.equal(state!.runtimeReady, false);
      await assert.rejects(lstat(path.join(issueRoot(root, issue.key), ".issue-runtime.json")), { code: "ENOENT" });
    }
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
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
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
    await claimIssueRoot(root, issue!.key);
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
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
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
      await claimIssueRoot(root, issue!.key);
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
    // An unreadable subtree can make du print a total and still exit 1. That total is incomplete.
    let unreadable = true;
    const measure = async (candidate: string) => {
      if (unreadable && candidate === issueRoot(root, created[0]!.key)) throw new Error("du: unreadable subtree");
      return directoryBytes(candidate);
    };

    const manager = new WorkspaceLifecycleManager(
      database.db,
      root,
      measurementEngine as never,
      {
        retentionMs: 0,
        highWaterBytes: 0,
        targetBytes: 0,
        maintenanceIntervalMs: 0,
        taskConcurrency: 1,
      },
      { measure },
    );
    const result = await manager.maintain();
    assert.deepEqual(
      result.failures.map((failure) => failure.issueKey),
      [created[0]!.key],
    );
    assert.deepEqual(
      result.released.map((release) => release.issueKey),
      [created[1]!.key],
    );
    assert.equal(manager.readStats().snapshot, null);
    assert.equal(manager.readStats().error, "workspace_measurement_incomplete");
    // Once measurement works again the next cycle is complete again.
    unreadable = false;
    const refreshed = await manager.maintain();
    assert.deepEqual(refreshed.failures, []);
  } finally {
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
      await claimIssueRoot(root, issue!.key);
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
        await git(["-C", prepared.workspacePath, "commit", "-m", "large committed file"]);
      }
      created.push(issue!);
    }
    const policy = { retentionMs: Infinity, highWaterBytes: 0, targetBytes: 0, maintenanceIntervalMs: 0, taskConcurrency: 1 };
    await writeFile(path.join(gitRoot(root), "shared-accounting-probe"), Buffer.alloc(2 * 1024 ** 2, 11));
    const initial = await new WorkspaceLifecycleManager(database.db, root, quotaEngine as never, policy).sampleStats();
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
    const fresh = await new WorkspaceLifecycleManager(database.db, root, quotaEngine as never, policy).sampleStats();
    assert.equal(result.totalBytes, fresh.totalBytes);
    assert.equal((await manager.sampleStats()).totalBytes, fresh.totalBytes);
    assert.equal((await manager.sampleStats()).sharedGitBytes, fresh.sharedGitBytes);
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

/** Drains the promise callbacks queued by a fired maintenance timer; only setTimeout is mocked. */
const settle = () => nextImmediate();
/** Drains immediates until a condition holds; polling timers are unavailable while setTimeout is mocked. */
async function settleUntil(check: () => boolean, attempts = 1_000): Promise<void> {
  for (let attempt = 0; attempt < attempts && !check(); attempt++) await settle();
  assert.ok(check(), "condition_not_met");
}

/** A real manager over one seeded open Issue; each maintenance pass measures that Issue root exactly once. */
async function countedMaintenance(context: TestContext, policy: ConstructorParameters<typeof WorkspaceLifecycleManager>[3], hold?: Promise<void>) {
  const {
    root,
    database,
    issues: [issue],
  } = await seededLifecycle(context, ["ISSUE-20260815-001"]);
  const counter = { cycles: 0 };
  const measure = async (candidate: string) => {
    if (candidate !== issueRoot(root, issue!.key)) return 0;
    counter.cycles++;
    await hold;
    return 0;
  };
  return { counter, manager: new WorkspaceLifecycleManager(database, root, engine as never, policy, { measure }) };
}

test("applies an updated policy to the maintenance timer without restarting the manager", async (t) => {
  const disabled = { retentionMs: Number.POSITIVE_INFINITY, highWaterBytes: 0, targetBytes: 0, maintenanceIntervalMs: 0, taskConcurrency: 1 };
  const { counter, manager } = await countedMaintenance(t, disabled);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let completed = Promise.withResolvers<void>();
  manager.start(undefined, () => completed.resolve());
  try {
    assert.throws(() => manager.updatePolicy({ ...disabled, highWaterBytes: 10, targetBytes: 10 }), /workspace_target_must_be_below_high_water/);
    assert.deepEqual(manager.policy, disabled);
    // Listening with periodic maintenance disabled must not run an initial scan.
    t.mock.timers.tick(60_000);
    await settle();
    assert.equal(counter.cycles, 0);
    manager.updatePolicy({ ...disabled, maintenanceIntervalMs: 5 });
    for (const expected of [1, 2]) {
      t.mock.timers.tick(4);
      await settle();
      assert.equal(counter.cycles, expected - 1);
      t.mock.timers.tick(1);
      await completed.promise;
      await settle();
      assert.equal(counter.cycles, expected);
      completed = Promise.withResolvers<void>();
    }
    manager.updatePolicy(disabled);
    t.mock.timers.tick(60_000);
    await settle();
    assert.equal(counter.cycles, 2);
  } finally {
    await manager.stop();
  }
});

test("a slow maintenance pass does not start or accumulate timer work", async (t) => {
  const policy = { retentionMs: Infinity, highWaterBytes: 0, targetBytes: 0, maintenanceIntervalMs: 5, taskConcurrency: 1 };
  const firstPass = Promise.withResolvers<void>();
  const { counter, manager } = await countedMaintenance(t, policy, firstPass.promise);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const completed = Promise.withResolvers<void>();
  manager.start(undefined, () => completed.resolve());
  try {
    t.mock.timers.tick(5);
    await settleUntil(() => counter.cycles === 1);
    // Further intervals elapse while the first pass is still running.
    t.mock.timers.tick(30);
    await settle();
    assert.equal(counter.cycles, 1);
    manager.updatePolicy({ ...policy, maintenanceIntervalMs: 0 });
    firstPass.resolve();
    await completed.promise;
    await settle();
    t.mock.timers.tick(30);
    await settle();
    assert.equal(counter.cycles, 1);
  } finally {
    firstPass.resolve();
    await manager.stop();
  }
});

test("stops maintenance only after the active exclusive operation drains", async (context) => {
  const {
    root,
    database,
    issues: [issue],
  } = await seededLifecycle(context, ["ISSUE-20260815-002"]);
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  // A statistics sample holds the lifecycle queue while it measures the Issue root.
  const measure = async (candidate: string) => {
    if (candidate === issueRoot(root, issue!.key)) {
      started.resolve();
      await gate.promise;
    }
    return 0;
  };
  const manager = new WorkspaceLifecycleManager(
    database,
    root,
    engine as never,
    { retentionMs: Number.POSITIVE_INFINITY, highWaterBytes: 0, targetBytes: 0, maintenanceIntervalMs: 0, taskConcurrency: 1 },
    { measure },
  );
  const sample = manager.sampleStats();
  await started.promise;

  let stopped = false;
  const firstStop = manager.stop();
  assert.equal(manager.stop(), firstStop);
  const stopping = firstStop.then(() => {
    stopped = true;
  });
  // New lifecycle work is refused once stopping begins; the active operation still drains.
  await assert.rejects(manager.releaseIssue(issue!.id), /workspace_lifecycle_closing/);
  await assert.rejects(manager.maintain(), /workspace_lifecycle_closing/);
  assert.throws(() => manager.readStats(), /workspace_lifecycle_closing/);
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(stopped, false);
  gate.resolve();
  await Promise.all([sample, stopping]);
  assert.equal(stopped, true);
});

test("lifecycle mutations reauthorize only after earlier lifecycle and inspection work drains", async (context) => {
  const {
    root,
    database,
    issues: [blocker, target],
  } = await seededLifecycle(context, ["ISSUE-20260816-001", "ISSUE-20260816-002"], "test");
  await database
    .update(issues)
    .set({ status: "resolved", resolvedAt: new Date(0) })
    .where(eq(issues.id, blocker!.id));
  // The blocker reopens a resolved read-only Issue and holds the lifecycle queue inside its session close.
  const closing = Promise.withResolvers<void>(),
    closeGate = Promise.withResolvers<void>();
  const gatedEngine = {
    ...engine,
    running: new Set<string>(),
    async closeSession(issueId: string) {
      closing.resolve();
      await closeGate.promise;
      engine.closed.push(issueId);
    },
  };
  const inspecting = Promise.withResolvers<void>(),
    inspectionGate = Promise.withResolvers<void>();
  let holdInspection = false;
  const measure = async () => {
    if (holdInspection) {
      inspecting.resolve();
      await inspectionGate.promise;
    }
    return 0;
  };
  const manager = new WorkspaceLifecycleManager(
    database,
    root,
    gatedEngine as never,
    { retentionMs: Number.POSITIVE_INFINITY, highWaterBytes: 0, targetBytes: 0, maintenanceIntervalMs: 0, taskConcurrency: 1 },
    { measure },
  );
  const denied = new Error("caller_no_longer_authorized");
  let authorizations = 0;
  const authorize = async () => {
    authorizations++;
    throw denied;
  };
  const reopened = manager.reopenIssue(blocker!.id);
  await closing.promise;
  const queued = [
    manager.releaseIssue(target!.id, authorize),
    manager.reopenIssue(target!.id, authorize),
    manager.convertIssueToDevelopment(target!.id, undefined, undefined, authorize),
    manager.migrateDevelopmentIssueScope(target!.id, { serviceId: target!.serviceId, environmentId: target!.environmentId }, target!.updatedAt.toISOString(), undefined, authorize),
  ];
  // Let every queued caller run as far as it can; none may reach authorization yet.
  for (let turn = 0; turn < 20; turn++) await settle();
  assert.equal(authorizations, 0);
  closeGate.resolve();
  assert.equal((await reopened).status, "open");
  for (const operation of queued) await assert.rejects(operation, (error) => error === denied);
  assert.equal(authorizations, queued.length);

  // A per-Issue inspection is the second wait: authorization follows it as well.
  holdInspection = true;
  const inspection = manager.inspectIssue(target!.id);
  await inspecting.promise;
  holdInspection = false;
  const release = manager.releaseIssue(target!.id, authorize);
  for (let turn = 0; turn < 20; turn++) await settle();
  assert.equal(authorizations, queued.length);
  inspectionGate.resolve();
  await inspection;
  await assert.rejects(release, (error) => error === denied);
  assert.equal(authorizations, queued.length + 1);
  assert.deepEqual(engine.closed, [blocker!.id]);
  assert.equal((await database.select().from(issues).where(eq(issues.id, target!.id)))[0]!.updatedAt.getTime(), target!.updatedAt.getTime());
});

test("serializes deep inspection per Issue without blocking other Issues", async (context) => {
  const {
    root,
    database,
    issues: [a, b],
  } = await seededLifecycle(context, ["ISSUE-20260814-001", "ISSUE-20260814-002"]);
  const entered = Promise.withResolvers<void>();
  const firstGate = Promise.withResolvers<void>();
  const inspected: string[] = [];
  const measure = async (candidate: string) => {
    const issue = [a!, b!].find(({ key }) => candidate === issueRoot(root, key));
    if (issue) inspected.push(issue.id);
    if (issue === a && inspected.filter((id) => id === a!.id).length === 1) {
      entered.resolve();
      await firstGate.promise;
    }
    return 0;
  };
  const manager = new WorkspaceLifecycleManager(
    database,
    root,
    engine as never,
    { retentionMs: Number.POSITIVE_INFINITY, highWaterBytes: 0, targetBytes: 0, maintenanceIntervalMs: 0, taskConcurrency: 1 },
    { measure },
  );

  const first = manager.inspectIssue(a!.id);
  await entered.promise;
  const sameIssue = manager.inspectIssue(a!.id);
  const otherIssue = manager.inspectIssue(b!.id);
  await otherIssue;
  assert.deepEqual(inspected, [a!.id, b!.id]);
  let stopped = false;
  const stopping = manager.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(stopped, false);
  firstGate.resolve();
  await Promise.all([first, sameIssue, stopping]);
  assert.deepEqual(inspected, [a!.id, b!.id, a!.id]);
  assert.equal(stopped, true);
});

test("shares one statistics scan and retains the complete snapshot until an explicit or scheduled update", async (context) => {
  const {
    root,
    database,
    issues: [issue],
  } = await seededLifecycle(context, ["ISSUE-20260814-001"]);
  const started = Promise.withResolvers<void>();
  const firstGate = Promise.withResolvers<void>();
  // Each Issue-root measurement is one full inspection; a reused known size would skip it.
  let inspections = 0;
  const measure = async (candidate: string) => {
    if (candidate !== issueRoot(root, issue!.key)) return 0;
    inspections += 1;
    if (inspections === 1) {
      started.resolve();
      await firstGate.promise;
    }
    return 0;
  };
  const manager = new WorkspaceLifecycleManager(
    database,
    root,
    engine as never,
    { retentionMs: Number.POSITIVE_INFINITY, highWaterBytes: 0, targetBytes: 0, maintenanceIntervalMs: 0, taskConcurrency: 1 },
    { measure },
  );

  const first = manager.sampleStats();
  const second = manager.sampleStats();
  await started.promise;
  assert.equal(inspections, 1);
  firstGate.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(secondResult, firstResult);
  assert.equal(inspections, 1);

  const cached = manager.readStats().snapshot!;
  assert.equal(inspections, 1);
  assert.equal(cached.sampledAt, firstResult.sampledAt);
  await manager.sampleStats();
  assert.equal(inspections, 2);
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  context.mock.timers.tick(5_001);
  manager.readStats();
  assert.equal(inspections, 2);
});

test("bounds concurrent Workspace inspections while preserving Issue order", async (context) => {
  const {
    root,
    database,
    issues: seeded,
  } = await seededLifecycle(
    context,
    Array.from({ length: 5 }, (_, index) => `ISSUE-20260814-10${index}`),
  );
  const roots = new Set(seeded.map(({ key }) => issueRoot(root, key)));
  let active = 0;
  let maximumActive = 0;
  let started = 0;
  const inspectionGate = Promise.withResolvers<void>();
  const concurrencyReached = Promise.withResolvers<void>();
  const measure = async (candidate: string) => {
    if (!roots.has(candidate)) return 0;
    active += 1;
    started += 1;
    maximumActive = Math.max(maximumActive, active);
    if (active === 2) concurrencyReached.resolve();
    await inspectionGate.promise;
    active -= 1;
    return 0;
  };
  const manager = new WorkspaceLifecycleManager(
    database,
    root,
    engine as never,
    { retentionMs: Number.POSITIVE_INFINITY, highWaterBytes: 0, targetBytes: 0, maintenanceIntervalMs: 0, taskConcurrency: 2 },
    { measure },
  );

  const statistics = manager.sampleStats();
  await concurrencyReached.promise;
  assert.equal(started, 2);
  assert.equal(active, 2);
  inspectionGate.resolve();
  const result = await statistics;
  assert.equal(maximumActive, 2);
  assert.deepEqual(
    result.workspaces.map(({ issueId }) => issueId),
    seeded.map(({ id }) => id),
  );
});

/** A real manager whose maintenance cannot measure the seeded Issue roots, so every pass reports one failure per Issue. */
async function failingMaintenance(context: TestContext, failures: Map<string, Error>) {
  const { root, database, issues: seeded } = await seededLifecycle(context, [...failures.keys()]);
  const measure = async (candidate: string) => {
    const issue = seeded.find(({ key }) => candidate === issueRoot(root, key));
    if (issue) throw failures.get(issue.key)!;
    return 0;
  };
  return new WorkspaceLifecycleManager(database, root, engine as never, { retentionMs: Infinity, highWaterBytes: 0, targetBytes: 0, maintenanceIntervalMs: 1, taskConcurrency: 1 }, { measure });
}

test("isolates maintenance reporter failures", async (context) => {
  const manager = await failingMaintenance(context, new Map([["ISSUE-20261024-950", new Error("unmeasurable")]]));
  let reports = 0;
  manager.start(() => {
    reports += 1;
    throw new Error("logger_failed");
  });
  // A throwing reporter must not stop the timer: a later pass reports again.
  await waitFor(() => reports > 1, { attempts: 2_000, intervalMs: 1 });
  await manager.stop();
  assert.ok(reports > 1);
});

test("maintenance reports each failed Issue even when the reporter itself fails", async (context) => {
  const first = new Error("first failure"),
    second = new Error("second failure");
  const manager = await failingMaintenance(
    context,
    new Map([
      ["ISSUE-20261024-951", first],
      ["ISSUE-20261024-952", second],
    ]),
  );
  const reported: Error[] = [];
  manager.start((error) => {
    assert(error instanceof Error);
    reported.push(error);
    throw new Error("reporter failed");
  });
  await waitFor(() => reported.length >= 2, { attempts: 2_000, intervalMs: 1 });
  await manager.stop();
  assert.match(reported[0]!.message, /ISSUE-20261024-951/);
  assert.equal(reported[0]!.cause, first);
  assert.match(reported[1]!.message, /ISSUE-20261024-952/);
  assert.equal(reported[1]!.cause, second);
});

test("releases clean workspaces while preserving attachments, sessions, and branches", async (t) => {
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
    await claimIssueRoot(root, issue!.key);
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

    const lifecycle = new WorkspaceLifecycleManager(database.db, root, engine as never, {
      retentionMs: Number.POSITIVE_INFINITY,
      highWaterBytes: 0,
      targetBytes: 0,
      maintenanceIntervalMs: 0,
      taskConcurrency: 1,
    });
    await writeFile(path.join(prepared[1]!.workspacePath, "untracked.txt"), "do not delete\n", "utf8");
    const dirtyInspection = await lifecycle.inspectIssue(issue!.id);
    assert.equal(dirtyInspection.releasable, false);
    assert.equal(dirtyInspection.blockedReason, "workspace_has_changes");
    await assert.rejects(lifecycle.releaseIssue(issue!.id), (error: unknown) => error instanceof WorkspaceReleaseRefusal && error.code === "workspace_has_changes");
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
    await assert.rejects(lifecycle.releaseIssue(issue!.id), (error) => error instanceof WorkspaceReleaseRefusal && error.code === "workspace_has_changes");
    assert.equal(await readFile(ignoredEvidence, "utf8"), "uncommitted evidence");
    assert.equal(
      (await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id))).every((repository) => repository.localPath !== null),
      true,
    );
    await unlink(ignoredEvidence);
    const statsBeforeRelease = await lifecycle.sampleStats();
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
    await assert.rejects(lifecycle.releaseIssue(issue!.id), (error) => error instanceof WorkspaceReleaseRefusal && error.code === "issue_runtime_entry_missing");
    await writeFile(manifestPath, originalManifest);
    assert.equal(released.releasedBytes > 0, true);
    assert.equal(await readFile(checkpoint, "utf8"), '{"remaining":10}\n');
    await Promise.all(prepared.map(async (worktree) => assert.rejects(lstat(worktree.workspacePath), { code: "ENOENT" })));
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
    assert.equal(releasedWorkspace!.runtimeReady, false);
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

    // The injected database is the lifecycle's transaction boundary; fail its next transaction once.
    const runTransaction = database.db.transaction.bind(database.db);
    let transactionFailure: Error | undefined;
    database.db.transaction = (async (operation) => {
      const failure = transactionFailure;
      transactionFailure = undefined;
      if (failure) throw failure;
      return runTransaction(operation);
    }) as typeof database.db.transaction;
    transactionFailure = new Error("simulated_restore_transaction_failure");
    await assert.rejects(
      lifecycle.reopenIssue(issue!.id),
      (error: unknown) => error instanceof WorkspaceRestoreRefusal && error.code === "simulated_restore_transaction_failure" && error.cause instanceof Error,
    );
    // Uncertain outcomes, operational damage and unpublishable messages are never republished as refusals.
    const uncertain = new OperationError("simulated_restore_outcome_unknown", "unknown");
    transactionFailure = uncertain;
    await assert.rejects(lifecycle.reopenIssue(issue!.id), (error: unknown) => error === uncertain);
    const missingRoot = new Error("issue_root_missing");
    transactionFailure = missingRoot;
    await assert.rejects(lifecycle.reopenIssue(issue!.id), (error: unknown) => error === missingRoot);
    const unpublishable = new Error("EACCES: permission denied, open '/private/path'");
    transactionFailure = unpublishable;
    await assert.rejects(lifecycle.reopenIssue(issue!.id), (error: unknown) => error === unpublishable);
    assert.equal(await readFile(checkpoint, "utf8"), '{"remaining":10}\n');
    assert.equal(
      (await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id))).every((repository) => repository.localPath === null),
      true,
    );

    assert.ok((await browser.file(issue!, "alpha", "README.md")).content.length);
    await assert.rejects(lstat(prepared[0]!.workspacePath), { code: "ENOENT" });
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
    await assert.rejects(lifecycle.releaseIssue(issue!.id), (error: unknown) => error instanceof WorkspaceReleaseRefusal && error.code === "issue_not_resolved");
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
    await assert.rejects(lifecycle.releaseIssue(issue!.id), (error: unknown) => error instanceof WorkspaceReleaseRefusal && error.code === "workspace_path_does_not_match_repository");
    await database.db.update(issueRepositories).set({ workspaceName: "alpha" }).where(eq(issueRepositories.id, restoredRows[0]!.id));
    // Git removal is the WorktreeManager boundary: change a worktree between the batch's removals.
    const removeWorktree = WorktreeManager.prototype.remove;
    let removalCount = 0;
    let removal = t.mock.method(WorktreeManager.prototype, "remove", async function (this: WorktreeManager, url: string, workspacePath: string, branch: string) {
      removalCount += 1;
      if (removalCount === 2) await writeFile(path.join(workspacePath, "concurrent-change.txt"), "preserve\n", "utf8");
      return removeWorktree.call(this, url, workspacePath, branch);
    });
    await assert.rejects(lifecycle.releaseIssue(issue!.id), (error: unknown) => error instanceof WorkspaceReleaseRefusal && error.code === "workspace_has_changes");
    removal.mock.restore();
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
    removal = t.mock.method(WorktreeManager.prototype, "remove", async function (this: WorktreeManager, url: string, workspacePath: string, branch: string) {
      removalCount += 1;
      const commit = await removeWorktree.call(this, url, workspacePath, branch);
      if (removalCount === restoredRows.length) await writeFile(concurrentRootEntry, "preserve root entry\n", "utf8");
      return commit;
    });
    await lifecycle.releaseIssue(issue!.id);
    removal.mock.restore();
    assert.equal(await readFile(concurrentRootEntry, "utf8"), "preserve root entry\n");
    await Promise.all(restoredRows.map(async (repository) => assert.rejects(lstat(repository.localPath!), { code: "ENOENT" })));
    await lifecycle.reopenIssue(issue!.id);
    await database.db
      .update(issues)
      .set({ status: "resolved", resolvedAt: new Date(0) })
      .where(eq(issues.id, issue!.id));
    await Promise.all(restoredRows.map((repository) => access(repository.localPath!)));
    await unlink(concurrentRootEntry);

    // The release marker is the batch's finalize transaction; its failure must roll every worktree back.
    transactionFailure = new Error("simulated_release_transaction_failure");
    await assert.rejects(lifecycle.releaseIssue(issue!.id), /simulated_release_transaction_failure/);
    assert.equal(transactionFailure, undefined);
    for (const repository of restoredRows) {
      await access(repository.localPath!);
      assert.equal(await git(["-C", repository.localPath!, "branch", "--show-current"]), repository.workingBranch);
    }
    const rowsAfterTransactionRollback = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    assert.deepEqual(rowsAfterTransactionRollback.map((repository) => repository.localPath).sort(), restoredRows.map((repository) => repository.localPath).sort());

    const restoredByUrl = new Map(restoredRows.map((repository) => [repository.url, repository]));
    const missingRepository = restoredByUrl.get(remotes[1]!)!;
    await worktrees.remove(missingRepository.url, missingRepository.localPath!, missingRepository.workingBranch!);
    assert.equal((await lifecycle.inspectIssue(issue!.id)).blockedReason, "workspace_repository_missing");
    await assert.rejects(lifecycle.releaseIssue(issue!.id), (error: unknown) => error instanceof WorkspaceReleaseRefusal && error.code === "workspace_repository_missing");
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
    await assert.rejects(lifecycle.releaseIssue(issue!.id), (error: unknown) => error instanceof WorkspaceReleaseRefusal && error.code === "development_repository_state_invalid");
    await Promise.all(restoredRows.map((repository) => access(repository.localPath!)));
    await database.db.update(issueRepositories).set({ localPath: missingRepository.localPath }).where(eq(issueRepositories.id, missingRepository.id));

    await database.db.delete(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    assert.equal((await lifecycle.inspectIssue(issue!.id)).blockedReason, "development_repository_state_invalid");
    await assert.rejects(lifecycle.releaseIssue(issue!.id), (error: unknown) => error instanceof WorkspaceReleaseRefusal && error.code === "development_repository_state_invalid");
    await Promise.all(restoredRows.map((repository) => access(repository.localPath!)));
    await database.db.insert(issueRepositories).values(restoredRows);

    await database.db
      .update(issues)
      .set({ status: "resolved", resolvedAt: new Date(0) })
      .where(eq(issues.id, issue!.id));
    for (const repository of restoredRows) await worktrees.remove(repository.url, repository.localPath!, repository.workingBranch!);
    const preservedRoot = path.join(root, "preserved-issue-root");
    await rename(issueRoot(root, issue!.key), preservedRoot);
    await database.db.update(issueWorkspaces).set({ status: "running" }).where(eq(issueWorkspaces.issueId, issue!.id));
    await assert.rejects(lifecycle.releaseIssue(issue!.id), (error: unknown) => error instanceof WorkspaceReleaseRefusal && error.code === "workspace_busy");
    assert.equal(classifyRepositoryState(await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id))), "development_workspace");
    await database.db.update(issueWorkspaces).set({ status: "ready" }).where(eq(issueWorkspaces.issueId, issue!.id));
    // The root held the private Git store; neither release nor reopen may rebuild from an older shared ref.
    await assert.rejects(lifecycle.releaseIssue(issue!.id), (error: unknown) => error instanceof WorkspaceReleaseRefusal && error.code === "workspace_missing");
    assert.equal(classifyRepositoryState(await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id))), "development_workspace");
    assert.equal((await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, issue!.id)))[0]!.status, "ready");
    await assert.rejects(lifecycle.reopenIssue(issue!.id), (error: unknown) => error instanceof WorkspaceRestoreRefusal && error.code === "workspace_missing");
    // A redirected root is operational damage, not a missing workspace the operator can restore.
    await symlink(preservedRoot, issueRoot(root, issue!.key));
    await assert.rejects(lifecycle.reopenIssue(issue!.id), (error: unknown) => !(error instanceof WorkspaceRestoreRefusal) && error instanceof Error && error.message === "invalid_issue_root");
    await unlink(issueRoot(root, issue!.key));

    const reconstruct = async () => {
      await prepareIssueRuntime(root, issue!.key, [], "write");
      // A reconstructed worktree is no longer released; the fixture must record that invariant explicitly.
      await database.db.update(issueWorkspaces).set({ releasedAt: null }).where(eq(issueWorkspaces.issueId, issue!.id));
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
    const retentionLifecycle = new WorkspaceLifecycleManager(database.db, root, engine as never, {
      retentionMs: 0,
      highWaterBytes: 0,
      targetBytes: 0,
      maintenanceIntervalMs: 0,
      taskConcurrency: 1,
    });
    const retention = await retentionLifecycle.maintain();
    assert.deepEqual(
      retention.released.map(({ issueKey }) => issueKey),
      [issue!.key],
    );

    await reconstruct();
    const quotaLifecycle = new WorkspaceLifecycleManager(database.db, root, engine as never, {
      retentionMs: Number.POSITIVE_INFINITY,
      highWaterBytes: 1,
      targetBytes: 0,
      maintenanceIntervalMs: 0,
      taskConcurrency: 1,
    });
    const quota = await quotaLifecycle.maintain();
    assert.deepEqual(
      quota.released.map(({ issueKey }) => issueKey),
      [issue!.key],
    );
    assert.equal(await readFile(checkpoint, "utf8"), '{"remaining":10}\n');
    await Promise.all(prepared.map(async (worktree) => assert.rejects(lstat(worktree.workspacePath), { code: "ENOENT" })));

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
    await assert.rejects(retentionLifecycle.releaseIssue(readOnlyIssue!.id), (error: unknown) => error instanceof WorkspaceReleaseRefusal && error.code === "workspace_not_development");
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
    await database.db.insert(subjects).values({ subject: "conversion-tester", role: "developer", displayName: "Conversion Tester", email: "conversion@example.test" });
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
    const { runtimeRoot } = await projects.prepare(issue!, "test");
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

    const originalRepositories = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    const originalLink = await readlink(path.join(runtimeRoot, "conversion"));
    const originalManifest = await readFile(path.join(runtimeRoot, ".issue-runtime.json"), "utf8");
    // The upstream changes between analysis and conversion; rollback must keep the analyzed version.
    const source = path.join(root, "conversion-source");
    await writeFile(path.join(source, "README.md"), "new upstream baseline\n");
    await git(["-C", source, "commit", "-am", "advance"]);
    await git(["-C", source, "push", remote, "main"]);

    const mutableDatabase = database.db as typeof database.db & { transaction: typeof database.db.transaction };
    const transaction = mutableDatabase.transaction.bind(mutableDatabase);
    let failFinalize = true;
    mutableDatabase.transaction = (async (operation: Parameters<typeof database.db.transaction>[0]) => {
      if (failFinalize) {
        failFinalize = false;
        // Rollback must also work with the remote unavailable after preparation.
        await rename(remote, `${remote}.offline`);
        throw new Error("simulated_conversion_transaction_failure");
      }
      return transaction(operation);
    }) as typeof database.db.transaction;
    await assert.rejects(lifecycle.convertIssueToDevelopment(issue!.id), (error: unknown) => error instanceof WorkspaceConversionRefusal && error.code === "simulated_conversion_transaction_failure");
    mutableDatabase.transaction = transaction;

    const [rolledBackIssue] = await database.db.select().from(issues).where(eq(issues.id, issue!.id)).limit(1);
    const rolledBackRepositories = await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id));
    assert.equal(rolledBackIssue!.environmentId, testEnvironment.id);
    assert.equal(rolledBackIssue!.type, "smart_analysis");
    assert.equal(classifyRepositoryState(rolledBackRepositories), "read_only");
    assert.deepEqual(rolledBackRepositories, originalRepositories);
    assert.equal(await readlink(path.join(runtimeRoot, "conversion")), originalLink);
    assert.equal(await readFile(path.join(runtimeRoot, ".issue-runtime.json"), "utf8"), originalManifest);
    assert.equal((await stat(issueRoot(root, issue!.key))).isDirectory(), true);
    assert.equal(path.resolve(runtimeRoot, await readlink(path.join(runtimeRoot, "conversion"))).startsWith(path.join(root, "git", "checkouts")), true);
    assert.equal(await readFile(sessionFile, "utf8"), '{"type":"session"}\n');
    assert.equal(await readFile(attachmentFile, "utf8"), attachmentContent);
    assert.deepEqual(conversionEngine.enqueued, []);
    await rename(`${remote}.offline`, remote);

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
    await assert.rejects(lifecycle.convertIssueToDevelopment(issue!.id), (error: unknown) => error instanceof WorkspaceConversionRefusal && error.code === "issue_not_convertible_to_development");
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
    await database.db.insert(subjects).values({ subject: "migration-tester", role: "developer", displayName: "Migration Tester" });
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
      (error: unknown) => error instanceof ScopeTransitionRefusal && error.code === "development_branch_mode_immutable",
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
      (error: unknown) => error instanceof WorkspaceScopeMigrationRefusal && error.code === "scope_transition_removed_repository_changed",
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
      (error: unknown) => error instanceof WorkspaceScopeMigrationRefusal && error.code === "simulated_scope_migration_transaction_failure",
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
    await claimIssueRoot(root, issue!.key);
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
    const initial = await manager.sampleStats();
    assert.equal(initial.workspaces[0]!.releasable, true);
    await writeFile(path.join(prepared.workspacePath, "README.md"), "new working changes\n");
    assert.equal(manager.readStats().snapshot?.sampledAt, initial.sampledAt);
    assert.equal(manager.readStats().snapshot?.workspaces[0]!.releasable, true);
    await assert.rejects(manager.releaseIssue(issue!.id), /workspace_has_changes/);
    assert.equal(await readFile(path.join(prepared.workspacePath, "README.md"), "utf8"), "new working changes\n");
    assert.equal((await manager.sampleStats()).workspaces[0]!.blockedReason, "workspace_has_changes");
    const forced = await manager.sampleStats();
    assert.equal(forced.workspaces[0]!.releasable, false);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("statistics reuse one sample across a maintenance cycle unless refreshed", async (context) => {
  const {
    root,
    database,
    issues: [issue],
  } = await seededLifecycle(context, ["ISSUE-20260814-001"]);
  // Maintenance measures each Issue root once and hands the sizes to its sample; every other sample measures again.
  let inspections = 0;
  const measure = async (candidate: string) => {
    if (candidate === issueRoot(root, issue!.key)) inspections += 1;
    return 0;
  };
  const manager = new WorkspaceLifecycleManager(
    database,
    root,
    engine as never,
    { retentionMs: Number.POSITIVE_INFINITY, highWaterBytes: 0, targetBytes: 0, maintenanceIntervalMs: 15 * 60_000, taskConcurrency: 1 },
    { measure },
  );
  const first = await manager.sampleStats();
  assert.equal(inspections, 1);
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  // A page revisit within the maintenance cycle serves the sampled snapshot instead of rescanning the fleet.
  context.mock.timers.tick(5 * 60_000);
  const cached = manager.readStats().snapshot!;
  assert.equal(inspections, 1);
  assert.equal(cached.sampledAt, first.sampledAt);
  // Automatic maintenance changes workspace state, so its cache must not outlive that pass.
  await manager.maintain();
  const maintained = manager.readStats().snapshot!;
  assert.equal(inspections, 2);
  assert.notEqual(maintained.sampledAt, first.sampledAt);
  // The explicit refresh still measures.
  await manager.sampleStats();
  assert.equal(inspections, 3);
  // Reads keep the last completed snapshot; only scheduled or explicit sampling does I/O.
  context.mock.timers.tick(15 * 60_000 + 1);
  manager.readStats();
  assert.equal(inspections, 3);
});

test("overlapping refreshes share the active fresh sample", async (context) => {
  const {
    root,
    database,
    issues: [issue],
  } = await seededLifecycle(context, ["ISSUE-20260814-001"]);
  const started = Promise.withResolvers<void>();
  const firstGate = Promise.withResolvers<void>();
  let inspections = 0;
  const measure = async (candidate: string) => {
    if (candidate !== issueRoot(root, issue!.key)) return 0;
    inspections += 1;
    const bytes = inspections;
    if (inspections === 1) {
      started.resolve();
      await firstGate.promise;
    }
    return bytes;
  };
  const manager = new WorkspaceLifecycleManager(
    database,
    root,
    engine as never,
    { retentionMs: Number.POSITIVE_INFINITY, highWaterBytes: 0, targetBytes: 0, maintenanceIntervalMs: 0, taskConcurrency: 1 },
    { measure },
  );
  const first = manager.sampleStats();
  await started.promise;
  const refreshed = manager.sampleStats();
  const alsoRefreshed = manager.sampleStats();
  firstGate.resolve();
  const [firstResult, refreshedResult, alsoRefreshedResult] = await Promise.all([first, refreshed, alsoRefreshed]);
  assert.equal(inspections, 1);
  assert.equal(firstResult.totalBytes, 1);
  assert.equal(refreshedResult.totalBytes, 1);
  assert.equal(alsoRefreshedResult, refreshedResult);
});

/** Turn a seeded row into a resolved development Issue with one clean registered worktree, so a real release succeeds. */
async function releasableDevelopmentIssue(root: string, database: Awaited<ReturnType<typeof seededLifecycle>>["database"], issue: typeof issues.$inferSelect, resolvedAt: Date) {
  await database.update(issues).set({ status: "resolved", resolvedAt }).where(eq(issues.id, issue.id));
  await database.update(issueWorkspaces).set({ status: "ready", runtimeReady: true }).where(eq(issueWorkspaces.issueId, issue.id));
  const remote = await createRemote(root, issue.key.toLowerCase());
  const prepared = await new WorktreeManager(root).prepare({ issueKey: issue.key, workspaceName: "repo", url: remote, baseBranch: "main", mode: "hotfix" });
  await database.insert(issueRepositories).values({
    issueId: issue.id,
    url: remote,
    baseBranch: "main",
    workingBranch: prepared.workingBranch,
    localPath: prepared.workspacePath,
    workspaceName: "repo",
    commitBefore: prepared.baseCommit,
  });
}

test("statistics requested after a queued release see the released workspace", async (context) => {
  const {
    root,
    database,
    issues: [issue],
  } = await seededLifecycle(context, ["ISSUE-20261025-993"]);
  await releasableDevelopmentIssue(root, database, issue!, new Date(0));
  // Hold the first sample inside its Issue-root measurement so the release and the next sample queue behind it.
  const started = Promise.withResolvers<void>(),
    gate = Promise.withResolvers<void>();
  let held = false;
  const measure = async (candidate: string) => {
    if (candidate === issueRoot(root, issue!.key) && !held) {
      held = true;
      started.resolve();
      await gate.promise;
    }
    return directoryBytes(candidate);
  };
  const manager = new WorkspaceLifecycleManager(
    database,
    root,
    engine as never,
    { retentionMs: Infinity, highWaterBytes: 0, targetBytes: 0, maintenanceIntervalMs: 0, taskConcurrency: 1 },
    { measure },
  );
  const statistics = manager.sampleStats();
  await started.promise;
  const release = manager.releaseIssue(issue!.id);
  const afterRelease = manager.sampleStats();
  gate.resolve();
  const before = await statistics;
  assert.equal(before.workspaces[0]!.blockedReason, null);
  assert.equal((await release).alreadyReleased, false);
  const current = await afterRelease;
  assert.notEqual(current, before);
  assert.equal(current.workspaces[0]!.blockedReason, "workspace_released");
  assert.equal(manager.readStats().snapshot, current);
});

test("a failed release whose workspace cannot be measured does not stop maintenance of other candidates", async (context) => {
  const {
    root,
    database,
    issues: [failing, releasable],
  } = await seededLifecycle(context, ["ISSUE-20261103-001", "ISSUE-20261103-002"]);
  await database
    .update(issues)
    .set({ status: "resolved", resolvedAt: new Date(0) })
    .where(eq(issues.id, failing!.id));
  await writeFile(path.join(issueRoot(root, failing!.key), "evidence.txt"), "x".repeat(8192));
  await releasableDevelopmentIssue(root, database, releasable!, new Date(1000));
  // The maintenance pass measures the failing root once; its release inspection and the follow-up measurement then fail.
  let failingMeasurements = 0;
  const measure = async (candidate: string) => {
    if (candidate === issueRoot(root, failing!.key) && ++failingMeasurements > 1) throw new Error("du command failed");
    return directoryBytes(candidate);
  };
  const manager = new WorkspaceLifecycleManager(database, root, engine as never, { retentionMs: 0, highWaterBytes: 0, targetBytes: 0, maintenanceIntervalMs: 0, taskConcurrency: 1 }, { measure });
  const result = await manager.maintain();
  assert.deepEqual(
    result.released.map((release) => release.issueKey),
    [releasable!.key],
  );
  assert.equal(failingMeasurements, 3);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]!.issueKey, failing!.key);
  assert.match(String((result.failures[0]!.error as Error).message), /workspace_maintenance_measurement_failed/);
  assert.equal(manager.readStats().error, "workspace_measurement_incomplete");
  const [released] = await database.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, releasable!.id));
  assert.notEqual(released!.releasedAt, null);
  const [retained] = await database.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, failing!.id));
  assert.equal(retained!.releasedAt, null);
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
    await claimIssueRoot(root, issue!.key);
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
    await assert.rejects(manager.releaseIssue(issue!.id), (error) => error instanceof WorkspaceReleaseRefusal && error.code === "workspace_missing");
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
    await claimIssueRoot(root, issue!.key);
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
    await assert.rejects(manager.reopenIssue(issue!.id), (error) => error instanceof WorkspaceRestoreRefusal && error.code === "workspace_missing");
    // A repeated release returns the same stable refusal rather than a generic restore failure.
    await assert.rejects(manager.releaseIssue(issue!.id), (error) => error instanceof WorkspaceReleaseRefusal && error.code === "workspace_missing");
    assert.equal(classifyRepositoryState(await database.db.select().from(issueRepositories).where(eq(issueRepositories.issueId, issue!.id))), "development_snapshot");
    assert.equal((await database.db.select().from(issues).where(eq(issues.id, issue!.id)))[0]!.status, "resolved");
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot reads remain immediate during sampling, preserve failures, and drain on shutdown", async (context) => {
  const { root, database } = await seededLifecycle(context, []);
  let entered = Promise.withResolvers<void>();
  let gate = Promise.withResolvers<void>();
  let fail = false;
  let scans = 0;
  // Without Issues, each sample measures only the shared Git root.
  const measure = async () => {
    scans++;
    entered.resolve();
    await gate.promise;
    if (fail) throw new Error("du command failed: /private/secret");
    return 0;
  };
  const manager = new WorkspaceLifecycleManager(
    database,
    root,
    engine as never,
    { retentionMs: Infinity, highWaterBytes: 0, targetBytes: 0, maintenanceIntervalMs: 0, taskConcurrency: 1 },
    { measure },
  );
  assert.deepEqual(manager.readStats(), { snapshot: null, sampling: true, error: null });
  const first = manager.sampleStats();
  await entered.promise;
  for (let count = 0; count < 10; count++) assert.equal(manager.readStats().sampling, true);
  assert.equal(scans, 1);
  gate.resolve();
  const snapshot = await first;
  assert.equal(manager.readStats().snapshot, snapshot);

  gate = Promise.withResolvers<void>();
  fail = true;
  assert.deepEqual(manager.readStats(true), { snapshot, sampling: true, error: null });
  const failed = assert.rejects(manager.sampleStats(), /du command failed/);
  gate.resolve();
  await failed;
  assert.deepEqual(manager.readStats(), { snapshot, sampling: false, error: "workspace_statistics_failed" });
  for (let count = 0; count < 10; count++) manager.readStats();
  assert.equal(scans, 2, "ordinary polling must not retry a failed scan");

  fail = false;
  entered = Promise.withResolvers<void>();
  gate = Promise.withResolvers<void>();
  manager.readStats(true);
  const retry = manager.sampleStats();
  let stopped = false;
  const closing = manager.stop().then(() => {
    stopped = true;
  });
  await entered.promise;
  assert.equal(stopped, false);
  gate.resolve();
  await Promise.all([retry, closing]);
  assert.equal(scans, 3);
  assert.equal(stopped, true);
});

test("maintenance publishes a complete snapshot without rescanning measured Issue roots", async (context) => {
  const {
    root,
    database,
    issues: [issue],
  } = await seededLifecycle(context, ["ISSUE-20261113-999"], "test");
  const measured: string[] = [];
  let manager!: WorkspaceLifecycleManager;
  const measure = async (candidate: string) => {
    measured.push(candidate);
    assert.equal(manager.readStats().sampling, true);
    assert.equal(manager.readStats().snapshot, null);
    return directoryBytes(candidate);
  };
  manager = new WorkspaceLifecycleManager(database, root, engine as never, { retentionMs: Infinity, highWaterBytes: 0, targetBytes: 0, maintenanceIntervalMs: 0, taskConcurrency: 1 }, { measure });
  try {
    await writeFile(path.join(issueRoot(root, issue!.key), "report.txt"), "x".repeat(8192));
    const result = await manager.maintain();
    const state = manager.readStats();
    assert.equal(measured.filter((candidate) => candidate === issueRoot(root, issue!.key)).length, 1);
    assert.ok(state.snapshot!.workspaces[0]!.bytes >= 8192);
    assert.equal(state.snapshot?.totalBytes, result.totalBytes);
    assert.equal(state.snapshot?.sharedGitBytes, 0);
    assert.equal(state.snapshot?.workspaces[0]?.blockedReason, "workspace_not_development");
    assert.equal(state.sampling, false);
    assert.equal(state.error, null);
  } finally {
    await manager.stop();
  }
});
