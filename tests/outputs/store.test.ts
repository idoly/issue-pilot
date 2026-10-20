import assert from "node:assert/strict";
import { mkdtemp, open, readFile, readdir, rm, stat, utimes, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { IssueOutputStore, listIssueOutputs, resolveIssueOutput } from "../../src/outputs/store.ts";
import { issueOutputRoot } from "../../src/workspace/state.ts";

test("enforces output filename limits in UTF-8 bytes before running a producer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-output-name-bytes-"));
  const store = new IssueOutputStore(root, "ISSUE-20261019-001");
  let generated = false;
  try {
    const valid = "界".repeat(83) + ".json", invalid = "界".repeat(84) + ".json";
    await store.write(valid, "complete");
    assert.equal((await store.read(valid)).toString(), "complete");
    await assert.rejects(store.generate(invalid, async append => { generated = true; await append("must not run"); }), { message: "invalid_output_file_name" });
    assert.equal(generated, false);
    assert.deepEqual((await store.list()).map(output => output.fileName), [valid]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("lists recent outputs first with stable filename order for equal timestamps", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-output-order-"));
  const issueKey = "ISSUE-20260929-002";
  const store = new IssueOutputStore(root, issueKey);
  try {
    for (const name of ["old.csv", "z-new.xlsx", "a-new.md"]) await store.write(name, "data");
    for (const [name, date] of [["old.csv", "2026-01-01"], ["z-new.xlsx", "2026-02-01"], ["a-new.md", "2026-02-01"]] as const) {
      const file = await resolveIssueOutput(root, issueKey, name);
      await utimes(file, new Date(date), new Date(date));
    }
    assert.deepEqual((await store.list()).map(({ fileName }) => fileName), ["a-new.md", "z-new.xlsx", "old.csv"]);
    await store.write("old.csv", "updated");
    assert.equal((await store.list())[0]!.fileName, "old.csv");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publishes complete output when individual filesystem writes are short", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-output-short-write-"));
  const probe = await open(path.join(root, "probe"), "wx");
  const prototype: FileHandle = Object.getPrototypeOf(probe);
  const write = prototype.write;
  await probe.close();
  context.mock.method(prototype, "write", function (this: FileHandle, content: string | Uint8Array) {
    const bytes = typeof content === "string" ? Buffer.from(content) : content;
    return Reflect.apply(write, this, [bytes.subarray(0, 3)]);
  });
  try {
    const store = new IssueOutputStore(root, "ISSUE-20260929-003");
    await store.generate("result.txt", async append => {
      await append("完整字符串");
      await append(Buffer.from("及二进制"));
    });
    assert.equal((await store.read("result.txt")).toString(), "完整字符串及二进制");
    await store.write("result.txt", "完整字符串及二进制后续");
    assert.equal((await store.read("result.txt")).toString(), "完整字符串及二进制后续");
  } finally { context.mock.restoreAll(); await rm(root, { recursive: true, force: true }); }
});

test("lists only published files while a producer is still writing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-output-publication-"));
  const store = new IssueOutputStore(root, "ISSUE-20261017-004");
  let entered!: () => void, release!: () => void;
  const writing = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const generation = store.generate("result.bin", async append => { await append("first"); entered(); await gate; await append("second"); });
  try {
    await writing;
    assert.deepEqual(await store.list(), []);
    release(); await generation;
    assert.equal((await store.read("result.bin")).toString(), "firstsecond");
    assert.deepEqual((await store.list()).map(file => file.fileName), ["result.bin"]);
  } finally { release(); await generation.catch(() => {}); await rm(root, { recursive: true, force: true }); }
});

test("writes durable Issue outputs atomically and confines file names", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-outputs-"));
  const issueKey = "ISSUE-20260929-001";
  const store = new IssueOutputStore(root, issueKey);
  try {
    const created = await store.write("result.sql", "SELECT 1;\n");
    assert.equal(created.fileName, "result.sql");
    assert.equal(created.size, 10);
    const replaced = await store.write("result.sql", "SELECT 1;\nSELECT 2;\n");
    assert.equal(replaced.size, 20);
    const outputPath = await resolveIssueOutput(root, issueKey, "result.sql");
    assert.equal(await readFile(outputPath, "utf8"), "SELECT 1;\nSELECT 2;\n");
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    assert.deepEqual((await listIssueOutputs(root, issueKey)).map(({ fileName, size }) => ({ fileName, size })), [{ fileName: "result.sql", size: 20 }]);

    await assert.rejects(store.write("../outside.sql", "bad"), /invalid_output_file_name/);
    await assert.rejects(store.write("nested/result.sql", "bad"), /invalid_output_file_name/);
    await assert.rejects(store.generate("result.sql", async () => { throw new Error("generation_failed"); }), /generation_failed/);
    assert.equal(await readFile(outputPath, "utf8"), "SELECT 1;\nSELECT 2;\n");
    assert.deepEqual((await readdir(issueOutputRoot(root, issueKey))).filter((name) => name.startsWith(".")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
