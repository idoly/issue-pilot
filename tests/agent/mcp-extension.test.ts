import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { hostMcpPid } from "../helpers/mcp-process.ts";
import { createPrivateSessionManager, PiSessionRuntime, type ManagedPiSession, type StartPiSessionOptions } from "../../src/agent/pi-session.ts";

async function fixture(env: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-native-mcp-"));
  const models = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null, modelsStorePath: path.join(root, "models.json"), refreshOnCreate: false });
  const faux = fauxProvider({ provider: "mcp-fixture", models: [{ id: "fixture", contextWindow: 64000 }], tokensPerSecond: 100000 });
  models.registerNativeProvider(faux.provider);
  const runtime = new PiSessionRuntime({ load: async () => models, close: async () => {} });
  const options: StartPiSessionOptions = {
    agentDirectory: root,
    manager: await createPrivateSessionManager(root, root), workspaceRoot: root,
    context: { issueKey: "ISSUE-20261018-998", serviceKey: "entry", environmentKey: "prod", codemode: "off", model: { provider: "mcp-fixture", modelId: "fixture", thinkingLevel: "off" }, capabilities: [], canModifyCode: false },
    deploymentConfig: {}, systemPrompt: "Use configured MCP tools.", onEvent() {},
    mcpConfigurations: [{ id: "local", name: "Local", url: "", transport: "stdio", authorization: "", enabled: true, stdio: { command: process.execPath, args: [fileURLToPath(new URL("../helpers/mcp-stdio-server.mjs", import.meta.url))], env: { MCP_FIXTURE_PID_FILE: path.join(root, "pid"), MCP_FIXTURE_SLOW_FILE: path.join(root, "slow"), MCP_FIXTURE_SECRET: "native-mcp-private-key", ...env } } }],
  };
  return { root, runtime, options, faux, close: () => rm(root, { recursive: true, force: true }) };
}
async function ready(managed: ManagedPiSession) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (managed.session.getCallableToolNames().includes("mcp__local__counter")) return;
    await pause(10);
  }
  throw new Error("mcp_tools_not_ready");
}
async function file(root: string, name: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { return await readFile(path.join(root, name), "utf8"); } catch { await pause(10); }
  }
  throw new Error("mcp_fixture_file_not_ready");
}
function data(outcome: { result: AgentToolResult<unknown>; isError: boolean }) {
  assert.equal(outcome.isError, false, JSON.stringify(outcome.result));
  const block = outcome.result.content[0]; assert.ok(block?.type === "text");
  return JSON.parse(block.text) as { pid: number; count: number; cwd: string; inherited: boolean };
}
const stopped = (pid: number) => assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });

function declaredTools(context: TranscriptContext) {
  const tools = new Map<string, { name: string; description: string }>();
  for (const message of context.messages) if (message.role === "system") {
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
  }
  return tools;
}

for (const mode of ["off", "on", "only"] as const) test(`uses ${mode === "off" ? "direct" : "discoverable"} MCP tools with codemode ${mode}`, async () => {
  const f = await fixture({ MCP_FIXTURE_RESOURCES: "1" }); let managed: ManagedPiSession | undefined;
  f.options.context.codemode = mode;
  try {
    f.faux.setResponses([
      context => {
        const tools = declaredTools(context);
        assert.equal(tools.has("codemode"), mode !== "off");
        assert.equal(tools.has("mcp__local__counter"), mode === "off");
        assert.equal(tools.has("list_mcp_resources"), mode === "off");
        if (mode !== "off") assert.doesNotMatch(tools.get("codemode")!.description, /mcp__local__counter/);
        const code = 'const found = await searchTools("counter", {namespace:"mcp__local"}); const description = await describeTool("mcp__local__counter"); const counter = await tools.mcp__local__counter({}); const resources = await tools.list_mcp_resources({server:"local"}); return {count:counter.structuredContent.count,resources:resources.resources.length,discovered:Boolean(description) && found.some(tool=>tool.name==="mcp__local__counter")};';
        return fauxAssistantMessage(fauxToolCall(mode === "off" ? "mcp__local__counter" : "codemode", mode === "off" ? {} : { code }, { id: "selected" }), { stopReason: "toolUse" });
      },
      context => {
        const result = context.messages.find(message => message.role === "toolResult" && message.toolCallId === "selected");
        assert.ok(result && result.role === "toolResult"); assert.equal(result.isError, false);
        assert.match(JSON.stringify(result.content), /count/);
        if (mode !== "off") { assert.match(JSON.stringify(result.content), /discovered.*true/); assert.match(JSON.stringify(result.content), /resources.*1/); }
        return fauxAssistantMessage("MCP selection verified.");
      },
    ]);
    managed = await f.runtime.start(f.options); await managed.prompt("Use the configured MCP tools.");
    assert.equal(managed.session.getActiveToolNames().includes("mcp__local__counter"), mode === "off");
    assert.ok(managed.session.getCallableToolNames().includes("mcp__local__counter"));
    assert.ok(managed.session.getCallableToolNames().includes("list_mcp_resources"));
    assert.equal(managed.session.getLastAssistantText(), "MCP selection verified.");
  } finally { await managed?.stop(); await f.close(); }
});

for (const mode of ["on", "only"] as const) test(`preserves sanitized MCP business errors as results in codemode ${mode}`, async () => {
  const f = await fixture(); let managed: ManagedPiSession | undefined;
  f.options.context.codemode = mode;
  try {
    const code = 'const results = await Promise.allSettled([tools.mcp__local__tool_error({}), tools.mcp__local__fail({}), tools.mcp__local__counter({})]); const business = results[0]; return {businessResolved:business.status === "fulfilled",isError:business.status === "fulfilled" && business.value.isError === true,code:business.status === "fulfilled" ? business.value.content[0].text : "rejected",protocolRejected:results[1].status === "rejected",success:results[2].status === "fulfilled"};';
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", { code }, { id: "errors" }), { stopReason: "toolUse" }),
      context => {
        const result = context.messages.find(message => message.role === "toolResult" && message.toolCallId === "errors");
        assert.ok(result && result.role === "toolResult"); assert.equal(result.isError, false);
        const text = JSON.stringify(result.content);
        for (const key of ["businessResolved", "isError", "protocolRejected", "success"]) assert.match(text, new RegExp(key + '.*true'));
        assert.match(text, /mcp_tool_failed/); assert.doesNotMatch(JSON.stringify(context), /native-mcp-private-key/);
        return fauxAssistantMessage("MCP errors handled as data.");
      },
    ]);
    managed = await f.runtime.start(f.options); await managed.prompt("Handle partial MCP failures.");
    assert.equal(managed.session.getLastAssistantText(), "MCP errors handled as data.");
    assert.doesNotMatch(await readFile(f.options.manager.getSessionFile()!, "utf8"), /native-mcp-private-key/);
  } finally { await managed?.stop(); await f.close(); }
});

test("reopens MCP sessions with the current exposure instead of historical direct tools", async () => {
  const f = await fixture(); let managed: ManagedPiSession | undefined;
  try {
    for (const mode of ["off", "on", "only", "off"] as const) {
      f.options.context.codemode = mode;
      f.faux.setResponses([context => {
        assert.equal(declaredTools(context).has("mcp__local__counter"), mode === "off");
        return fauxAssistantMessage("Current MCP exposure applied.");
      }]);
      managed = await f.runtime.start(f.options); await managed.prompt("Inspect current tools.");
      assert.equal(managed.session.getLastAssistantText(), "Current MCP exposure applied.");
      await ready(managed);
      assert.ok(managed.session.getCallableToolNames().includes("mcp__local__counter"));
      await managed.stop(); managed = undefined;
      f.options.manager = SessionManager.open(f.options.manager.getSessionFile()!);
    }
  } finally { await managed?.stop(); await f.close(); }
});

test("SDK tools reuse a private stdio process, retain literal configuration and reconnect after exit", async () => {
  const f = await fixture(); let managed: ManagedPiSession | undefined;
  const previous = process.env.MCP_PARENT_SECRET; process.env.MCP_PARENT_SECRET = "parent-private";
  f.options.mcpConfigurations![0]!.stdio!.env.LITERAL = `!touch ${path.join(f.root, "must-not-run")}`;
  try {
    f.faux.setResponses([fauxAssistantMessage("MCP connection ready.")]);
    managed = await f.runtime.start(f.options); await ready(managed); await managed.prompt("Inspect the connected MCP tools.");
    const context = managed.session.extensionRunner.createToolContext("integration", undefined);
    const first = data(await context.executeTool("mcp__local__counter", {}));
    const firstHostPid = await hostMcpPid(path.join(f.root, "pid"));
    const second = data(await context.executeTool("mcp__local__write", {}));
    assert.equal(first.pid, second.pid); assert.equal(second.count, first.count + 1); assert.equal(first.cwd, f.root); assert.equal(first.inherited, false);
    await assert.rejects(readFile(path.join(f.root, "must-not-run")), { code: "ENOENT" });
    assert.doesNotMatch(JSON.stringify(managed.session.getAllTools()), /native-mcp-private-key|must-not-run/);
    await context.executeTool("mcp__local__die", {});
    const restarted = data(await context.executeTool("mcp__local__counter", {}));
    assert.equal(restarted.count, 1);
    const restartedHostPid = await hostMcpPid(path.join(f.root, "pid"));
    assert.notEqual(firstHostPid, restartedHostPid); stopped(firstHostPid);
    await Promise.all([managed.stop(), managed.stop()]); stopped(restartedHostPid);
  } finally {
    await managed?.stop(); await f.close();
    if (previous === undefined) delete process.env.MCP_PARENT_SECRET; else process.env.MCP_PARENT_SECRET = previous;
  }
});

test("SDK call cancellation leaves the shared connection usable and errors omit remote secrets", async () => {
  const f = await fixture(); let managed: ManagedPiSession | undefined;
  try {
    f.faux.setResponses([fauxAssistantMessage("MCP connection ready.")]);
    managed = await f.runtime.start(f.options); await ready(managed); await managed.prompt("Inspect the connected MCP tools.");
    const context = managed.session.extensionRunner.createToolContext("integration", undefined);
    for (const name of ["fail", "tool_error"]) {
      const result = await context.executeTool(`mcp__local__${name}`, {});
      assert.equal(result.isError, true); assert.doesNotMatch(JSON.stringify(result), /native-mcp-private-key/);
      if (name === "tool_error") assert.deepEqual(result.result.structuredContent, { isError: true, content: [{ type: "text", text: "mcp_tool_failed" }] });
      else assert.equal(result.result.structuredContent, undefined);
    }
    const controller = new AbortController();
    const pending = context.executeTool("mcp__local__slow", {}, { signal: controller.signal });
    await file(f.root, "slow"); controller.abort(); await pending;
    const result = data(await context.executeTool("mcp__local__counter", {}));
    assert.equal(result.pid, Number(await file(f.root, "pid")));
    const resultHostPid = await hostMcpPid(path.join(f.root, "pid"));
    await managed.stop(); stopped(resultHostPid);
  } finally { await managed?.stop(); await f.close(); }
});

test("SDK shutdown closes a stdio server whose initialization is pending", async () => {
  const f = await fixture({ MCP_FIXTURE_HANG: "1" }); let managed: ManagedPiSession | undefined;
  try {
    managed = await f.runtime.start(f.options);
    await file(f.root, "pid");
    const child = await hostMcpPid(path.join(f.root, "pid"));
    await managed.stop(); stopped(child);
  } finally { await managed?.stop(); await f.close(); }
});

for (const nested of [false, true]) test(`rejects hook-mutated MCP input before ${nested ? "codemode" : "direct"} dispatch`, async () => {
  const f = await fixture(); let managed: ManagedPiSession | undefined;
  f.options.context.codemode = nested ? "on" : "off"; f.options.agentDirectory = f.root;
  try {
    await mkdir(path.join(f.root, "extensions"));
    await writeFile(path.join(f.root, "extensions/mutate.ts"), "export default pi => pi.on('tool_call',event=>{if(event.toolName==='mcp__local__write')event.input.unexpected=true;});");
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall(nested ? "codemode" : "mcp__local__write", nested ? { code: "return await tools.mcp__local__write({});" } : {}, { id: "mutated" }), { stopReason: "toolUse" }),
      context => {
        const result = context.messages.find(message => message.role === "toolResult" && message.toolCallId === "mutated");
        assert.ok(result && result.role === "toolResult"); assert.equal(result.isError, true); assert.match(JSON.stringify(result.content), /invalid_mcp_tool_input/);
        return fauxAssistantMessage("Invalid MCP input rejected.");
      },
    ]);
    managed = await f.runtime.start(f.options); await managed.prompt("Use the configured MCP tool.");
    const result = data(await managed.session.extensionRunner.createToolContext("verify", undefined).executeTool("mcp__local__counter", {}));
    assert.equal(result.count, 1);
  } finally { await managed?.stop(); await f.close(); }
});

test("SDK refreshes changed tool schemas and withdraws removed tools", async () => {
  const f = await fixture({ MCP_FIXTURE_DYNAMIC: "1" }); let managed: ManagedPiSession | undefined;
  try {
    f.faux.setResponses([fauxAssistantMessage("Connected.")]);
    managed = await f.runtime.start(f.options); await managed.prompt("Inspect the MCP tools.");
    const context = managed.session.extensionRunner.createToolContext("dynamic", undefined);
    assert.equal(data(await context.executeTool("mcp__local__counter", {})).count, 1);
    await context.executeTool("mcp__local__change", {});
    for (let attempt = 0; attempt < 200 && !JSON.stringify(managed.session.getAllTools().find(tool => tool.name === "mcp__local__counter")?.parameters).includes("confirm"); attempt++) await pause(10);
    assert.equal((await context.executeTool("mcp__local__counter", {})).isError, true);
    assert.equal(data(await context.executeTool("mcp__local__counter", { confirm: true })).count, 3);
    await context.executeTool("mcp__local__remove", {});
    for (let attempt = 0; attempt < 200 && managed.session.getCallableToolNames().includes("mcp__local__counter"); attempt++) await pause(10);
    assert.equal(managed.session.getCallableToolNames().includes("mcp__local__counter"), false);
    assert.equal((await context.executeTool("mcp__local__counter", { confirm: true })).isError, true);
  } finally { await managed?.stop(); await f.close(); }
});

test("SDK exposes MCP resources through the native resource tools", async () => {
  const f = await fixture({ MCP_FIXTURE_RESOURCES: "1" }); let managed: ManagedPiSession | undefined;
  try {
    f.faux.setResponses([fauxAssistantMessage("Connected.")]);
    managed = await f.runtime.start(f.options); await managed.prompt("Inspect the MCP resources.");
    const context = managed.session.extensionRunner.createToolContext("resources", undefined);
    const listed = await context.executeTool("list_mcp_resources", {});
    assert.equal(listed.isError, false); assert.match(JSON.stringify(listed.result), /fixture:\/\/evidence/);
    const templates = await context.executeTool("list_mcp_resource_templates", {});
    assert.equal(templates.isError, false);
    assert.deepEqual(templates.result.structuredContent, { resourceTemplates: [] });
    const read = await context.executeTool("read_mcp_resource", { server: "local", uri: "fixture://evidence" });
    assert.equal(read.isError, false); assert.match(JSON.stringify(read.result), /resource evidence/);
    const binary = await context.executeTool("read_mcp_resource", { server: "local", uri: "fixture://binary.bin" });
    assert.equal(binary.isError, false); assert.doesNotMatch(JSON.stringify(binary.result.content), /pi-mcp-[0-9a-f]{16}/);
    const files = (await readdir(f.root)).filter(name => name.startsWith("mcp-") && name.endsWith(".bin"));
    assert.equal(files.length, 1);
    assert.deepEqual(await readFile(path.join(f.root, files[0]!)), Buffer.from([0, 255, 1, 2]));
    assert.equal((await stat(path.join(f.root, files[0]!))).mode & 0o777, 0o600);
  } finally { await managed?.stop(); await f.close(); }
});

test("rejects loader environment overrides before starting a stdio sandbox", async () => {
  const f = await fixture({ LD_PRELOAD: "./untrusted-loader.so" });
  try {
    await assert.rejects(f.runtime.start(f.options), /unsafe_issue_launcher_environment/);
    await assert.rejects(readFile(path.join(f.root, "pid")), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("rejects oversized MCP results before formatting or returning their contents", async () => {
  const f = await fixture({ MCP_FIXTURE_RESULT_BYTES: String(1024 * 1024 + 100) }); let managed: ManagedPiSession | undefined;
  try {
    f.faux.setResponses([fauxAssistantMessage("Connected.")]);
    managed = await f.runtime.start(f.options); await managed.prompt("Inspect the MCP tools.");
    const result = await managed.session.extensionRunner.createToolContext("budget", undefined).executeTool("mcp__local__counter", {});
    assert.equal(result.isError, true); assert.match(JSON.stringify(result.result), /mcp_result_too_large/);
  } finally { await managed?.stop(); await f.close(); }
});

for (const excessive of [false, true]) test(`${excessive ? "rejects" : "accepts"} paginated MCP discovery within the configured tool budget`, async () => {
  const f = await fixture({ MCP_FIXTURE_PAGE_SIZE: "3", ...(excessive ? { MCP_FIXTURE_TOOL_COUNT: "201" } : {}) }); let managed: ManagedPiSession | undefined;
  try {
    f.faux.setResponses([fauxAssistantMessage("Agent remains usable.")]);
    managed = await f.runtime.start(f.options); await managed.prompt("Inspect the available tools.");
    const names = managed.session.getCallableToolNames().filter(name => name.startsWith("mcp__"));
    assert.equal(names.length, excessive ? 0 : 6);
    assert.equal(managed.session.getLastAssistantText(), "Agent remains usable.");
  } finally { await managed?.stop(); await f.close(); }
});

test("uses only enabled database configurations and ignores MCP files in the Issue directory", async () => {
  const f = await fixture(); let managed: ManagedPiSession | undefined;
  f.options.mcpConfigurations![0]!.enabled = false;
  try {
    await mkdir(path.join(f.root, ".pi"));
    await writeFile(path.join(f.root, ".pi/mcp.json"), JSON.stringify({ mcpServers: { unwanted: { command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(path.join(f.root, "unwanted"))},'1')`] } } }));
    f.faux.setResponses([fauxAssistantMessage("Configured tools only.")]);
    managed = await f.runtime.start(f.options); await managed.prompt("Inspect the available tools.");
    assert.equal(managed.session.getCallableToolNames().some(name => name.startsWith("mcp__")), false);
    assert.equal(managed.session.getActiveToolNames().includes("codemode"), false);
    await assert.rejects(readFile(path.join(f.root, "unwanted")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(f.root, "pid")), { code: "ENOENT" });
  } finally { await managed?.stop(); await f.close(); }
});

for (const transport of ["streamable_http", "sse"] as const) test(`native ${transport} calls preserve literal authorization and image/structured results`, async () => {
  const f = await fixture(); let managed: ManagedPiSession | undefined;
  const original = globalThis.fetch; let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder(), authorization = "Bearer ${MCP_SHOULD_STAY_LITERAL}";
  f.options.mcpConfigurations = [{ id: "local", name: "Remote", url: "https://mcp.example.test/mcp", authorization, transport, enabled: true }];
  globalThis.fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), authorization); assert.equal(init?.redirect, "error");
    if ((init?.method ?? "GET") === "GET") return new Response(new ReadableStream({ start(controller) { stream = controller; controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
    const request = JSON.parse(String(init?.body)); let result;
    if (request.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
    if (request.method === "tools/list") result = { tools: [{ name: "counter", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] };
    if (request.method === "tools/call") result = { content: [{ type: "text", text: "evidence" }, { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=", mimeType: "image/png" }], structuredContent: { value: 42 } };
    if (!result) return new Response(null, { status: 202 });
    const message = { jsonrpc: "2.0", id: request.id, result };
    if (transport === "sse") { stream!.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`)); return new Response(null, { status: 202 }); }
    return new Response(JSON.stringify(message), { headers: { "content-type": "application/json" } });
  };
  try {
    f.faux.setResponses([fauxAssistantMessage("Connected.")]);
    managed = await f.runtime.start(f.options); await managed.prompt("Inspect the MCP tools.");
    const result = await managed.session.extensionRunner.createToolContext("http", undefined).executeTool("mcp__local__counter", {});
    assert.equal(result.isError, false); assert.ok(result.result.content.some(block => block.type === "image"));
    assert.deepEqual((result.result.structuredContent as { structuredContent: unknown }).structuredContent, { value: 42 });
    assert.doesNotMatch(JSON.stringify(managed.session.getAllTools()), /MCP_SHOULD_STAY_LITERAL/);
  } finally { await managed?.stop(); globalThis.fetch = original; await f.close(); }
});

test("reports an expired HTTP call without replaying it and reconnects for a later explicit call", async () => {
  const f = await fixture(); const original = globalThis.fetch; let managed: ManagedPiSession | undefined, initializations = 0, calls = 0;
  f.options.mcpConfigurations = [{ id: "local", name: "Remote", url: "https://mcp.example.test/mcp", authorization: "", transport: "streamable_http", enabled: true }];
  globalThis.fetch = async (_input, init) => {
    const method = init?.method ?? "GET";
    if (method === "GET") return new Response(null, { status: 405 });
    if (method === "DELETE") return new Response(null, { status: 200 });
    const request = JSON.parse(String(init?.body)); let result;
    if (request.method === "initialize") { initializations++; result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }; }
    if (request.method === "tools/list") result = { tools: [{ name: "counter", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] };
    if (request.method === "tools/call") {
      if (new Headers(init?.headers).get("mcp-session-id") === "session-1") return new Response("private-expiration-detail", { status: 404 });
      calls++; result = { content: [{ type: "text", text: "completed" }] };
    }
    if (!result) return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { headers: { "content-type": "application/json", ...(request.method === "initialize" ? { "mcp-session-id": `session-${initializations}` } : {}) } });
  };
  try {
    f.faux.setResponses([fauxAssistantMessage("Connected.")]);
    managed = await f.runtime.start(f.options); await managed.prompt("Inspect the MCP tools.");
    const context = managed.session.extensionRunner.createToolContext("expired", undefined);
    const expired = await context.executeTool("mcp__local__counter", {});
    assert.equal(expired.isError, true);
    assert.equal(calls, 0);
    const result = await context.executeTool("mcp__local__counter", {});
    assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(initializations, 2); assert.equal(calls, 1);
  } finally { await managed?.stop(); globalThis.fetch = original; await f.close(); }
});

test("keeps discovery responses separate from server requests with the same JSON-RPC id", async () => {
  const f = await fixture({ MCP_FIXTURE_ROOTS: "1" }); let managed: ManagedPiSession | undefined;
  try {
    f.faux.setResponses([fauxAssistantMessage("Connected.")]);
    managed = await f.runtime.start(f.options); await managed.prompt("Inspect the MCP tools.");
    const result = await managed.session.extensionRunner.createToolContext("duplex", undefined).executeTool("mcp__local__counter", {});
    assert.equal(data(result).count, 1);
  } finally { await managed?.stop(); await f.close(); }
});

test("shutdown interrupts legacy SSE startup before an endpoint is announced", async () => {
  const f = await fixture(); const original = globalThis.fetch; let started!: () => void;
  const opening = new Promise<void>(resolve => { started = resolve; });
  f.options.mcpConfigurations = [{ id: "local", name: "Pending SSE", url: "https://mcp.example.test/sse", authorization: "", transport: "sse", enabled: true }];
  globalThis.fetch = async () => { started(); return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } }); };
  try {
    const managed = await f.runtime.start(f.options); await opening;
    const closed = await Promise.race([managed.stop().then(() => true), pause(400).then(() => false)]);
    assert.equal(closed, true);
  } finally { globalThis.fetch = original; await f.close(); }
});
