import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { executeLocalCommand } from "../../src/process.ts";

test("bounds output and applies scoped environment overrides for local capability processes", async () => {
  const normal = await executeLocalCommand(process.execPath, ["-e", "process.stdout.write('ok')"]);
  assert.equal(normal.stdout, "ok");
  const scoped = await executeLocalCommand("/bin/sh", ["-c", "printf '%s:%s' \"$HOME\" \"$TEST_MARKER\""], {
    environment: { HOME: "/tmp/issue-pilot-profile", TEST_MARKER: "scoped" },
  });
  assert.equal(scoped.stdout, "/tmp/issue-pilot-profile:scoped");
  await assert.rejects(
    executeLocalCommand(process.execPath, ["-e", `process.stdout.write('x'.repeat(${issuePilotConfig.limits.process.commandOutputBytes + 1}))`]),
    /command_output_too_large/,
  );
});

test("terminates descendant processes after the grace period", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-process-"));
  const pidFile = join(root, "descendant.pid");
  const descendant = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
  const parent = [
    "const { spawn } = require('node:child_process')",
    "const { writeFileSync } = require('node:fs')",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' })`,
    `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))`,
    "setInterval(() => {}, 1000)",
  ].join(";");

  try {
    const result = await executeLocalCommand(process.execPath, ["-e", parent], { timeout: 250 });
    assert.equal(result.killed, true);
    const descendantPid = Number(await readFile(pidFile, "utf8"));
    await delay(issuePilotConfig.limits.process.terminationGraceMs + 250);
    assert.throws(() => process.kill(descendantPid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
