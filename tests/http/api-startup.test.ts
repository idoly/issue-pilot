import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Server } from "node:net";
import { test } from "node:test";

import { inspect, promisify } from "node:util";
import { eq } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { buildApi, installShutdownHandlers, startApi, type AgentController } from "../../src/http/api.ts";
import { errorChain } from "../../src/diagnostics.ts";
import { ApplicationStateLease } from "../../src/workspace/state-lease.ts";
import { createApiFixture, createIssue, createService, modelCatalog } from "./fixture.ts";
import { openDatabase } from "../../src/db/client.ts";

import { agentSessions, issues, issueWorkspaces, serviceRepositories } from "../../src/db/schema.ts";
import { IssueProjectManager } from "../../src/workspace/project.ts";
import { WorktreeManager } from "../../src/workspace/git.ts";
import { issueRoot, legacyIssueRoot } from "../../src/workspace/state.ts";
import { registerTestRepositories } from "../helpers/repositories.ts";

const git = promisify(execFile);

class StartupEngine implements AgentController {
  closed = 0;
  closeError: Error | undefined;
  enqueue(): void {}
  async send(): Promise<void> {}
  isRunning(): boolean {
    return false;
  }
  getRunState() {
    return "idle" as const;
  }
  async runExclusive<T>(_issueIds: string[], operation: (reservation: { enqueue(): void; closeSession(): Promise<void> }) => Promise<T>): Promise<T> {
    return operation({ enqueue() {}, async closeSession() {} });
  }
  async close(): Promise<void> {
    this.closed += 1;
    if (this.closeError) throw this.closeError;
  }
}

test("classifies malformed, unsupported and oversized request bodies as client errors", async () => {
  const fixture = await createApiFixture();
  try {
    const empty = await fixture.app.inject({ method: "POST", url: "/api/issues", headers: { "content-type": "application/json" }, payload: "" });
    assert.equal(empty.statusCode, 400);
    assert.deepEqual(empty.json(), { error: "invalid_json" });
    const malformed = await fixture.app.inject({ method: "POST", url: "/api/issues", headers: { "content-type": "application/json" }, payload: "{" });
    assert.equal(malformed.statusCode, 400);
    assert.deepEqual(malformed.json(), { error: "invalid_json" });
    const oversized = await fixture.app.inject({ method: "POST", url: "/api/issues", headers: { "content-type": "application/json" }, payload: JSON.stringify("x".repeat(1_200_000)) });
    assert.equal(oversized.statusCode, 413);
    assert.deepEqual(oversized.json(), { error: "payload_too_large" });
    const boundary = "issue-pilot-boundary";
    const fields = Array.from({ length: 65 }, (_, index) => `--${boundary}\r\nContent-Disposition: form-data; name="field${index}"\r\n\r\nx\r\n`).join("");
    const tooManyFields = await fixture.app.inject({
      method: "POST",
      url: "/api/issues",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: `${fields}--${boundary}--\r\n`,
    });
    assert.equal(tooManyFields.statusCode, 413);
    assert.deepEqual(tooManyFields.json(), { error: "payload_too_large" });
  } finally {
    await fixture.cleanup();
  }
});

test("rejects a second API before recovering the first API's active Issue state", async () => {
  const fixture = await createApiFixture(),
    connection = openDatabase(fixture.databaseFile);
  try {
    await createService(fixture.app, "Startup ownership");
    const issue = await createIssue(fixture.app, "startup-ownership");
    await connection.client.execute({ sql: "UPDATE issues SET status = 'in_progress' WHERE key = ?", args: [String(issue.id)] });
    await connection.client.execute({ sql: "UPDATE issue_workspaces SET status = 'running' WHERE issue_id = (SELECT id FROM issues WHERE key = ?)", args: [String(issue.id)] });
    await assert.rejects(buildApi({ stateRoot: fixture.root, databaseFile: fixture.databaseFile, engine: new StartupEngine(), modelCatalog, logger: false }), /application_already_running/);
    const states = await connection.client.execute({
      sql: "SELECT issues.status AS issue_status, issue_workspaces.status AS workspace_status FROM issues JOIN issue_workspaces ON issues.id = issue_workspaces.issue_id WHERE issues.key = ?",
      args: [String(issue.id)],
    });
    assert.deepEqual(states.rows, [{ issue_status: "in_progress", workspace_status: "running" }]);
    assert.equal((await fixture.app.inject({ method: "GET", url: "/health" })).statusCode, 200);
  } finally {
    await connection.close();
    await fixture.cleanup();
  }
});

test("serves recorded Issue code after restart without fetching or rebuilding historical workspaces", async () => {
  const fixture = await createApiFixture();
  const database = openDatabase(fixture.databaseFile);
  let app: FastifyInstance | undefined;
  try {
    const remote = path.join(fixture.root, "remote");
    await git("git", ["init", "-b", "main", remote]);
    await writeFile(path.join(remote, "README.md"), "recorded version");
    await git("git", ["-C", remote, "add", "README.md"]);
    const commit = (message: string) => git("git", ["-C", remote, "-c", "user.name=Fixture", "-c", "user.email=test@example.test", "commit", "-am", message]);
    await commit("initial");
    await createService(fixture.app, "Restart", ["test"]);
    await registerTestRepositories(database.db, [remote]);
    await database.db.update(serviceRepositories).set({ url: remote });
    const saved = await createIssue(fixture.app, "restart", "test", "Recorded code");
    const unrelated = await createIssue(fixture.app, "restart", "test", "Unselected view");
    const [record] = await database.db
      .select()
      .from(issues)
      .where(eq(issues.key, String(saved.id)));
    const [other] = await database.db
      .select()
      .from(issues)
      .where(eq(issues.key, String(unrelated.id)));
    const projects = new IssueProjectManager(database.db, fixture.root);
    for (const issue of [record!, other!]) {
      const workspacePath = await projects.hydrateReadOnlyRuntime(issue);
      await database.db.insert(agentSessions).values({ issueId: issue.id, workspacePath, sessionFile: path.join(workspacePath, ".session-fixture.jsonl") });
    }
    await writeFile(path.join(remote, "README.md"), "advanced remote version");
    await commit("advance");
    const advanced = await new WorktreeManager(fixture.root).prepareShared({ url: remote, baseBranch: "main" });

    const workspace = issueRoot(fixture.root, record!.key);
    const unrelatedManifest = path.join(issueRoot(fixture.root, other!.key), ".issue-runtime.json");
    await writeFile(unrelatedManifest, "preserve invalid manifest");
    await database.db.update(issueWorkspaces).set({ status: "ready", runtimeReady: false }).where(eq(issueWorkspaces.issueId, other!.id));
    await writeFile(path.join(issueRoot(fixture.root, other!.key), ".session-fixture.jsonl"), "");
    const legacy = legacyIssueRoot(fixture.root, other!.key);
    const unmanaged = issueRoot(fixture.root, "ISSUE-20260807-999");
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, "old-work.txt"), "preserve legacy files");
    await mkdir(unmanaged);
    await writeFile(path.join(unmanaged, "unmanaged.txt"), "preserve unmanaged files");
    const [before] = await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, record!.id));
    await fixture.stop();
    await rename(remote, remote + "-offline");

    app = await buildApi({ stateRoot: fixture.root, databaseFile: fixture.databaseFile, engine: new StartupEngine(), modelCatalog, logger: false });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    assert.equal((await fetch(address + "/health")).status, 200);
    assert.equal(((await (await fetch(address + "/api/issues")).json()) as unknown[]).length, 2);
    const unprepared = await app.inject(`/api/issues/${other!.key}`);
    assert.equal(unprepared.statusCode, 200, unprepared.body);
    assert.equal(unprepared.json().workspace.sourceAvailable, false);
    assert.equal(unprepared.json().workspace.retryable, true);
    const legacyFiles = await app.inject(`/api/issues/${other!.key}/files`);
    assert.equal(legacyFiles.statusCode, 500);
    assert.deepEqual(legacyFiles.json(), { error: "issue_layout_migration_required" });
    assert.equal(await readFile(path.join(legacy, "old-work.txt"), "utf8"), "preserve legacy files");
    assert.equal(await readFile(path.join(unmanaged, "unmanaged.txt"), "utf8"), "preserve unmanaged files");
    const readCode = () =>
      app!.inject({
        method: "GET",
        url: `/api/issues/${record!.key}/source/file`,
        headers: { "x-issue-pilot-repository": "remote", "x-issue-pilot-path": "README.md" },
      });
    const snapshot = await readCode();
    assert.equal(snapshot.statusCode, 200, snapshot.body);
    assert.equal(snapshot.json().content, "recorded version");
    assert.equal(await readFile(unrelatedManifest, "utf8"), "preserve invalid manifest");
    const [after] = await database.db.select().from(issueWorkspaces).where(eq(issueWorkspaces.issueId, record!.id));
    assert.deepEqual(after, before);

    const entry = path.join(workspace, "remote");
    await unlink(entry);
    await symlink(advanced.workspacePath, entry);
    const mismatched = await readCode();
    assert.equal(mismatched.statusCode, 409, mismatched.body);
    assert.deepEqual(mismatched.json(), { error: "source_runtime_invalid" });
    await writeFile(path.join(workspace, "evidence.txt"), "ordinary file");
    const files = `/api/issues/${record!.key}/files`;
    assert.equal((await app.inject(files)).statusCode, 200);
    assert.equal((await app.inject(files + "/download?path=evidence.txt")).body, "ordinary file");
    const blockedDownload = await app.inject(files + "/download?path=remote/README.md");
    assert.equal(blockedDownload.statusCode, 409, blockedDownload.body);
    assert.deepEqual(blockedDownload.json(), { error: "source_runtime_invalid" });
  } finally {
    await app?.close();
    await database.close();
    await fixture.cleanup();
  }
});

test("closes Fastify exactly once when the process receives a shutdown signal", async () => {
  const target = new EventEmitter();
  let closes = 0;
  const app = {
    async close() {
      closes += 1;
    },
    log: { error() {} },
  } as unknown as FastifyInstance;
  const removeHandlers = installShutdownHandlers(app, target as never);
  target.emit("SIGTERM");
  target.emit("SIGINT");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closes, 1);
  removeHandlers();
  assert.equal(target.listenerCount("SIGTERM"), 0);
  assert.equal(target.listenerCount("SIGINT"), 0);
});

test("redacts nested database failures from shutdown diagnostics while retaining the SQLite code", async () => {
  const target = new EventEmitter();
  const cause = Object.assign(new Error("fixture_io_failure"), { code: "SQLITE_IOERR" });
  const query = new DrizzleQueryError("insert into private_configuration values (?)", ["fixture-private-key"], cause);
  const failure = new Error("shutdown_cleanup_failed", { cause: new AggregateError([query], "cleanup_failed") });
  const logged: unknown[] = [];
  const app = {
    async close() {
      throw failure;
    },
    log: {
      error(error: unknown) {
        logged.push(error);
      },
    },
  } as unknown as FastifyInstance;
  const removeHandlers = installShutdownHandlers(app, target);
  try {
    target.emit("SIGTERM");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(logged.length, 1);
    assert.doesNotMatch(inspect(logged), /fixture-private-key|insert into private_configuration/);
    assert.match(inspect(logged), /database_operation_failed:SQLITE_IOERR/);
  } finally {
    removeHandlers();
  }
});

test("isolates shutdown reporting failures", async () => {
  const target = new EventEmitter();
  const app = {
    async close() {
      throw new Error("close_failed");
    },
    log: {
      error() {
        throw new Error("logger_failed");
      },
    },
  } as unknown as FastifyInstance;
  const removeHandlers = installShutdownHandlers(app, target as never);
  target.emit("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  removeHandlers();
  assert.equal(target.listenerCount("SIGTERM"), 0);
  assert.equal(target.listenerCount("SIGINT"), 0);
});

test("closes the database when Agent shutdown fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-api-close-"));
  const databaseFile = path.join(root, "issues.db");
  const engine = new StartupEngine();
  engine.closeError = new Error("agent_close_failed");
  try {
    const app = await buildApi({ stateRoot: root, databaseFile, engine, logger: false });
    await assert.rejects(app.close(), /agent_close_failed/);
    const database = openDatabase(databaseFile);
    assert.deepEqual((await database.client.execute("pragma integrity_check")).rows, [{ integrity_check: "ok" }]);
    await database.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("closes initialized resources when API assembly fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-api-startup-"));
  const databaseFile = path.join(root, "issues.db");
  const engine = new StartupEngine();
  try {
    await assert.rejects(
      buildApi({
        stateRoot: root,
        databaseFile,
        engine,
        logger: false,
        workspacePolicy: { retentionMs: 0, highWaterBytes: 1, targetBytes: 1, maintenanceIntervalMs: 0, taskConcurrency: 1 },
      }),
      /workspace_target_must_be_below_high_water/,
    );
    assert.equal(engine.closed, 1);
    const database = openDatabase(databaseFile);
    assert.deepEqual((await database.client.execute("pragma integrity_check")).rows, [{ integrity_check: "ok" }]);
    await database.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves assembly and cleanup failures while closing every initialized owner once", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-startup-cleanup-"));
  const databaseFile = path.join(root, "issues.db");
  const engine = new StartupEngine();
  const engineFailure = new Error("fixture_engine_close_failed");
  const leaseFailure = new Error("fixture_lease_close_failed");
  engine.closeError = engineFailure;
  const lease = new ApplicationStateLease(root);
  let leaseCloses = 0;
  try {
    await assert.rejects(
      buildApi({
        stateRoot: root,
        databaseFile,
        engine,
        modelCatalog,
        logger: false,
        workspacePolicy: { retentionMs: 0, highWaterBytes: 1, targetBytes: 1, maintenanceIntervalMs: 0, taskConcurrency: 1 },
        stateLease: {
          start: () => lease.start(),
          async close() {
            leaseCloses++;
            assert.equal(engine.closed, 1);
            await lease.close();
            throw leaseFailure;
          },
        },
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        const failures = errorChain(error);
        assert.ok(failures.some((failure) => failure instanceof Error && failure.message === "workspace_target_must_be_below_high_water"));
        assert.ok(failures.includes(engineFailure));
        assert.ok(failures.includes(leaseFailure));
        return true;
      },
    );
    assert.equal(engine.closed, 1);
    assert.equal(leaseCloses, 1);
    const retry = await buildApi({ stateRoot: root, databaseFile, engine: new StartupEngine(), modelCatalog, logger: false });
    assert.equal((await retry.inject({ method: "GET", url: "/health" })).statusCode, 200);
    await retry.close();
  } finally {
    await lease.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("retains lease acquisition and release failures before the database opens", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-lease-cleanup-"));
  const acquisition = new Error("fixture_lease_start_failed");
  const release = new Error("fixture_lease_release_failed");
  let closes = 0;
  try {
    await assert.rejects(
      buildApi({
        stateRoot: root,
        databaseFile: path.join(root, "issues.db"),
        logger: false,
        stateLease: {
          async start() {
            throw acquisition;
          },
          async close() {
            closes++;
            throw release;
          },
        },
      }),
      (error) => {
        assert.equal(errorChain(error).filter((failure) => failure === acquisition || failure === release).length, 2);
        return true;
      },
    );
    assert.equal(closes, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retains listen and cleanup failures and removes signal handlers", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-listen-cleanup-"));
  const engine = new StartupEngine();
  const listenFailure = new Error("fixture_listen_failed");
  const cleanupFailure = new Error("fixture_listen_cleanup_failed");
  engine.closeError = cleanupFailure;
  const listen = Server.prototype.listen;
  const handlers = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  context.mock.method(Server.prototype, "listen", function (this: Server, ...args: Parameters<Server["listen"]>) {
    // The state lease uses a Unix socket; fail only the API TCP listener.
    if (typeof args[0] === "object" && args[0] && "port" in args[0]) throw listenFailure;
    return Reflect.apply(listen, this, args);
  });
  try {
    await assert.rejects(startApi({ stateRoot: root, databaseFile: path.join(root, "issues.db"), engine, modelCatalog, logger: false }), (error) => {
      const failures = errorChain(error);
      assert.ok(failures.includes(listenFailure));
      assert.ok(failures.includes(cleanupFailure));
      return true;
    });
    assert.equal(engine.closed, 1);
    assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], handlers);
  } finally {
    context.mock.restoreAll();
    await rm(root, { recursive: true, force: true });
  }
});
