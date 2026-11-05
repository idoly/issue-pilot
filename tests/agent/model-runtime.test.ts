import assert from "node:assert/strict";
import fs, { access, chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { createPiModelRuntime, PiAgentModelCatalog, type PiModelRuntime } from "../../src/agent/model-runtime.ts";
import { errorChain } from "../../src/diagnostics.ts";

for (const cleanupFails of [false, true]) {
  test(`model initialization retains its private directory until cleanup succeeds (initial cleanup failure: ${cleanupFails})`, async (context) => {
    const agentDir = await mkdtemp(join(tmpdir(), "issue-pilot-runtime-cleanup-"));
    const primary = new Error("fixture_model_initialization_failed");
    const cleanup = Object.assign(new Error("fixture_private_directory_cleanup_failed"), { code: "EACCES" });
    const runtime = createPiModelRuntime(agentDir);
    const remove = fs.rm;
    const makeTemporary = fs.mkdtemp;
    let directory: string | undefined;
    let removals = 0;
    context.mock.method(fs, "mkdtemp", async (prefix: string) => {
      directory = await makeTemporary(prefix);
      return directory;
    });
    context.mock.method(ModelRuntime, "create", async () => {
      throw primary;
    });
    context.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      if (args[0] === directory) {
        removals++;
        if (cleanupFails && removals === 1) throw cleanup;
      }
      return remove(...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(runtime.load(), (error) => {
        if (!cleanupFails) assert.equal(error, primary);
        else {
          assert.ok(errorChain(error).includes(primary));
          assert.ok(errorChain(error).includes(cleanup));
        }
        return true;
      });
      assert.ok(directory);
      if (cleanupFails) await access(directory);
      await Promise.all([runtime.close(), runtime.close()]);
      assert.equal(removals, cleanupFails ? 2 : 1);
      await assert.rejects(access(directory), { code: "ENOENT" });
      await assert.rejects(runtime.load(), /pi_model_runtime_closed/);
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
      await runtime.close();
      if (directory) await remove(directory, { recursive: true, force: true });
      await remove(agentDir, { recursive: true, force: true });
    }
  });
}

function model(provider: string, id: string): Model<"openai-responses"> {
  return {
    provider,
    id,
    name: id,
    api: "openai-responses",
    baseUrl: "https://example.test/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 64_000,
    maxTokens: 8_000,
  };
}

test("shares one offline Pi catalog refresh and lists every model of the Operator models.json providers", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "issue-pilot-catalog-"));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "a-provider": {}, "z-provider": {} } }));
  const refreshes: unknown[] = [];
  const runtime = {
    async refresh(options: unknown) {
      refreshes.push(options);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { aborted: false, errors: new Map() };
    },
    // Availability depends on host authentication, which no longer selects candidates.
    getModels() {
      return [model("z-provider", "second"), model("built-in", "unlisted"), model("a-provider", "first")];
    },
  } as unknown as ModelRuntime;
  const sharedRuntime: PiModelRuntime = {
    async load() {
      return runtime;
    },
    async close() {},
  };
  const catalog = new PiAgentModelCatalog(sharedRuntime, agentDir);

  const [first, second] = await Promise.all([catalog.list(), catalog.list()]);

  assert.deepEqual(refreshes, [{ allowNetwork: false }]);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map(({ provider, id, contextWindow }) => ({ provider, id, contextWindow })),
    [
      { provider: "a-provider", id: "first", contextWindow: 64_000 },
      { provider: "z-provider", id: "second", contextWindow: 64_000 },
    ],
  );
  assert.ok(first.every(({ thinkingLevels }) => thinkingLevels.includes("off") && thinkingLevels.includes("high")));

  await catalog.list();
  assert.deepEqual(refreshes, [{ allowNetwork: false }, { allowNetwork: false }]);
  await rm(agentDir, { recursive: true, force: true });
});

test("refreshes models without writing to the read-only Pi configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-models-"));
  const agentDir = join(root, "agent");
  const runtime = createPiModelRuntime(agentDir);
  try {
    await mkdir(agentDir, { mode: 0o700 });
    await Promise.all([
      writeFile(join(agentDir, "auth.json"), "{}\n", { mode: 0o600 }),
      writeFile(join(agentDir, "models-store.json"), "{}\n", { mode: 0o600 }),
      writeFile(
        join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            "test-provider": {
              baseUrl: "https://example.test/v1",
              api: "openai-responses",
              apiKey: "test-key",
              models: [
                {
                  id: "test-model",
                  name: "Test Model",
                  reasoning: true,
                  input: ["text"],
                  contextWindow: 64_000,
                  maxTokens: 8_000,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        }),
        { mode: 0o400 },
      ),
    ]);
    await Promise.all([chmod(join(agentDir, "auth.json"), 0o400), chmod(join(agentDir, "models-store.json"), 0o400), chmod(agentDir, 0o500)]);

    const [first, second] = await Promise.all([runtime.load(), runtime.load()]);
    assert.equal(first, second);
    const refreshed = await first.refresh({ allowNetwork: false });

    assert.equal(refreshed.errors.size, 0);
    assert.deepEqual(
      first.getModels("test-provider").map(({ provider, id }) => ({ provider, id })),
      [{ provider: "test-provider", id: "test-model" }],
    );
    assert.deepEqual((await readdir(agentDir)).sort(), ["auth.json", "models-store.json", "models.json"]);
  } finally {
    await runtime.close();
    await chmod(agentDir, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
  await assert.rejects(runtime.load(), /pi_model_runtime_closed/);
});
