import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { openApplicationDatabase } from "../../src/db/bootstrap.ts";
import { globalAgentConfiguration } from "../../src/db/schema.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { applyFileConfiguration } from "../../src/configuration/file-configuration.ts";

const execute = promisify(execFile);

test("offline preparation converts legacy users and sources into usable v2 files without changing the input", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-configuration-preparation-"));
  const source = path.join(root, "source"), output = path.join(root, "output");
  await mkdir(source);
  const database = await openApplicationDatabase(path.join(source, "issues.db"));
  try {
    await database.db.insert(globalAgentConfiguration).values({ id: 1, provider: "fixture", model: "fixture", thinkingLevel: "medium" });
    const user = stringify({ version: 1, user: { subject: issuePilotConfig.bootstrapUser.subject }, apiKeys: { fixture: "private-fixture-key" }, dingtalk: { apiKey: "private-gateway-key" } });
    const service = stringify({ version: 1, sources: { dingtalk: { mcp: "dingtalk", url: "https://alidocs.dingtalk.com/i/nodes/base?sheetId=table", assignee: "Fixture" } } });
    await writeFile(path.join(source, "user.yaml"), user, { mode: 0o600 });
    await writeFile(path.join(source, "service.yaml"), service, { mode: 0o600 });
    const args = ["--experimental-strip-types", "scripts/prepare-configuration.ts", "--state-root", source, "--output", output, "--subject", issuePilotConfig.bootstrapUser.subject];
    const prepared = await execute(process.execPath, args);
    assert.doesNotMatch(prepared.stdout + prepared.stderr, /private-fixture-key|private-gateway-key/);
    const generatedUser = parse(await readFile(path.join(output, "user.yaml"), "utf8"));
    const generatedService = parse(await readFile(path.join(output, "service.yaml"), "utf8"));
    assert.equal(generatedUser.version, 2);
    assert.equal(generatedService.version, 2);
    assert.equal(generatedService.sources, undefined);
    assert.equal(generatedUser.users[issuePilotConfig.bootstrapUser.subject].apiKeys.fixture, "private-fixture-key");
    assert.equal(generatedUser.users[issuePilotConfig.bootstrapUser.subject].dingtalk.source.assignee, "Fixture");
    assert.equal(generatedUser.users[issuePilotConfig.bootstrapUser.subject].dingtalk.apiKey, undefined);
    assert.equal(generatedUser.shared.dingtalk.apiKey, "private-gateway-key");
    assert.equal(await readFile(path.join(source, "user.yaml"), "utf8"), user);
    assert.equal(await readFile(path.join(source, "service.yaml"), "utf8"), service);
    const projected = await openApplicationDatabase(path.join(output, "issues.db"));
    try {
      const state = await applyFileConfiguration(projected.db, output);
      assert.deepEqual(state.userSubjects, [issuePilotConfig.bootstrapUser.subject]);
    } finally { projected.close(); }
    await assert.rejects(execute(process.execPath, args), error => error instanceof Error && "stderr" in error && /configuration_preparation_failed/.test(String(error.stderr)));
    assert.deepEqual(parse(await readFile(path.join(output, "user.yaml"), "utf8")), generatedUser);
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
