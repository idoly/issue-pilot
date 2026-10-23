import crypto from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import fs, { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generatedWorkFileSaver, IssueWorkFileStore } from "../../src/workspace/work-file-store.ts";

test("SDK output collisions preserve a temporary file owned by another operation", async context => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-sdk-output-collision-"));
  const id = "11111111-1111-4111-8111-111111111111";
  const temporary = path.join(root, `.work-file-${id}.tmp`);
  try {
    await writeFile(temporary, "existing evidence", { mode: 0o600 });
    context.mock.method(crypto, "randomUUID", () => id);
    syncBuiltinESMExports();
    await assert.rejects(generatedWorkFileSaver(root, "mcp")("new output", ".txt"), { code: "EEXIST" });
    assert.equal(await readFile(temporary, "utf8"), "existing evidence");
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("separate store instances share destination serialization and queued cancellation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-work-store-instances-"));
  const first = new IssueWorkFileStore(root, "ISSUE-20261022-001");
  const second = new IssueWorkFileStore(root, "issue-20261022-001");
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const controller = new AbortController();
  const reason = new Error("queued_store_cancelled");
  let secondStarted = false;
  let secondSettled = false;
  let writing: Promise<unknown> | undefined;
  let queued: Promise<unknown> | undefined;
  try {
    writing = first.generate("result.txt", async append => {
      entered();
      await gate;
      await append("first");
    });
    await started;
    queued = second.generate("result.txt", async () => { secondStarted = true; }, controller.signal);
    const observed = queued.then(() => { secondSettled = true; }, () => { secondSettled = true; });
    controller.abort(reason);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(secondSettled, false);
    release();
    await writing;
    await assert.rejects(queued, error => error === reason);
    await observed;
    assert.equal(secondStarted, false);
    assert.equal((await first.read("result.txt")).toString(), "first");
  } finally {
    release();
    await Promise.allSettled([writing, queued]);
    await rm(root, { recursive: true, force: true });
  }
});

test("query results are ordinary working files with direct download links", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-work-store-")), store = new IssueWorkFileStore(root, "ISSUE-20261022-001");
  try {
    const file = await store.write("report.json", '{"rows":1}');
    assert.equal(file.size, 10); assert.equal(path.relative(root, store.directory), "workspaces/issue-20261022-001");
    assert.equal(store.downloadPath("report.json"), "/api/issues/ISSUE-20261022-001/files/download?path=report.json");
    assert.equal((await store.read("report.json")).toString(), '{"rows":1}');
    assert.equal((await stat(path.join(store.directory, "report.json"))).mode & 0o777, 0o600);
    await store.write("report.json", "updated"); assert.equal((await store.read("report.json")).toString(), "updated");
    assert.deepEqual(await readdir(store.directory), ["report.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("failed or cancelled generation retains the old file and removes temporary files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-work-store-failure-")), store = new IssueWorkFileStore(root, "ISSUE-20261022-001");
  try {
    await store.write("report.json", "old");
    await assert.rejects(store.generate("report.json", async append => { await append("new partial"); throw new Error("producer failed"); }), /producer failed/);
    const controller = new AbortController(), reason = new Error("cancelled");
    await assert.rejects(store.generate("report.json", async append => { await append("new"); controller.abort(reason); }, controller.signal), error => error === reason);
    assert.equal((await store.read("report.json")).toString(), "old"); assert.deepEqual(await readdir(store.directory), ["report.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("file-name and replacement validation precedes a producer and never follows destination links", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-work-store-policy-")), store = new IssueWorkFileStore(root, "ISSUE-20261022-001");
  try {
    let calls = 0;
    for (const name of ["../escape", "/absolute", ".git", ".session-private.jsonl", "a".repeat(256)]) await assert.rejects(store.generate(name, async () => { calls++; }), /invalid_work_file_name/);
    assert.equal(calls, 0);
    await mkdir(store.directory, { recursive: true }); await writeFile(path.join(root, "outside.txt"), "untouched");
    await symlink(path.join(root, "outside.txt"), path.join(store.directory, "report.json"));
    await assert.rejects(store.generate("report.json", async () => { calls++; }), /invalid_work_file/);
    assert.equal(calls, 0); assert.equal(await readFile(path.join(root, "outside.txt"), "utf8"), "untouched");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("a cleanup failure preserves the generation error and releases the queue for retry", async context => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-work-store-cleanup-")), store = new IssueWorkFileStore(root, "ISSUE-20261022-001");
  try {
    await store.write("report.json", "old");
    const original = new Error("generation failed"), cleanup = new Error("close failed"), openFile = fs.open;
    context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await openFile(...args), close = handle.close.bind(handle);
      context.mock.method(handle, "close", async () => { await close(); throw cleanup; });
      return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(store.generate("report.json", async () => { throw original; }), error => error instanceof AggregateError && error.errors[0] === original && error.errors[1] === cleanup);
    context.mock.restoreAll(); syncBuiltinESMExports();
    assert.equal((await store.read("report.json")).toString(), "old");
    assert.deepEqual(await readdir(store.directory), ["report.json"]);
    await store.write("report.json", "retried");
    assert.equal((await store.read("report.json")).toString(), "retried");
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); }
});
test("same-name generation serializes and queued cancellation never starts its producer", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-work-store-queue-")), store = new IssueWorkFileStore(root, "ISSUE-20261022-001");
  let release!: () => void;
  try {
    let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const first = store.generate("result.json", async append => { entered(); await gate; await append("first"); }); await waiting;
    const controller = new AbortController(), reason = new Error("queued cancellation"); let calls = 0;
    const second = store.generate("result.json", async () => { calls++; }, controller.signal);
    controller.abort(reason); release(); await first; await assert.rejects(second, error => error === reason);
    assert.equal(calls, 0); assert.equal((await store.read("result.json")).toString(), "first");
  } finally { release?.(); await rm(root, { recursive: true, force: true }); }
});
