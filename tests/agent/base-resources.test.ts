import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createPrivateSessionManager, PiSessionRuntime } from "../../src/agent/pi-session.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-base-resources-"));
  await mkdir(path.join(root, "sessions"));
  const models = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null, modelsStorePath: path.join(root, "models.json"), refreshOnCreate: false });
  const faux = fauxProvider({ provider: "base-fixture", models: [{ id: "fixture", contextWindow: 64000 }], tokensPerSecond: 100000 }); models.registerNativeProvider(faux.provider);
  const runtime = new PiSessionRuntime({ load: async () => models, close: async () => {} });
  const manager = await createPrivateSessionManager(root, path.join(root, "sessions"));
  const options = { agentDirectory: root, manager, workspaceRoot: root, context: { issueKey: "ISSUE-20261017-001", serviceKey: "fixture", environmentKey: "prod", codemode: "on" as const, model: { provider: "base-fixture", modelId: "fixture", thinkingLevel: "off" as const }, capabilities: [], canModifyCode: false }, deploymentConfig: {}, systemPrompt: "Issue policy stays present.", onEvent: () => {} };
  return { root, options, faux, runtime, close: async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); } };
}

test("applies Pi settings, expands configured templates/skills, enables extension tools and runs shutdown cleanup", async () => {
  const f = await fixture(); let managed;
  try {
    const skill = path.join(f.root, "skills", "example-skill"); await mkdir(skill, { recursive: true });
    await mkdir(path.join(f.root, "prompts")); await mkdir(path.join(f.root, "extensions"));
    await writeFile(path.join(f.root, "APPEND_SYSTEM.md"), "Additional base instructions marker.");
    await writeFile(path.join(skill, "SKILL.md"), "---\nname: example-skill\ndescription: Inspect example evidence.\n---\nLoaded skill body marker.\n");
    const prompt = path.join(f.root, "prompts", "audit.md"); await writeFile(prompt, "---\ndescription: Audit a target\n---\nAudit target: $1\n");
    const extension = path.join(f.root, "extensions", "extension.ts"), started = path.join(f.root, "started"), ended = path.join(f.root, "ended");
    await writeFile(extension, `import { Type } from 'typebox'; import { writeFileSync } from 'node:fs';
export default pi => {
  pi.on('session_start', () => { writeFileSync(${JSON.stringify(started)}, 'started'); });
  pi.on('session_shutdown', () => { writeFileSync(${JSON.stringify(ended)}, 'ended'); });
  pi.registerTool({ name:'example_echo',label:'Example',description:'Return example evidence.',parameters:Type.Object({}),execute:async()=>({content:[{type:'text',text:'extension evidence'}],details:undefined}) });
  pi.registerTool({ name:'example_deferred',label:'Deferred',description:'Read deferred evidence.',exposure:'codemode',parameters:Type.Object({}),execute:async()=>({content:[{type:'text',text:'deferred evidence'}],details:undefined}) });
}`);
    const base = { settings: { compaction: { enabled: false, reserveTokens: 2000 }, retry: { enabled: true, maxRetries: 2 }, shellPath: "/bin/bash", shellCommandPrefix: "export BASE_PREFIX='enabled-by-base';", cacheWarming: "off" as const, codemode: { inlineBudget: 900 } } };
    f.faux.setResponses([
      context => { const text = JSON.stringify(context); assert.match(text, /Audit target: two words/); assert.match(text, /Managed Issue context/); assert.match(text, /Issue policy stays present/); assert.match(text, /Additional base instructions marker/); return fauxAssistantMessage(fauxToolCall("example_echo", {}), { stopReason: "toolUse" }); },
      fauxAssistantMessage(fauxToolCall("bash", { command: "printf '%s' \"$BASE_PREFIX\"" }), { stopReason: "toolUse" }),
      context => { assert.match(JSON.stringify(context), /extension evidence/); assert.match(JSON.stringify(context), /enabled-by-base/); return fauxAssistantMessage("Resources verified."); },
      context => { assert.match(JSON.stringify(context), /Loaded skill body marker/); return fauxAssistantMessage("Skill command expanded."); },
      fauxAssistantMessage(fauxToolCall("codemode", { code: "return await tools.example_deferred({});" }), { stopReason: "toolUse" }),
      context => { assert.match(JSON.stringify(context), /deferred evidence/); return fauxAssistantMessage("Deferred tool called."); },
    ]);
    managed = await f.runtime.start({ ...f.options, runtime: base });
    assert.equal(await readFile(started, "utf8"), "started");
    assert.ok(managed.session.getActiveToolNames().includes("example_echo"));
    assert.equal(managed.session.getActiveToolNames().includes("example_deferred"), false);
    assert.ok(managed.session.getCallableToolNames().includes("example_deferred"));
    assert.match(managed.session.systemPrompt, /example-skill/);
    assert.equal(managed.session.settingsManager.getCompactionSettings().enabled, false);
    assert.equal(managed.session.settingsManager.getRetrySettings().maxRetries, 2);
    assert.equal(managed.session.settingsManager.getSettings().codemode?.inlineBudget, 900);
    await managed.prompt("Managed Issue context.", [], '/audit "two words"'); assert.equal(managed.session.getLastAssistantText(), "Resources verified.");
    await managed.prompt("Managed Issue context.", [], "/skill:example-skill inspect"); assert.equal(managed.session.getLastAssistantText(), "Skill command expanded.");
    await managed.prompt("Read the deferred capability."); assert.equal(managed.session.getLastAssistantText(), "Deferred tool called.");
    await managed.stop(); await managed.stop(); assert.equal(await readFile(ended, "utf8"), "ended");
  } finally { await managed?.stop(); await f.close(); }
});

test("loads global Pi instructions and settings without executing Issue-local extensions", async () => {
  const f = await fixture(); let managed;
  try {
    const global = path.join(f.root, "global-pi"), work = path.join(f.root, "issue-work");
    await mkdir(global); await mkdir(path.join(work, ".pi", "extensions"), { recursive: true });
    await writeFile(path.join(global, "AGENTS.md"), "Global user instructions marker.");
    await writeFile(path.join(global, "settings.json"), JSON.stringify({ shellPath: "/bin/bash", retry: { enabled: false } }));
    await writeFile(path.join(work, ".pi", "extensions", "untrusted.ts"), "export default () => { throw new Error('issue-local-extension-must-not-run'); };\n");
    f.faux.setResponses([context => {
      assert.match(JSON.stringify(context), /Global user instructions marker/);
      return fauxAssistantMessage("Global resources verified.");
    }]);
    managed = await f.runtime.start({ ...f.options, agentDirectory: global, workspaceRoot: work });
    assert.equal(managed.session.settingsManager.getRetrySettings().enabled, false);
    await managed.prompt("Read the global instructions.");
    assert.equal(managed.session.getLastAssistantText(), "Global resources verified.");
  } finally { await managed?.stop(); await f.close(); }
});

test("reports extension loading and protected tool conflicts without leaking extension errors", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.root, "extensions"));
    const broken = path.join(f.root, "extensions", "broken.ts"); await writeFile(broken, "export default () => { throw new Error('private-extension-error'); };\n");
    await assert.rejects(f.runtime.start(f.options), { message: "agent_extension_load_failed" });
    await rm(broken);
    const conflict = path.join(f.root, "extensions", "conflict.ts"); await writeFile(conflict, "import { Type } from 'typebox'; export default pi => pi.registerTool({name:'service_query',label:'Conflict',description:'Conflict',parameters:Type.Object({}),execute:async()=>({content:[],details:undefined})});\n");
    await assert.rejects(f.runtime.start(f.options), { message: "agent_extension_tool_conflict" });
  } finally { await f.close(); }
});
