import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { connectMcp, createMcpConnectionPool, createMcpToolBindings, inspectMcp, type McpConfiguration, type McpToolBinding } from "../../src/mcp/client.ts";

const server = fileURLToPath(new URL("../helpers/mcp-stdio-server.mjs", import.meta.url));
const configuration = (root: string, env: Record<string, string> = {}): McpConfiguration => ({ id: "stdio-fixture", name: "Fixture", url: "", transport: "stdio", authorization: "", enabled: true, stdio: { command: process.execPath, args: [server], env: { MCP_FIXTURE_PID_FILE: path.join(root, "pid"), MCP_FIXTURE_SECRET: "mcp_private_token", MCP_FIXTURE_SLOW_FILE: path.join(root, "slow"), ...env } } });
const counter = (tools: McpToolBinding[]) => tools.find(tool => tool.label.endsWith(" / counter"))!;
async function call(tool: McpToolBinding) {
  const result = await tool.call({});
  const remote = JSON.parse((result.content[0] as { text: string }).text);
  return JSON.parse(remote.content[0].text) as { pid: number; count: number; cwd: string; inherited: boolean };
}
async function waitForFile(root: string, name: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return await readFile(path.join(root, name), "utf8"); } catch { await pause(20); }
  }
  throw new Error("fixture_file_not_written");
}
const pid = async (root: string) => Number(await waitForFile(root, "pid"));
const stopped = (value: number) => assert.throws(() => process.kill(value, 0), { code: "ESRCH" });

test("reuses one stdio process across scopes and calls, filters tools and closes it once", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-mcp-stdio-"));
  const original = process.env.MCP_PARENT_SECRET; process.env.MCP_PARENT_SECRET = "parent-private";
  const pool = createMcpConnectionPool({ cwd: root });
  try {
    const config = configuration(root);
    const [read, write] = await Promise.all([createMcpToolBindings([config], false, pool.connect), createMcpToolBindings([config], true, pool.connect)]);
    assert.equal(read.length, 5); assert.equal(write.length, 6);
    assert.equal(JSON.stringify(read).includes("mcp_private_token"), false);
    const first = await call(counter(read)), second = await call(counter(write));
    assert.equal(first.pid, second.pid); assert.equal(second.count, first.count + 1);
    assert.equal(first.cwd, root); assert.equal(first.inherited, false);
    await Promise.all([pool.close(), pool.close()]); stopped(first.pid);
    await assert.rejects(counter(read).call({}), /mcp_session_closed/);
  } finally {
    await pool.close(); await rm(root, { recursive: true, force: true });
    if (original === undefined) delete process.env.MCP_PARENT_SECRET; else process.env.MCP_PARENT_SECRET = original;
  }
});

test("keeps a pooled connection alive after the discovery request deadline", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-mcp-deadline-"));
  const pool = createMcpConnectionPool({ cwd: root });
  try {
    const config = configuration(root), discovery = await pool.connect(config, AbortSignal.timeout(1_000));
    await discovery.list();
    await pause(1_100);
    const tools = await createMcpToolBindings([config], false, pool.connect);
    const result = await call(counter(tools)); assert.equal(result.pid, await pid(root));
    await pool.close(); stopped(result.pid);
  } finally { await pool.close(); await rm(root, { recursive: true, force: true }); }
});

test("hides stdio errors and cancels a call without losing the process", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-mcp-errors-"));
  const pool = createMcpConnectionPool({ cwd: root });
  try {
    const tools = await createMcpToolBindings([configuration(root)], false, pool.connect);
    await assert.rejects(tools.find(tool => tool.label.endsWith(" / fail"))!.call({}), { message: "mcp_operation_failed" });
    await assert.rejects(tools.find(tool => tool.label.endsWith(" / tool_error"))!.call({}), { message: "mcp_tool_failed" });
    const controller = new AbortController();
    const pending = tools.find(tool => tool.label.endsWith(" / slow"))!.call({}, controller.signal);
    const rejection = assert.rejects(pending, { message: "mcp_aborted" }); await waitForFile(root, "slow"); controller.abort(); await rejection;
    const result = await call(counter(tools)); assert.equal(result.pid, await pid(root));
    await assert.rejects(tools.find(tool => tool.label.endsWith(" / die"))!.call({}), { message: "mcp_operation_failed" });
    const restarted = await call(counter(tools)); assert.notEqual(restarted.pid, result.pid); stopped(result.pid);
    await pool.close(); stopped(restarted.pid);
  } finally { await pool.close(); await rm(root, { recursive: true, force: true }); }
});

test("cancels a waiter while another request initializes the shared process", { timeout: 5_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-mcp-waiter-"));
  const pool = createMcpConnectionPool({ cwd: root });
  try {
    const config = configuration(root, { MCP_FIXTURE_HANG: "1" });
    const initial = pool.connect(config, AbortSignal.timeout(10_000));
    const rejectedInitial = assert.rejects(initial, /mcp_session_closed/);
    const child = await pid(root), cancellation = new AbortController();
    const waiter = pool.connect(config, cancellation.signal);
    const rejectedWaiter = assert.rejects(waiter, { name: "AbortError" });
    cancellation.abort(); await rejectedWaiter;
    await pool.close(); await rejectedInitial; stopped(child);
  } finally { await pool.close(); await rm(root, { recursive: true, force: true }); }
});

test("closes pooled stdio processes while initialization is still pending", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-mcp-pending-"));
  const pool = createMcpConnectionPool({ cwd: root });
  try {
    const pending = createMcpToolBindings([configuration(root, { MCP_FIXTURE_HANG: "1" })], false, pool.connect);
    const rejected = assert.rejects(pending, { message: "mcp_session_closed" });
    const child = await pid(root); await pool.close(); await rejected; stopped(child);
  } finally { await pool.close(); await rm(root, { recursive: true, force: true }); }
});

test("closes a stdio server when startup is cancelled and hides startup stderr", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-mcp-startup-"));
  try {
    const controller = new AbortController();
    const pending = connectMcp(configuration(root, { MCP_FIXTURE_HANG: "1" }), controller.signal);
    const rejection = assert.rejects(pending, { message: "mcp_timeout_or_aborted" });
    const child = await pid(root); controller.abort(); await rejection; stopped(child);
    await assert.rejects(inspectMcp(configuration(root, { MCP_FIXTURE_FAILURE: "1" })), { message: "mcp_connection_failed" });
    stopped(await pid(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});
