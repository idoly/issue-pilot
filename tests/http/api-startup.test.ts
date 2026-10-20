import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { inspect } from "node:util";
import { DrizzleQueryError } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { buildApi, installShutdownHandlers, type AgentController } from "../../src/http/api.ts";
import { createApiFixture, createIssue, createService, modelCatalog } from "./fixture.ts";
import { openDatabase } from "../../src/db/client.ts";

class StartupEngine implements AgentController {
  closed = 0;
  closeError: Error | undefined;
  enqueue(): void {}
  async send(): Promise<void> {}
  isRunning(): boolean { return false; }
  async runExclusive<T>(_issueIds: string[], operation: (reservation: { enqueue(): void; closeSession(): Promise<void> }) => Promise<T>): Promise<T> {
    return operation({ enqueue() {}, async closeSession() {} });
  }
  async close(): Promise<void> { this.closed += 1; if (this.closeError) throw this.closeError; }
}

test("rejects a second API before recovering the first API's active Issue state", async () => {
  const fixture = await createApiFixture(), connection = openDatabase(fixture.databaseFile);
  try {
    await createService(fixture.app, "Startup ownership");
    const issue = await createIssue(fixture.app, "startup-ownership");
    await connection.client.execute({ sql: "UPDATE issues SET status = 'in_progress' WHERE key = ?", args: [String(issue.id)] });
    await connection.client.execute({ sql: "UPDATE issue_workspaces SET status = 'running' WHERE issue_id = (SELECT id FROM issues WHERE key = ?)", args: [String(issue.id)] });
    await assert.rejects(buildApi({ stateRoot: fixture.root, databaseFile: fixture.databaseFile, engine: new StartupEngine(), modelCatalog, logger: false }), /project_tool_broker_already_running/);
    const states = await connection.client.execute({ sql: "SELECT issues.status AS issue_status, issue_workspaces.status AS workspace_status FROM issues JOIN issue_workspaces ON issues.id = issue_workspaces.issue_id WHERE issues.key = ?", args: [String(issue.id)] });
    assert.deepEqual(states.rows, [{ issue_status: "in_progress", workspace_status: "running" }]);
    assert.equal((await fixture.app.inject({ method: "GET", url: "/health" })).statusCode, 200);
  } finally { await connection.close(); await fixture.cleanup(); }
});

test("closes Fastify exactly once when the process receives a shutdown signal", async () => {
  const target = new EventEmitter();
  let closes = 0;
  const app = {
    async close() { closes += 1; },
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
  const app = { async close() { throw failure; }, log: { error(error: unknown) { logged.push(error); } } } as unknown as FastifyInstance;
  const removeHandlers = installShutdownHandlers(app, target);
  try {
    target.emit("SIGTERM");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(logged.length, 1);
    assert.doesNotMatch(inspect(logged), /fixture-private-key|insert into private_configuration/);
    assert.match(inspect(logged), /database_operation_failed:SQLITE_IOERR/);
  } finally { removeHandlers(); }
});

test("isolates shutdown reporting failures", async () => {
  const target = new EventEmitter();
  const app = {
    async close() { throw new Error("close_failed"); },
    log: { error() { throw new Error("logger_failed"); } },
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
    await assert.rejects(buildApi({
      stateRoot: root,
      databaseFile,
      engine,
      logger: false,
      workspacePolicy: { retentionMs: 0, highWaterBytes: 1, targetBytes: 1, maintenanceIntervalMs: 0, taskConcurrency: 1 },
    }), /workspace_target_must_be_below_high_water/);
    assert.equal(engine.closed, 1);
    const database = openDatabase(databaseFile);
    assert.deepEqual((await database.client.execute("pragma integrity_check")).rows, [{ integrity_check: "ok" }]);
    await database.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
