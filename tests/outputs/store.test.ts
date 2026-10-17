import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { IssueOutputStore, listIssueOutputs, resolveIssueOutput } from "../../src/outputs/store.ts";
import { issueOutputRoot } from "../../src/workspace/state.ts";

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
    await store.append("old.csv", "updated");
    assert.equal((await store.list())[0]!.fileName, "old.csv");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("writes durable Issue outputs atomically and confines file names", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "issue-pilot-outputs-"));
  const issueKey = "ISSUE-20260929-001";
  const store = new IssueOutputStore(root, issueKey);
  try {
    const created = await store.write("result.sql", "SELECT 1;\n");
    assert.equal(created.fileName, "result.sql");
    assert.equal(created.size, 10);
    const appended = await store.append("result.sql", "SELECT 2;\n");
    assert.equal(appended.size, 20);
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
