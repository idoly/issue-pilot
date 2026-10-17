import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPiModelRuntime } from "../../src/pi/models.ts";

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
