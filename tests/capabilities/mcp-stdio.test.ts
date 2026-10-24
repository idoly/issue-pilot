import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { connectMcp, inspectMcp, type McpConfiguration } from "../../src/mcp/client.ts";

const server = fileURLToPath(new URL("../helpers/mcp-stdio-server.mjs", import.meta.url));
const configuration = (root: string, env: Record<string, string> = {}): McpConfiguration => ({ id: "stdio-fixture", name: "Fixture", url: "", transport: "stdio", authorization: "", enabled: true, stdio: { command: process.execPath, args: [server], env: { MCP_FIXTURE_PID_FILE: path.join(root, "pid"), MCP_FIXTURE_SECRET: "mcp_private_token", ...env } } });
async function pid(root: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const value = Number(await readFile(path.join(root, "pid"), "utf8"));
      if (Number.isSafeInteger(value) && value > 0) return value;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    await pause(20);
  }
  throw new Error("fixture_file_not_written");
}
const stopped = (value: number) => assert.throws(() => process.kill(value, 0), { code: "ESRCH" });

test("tests a stdio configuration without invoking tools and closes the child", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-mcp-stdio-inspect-"));
  try {
    const tools = await inspectMcp(configuration(root));
    assert.equal(tools.length, 6);
    assert.equal(tools.find(tool => tool.name === "write")?.readOnly, false);
    assert.doesNotMatch(JSON.stringify(tools), /mcp_private_token/);
    stopped(await pid(root));
  } finally { await rm(root, { recursive: true, force: true }); }
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
