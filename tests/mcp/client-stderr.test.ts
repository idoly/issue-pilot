import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { connectMcp, redactMcpConnectionCredentials, type McpConfiguration } from "../../src/mcp/client.ts";

const server = fileURLToPath(new URL("../helpers/mcp-stdio-server.mjs", import.meta.url));

test("MCP diagnostics mask configured credentials and preserve unrelated business evidence", () => {
  const configuration: McpConfiguration = {
    id: "local",
    name: "Local",
    transport: "stdio",
    url: "",
    authorization: "Bearer our-system-key",
    enabled: true,
    stdio: { command: process.execPath, args: ["--token", "cli-system-secret"], env: { API_KEY: "fixture_short_secret", DBHUB_DSN: "mysql://reader:hello%20world@db.example.test/orders" } },
  };
  const text =
    'cli-system-secret SQL SELECT * FROM orders; /opt/app failed token=business-session-token password="hello world" API_KEY=fixture_short_secret Bearer our-system-key mysql://reader:hello%20world@db.example.test/orders';
  const diagnostic = redactMcpConnectionCredentials(text, configuration);
  assert.doesNotMatch(diagnostic, /our-system-key|cli-system-secret|fixture_short_secret|hello world|hello%20world/);
  assert.match(diagnostic, /token=business-session-token/);
  assert.match(diagnostic, /SQL SELECT \* FROM orders; \/opt\/app failed/);
});

for (const oversized of [false, true])
  test(
    `stdio diagnostics preserve the output boundary and ${oversized ? "omit oversized text without leaking a cut credential" : "retain business error details"}`,
    { timeout: 10_000 },
    async (context) => {
      const entries: string[] = [];
      context.mock.method(console, "warn", (line: string) => {
        entries.push(line);
      });
      const secret = oversized ? "private-key-".repeat(3000) : "fixture_short_secret";
      const configuration: McpConfiguration = {
        id: "local",
        name: "Local",
        url: "",
        transport: "stdio",
        authorization: "",
        enabled: true,
        stdio: { command: process.execPath, args: [server], env: { MCP_FIXTURE_FAILURE: "1", MCP_FIXTURE_SECRET: secret, MCP_FIXTURE_DIAGNOSTIC: "SQL failed at /opt/app token=business-token" } },
      };
      await assert.rejects(connectMcp(configuration, AbortSignal.timeout(5_000)), (error: unknown) => {
        assert.equal((error as Error).message, "mcp_connection_failed");
        assert.doesNotMatch(JSON.stringify(error), /fixture_short_secret|private-key-|business-token/);
        return true;
      });
      assert.equal(entries.length, 1);
      const diagnostic = JSON.parse(entries[0]!);
      assert.equal(diagnostic.mcpConnection, "Local");
      assert.doesNotMatch(diagnostic.stderr, /fixture_short_secret|private-key-/);
      if (oversized) assert.equal(diagnostic.stderr, "mcp_stderr_diagnostic_limit_exceeded");
      else assert.equal(diagnostic.stderr, "[credential] SQL failed at /opt/app token=business-token\n");
    },
  );
