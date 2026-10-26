import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext, type Tool, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { defineTool, ModelRuntime, SessionManager, type JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentCodemodeMode } from "../../src/domain/contracts.ts";
import { PiSessionRuntime, createPrivateSessionManager, type StartPiSessionOptions } from "../../src/agent/pi-session.ts";

async function fixture(mode: AgentCodemodeMode, overrides: Partial<StartPiSessionOptions> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-codemode-"));
  await mkdir(path.join(root, "sessions"));
  const models = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null, modelsStorePath: path.join(root, "models.json"), refreshOnCreate: false });
  const faux = fauxProvider({ provider: "codemode-fixture", models: [{ id: "fixture", contextWindow: 64000 }], tokensPerSecond: 100000 });
  models.registerNativeProvider(faux.provider);
  const runtime = new PiSessionRuntime({ load: async () => models, close: async () => {} });
  const events: JsonAgentSessionEvent[] = [];
  const manager = await createPrivateSessionManager(root, path.join(root, "sessions"));
  const options: StartPiSessionOptions = { agentDirectory: root, manager, workspaceRoot: root, context: { issueKey: "ISSUE-20261017-001", serviceKey: "entry", environmentKey: "prod", codemode: mode, model: { provider: "codemode-fixture", modelId: "fixture", thinkingLevel: "off" }, capabilities: [], canModifyCode: false }, deploymentConfig: {}, systemPrompt: "Use configured tools to investigate the Issue.", onEvent: event => events.push(event), ...overrides };
  return { root, models, runtime, options, faux, events, close: async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); } };
}
function declaredTools(context: TranscriptContext) {
  const tools = new Map<string, Tool>();
  for (const message of context.messages) if (message.role === "system") {
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
  }
  return tools;
}
function evidenceTool(url: string) {
  return defineTool({ name: "evidence_read", label: "Fixture evidence", description: "Read isolated fixture evidence.", parameters: Type.Object({}), execute: async (_id, _input, signal) => ({ content: [{ type: "text", text: await (await fetch(url, signal ? { signal } : {})).text() }], details: undefined }) });
}
const call = (code: string, id = "script") => fauxAssistantMessage(fauxToolCall("codemode", { code }, { id }), { stopReason: "toolUse" });

for (const retryEnabled of [false, true]) test(`rejects a final model stream failure without running partial tools (retry ${retryEnabled})`, async () => {
  const f = await fixture("off", { runtime: { settings: { retry: { enabled: retryEnabled, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 } } } });
  let managed;
  try {
    const interrupted = () => fauxAssistantMessage(fauxToolCall("write", { path: "partial.txt", content: "must not run" }), { stopReason: "error", errorMessage: "terminated: private upstream detail" });
    f.faux.setResponses([interrupted(), ...(retryEnabled ? [interrupted()] : [])]);
    managed = await f.runtime.start(f.options);
    await assert.rejects(managed.prompt("Write the requested file."), { message: "model_response_failed" });
    assert.equal(f.faux.state.callCount, retryEnabled ? 2 : 1);
    assert.equal(f.events.filter(event => event.type === "tool_execution_start").length, 0);
    await assert.rejects(readFile(path.join(f.root, "partial.txt")), { code: "ENOENT" });
    assert.ok(f.options.manager.getEntries().some(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error"));
    f.faux.appendResponses([fauxAssistantMessage("Continued after the interruption.")]);
    await managed.prompt("Continue after checking the saved results.");
    assert.equal(managed.session.getLastAssistantText(), "Continued after the interruption.");
  } finally { await managed?.stop(); await f.close(); }
});

test("lets Pi recover a model stream without repeating completed tools", async () => {
  const f = await fixture("off", { runtime: { settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 } } } });
  let managed;
  try {
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write", { path: "completed.txt", content: "saved once" }, { id: "completed" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("write", { path: "partial.txt", content: "must not run" }), { stopReason: "error", errorMessage: "terminated" }),
      context => {
        assert.equal(context.messages.filter(message => message.role === "toolResult" && message.toolCallId === "completed").length, 1);
        return fauxAssistantMessage("Recovered without replaying the completed write.");
      },
    ]);
    managed = await f.runtime.start(f.options);
    await managed.prompt("Save the requested evidence.");
    assert.equal(f.faux.state.callCount, 3);
    assert.equal(f.events.filter(event => event.type === "tool_execution_start").length, 1);
    assert.equal(await readFile(path.join(f.root, "completed.txt"), "utf8"), "saved once");
    await assert.rejects(readFile(path.join(f.root, "partial.txt")), { code: "ENOENT" });
    assert.equal(managed.session.getLastAssistantText(), "Recovered without replaying the completed write.");
  } finally { await managed?.stop(); await f.close(); }
});

test("reports non-retryable model failures without exposing upstream details", async () => {
  const f = await fixture("off", { runtime: { settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } } } });
  let managed;
  try {
    f.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 unauthorized: private upstream detail" })]);
    managed = await f.runtime.start(f.options);
    await assert.rejects(managed.prompt("Read the evidence."), { message: "model_response_failed" });
    assert.equal(f.faux.state.callCount, 1);
  } finally { await managed?.stop(); await f.close(); }
});

test("queues Codemode scripts across three sessions instead of exceeding SDK workers", { timeout: 15_000 }, async () => {
  let active = 0, peak = 0, requests = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer((_request, response) => {
    requests++; active++; peak = Math.max(peak, active);
    const timer = setTimeout(() => { timers.delete(timer); active--; response.writeHead(200, { "content-type": "text/plain" }); response.end("synthetic evidence"); }, 200);
    timers.add(timer);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const fixtures: Awaited<ReturnType<typeof fixture>>[] = [], sessions: Awaited<ReturnType<PiSessionRuntime["start"]>>[] = [];
  try {
    for (let index = 0; index < 3; index++) {
      const f = await fixture("on"); fixtures.push(f);
      f.options.workspaceTool = evidenceTool(`http://127.0.0.1:${address.port}`);
      f.faux.setResponses([call('return await tools.evidence_read({});'), fauxAssistantMessage("Script finished.")]);
      sessions.push(await f.runtime.start(f.options));
    }
    await Promise.all(sessions.map(managed => managed.prompt("Read the configured evidence.")));
    assert.equal(requests, 3);
    assert.equal(peak, 1);
    for (const f of fixtures) assert.deepEqual(f.events.filter(event => event.type === "tool_execution_end" && event.isError), []);
  } finally {
    for (const managed of sessions) await managed.stop();
    for (const f of fixtures) await f.close();
    for (const timer of timers) clearTimeout(timer);
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

for (const mode of ["off", "on", "only"] as const) test(`loads the explicit ${mode} codemode selection without host extension discovery`, async () => {
  const f = await fixture(mode); let managed;
  try {
    f.faux.setResponses([context => {
      const tools = declaredTools(context);
      assert.equal(tools.has("codemode"), mode !== "off");
      assert.equal(tools.has("read"), mode !== "only");
      assert.equal(tools.has("bash"), mode !== "only");
      if (mode !== "off") assert.doesNotMatch(tools.get("codemode")!.description, /models\.classify|models\.generateImages/);
      return fauxAssistantMessage("Selection verified.");
    }]);
    managed = await f.runtime.start(f.options);
    assert.equal(managed.session.getActiveToolNames().includes("codemode"), mode !== "off");
    assert.equal(managed.session.getCallableToolNames().includes("read"), true);
    assert.equal(managed.session.getCallableToolNames().includes("codemode"), false);
    await managed.prompt("Verify the configured tools.");
    assert.equal(managed.session.getLastAssistantText(), "Selection verified.");
  } finally { await managed?.stop(); await f.close(); }
});

for (const nested of [false, true]) test(`${nested ? "codemode" : "direct"} writes validate arguments again after a mutable extension hook`, async () => {
  const f = await fixture("on"); let managed;
  f.options.agentDirectory = f.root;
  try {
    await mkdir(path.join(f.root, "extensions"));
    await writeFile(path.join(f.root, "extensions", "mutator.ts"), "export default pi => pi.on('tool_call', event => { if(event.toolName==='write') event.input.content=9; });\n");
    const input = { path: "must-not-exist.txt", content: "before mutation" };
    f.faux.setResponses([
      nested ? call(`await tools.write(${JSON.stringify(input)});`, "mutated") : fauxAssistantMessage(fauxToolCall("write", input, { id: "mutated" }), { stopReason: "toolUse" }),
      context => {
        const result = context.messages.find(message => message.role === "toolResult" && message.toolCallId === "mutated");
        assert.ok(result && result.role === "toolResult"); assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.content), /invalid_issue_write_input/);
        return fauxAssistantMessage("Invalid write rejected.");
      },
    ]);
    managed = await f.runtime.start(f.options); await managed.prompt("Write a synthetic file.");
    await assert.rejects(readFile(path.join(f.root, "must-not-exist.txt")), { code: "ENOENT" });
    assert.equal(managed.session.getLastAssistantText(), "Invalid write rejected.");
  } finally { await managed?.stop(); await f.close(); }
});

for (const autoResize of [true, false]) test(`native image reads retain resize settings and model limits (${autoResize})`, async () => {
  const f = await fixture("off", { runtime: { settings: { images: { autoResize } } } });
  let managed;
  try {
    // Valid JPEG with trailing padding exercises the SDK's encoded-size limit without a new image dependency.
    const original = Buffer.concat([await readFile(new URL("../../docs/images/workspace.jpg", import.meta.url)), Buffer.alloc(4 * 1024 * 1024)]);
    await writeFile(path.join(f.root, "input.jpg"), original);
    const model = f.models.getModel("codemode-fixture", "fixture");
    assert.ok(model);
    model.inputLimits = { images: { resize: { maxWidth: 32, maxHeight: 32 } } };
    f.faux.setResponses([fauxAssistantMessage(fauxToolCall("read", { path: "input.jpg" }, { id: "image" }), { stopReason: "toolUse" }), fauxAssistantMessage("Read image.")]);
    managed = await f.runtime.start(f.options);
    await managed.prompt("Read the fixture image.");
    const event = f.events.find(event => event.type === "tool_execution_end" && event.toolCallId === "image");
    assert.ok(event && event.type === "tool_execution_end");
    assert.equal(event.isError, false);
    const image = event.result.content.find((item: TextContent | ImageContent) => item.type === "image");
    assert.ok(image && image.type === "image");
    const bytes = Buffer.from(image.data, "base64");
    if (autoResize) assert.equal(bytes.equals(original), false);
    else assert.equal(bytes.equals(original), true);
  } finally { await managed?.stop(); await f.close(); }
});

test("keeps updated Git identities across native Bash calls and rejects invalid updates", async () => {
  const f = await fixture("off"); let managed;
  f.options.gitIdentity = { name: " First Agent ", email: " first@example.test " };
  try {
    managed = await f.runtime.start(f.options);
    for (const [index, expected] of ["First Agent <first@example.test>", "Second Agent <second@example.test>", "Second Agent <second@example.test>"].entries()) {
      if (index === 1) managed.setGitIdentity({ name: " Second Agent ", email: " second@example.test " });
      if (index === 2) assert.throws(() => managed!.setGitIdentity({ name: "", email: "invalid@example.test" }), /invalid_git_commit_identity/);
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("bash", { command: "git var GIT_AUTHOR_IDENT" }, { id: `identity-${index}` }), { stopReason: "toolUse" }),
        context => {
          const result = context.messages.find(message => message.role === "toolResult" && message.toolCallId === `identity-${index}`);
          assert.ok(result && result.role === "toolResult"); assert.equal(result.isError, false);
          assert.ok(JSON.stringify(result.content).includes(expected));
          return fauxAssistantMessage("Git identity verified.");
        },
      ]);
      await managed.prompt("Read the current Git identity.");
    }
    assert.equal(managed.session.getLastAssistantText(), "Git identity verified.");
  } finally { await managed?.stop(); await f.close(); }
});

for (const withTool of [false, true]) test(`keeps the model response timeout active after ${withTool ? "native tool result" : "user"} messages`, { timeout: 5_000 }, async () => {
  const f = await fixture("off", { modelResponseIdleMs: 200 }); let managed;
  let release: (() => void) | undefined, safety: ReturnType<typeof setTimeout> | undefined;
  try {
    if (withTool) await writeFile(path.join(f.root, "evidence.txt"), "Synthetic tool evidence.");
    f.faux.setResponses([
      ...(withTool ? [fauxAssistantMessage(fauxToolCall("read", { path: "evidence.txt" }), { stopReason: "toolUse" })] : []),
      async (_context, options) => new Promise(resolve => {
        release = () => resolve(fauxAssistantMessage("Released stalled response."));
        safety = setTimeout(() => release?.(), 1_000);
        if (options?.signal?.aborted) release();
        else options?.signal?.addEventListener("abort", release, { once: true });
      }),
    ]);
    managed = await f.runtime.start(f.options);
    await assert.rejects(managed.prompt("Read the evidence, then wait for the model."), { message: "model_response_idle_timeout" });
    assert.ok(f.events.some(event => event.type === "message_end" && event.message.role === (withTool ? "toolResult" : "user")));
  } finally { clearTimeout(safety); release?.(); await managed?.stop(); await f.close(); }
});

test("batches evidence reads while enforcing native source and SQL boundaries", { timeout: 15_000 }, async () => {
  let active = 0, parallel = false, requests = 0;
  const waiting: Array<() => void> = [];
  const server = createServer((_request, response) => {
    requests++; active++;
    waiting.push(() => { response.writeHead(200, { "content-type": "text/plain" }); response.end("intermediate-evidence-marker"); active--; });
    if (active === 2) { parallel = true; for (const finish of waiting.splice(0)) finish(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const f = await fixture("on"); let managed;
  const config = { dms: { url: "https://dms.example.test/sse", authorization: "Bearer private-config-token", databases: [{ instanceAlias: "FIXTURE", schemaName: "fixture", instanceId: "1", instanceHost: "db.example.test", instancePort: "3306", databaseId: "1" }] } };
  f.options.context.capabilities = ["dms"];
  f.options.workspaceTool = evidenceTool(`http://127.0.0.1:${address.port}`);
  f.options.serviceScopes = [
    { environmentKey: "prod", serviceKey: "first", serviceName: "First", config },
    { environmentKey: "prod", serviceKey: "second", serviceName: "Second", config },
  ];
  const code = `const results = await Promise.allSettled([
    tools.evidence_read({}),
    tools.evidence_read({}),
    tools.service_query({environment:"test",service:"first",capability:"dms",schema:"fixture",script:"SELECT 1"}),
    tools.service_query({environment:"prod",service:"first",capability:"dms",schema:"fixture",script:"DELETE FROM orders"})
  ]);
  return results.map(result => result.status === "fulfilled" ? {count:JSON.stringify(result.value).length} : {error:result.reason.message});`;
  try {
    f.faux.setResponses([call(code), context => {
      const result = context.messages.find(message => message.role === "toolResult" && message.toolName === "codemode");
      assert.ok(result && result.role === "toolResult"); assert.equal(result.isError, false);
      assert.match(JSON.stringify(result.content), /count/); assert.match(JSON.stringify(result.content), /invalid.*input|validation|Invalid/i);
      assert.doesNotMatch(JSON.stringify(context), /intermediate-evidence-marker|private-config-token|db\.example\.test/);
      return fauxAssistantMessage("Two sources checked; unauthorized source rejected.");
    }]);
    managed = await f.runtime.start(f.options); await managed.prompt("Compare the configured evidence.");
    assert.equal(parallel, true); assert.equal(requests, 2);
    assert.equal(managed.session.getLastAssistantText(), "Two sources checked; unauthorized source rejected.");
    assert.ok(f.events.some(event => event.type === "tool_execution_start" && event.parentToolCallId === "script" && event.toolName === "evidence_read"));
    assert.doesNotMatch(await readFile(f.options.manager.getSessionFile()!, "utf8"), /intermediate-evidence-marker/);
  } finally { for (const finish of waiting.splice(0)) finish(); await managed?.stop(); await f.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("calls native MCP tools from codemode and reuses the SDK stdio connection", async () => {
  const f = await fixture("on"); let managed;
  f.options.mcpConfigurations = [{ id: "counter-fixture", name: "Counter", url: "", transport: "stdio", authorization: "", enabled: true, stdio: { command: process.execPath, args: [fileURLToPath(new URL("../helpers/mcp-stdio-server.mjs", import.meta.url))], env: { MCP_FIXTURE_SECRET: "private-mcp-fixture" } } }];
  try {
    f.faux.setResponses([call(`const first = await tools.mcp__counter_fixture__counter({});
      const second = await tools.mcp__counter_fixture__counter({});
      const written = await tools.mcp__counter_fixture__write({});
      const denied = await Promise.allSettled([tools.mcp__counter_fixture__write({unexpected:true})]);
      return {sameProcess:first.structuredContent.pid===second.structuredContent.pid,count:second.structuredContent.count,written:written.structuredContent.count,denied:denied[0].status};`), context => {
        const text = JSON.stringify(context);
        assert.match(text, /sameProcess/); assert.match(text, /rejected/); assert.doesNotMatch(text, /private-mcp-fixture/);
        const message = context.messages.find(message => message.role === "toolResult" && message.toolName === "codemode");
        assert.ok(message && message.role === "toolResult"); assert.equal(message.isError, false);
        assert.match(JSON.stringify(message.content), /true/); assert.match(JSON.stringify(message.content), /2/); assert.match(JSON.stringify(message.content), /3/);
        return fauxAssistantMessage("MCP calls reused the SDK process.");
      }]);
    managed = await f.runtime.start(f.options); await managed.prompt("Read the configured MCP source.");
    assert.equal(managed.session.getLastAssistantText(), "MCP calls reused the SDK process.");
  } finally { await managed?.stop(); await f.close(); }
});

test("persists ordinary working filenames in the codemode store across session reopen", async () => {
  const f = await fixture("only"); let managed;
  try {
    f.faux.setResponses([
      call('await tools.write({path:"result.txt",content:"saved by native tool"}); store("file","result.txt"); return {file:"result.txt"};', "write"),
      fauxAssistantMessage("Saved."),
      call('const existing = await tools.read({path:load("file")}); return {stored:load("file"),file:existing};', "resume"),
      context => { assert.match(JSON.stringify(context), /stored/); return fauxAssistantMessage("Reopened with stored filename."); },
    ]);
    managed = await f.runtime.start(f.options); await managed.prompt("Save the result.");
    assert.equal(await readFile(path.join(f.root, "result.txt"), "utf8"), "saved by native tool");
    await managed.stop();
    const manager = SessionManager.open(f.options.manager.getSessionFile()!);
    managed = await f.runtime.start({ ...f.options, manager }); await managed.prompt("Check the published result.");
    assert.equal(managed.session.getLastAssistantText(), "Reopened with stored filename.");
    assert.ok(manager.getBranch().some(entry => entry.type === "custom" && entry.customType === "codemode-store"));
    await managed.stop();
    f.faux.appendResponses([context => {
      assert.equal(declaredTools(context).has("codemode"), false);
      assert.equal(declaredTools(context).has("read"), true);
      return fauxAssistantMessage("Codemode disabled on resume.");
    }]);
    managed = await f.runtime.start({ ...f.options, manager: SessionManager.open(f.options.manager.getSessionFile()!), context: { ...f.options.context, codemode: "off" } });
    assert.equal(managed.session.getActiveToolNames().includes("codemode"), false);
    await managed.prompt("Continue after disabling codemode.");
    assert.equal(managed.session.getLastAssistantText(), "Codemode disabled on resume.");
  } finally { await managed?.stop(); await f.close(); }
});

test("keeps partial output but does not commit store writes when a script fails", async () => {
  const f = await fixture("on"); let managed;
  try {
    f.faux.setResponses([
      call('store("failed",1); text("partial evidence"); throw new Error("expected script failure");', "failed-script"),
      context => {
        const message = context.messages.find(message => message.role === "toolResult" && message.toolCallId === "failed-script");
        assert.ok(message && message.role === "toolResult"); assert.equal(message.isError, true);
        assert.match(JSON.stringify(message.content), /partial evidence/); assert.match(JSON.stringify(message.content), /expected script failure/);
        return call('return {failedValue:load("failed") ?? null};', "after-failure");
      },
      context => {
        const message = context.messages.find(message => message.role === "toolResult" && message.toolCallId === "after-failure");
        assert.ok(message && message.role === "toolResult"); assert.match(JSON.stringify(message.content), /null/);
        return fauxAssistantMessage("Failed writes were discarded.");
      },
    ]);
    managed = await f.runtime.start(f.options); await managed.prompt("Run a script and recover from its failure.");
    assert.equal(managed.session.getLastAssistantText(), "Failed writes were discarded.");
    assert.equal(f.options.manager.getBranch().some(entry => entry.type === "custom" && entry.customType === "codemode-store"), false);
  } finally { await managed?.stop(); await f.close(); }
});

test("Codemode images and truncated output are archived in the Issue root before the result is persisted", async () => {
  const f = await fixture("on"); let managed;
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=";
  try {
    f.faux.setResponses([call(`image({type:'image',data:${JSON.stringify(png)},mimeType:'image/png'});console.log('x'.repeat(50000));`), context => {
      const result = context.messages.find(message => message.role === "toolResult" && message.toolCallId === "script");
      assert.ok(result && result.role === "toolResult"); assert.equal(result.isError, false);
      assert.match(JSON.stringify(result.content), /codemode-[0-9a-f-]+\.png/);
      assert.doesNotMatch(JSON.stringify(result.content), /pi-codemode-[0-9a-f]{16}/);
      return fauxAssistantMessage("Files archived.");
    }]);
    managed = await f.runtime.start(f.options); await managed.prompt("Generate an image and a large text result.");
    const files = (await readdir(f.root)).filter(name => name.startsWith("codemode-"));
    assert.equal(files.filter(name => name.endsWith(".png")).length, 1, JSON.stringify(f.events.filter(event => event.type === "tool_execution_end")).slice(0, 1800)); assert.equal(files.filter(name => name.endsWith(".txt")).length, 1);
    assert.deepEqual(await readFile(path.join(f.root, files.find(name => name.endsWith(".png"))!)), Buffer.from(png, "base64"));
    assert.match(await readFile(path.join(f.root, files.find(name => name.endsWith(".txt"))!), "utf8"), /x{50000}/);
  } finally { await managed?.stop(); await f.close(); }
});

test("cancels nested evidence requests and permits another script after abort", { timeout: 15_000 }, async () => {
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  let disconnected!: () => void;
  const closed = new Promise<void>(resolve => { disconnected = resolve; });
  const server = createServer((_request, response) => { started(); response.once("close", disconnected); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const f = await fixture("on"); let managed;
  f.options.workspaceTool = evidenceTool(`http://127.0.0.1:${address.port}`);
  try {
    f.faux.setResponses([call('return await tools.evidence_read({});'), call('return {resumed:true};', "after-abort"), fauxAssistantMessage("Resumed after cancellation.")]);
    managed = await f.runtime.start(f.options);
    const pending = managed.prompt("Read the evidence.");
    await began; await managed.session.abort(); await pending; await closed;
    await managed.prompt("Continue with another script.");
    assert.equal(managed.session.getLastAssistantText(), "Resumed after cancellation.");
  } finally { await managed?.stop(); await f.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
