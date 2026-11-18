import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { connectMcp, type McpConfiguration } from "../../src/mcp/client.ts";

const server = fileURLToPath(new URL("../helpers/mcp-stdio-server.mjs", import.meta.url));

for (const size of [1, 30_000])
  test(`stdio diagnostics count ${size} multibyte characters without retaining child output`, { timeout: 10_000 }, async (context) => {
    const entries: string[] = [];
    context.mock.method(console, "warn", (line: string) => entries.push(line));
    const message = "错".repeat(size);
    const configuration: McpConfiguration = {
      id: "local",
      name: "Local",
      url: "",
      transport: "stdio",
      authorization: "",
      enabled: true,
      stdio: { command: process.execPath, args: [server], env: { MCP_FIXTURE_FAILURE: "1", MCP_FIXTURE_DIAGNOSTIC: message } },
    };
    await assert.rejects(connectMcp(configuration, AbortSignal.timeout(5_000)), { message: "mcp_connection_failed" });
    assert.equal(entries.length, 1);
    const diagnostic = JSON.parse(entries[0]!);
    assert.deepEqual(diagnostic, { level: 40, time: diagnostic.time, msg: "mcp_stdio_stderr", mcpConnection: "Local", stderrBytes: Buffer.byteLength(`fixture-secret ${message}\n`) });
  });
