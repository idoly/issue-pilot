import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ApplicationStateLease } from "../../src/workspace/state-lease.ts";

test("one application owns the state before startup, and concurrent close/start preserves ownership", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-state-lease-")), lease = new ApplicationStateLease(root), competitor = new ApplicationStateLease(root);
  try {
    await Promise.all([lease.start(), lease.start()]);
    assert.equal((await stat(lease.socketPath)).mode & 0o777, 0o600);
    await assert.rejects(competitor.start(), /application_already_running/);
    const closing = lease.close(), repeated = lease.close(); assert.equal(closing, repeated);
    const restart = lease.start(); await closing; await restart;
    await assert.rejects(competitor.start(), /application_already_running/);
    await lease.close(); await assert.rejects(stat(lease.socketPath), { code: "ENOENT" });
    await competitor.start(); await competitor.close();
  } finally { await Promise.all([lease.close(), competitor.close()]); await rm(root, { recursive: true, force: true }); }
});
test("shutdown during startup drains acquisition, and unknown control files survive failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-state-lease-close-")), lease = new ApplicationStateLease(root);
  try {
    const start = lease.start(), close = lease.close(); await Promise.all([start, close]);
    await assert.rejects(stat(lease.socketPath), { code: "ENOENT" });
    await mkdir(path.dirname(lease.socketPath), { recursive: true }); await writeFile(lease.socketPath, "operator evidence");
    await assert.rejects(lease.start(), /application_control_socket_invalid/); await lease.close();
    assert.equal(await readFile(lease.socketPath, "utf8"), "operator evidence");
  } finally { await lease.close(); await rm(root, { recursive: true, force: true }); }
});
test("parallel application starts never remove the successful owner's socket", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-state-lease-race-"));
  const first = new ApplicationStateLease(root), second = new ApplicationStateLease(root);
  try {
    const results = await Promise.allSettled([first.start(), second.start()]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const owner = results[0]!.status === "fulfilled" ? first : second, failed = owner === first ? second : first;
    await failed.close(); assert.equal((await stat(owner.socketPath)).isSocket(), true);
    await assert.rejects(failed.start());
  } finally { await Promise.all([first.close(), second.close()]); await rm(root, { recursive: true, force: true }); }
});
