import { writeFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

if (process.env.MCP_FIXTURE_PID_FILE) await writeFile(process.env.MCP_FIXTURE_PID_FILE, String(process.pid), { mode: 0o600 });
const secret = process.env.MCP_FIXTURE_SECRET ?? "fixture-secret";
if (process.env.MCP_FIXTURE_FAILURE) { console.error(secret); process.exit(17); }
if (process.env.MCP_FIXTURE_HANG) { setInterval(() => {}, 1000); process.stdin.resume(); }
else {
  const server = new Server({ name: "stdio-fixture", version: "1" }, { capabilities: { tools: {} } });
  let count = 0;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ["counter", "fail", "tool_error", "slow", "die", "write"].map(name => ({ name, inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: name === "write" ? { destructiveHint: true } : { readOnlyHint: true } })) }));
  server.setRequestHandler(CallToolRequestSchema, async (request, context) => {
    if (request.params.name === "fail") throw new Error(secret);
    if (request.params.name === "tool_error") return { isError: true, content: [{ type: "text", text: secret }] };
    if (request.params.name === "die") process.exit(19);
    if (request.params.name === "slow") {
      if (process.env.MCP_FIXTURE_SLOW_FILE) await writeFile(process.env.MCP_FIXTURE_SLOW_FILE, "1");
      context.signal.throwIfAborted();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 30_000);
        context.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error(secret)); }, { once: true });
      });
    }
    return { content: [{ type: "text", text: JSON.stringify({ pid: process.pid, count: ++count, cwd: process.cwd(), inherited: Boolean(process.env.MCP_PARENT_SECRET) }) }] };
  });
  await server.connect(new StdioServerTransport());
}
