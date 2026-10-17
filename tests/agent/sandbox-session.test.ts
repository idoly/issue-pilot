import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { PiSessionRuntime, createPrivateSessionManager } from "../../src/agent/pi-session.ts";
import { IssueOutputStore } from "../../src/outputs/store.ts";
import { executeLocalCommand } from "../../src/process.ts";
import { PodmanSandbox } from "../../src/sandbox/runtime.ts";

const available = process.platform === "linux" && process.getuid?.() !== 0 && await executeLocalCommand("podman", ["image", "exists", issuePilotConfig.runtime.sandbox.image], { timeout: 5000 }).then(result => !result.code, () => false);

test("SDK Agent imports query data, calculates in a real sandbox, publishes output, and recreates scratch next round", { skip: !available && "requires rootless Podman and the configured local sandbox image" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-sdk-sandbox-"));
  await mkdir(join(root, "sessions"));
  const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false });
  const faux = fauxProvider({ provider: "sandbox-fixture", models: [{ id: "fixture", contextWindow: 64000 }], tokensPerSecond: 100000 });
  models.registerNativeProvider(faux.provider);
  const created: PodmanSandbox[] = [];
  const runtime = new PiSessionRuntime({ load: async () => models, close: async () => {} }, async signal => { const sandbox = await PodmanSandbox.open(signal); created.push(sandbox); return sandbox; });
  const manager = await createPrivateSessionManager(root, join(root, "sessions"));
  const outputs = new IssueOutputStore(root, "ISSUE-20261017-001");
  await outputs.write("batch.json", JSON.stringify([{ privateMarker: "synthetic-hidden-row", amount: 17 }, { amount: 25 }]));
  const call = (operation: string, data: Record<string, unknown> = {}) => fauxAssistantMessage(fauxToolCall("sandbox", { operation, ...data }), { stopReason: "toolUse" });
  faux.setResponses([
    call("import_output", { fileName: "batch.json" }),
    call("run", { command: "node -e 'const fs=require(\"fs\");fs.writeFileSync(\"result.json\",JSON.stringify({sum:require(\"./batch.json\").reduce((s,x)=>s+x.amount,0)}))'" }),
    call("export_output", { fileName: "result.json" }),
    transcript => { assert.ok(!JSON.stringify(transcript).includes("synthetic-hidden-row")); return fauxAssistantMessage("Delivered result.json."); },
    call("run", { command: "test ! -e /work/result.json && test ! -e /work/batch.json" }),
    fauxAssistantMessage("Fresh scratch confirmed."),
  ]);
  let managed;
  try {
    managed = await runtime.start({ manager, context: { issueKey: "ISSUE-20261017-001", serviceKey: "fixture", environmentKey: "prod", model: { provider: "sandbox-fixture", modelId: "fixture", thinkingLevel: "off" }, capabilities: [], canModifyCode: false, canWriteOutputs: true }, deploymentConfig: {}, workspaceRoot: root, outputStore: outputs, systemPrompt: "Use tools and publish the requested result.", onEvent: () => {} });
    assert.ok(managed.session.getActiveToolNames().includes("sandbox"));
    assert.ok(!managed.session.getActiveToolNames().includes("codemode"));
    await managed.prompt("Sum the saved query data and deliver result.json.");
    assert.deepEqual(JSON.parse((await outputs.read("result.json")).toString()), { sum: 42 });
    assert.equal(managed.session.getLastAssistantText(), "Delivered result.json.");
    assert.equal(created.length, 1); assert.ok(created[0]!.closed);
    assert.ok(!(await readFile(manager.getSessionFile()!, "utf8")).includes("synthetic-hidden-row"));
    await managed.prompt("Confirm this round starts with fresh scratch.");
    assert.equal(managed.session.getLastAssistantText(), "Fresh scratch confirmed.");
    assert.equal(created.length, 2); assert.ok(created[1]!.closed);
    await managed.stop(); await managed.stop();
    assert.deepEqual(JSON.parse((await outputs.read("result.json")).toString()), { sum: 42 });
    assert.equal(faux.getPendingResponseCount(), 0);
  } finally { await managed?.stop(); await Promise.all(created.map(sandbox => sandbox.close())); await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
