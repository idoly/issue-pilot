import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createOutputTool } from "../../src/agent/output-tool.ts";
import { IssueOutputStore } from "../../src/outputs/store.ts";

const invoke = (tool: ReturnType<typeof createOutputTool>, input: unknown, signal?: AbortSignal) => tool.execute("output-test", input as never, signal, undefined, {} as never);

const text = (result: Awaited<ReturnType<typeof invoke>>) => result.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");

test("publishes any file bytes atomically without a format-specific operation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-publish-"));
  const work = path.join(root, "work");
  await mkdir(work);
  const store = new IssueOutputStore(root, "ISSUE-20261017-001");
  const tool = createOutputTool(store, work);
  const bytes = Buffer.from([0, 255, 1, 2]);
  try {
    await writeFile(path.join(work, "data.custom"), bytes);
    const result = await invoke(tool, { operation: "publish", sourcePath: "data.custom", fileName: "delivered.custom" });
    assert.deepEqual(await store.read("delivered.custom"), bytes);
    assert.match(JSON.stringify(result.content), /delivered.custom/);
    assert.equal("content" in JSON.parse(text(result)).output, false);
    const listed = await invoke(tool, { operation: "list" });
    assert.equal(JSON.parse(text(listed)).directory, store.directory);
    await assert.rejects(invoke(tool, { operation: "execute", fileName: "invalid" }), /invalid_output_input/);
    await assert.rejects(invoke(tool, { operation: "publish", sourcePath: "data.custom", fileName: "../escape" }), /invalid_output_file_name/);
    assert.deepEqual(await readFile(path.join(work, "data.custom")), bytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects sources outside the working directory and preserves old output on cancellation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-publish-scope-"));
  const work = path.join(root, "work");
  await mkdir(work);
  const store = new IssueOutputStore(root, "ISSUE-20261017-001");
  const tool = createOutputTool(store, work);
  try {
    await writeFile(path.join(root, "outside.txt"), "other evidence");
    await symlink(path.join(root, "outside.txt"), path.join(work, "link.txt"));
    await writeFile(path.join(work, "new.txt"), "new");
    await store.write("result.txt", "old");
    for (const sourcePath of ["../outside.txt", "link.txt"]) await assert.rejects(invoke(tool, { operation: "publish", sourcePath, fileName: "result.txt" }), /output_source_outside_work_directory/);
    await assert.rejects(invoke(tool, { operation: "publish", sourcePath: "new.txt", fileName: "result.txt" }, AbortSignal.abort(new Error("cancelled"))), /cancelled/);
    assert.equal((await store.read("result.txt")).toString(), "old");
  } finally { await rm(root, { recursive: true, force: true }); }
});
