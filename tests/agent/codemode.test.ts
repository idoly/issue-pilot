import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager, type JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createPrivateSessionManager, PiSessionRuntime } from "../../src/agent/pi-session.ts";
import type { AgentSessionContext } from "../../src/agent/context.ts";

test("native codemode composes authorized reads, rejects writes, and restores branch storage from JSONL", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-codemode-"));
  await mkdir(join(root, "sessions"));
  await writeFile(join(root, "evidence.txt"), "private row\npublic count: 2\n");
  const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false });
  const faux = fauxProvider({ provider: "codemode-fixture", models: [{ id: "fixture", contextWindow: 64000 }], tokensPerSecond: 100000 });
  models.registerNativeProvider(faux.provider);
  const runtime = new PiSessionRuntime({ load: async () => models, close: async () => {} });
  const context: AgentSessionContext = {
    issueKey: "ISSUE-20261016-001", serviceKey: "fixture", environmentKey: "prod",
    model: { provider: "codemode-fixture", modelId: "fixture", thinkingLevel: "off" },
    capabilities: [], canModifyCode: false, canWriteOutputs: false,
  };
  const events: JsonAgentSessionEvent[] = [];
  const options = { codemode: true, context, deploymentConfig: {}, workspaceRoot: root, systemPrompt: "Use authorized tools.", onEvent: (event: JsonAgentSessionEvent) => events.push(event) };
  const manager = await createPrivateSessionManager(root, join(root, "sessions"));
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("codemode", { code: `
      const results = await Promise.all([tools.read({path: "evidence.txt"}), tools.ls({path: "."})]);
      if (typeof process !== "undefined" || typeof fetch !== "undefined" || typeof models !== "undefined") throw new Error("unexpected host access");
      if (ALL_TOOLS.some(t => ["bash", "edit", "write", "output"].includes(t.name))) throw new Error("mutation exposed");
      let denied = false;
      try { await tools.write({path: "forbidden.txt", content: "no"}); } catch { denied = true; }
      if (!denied) throw new Error("write allowed");
      store("count", results[0].split("\\n").filter(Boolean).length);
      text({count: load("count"), denied});
    ` }, { id: "script-1" }), { stopReason: "toolUse" }),
    (transcript) => {
      const result = transcript.messages.find(m => m.role === "toolResult" && m.toolCallId === "script-1");
      assert.ok(result && result.role === "toolResult");
      assert.equal(result.isError, false);
      const text = JSON.stringify(result.content);
      assert.match(text, /Script completed/);
      assert.match(text, /count/);
      assert.doesNotMatch(text, /private row/);
      return fauxAssistantMessage("Counted without exposing the rows.");
    },
    fauxAssistantMessage(fauxToolCall("codemode", { code: 'return { count: load("count") };' }, { id: "script-2" }), { stopReason: "toolUse" }),
    (transcript) => {
      const result = transcript.messages.find(m => m.role === "toolResult" && m.toolCallId === "script-2");
      assert.ok(result && result.role === "toolResult");
      assert.equal(result.isError, false);
      assert.match(result.content.map(block => block.type === "text" ? block.text : "").join("\n"), /"count"\s*:\s*2/);
      return fauxAssistantMessage("Stored count survived reopening.");
    },
  ]);
  let managed;
  try {
    managed = await runtime.start({ ...options, manager });
    await managed.prompt("Count the evidence rows");
    const nested = events.filter(e => e.type === "tool_execution_end" && e.parentToolCallId === "script-1");
    assert.equal(nested.length, 2);
    assert.ok(nested.every(e => e.type === "tool_execution_end" && !e.isError));
    assert.equal(manager.getBranch().filter(e => e.type === "message" && e.message.role === "toolResult").length, 1);
    await managed.stop();
    managed = await runtime.start({ ...options, manager: SessionManager.open(manager.getSessionFile()!) });
    await managed.prompt("Read the stored count");
    assert.equal(faux.getPendingResponseCount(), 0);
    assert.equal(managed.session.getLastAssistantText(), "Stored count survived reopening.");
  } finally {
    await managed?.stop();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
