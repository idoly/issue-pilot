import subprocess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { executeLocalCommand } from "../../src/process.ts";

test("a subprocess error does not release its owner before stdio closes", async context => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill() { return true; },
  });
  context.mock.method(subprocess, "spawn", () => child as unknown as ReturnType<typeof subprocess.spawn>);
  syncBuiltinESMExports();
  let settled = false;
  const reason = new Error("spawn_or_termination_failed");
  const execution = executeLocalCommand("fixture", []);
  const observed = execution.then(() => { settled = true; }, () => { settled = true; });
  try {
    child.emit("error", reason);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    child.emit("close", 1);
    await assert.rejects(execution, error => error === reason);
  } finally {
    child.emit("close", 1);
    await observed;
    context.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

for (const channel of ["stdout", "stderr", "stdin"] as const) test(`handles a ${channel} pipe error and waits for process cleanup`, async context => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    kill() { return true; },
  });
  context.mock.method(subprocess, "spawn", () => child as unknown as ReturnType<typeof subprocess.spawn>);
  syncBuiltinESMExports();
  const reason = new Error(`${channel}_io_failed`);
  const execution = executeLocalCommand("fixture", [], { input: Buffer.from("input") });
  let settled = false;
  const observed = execution.then(() => { settled = true; }, () => { settled = true; });
  try {
    assert.doesNotThrow(() => child[channel].emit("error", reason));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    child.emit("close", 1);
    await assert.rejects(execution, error => error === reason);
  } finally {
    child.emit("close", 1); await observed;
    context.mock.restoreAll(); syncBuiltinESMExports();
  }
});

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

test("strict stdout decoding preserves valid split UTF-8, BOMs and replacement characters", async () => {
  const expected = "\ufeff订单🙂 �\n", input = Buffer.from(expected);
  const script = "const bytes=require('node:fs').readFileSync(0);let i=0;const write=()=>{if(i===bytes.length)return;process.stdout.write(bytes.subarray(i,++i));setTimeout(write,1)};write()";
  const complete = await executeLocalCommand(process.execPath, ["-e", script], { input, strictStdoutUtf8: true });
  assert.equal(complete.stdout, expected);
  const chunks: string[] = [];
  const streamed = await executeLocalCommand(process.execPath, ["-e", script], { input, strictStdoutUtf8: true, onStdout: chunk => chunks.push(chunk) });
  assert.equal(chunks.join(""), expected);
  assert.equal(streamed.stdout, "");
});

for (const bytes of [[0x61, 0xff], [0xf0, 0x9f]]) test(`rejects malformed stdout UTF-8 ${bytes.join(",")}`, async () => {
  const command = ["-e", `process.stdout.write(Buffer.from(${JSON.stringify(bytes)}))`];
  await assert.rejects(executeLocalCommand(process.execPath, command, { strictStdoutUtf8: true }), /command_stdout_not_utf8/);
  assert.equal((await executeLocalCommand(process.execPath, command)).stdout, Buffer.from(bytes).toString("utf8"));
});

test("strict stdout decoding retains byte limits, cancellation and consumer failures", async () => {
  await assert.rejects(executeLocalCommand(process.execPath, ["-e", "process.stdout.write('订单')"], { strictStdoutUtf8: true, maxOutputBytes: 3 }), /command_output_too_large/);
  await assert.rejects(executeLocalCommand(process.execPath, ["-e", "process.stdout.write('valid');setInterval(()=>{},1000)"], { strictStdoutUtf8: true, onStdout: () => { throw new Error("consumer_failed"); } }), /consumer_failed/);
  const controller = new AbortController();
  const stopped = await executeLocalCommand(process.execPath, ["-e", "process.stdout.write('valid');setInterval(()=>{},1000)"], { strictStdoutUtf8: true, signal: controller.signal, onStdout: () => controller.abort() });
  assert.equal(stopped.killed, true);
  const interrupted = await executeLocalCommand(process.execPath, ["-e", "process.stdout.write(Buffer.from([0xf0]));setInterval(()=>{},1000)"], { strictStdoutUtf8: true, timeout: 100 });
  assert.equal(interrupted.killed, true);
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
  const descendant = "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)";
  const parent = [
    "const { spawn } = require('node:child_process')",
    "const { writeFileSync } = require('node:fs')",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'pipe', 'ignore'] })`,
    `child.stdout.once('data', () => { writeFileSync(${JSON.stringify(pidFile)}, String(child.pid)); process.stdout.write('ready'); })`,
    "setInterval(() => {}, 1000)",
  ].join(";");

  try {
    const controller = new AbortController();
    const result = await executeLocalCommand(process.execPath, ["-e", parent], {
      signal: controller.signal,
      timeout: 5000,
      onStdout: text => { if (text.includes("ready")) controller.abort(); },
    });
    assert.equal(result.killed, true);
    const descendantPid = Number(await readFile(pidFile, "utf8"));
    // Completion must include escalation, even when descendants don't retain stdio.
    await delay(25);
    assert.throws(() => process.kill(descendantPid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
