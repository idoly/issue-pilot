import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { migrateStateDatabase } from "../../src/db/migrate.ts";
import { ApplicationStateLease } from "../../src/workspace/state-lease.ts";

test("the migration command refuses to run while another process holds the application state lease", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-migrate-lease-"));
  const databaseFile = path.join(root, "issues.db");
  const running = new ApplicationStateLease(root);
  try {
    await running.start();
    await assert.rejects(migrateStateDatabase(root, databaseFile), /application_already_running/);
    await running.close();
    // Without a running server the command migrates and releases its own lease.
    await migrateStateDatabase(root, databaseFile);
    await running.start();
  } finally {
    await running.close();
    await rm(root, { recursive: true, force: true });
  }
});
