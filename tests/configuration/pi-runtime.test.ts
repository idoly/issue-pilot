import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inspectAgentResources, parseAgentRuntime } from "../../src/configuration/pi-runtime.ts";

test("validates supported Pi fields against the installed SDK schema and rejects conflicting owners", () => {
  const runtime = { settings: { compaction: { enabled: false, keepRecentTokens: 8000 }, retry: { enabled: true, maxRetries: 2 }, shellPath: "/bin/bash", images: { autoResize: true }, cacheWarming: "off", codemode: { inlineBudget: 600 } } };
  assert.deepEqual(parseAgentRuntime(runtime), runtime);
  assert.deepEqual(parseAgentRuntime({ networkAllowedDomains: ["db.example.test:3306", "repo.example.test:443"] }), { networkAllowedDomains: ["db.example.test:3306", "repo.example.test:443"] });
  for (const networkAllowedDomains of [["*"], ["http://example.test"], ["example.test:0"], [9]]) assert.throws(() => parseAgentRuntime({ networkAllowedDomains }), /invalid_agent_runtime_configuration/);
  for (const settings of [{ defaultModel: "other" }, { defaultTools: ["bash"] }, { sessionDir: "/other" }, { extensions: ["/other"] }, { codemode: { mode: "only" } }, { retry: { maxRetries: -1 } }, { retry: { enabled: "yes" } }, { retry: { unsupported: true } }, { unknown: true }, { retry: { maxDelayMs: 1000 } }]) {
    assert.throws(() => parseAgentRuntime({ settings }), /invalid_agent_runtime_configuration/);
  }
  assert.throws(() => parseAgentRuntime({ skills: ["/custom"] }), /invalid_agent_runtime_configuration/);
  assert.throws(() => parseAgentRuntime({ extensions: ["/custom"] }), /invalid_agent_runtime_configuration/);
  assert.throws(() => parseAgentRuntime({ instructions: "x".repeat(50_001) }), /invalid_agent_runtime_configuration/);
});

test("previews native skills and prompt metadata without executing extension code", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-base-preview-"));
  try {
    const skill = path.join(root, "skills", "example-skill"); await mkdir(skill, { recursive: true });
    await mkdir(path.join(root, "prompts")); await mkdir(path.join(root, "extensions"));
    await writeFile(path.join(skill, "SKILL.md"), "---\nname: example-skill\ndescription: Inspect synthetic evidence.\n---\nFollow the example skill.\n");
    const prompt = path.join(root, "prompts", "audit.md"); await writeFile(prompt, "---\ndescription: Audit the supplied target\n---\nAudit $1.\n");
    const sentinel = path.join(root, "extension-executed");
    const extension = path.join(root, "extensions", "extension.ts"); await writeFile(extension, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'unexpected'); export default () => {};`);
    const result = await inspectAgentResources(root);
    assert.equal(result.skills[0]?.name, "example-skill"); assert.equal(result.prompts[0]?.name, "audit"); assert.deepEqual(result.extensions, [extension]);
    await assert.rejects(readFile(sentinel), { code: "ENOENT" });
    assert.deepEqual((await inspectAgentResources(path.join(root, "missing"))).skills, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
