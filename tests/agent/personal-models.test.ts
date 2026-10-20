import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPiModelRuntime } from "../../src/agent/model-runtime.ts";
import { createPrivateSessionManager, PiSessionRuntime } from "../../src/agent/pi-session.ts";

test("personal model runtimes isolate API keys from other users and operator auth", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-personal-model-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "test-provider": { type: "api_key", key: "operator-key" } }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "test-provider": { baseUrl: "https://example.test/v1", api: "openai-responses", apiKey: "operator-model-key", models: [{ id: "model", name: "Model", reasoning: true, input: ["text"], contextWindow: 64000, maxTokens: 8000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  const a = createPiModelRuntime(agentDir, { provider: "test-provider", apiKey: "alice-key" });
  const b = createPiModelRuntime(agentDir, { provider: "test-provider", apiKey: "bob-key" });
  try {
    const ar = await a.load();
    const br = await b.load();
    assert.notEqual(ar, br);
    assert.ok(JSON.stringify(await ar.getAuth("test-provider")).includes("alice-key"));
    assert.ok(JSON.stringify(await br.getAuth("test-provider")).includes("bob-key"));
    assert.equal(JSON.stringify(await ar.getAuth("test-provider")).includes("operator-key"), false);
    await a.close();
    assert.ok(JSON.stringify(await br.getAuth("test-provider")).includes("bob-key"));
  } finally { await a.close(); await b.close(); await rm(root, { recursive: true, force: true }); }
});

test("personal model requests omit provider and model Operator headers", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-personal-headers-"));
  const agent = join(root, "operator"), work = join(root, "work"), sessions = join(root, "sessions");
  await Promise.all([mkdir(agent), mkdir(work), mkdir(sessions)]);
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { "test-provider": {
    baseUrl: "https://example.test/v1", api: "openai-responses", apiKey: "operator-key",
    headers: { "X-Operator-Token": "operator-token" },
    models: [{ id: "model", name: "Model", reasoning: false, input: ["text"], contextWindow: 64000, maxTokens: 8000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, headers: { "X-Model-Token": "operator-model-token" } }],
  } } }));
  const personal = createPiModelRuntime(agent, { provider: "test-provider", apiKey: "personal-key" });
  const runtime = new PiSessionRuntime(personal), originalFetch = globalThis.fetch;
  let headers: Headers | undefined;
  let managed: Awaited<ReturnType<PiSessionRuntime["start"]>> | undefined;
  try {
    globalThis.fetch = async (input, init) => {
      headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      throw new Error("fixture_transport_stopped");
    };
    managed = await runtime.start({ manager: await createPrivateSessionManager(work, sessions), workspaceRoot: work,
      context: { issueKey: "ISSUE-20261020-991", serviceKey: "test", environmentKey: "prod", codemode: "off",
        model: { provider: "test-provider", modelId: "model", thinkingLevel: "off" }, capabilities: [], canModifyCode: false, canWriteOutputs: false },
      deploymentConfig: {}, systemPrompt: "Fixture", runtime: { settings: { retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" } },
      modelResponseIdleMs: 2000, onEvent() {},
    });
    await managed.prompt("Reply briefly.").catch(() => undefined);
    assert.ok(headers, "the actual SDK request must be observed");
    assert.equal(headers.get("authorization"), "Bearer personal-key");
    assert.equal(headers.has("X-Operator-Token"), false);
    assert.equal(headers.has("X-Model-Token"), false);
  } finally {
    await managed?.stop(); await runtime.close(); await personal.close(); globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
