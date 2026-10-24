import crypto from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import fs, { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { claimIssueRoot, issueRoot } from "../../src/workspace/state.ts";
import path from "node:path";
import { generatedWorkFileSaver, IssueWorkFileStore, listIssueWorkFiles, openIssueWorkFile, prepareIssueWorkDirectory } from "../../src/workspace/work-files.ts";

const key = "ISSUE-20261021-001";

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
    assert.equal((await readFile(path.join(first.directory, "result.txt"))).toString(), "first");
  } finally {
    release();
    await Promise.allSettled([writing, queued]);
    await rm(root, { recursive: true, force: true });
  }
});

test("query results are ordinary working files with direct download links", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-work-store-")), store = new IssueWorkFileStore(root, "ISSUE-20261022-001");
  try {
    const file = await store.generate("report.json", async append => { await append('{"rows":1}'); });
    assert.equal(file.size, 10); assert.equal(path.relative(root, store.directory), "workspaces/issue-20261022-001");
    assert.equal(store.downloadPath("report.json"), "/api/issues/ISSUE-20261022-001/files/download?path=report.json");
    assert.equal((await readFile(path.join(store.directory, "report.json"))).toString(), '{"rows":1}');
    assert.equal((await stat(path.join(store.directory, "report.json"))).mode & 0o777, 0o600);
    await store.generate("report.json", async append => { await append("updated"); }); assert.equal((await readFile(path.join(store.directory, "report.json"))).toString(), "updated");
    assert.deepEqual(await readdir(store.directory), ["report.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("failed or cancelled generation retains the old file and removes temporary files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-work-store-failure-")), store = new IssueWorkFileStore(root, "ISSUE-20261022-001");
  try {
    await store.generate("report.json", async append => { await append("old"); });
    await assert.rejects(store.generate("report.json", async append => { await append("new partial"); throw new Error("producer failed"); }), /producer failed/);
    const controller = new AbortController(), reason = new Error("cancelled");
    await assert.rejects(store.generate("report.json", async append => { await append("new"); controller.abort(reason); }, controller.signal), error => error === reason);
    assert.equal((await readFile(path.join(store.directory, "report.json"))).toString(), "old"); assert.deepEqual(await readdir(store.directory), ["report.json"]);
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
    await store.generate("report.json", async append => { await append("old"); });
    const original = new Error("generation failed"), cleanup = new Error("close failed"), openFile = fs.open;
    context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await openFile(...args), close = handle.close.bind(handle);
      context.mock.method(handle, "close", async () => { await close(); throw cleanup; });
      return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(store.generate("report.json", async () => { throw original; }), error => error instanceof AggregateError && error.errors[0] === original && error.errors[1] === cleanup);
    context.mock.restoreAll(); syncBuiltinESMExports();
    assert.equal((await readFile(path.join(store.directory, "report.json"))).toString(), "old");
    assert.deepEqual(await readdir(store.directory), ["report.json"]);
    await store.generate("report.json", async append => { await append("retried"); });
    assert.equal((await readFile(path.join(store.directory, "report.json"))).toString(), "retried");
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
    assert.equal(calls, 0); assert.equal((await readFile(path.join(store.directory, "result.json"))).toString(), "first");
  } finally { release?.(); await rm(root, { recursive: true, force: true }); }
});

test("Issue creation claims an empty working directory and preserves an unknown existing directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-work-claim-"));
  try {
    const target = issueRoot(root, key);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "evidence.txt"), "preserve");
    await assert.rejects(claimIssueRoot(root, key), /unmanaged_issue_state:workspaces/);
    assert.equal(await readFile(path.join(target, "evidence.txt"), "utf8"), "preserve");
    await assert.rejects(readFile(path.join(issueRoot(root, key), "anything")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("lists and downloads working files without following paths outside the Issue or Git controls", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-working-files-"));
  try {
    const work = await prepareIssueWorkDirectory(root, key);
    assert.equal(work, issueRoot(root, key));
    await mkdir(path.join(work, "nested"));
    await writeFile(path.join(work, "nested", "库存 #1.xlsx"), "workbook");
    await writeFile(path.join(work, "nested", ".session-business.txt"), "ordinary nested content");
    await writeFile(path.join(work, ".session-private.jsonl"), "private session");
    await symlink(path.join(work, ".session-private.jsonl"), path.join(work, "session-alias"));
    const nested = await openIssueWorkFile(root, key, "nested/.session-business.txt");
    try { assert.equal((await nested.handle.readFile()).toString(), "ordinary nested content"); } finally { await nested.handle.close(); }
    for (const selected of [".session-private.jsonl", "session-alias"]) await assert.rejects(openIssueWorkFile(root, key, selected), /managed_issue_file_private/);
    await mkdir(path.join(work, ".git"));
    await writeFile(path.join(work, ".git", "config"), "private git data");
    await writeFile(path.join(root, "secret"), "private");
    await symlink(path.join(root, "secret"), path.join(work, "escape"));
    await symlink(path.join(work, ".git"), path.join(work, "git-alias"));
    const listing = await listIssueWorkFiles(root, key);
    assert.equal(listing.some(row => row.name === ".git"), false);
    assert.equal(listing.find(row => row.name === "escape")?.kind, "link");
    const file = await openIssueWorkFile(root, key, "nested/库存 #1.xlsx");
    try { assert.equal((await file.handle.readFile()).toString(), "workbook"); }
    finally { await file.handle.close(); }
    for (const selected of ["../secret", "/etc/passwd", "escape", ".git/config", "git-alias/config"]) {
      await assert.rejects(openIssueWorkFile(root, key, selected), /invalid_issue_file_path/);
    }
    await assert.rejects(openIssueWorkFile(root, key, "nested"), /issue_file_not_regular/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
