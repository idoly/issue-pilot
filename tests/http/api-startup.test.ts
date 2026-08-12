import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { FastifyInstance } from "fastify";

import { buildApi, installShutdownHandlers, type AgentController } from "../../src/http/api.ts";
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
      workspacePolicy: { retentionMs: 0, highWaterBytes: 1, targetBytes: 1, maintenanceIntervalMs: 0 },
    }), /workspace_target_must_be_below_high_water/);
    assert.equal(engine.closed, 1);
    const database = openDatabase(databaseFile);
    assert.deepEqual((await database.client.execute("pragma integrity_check")).rows, [{ integrity_check: "ok" }]);
    await database.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
