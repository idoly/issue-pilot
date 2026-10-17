import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager, type JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { PiSessionRuntime, createPrivateSessionManager } from "../../src/agent/pi-session.ts";
import type { AgentSessionContext } from "../../src/agent/context.ts";
import { sessionTranscript } from "../../src/agent/events.ts";

const context: AgentSessionContext = {
  issueKey: "ISSUE-20261016-004", serviceKey: "fixture", environmentKey: "prod",
  model: { provider: "sdk-fixture", modelId: "sdk-model", thinkingLevel: "medium" },
  capabilities: [], canModifyCode: false, canWriteOutputs: false,
};

test("SDK 1.3 replays persistent sessions with current tools and canonical prompts without restoring obsolete tools", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-sdk-lifecycle-"));
  await mkdir(path.join(root, "sessions"));
  await writeFile(path.join(root, "evidence.txt"), "verified evidence\n");
  const models = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null, modelsStorePath: path.join(root, "models-store.json"), refreshOnCreate: false });
  const faux = fauxProvider({ provider: "sdk-fixture", models: [{ id: "sdk-model", reasoning: true, contextWindow: 64000 }], tokensPerSecond: 100000 });
  models.registerNativeProvider(faux.provider);
  const runtime = new PiSessionRuntime({ load: async () => models, close: async () => {} });
  const manager = await createPrivateSessionManager(root, path.join(root, "sessions"));
  const events: JsonAgentSessionEvent[] = [];
  let prompts = 0;
  faux.setResponses([
    (transcript) => {
      const serialized = JSON.stringify(transcript);
      assert.ok(serialized.includes("Issue Pilot SDK policy"));
      prompts += 1;
      return fauxAssistantMessage(fauxToolCall("read", { path: "evidence.txt" }, { id: "read-1" }), { stopReason: "toolUse" });
    },
    (transcript) => {
      assert.ok(JSON.stringify(transcript).includes("verified evidence"));
      return fauxAssistantMessage("Verified the file.");
    },
    (transcript) => {
      assert.ok(JSON.stringify(transcript).includes("Verified the file."));
      return fauxAssistantMessage("Resumed correctly.");
    },
  ]);
  try {
    const first = await runtime.start({ manager, context, deploymentConfig: {}, workspaceRoot: root, systemPrompt: "Issue Pilot SDK policy", onEvent: (event) => events.push(event) });
    await first.prompt("Check the evidence");
    assert.equal(prompts, 1);
    assert.ok(events.some((event) => event.type === "agent_settled" && event.aborted === false));
    const ended = events.find((event) => event.type === "tool_execution_end");
    assert.ok(ended?.type === "tool_execution_end" && typeof ended.durationMs === "number");
    await first.stop();
    const persisted = manager.getSessionFile()!;
    // Simulate an earlier development session declaring mutation tools; explicit
    // current-context selection must override the transcript on read-only resume.
    manager.appendMessage({ role: "system", content: "", toolsAdded: [{ name: "bash", description: "old writable tool", parameters: {} }], timestamp: Date.now() });
    const reopened = SessionManager.open(persisted);
    const resumed = await runtime.start({ manager: reopened, context, deploymentConfig: {}, workspaceRoot: root, systemPrompt: "Issue Pilot SDK policy", onEvent: (event) => events.push(event) });
    assert.deepEqual(resumed.session.getActiveToolNames().sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
    await resumed.prompt("Continue after reopening");
    await resumed.stop();
    const replay = sessionTranscript(SessionManager.open(persisted), "issue");
    assert.ok(JSON.stringify(replay).includes("Resumed correctly."));
    assert.equal(replay.some(({ event }) => event.type === "message_end" && event.message.role === "system"), false);
    assert.ok((await readFile(persisted, "utf8")).includes('"version":3'));
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
