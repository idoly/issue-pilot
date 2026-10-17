import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SandboxToolSession } from "../../src/agent/sandbox-tool.ts";
import { IssueOutputStore } from "../../src/outputs/store.ts";
import type { AnalysisSandbox } from "../../src/sandbox/runtime.ts";

class FakeSandbox implements AnalysisSandbox {
  closed = false;
  readonly files = new Map<string, Buffer>();
  exportHook: (() => void) | undefined;
  async execute(_command: string) { return { stdout: "computed", stderr: "", code: 0, killed: false }; }
  async importFile(name: string, content: Uint8Array) { this.files.set(name, Buffer.from(content)); }
  async exportFile(name: string) { this.exportHook?.(); const value = this.files.get(name); if (!value) throw new Error("sandbox_export_failed"); return value; }
  async close() { this.closed = true; }
}
const invoke = (session: SandboxToolSession, input: unknown, signal?: AbortSignal) => session.tool.execute("sandbox-fixture", input as never, signal, undefined, {} as never);

test("read-only Issues get scratch execution but cannot import or publish durable files", async () => {
  let starts = 0;
  const session = new SandboxToolSession(undefined, async () => { starts++; return new FakeSandbox(); });
  try {
    assert.ok(!JSON.stringify(session.tool.parameters).includes("import_output"));
    await assert.rejects(invoke(session, { operation: "export_output", fileName: "result.json" }), /invalid_sandbox_input/);
    assert.equal(starts, 0);
    const result = await invoke(session, { operation: "run", command: "node analysis.js" });
    assert.match(JSON.stringify(result.content), /computed/);
    assert.equal(starts, 1);
  } finally { await session.close(); }
});

test("output transfers use only this Issue store, omit data from tool results, and preserve old files on abort", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-sandbox-tool-"));
  const outputs = new IssueOutputStore(root, "ISSUE-20261017-001");
  const other = new IssueOutputStore(root, "ISSUE-20261017-002");
  const sandbox = new FakeSandbox();
  const session = new SandboxToolSession(outputs, async () => sandbox);
  try {
    await outputs.write("batch.json", '[{"secretBusinessRow":42}]');
    await other.write("batch.json", "other issue evidence");
    const imported = await invoke(session, { operation: "import_output", fileName: "batch.json" });
    assert.equal(sandbox.files.get("batch.json")?.toString(), '[{"secretBusinessRow":42}]');
    assert.ok(!JSON.stringify(imported.content).includes("secretBusinessRow"));
    await assert.rejects(invoke(session, { operation: "import_output", fileName: "../ISSUE-20261017-002/batch.json" }), /invalid_output_file_name/);
    const bytes = Buffer.from([0, 255, 1, 2]);
    sandbox.files.set("result.bin", bytes);
    const exported = await invoke(session, { operation: "export_output", fileName: "result.bin" });
    assert.deepEqual(await outputs.read("result.bin"), bytes);
    assert.match(JSON.stringify(exported.content), /result.bin/);
    assert.equal((await other.list()).length, 1);
    await outputs.write("result.json", "old result");
    sandbox.files.set("result.json", Buffer.from("replacement"));
    const controller = new AbortController();
    sandbox.exportHook = () => controller.abort();
    await assert.rejects(invoke(session, { operation: "export_output", fileName: "result.json" }, controller.signal), /sandbox_aborted/);
    assert.equal((await outputs.read("result.json")).toString(), "old result");
    await assert.rejects(outputs.read("batch.json", 3), /output_read_too_large/);
    assert.equal((await outputs.read("batch.json", 100)).toString(), '[{"secretBusinessRow":42}]');
  } finally { await session.close(); await rm(root, { recursive: true, force: true }); }
});

test("run completion clears scratch, subsequent rounds recreate it, and close rejects later calls", async () => {
  const created: FakeSandbox[] = [];
  const session = new SandboxToolSession(undefined, async () => { const sandbox = new FakeSandbox(); created.push(sandbox); return sandbox; });
  await invoke(session, { operation: "run", command: "first" });
  await session.finishRun();
  assert.ok(created[0]!.closed);
  await invoke(session, { operation: "run", command: "second" });
  assert.equal(created.length, 2);
  await session.close(); await session.close();
  assert.ok(created[1]!.closed);
  await assert.rejects(invoke(session, { operation: "run", command: "late" }), /sandbox_aborted/);
});

test("run cleanup retries a failed removal without losing ownership", async () => {
  const sandbox = new FakeSandbox();
  let attempts = 0;
  sandbox.close = async () => { if (++attempts === 1) throw new Error("sandbox_cleanup_failed"); sandbox.closed = true; };
  const session = new SandboxToolSession(undefined, async () => sandbox);
  await invoke(session, { operation: "run", command: "first" });
  await session.finishRun();
  assert.equal(attempts, 2);
  assert.ok(sandbox.closed);
  await session.close();
});

test("shutdown waits for a pending start and removes its container before returning", async () => {
  const sandbox = new FakeSandbox();
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const session = new SandboxToolSession(undefined, async () => { entered(); await gate; return sandbox; });
  const run = invoke(session, { operation: "run", command: "pending" });
  const rejected = assert.rejects(run, /sandbox_aborted/);
  await ready;
  const closing = session.close();
  release();
  await rejected; await closing;
  assert.ok(sandbox.closed);
});
