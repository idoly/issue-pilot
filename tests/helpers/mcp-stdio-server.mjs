import { writeFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";

if (process.env.MCP_FIXTURE_PID_FILE) await writeFile(process.env.MCP_FIXTURE_PID_FILE, String(process.pid), { mode: 0o600 });
const secret = process.env.MCP_FIXTURE_SECRET ?? "fixture-secret";
if (process.env.MCP_FIXTURE_FAILURE) { console.error(secret); process.exit(17); }
if (process.env.MCP_FIXTURE_HANG) { setInterval(() => {}, 1000); process.stdin.resume(); }
else {
  const server = new Server({ name: "stdio-fixture", version: "1" }, { capabilities: { tools: {}, ...(process.env.MCP_FIXTURE_RESOURCES ? { resources: {} } : {}) } });
  let count = 0, changed = false, removed = false, rootsChecked = false;
  server.setRequestHandler(ListToolsRequestSchema, async request => {
    if (process.env.MCP_FIXTURE_ROOTS && !rootsChecked) { rootsChecked = true; await server.ping(); await server.listRoots(); }
    const names = process.env.MCP_FIXTURE_TOOL_COUNT ? Array.from({ length: Number(process.env.MCP_FIXTURE_TOOL_COUNT) }, (_, index) => `tool_${index}`) : ["counter", "fail", "tool_error", "slow", "die", "write", ...(process.env.MCP_FIXTURE_DYNAMIC ? ["change", "remove"] : [])].filter(name => !removed || name !== "counter");
    const tools = names.map(name => ({ name, inputSchema: { type: "object", properties: name === "counter" && changed ? { confirm: { type: "boolean" } } : {}, ...(name === "counter" && changed ? { required: ["confirm"] } : {}), additionalProperties: false }, annotations: name === "write" ? { destructiveHint: true } : { readOnlyHint: true } }));
    const offset = Number(request.params?.cursor ?? 0), size = Number(process.env.MCP_FIXTURE_PAGE_SIZE ?? tools.length);
    return { tools: tools.slice(offset, offset + size), ...(offset + size < tools.length ? { nextCursor: String(offset + size) } : {}) };
  });
  if (process.env.MCP_FIXTURE_RESOURCES) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: "fixture://evidence", name: "Evidence", mimeType: "text/plain" }] }));
    server.setRequestHandler(ReadResourceRequestSchema, async request => ({ contents: [request.params.uri.endsWith(".bin") ? { uri: request.params.uri, mimeType: "application/octet-stream", blob: Buffer.from([0, 255, 1, 2]).toString("base64") } : { uri: request.params.uri, mimeType: "text/plain", text: "resource evidence" }] }));
  }
  server.setRequestHandler(CallToolRequestSchema, async (request, context) => {
    if (request.params.name === "fail") throw new Error(secret);
    if (request.params.name === "tool_error") return { isError: true, content: [{ type: "text", text: secret }], structuredContent: { secret }, _meta: { secret } };
    if (request.params.name === "die") process.exit(19);
    if (request.params.name === "change") { changed = true; await server.sendToolListChanged(); }
    if (request.params.name === "remove") { removed = true; await server.sendToolListChanged(); }
    if (request.params.name === "slow") {
      if (process.env.MCP_FIXTURE_SLOW_FILE) await writeFile(process.env.MCP_FIXTURE_SLOW_FILE, "1");
      context.signal.throwIfAborted();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 30_000);
        context.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error(secret)); }, { once: true });
      });
    }
    const data = { pid: process.pid, count: ++count, cwd: process.cwd(), inherited: Boolean(process.env.MCP_PARENT_SECRET) };
    return { content: [{ type: "text", text: JSON.stringify(data).padEnd(Number(process.env.MCP_FIXTURE_RESULT_BYTES ?? 0), "x") }], structuredContent: data };
  });
  await server.connect(new StdioServerTransport());
}
