import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { executeLocalCommand } from "../../src/process.ts";

test("rejects an already cancelled command before attempting to spawn", async () => {
  const reason = new Error("cancelled_before_spawn");
  const command = `${process.execPath}.must-not-run`;
  await assert.rejects(executeLocalCommand(command, [], { signal: AbortSignal.abort(reason) }), error => error === reason);
  await assert.rejects(executeLocalCommand(command, []), { code: "ENOENT" });
});

test("bounds output and applies scoped environment overrides for local capability processes", async () => {
  const normal = await executeLocalCommand(process.execPath, ["-e", "process.stdout.write('ok')"]);
  assert.equal(normal.stdout, "ok");
  const scoped = await executeLocalCommand("/bin/sh", ["-c", "printf '%s:%s' \"$HOME\" \"$TEST_MARKER\""], {
    environment: { HOME: "/tmp/issue-pilot-profile", TEST_MARKER: "scoped" },
  });
  assert.equal(scoped.stdout, "/tmp/issue-pilot-profile:scoped");
  const oversizedCommand = ["-e", `process.stdout.write('x'.repeat(${issuePilotConfig.limits.process.commandOutputBytes + 1}))`];
  await assert.rejects(executeLocalCommand(process.execPath, oversizedCommand), /command_output_too_large/);
  const unbounded = await executeLocalCommand(process.execPath, oversizedCommand, { maxOutputBytes: null });
  assert.equal(Buffer.byteLength(unbounded.stdout), issuePilotConfig.limits.process.commandOutputBytes + 1);
  assert.equal(unbounded.killed, false);
});

test("streams stdout without retaining it and stops a cancelled producer", async () => {
  const chunks: string[] = [];
  const complete = await executeLocalCommand(process.execPath, ["-e", "process.stdout.write('订单 AI\\n')"], { onStdout: chunk => chunks.push(chunk) });
  assert.equal(chunks.join(""), "订单 AI\n");
  assert.equal(complete.stdout, "");
  const cancellation = new AbortController();
  const stopped = await executeLocalCommand(process.execPath, ["-e", "setInterval(()=>process.stdout.write('AI\\n'),1)"], { signal: cancellation.signal, onStdout: () => cancellation.abort() });
  assert.equal(stopped.killed, true); assert.equal(stopped.stdout, "");
  await assert.rejects(executeLocalCommand(process.execPath, ["-e", "process.stdout.write('AI');setInterval(()=>{},1000)"], { onStdout: () => { throw new Error("consumer_failed"); } }), /consumer_failed/);
});

test("passes binary stdin without argv exposure and tolerates an early reader exit", async () => {
  const input = Buffer.from(Array.from({ length: 1024 }, (_, index) => index % 256));
  const result = await executeLocalCommand(process.execPath, ["-e", "const fs=require('fs'),crypto=require('crypto');process.stdout.write(JSON.stringify({hash:crypto.createHash('sha256').update(fs.readFileSync(0)).digest('hex'),args:process.argv.slice(1)}))"], { input });
  assert.deepEqual(JSON.parse(result.stdout), { hash: createHash("sha256").update(input).digest("hex"), args: [] });
  const early = await executeLocalCommand(process.execPath, ["-e", "process.exit(0)"], { input: Buffer.alloc(1024 * 1024) });
  assert.equal(early.code, 0);
  assert.equal(early.killed, false);
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
