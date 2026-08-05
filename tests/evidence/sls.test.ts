import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { readSlsLogs } from "../../src/evidence/sls.ts";

test("runs bounded SLS reads through the secured local Aliyun CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "issue-pilot-sls-"));
  const config = join(root, ".aliyun", "config.json");
  const plugin = join(root, ".aliyun", "plugins", "aliyun-cli-sls", "aliyun-cli-sls");
  const cli = join(root, "aliyun");
  const previous = { config: process.env.ISSUE_PILOT_ALIYUN_CONFIG_FILE, cli: process.env.ISSUE_PILOT_ALIYUN_CLI };
  try {
    await mkdir(join(root, ".aliyun", "plugins", "aliyun-cli-sls"), { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(config, "{}", { mode: 0o600 }),
      writeFile(cli, "fixture", { mode: 0o755 }),
      writeFile(plugin, "fixture", { mode: 0o755 }),
    ]);
    process.env.ISSUE_PILOT_ALIYUN_CONFIG_FILE = config;
    process.env.ISSUE_PILOT_ALIYUN_CLI = cli;
    const calls: Array<{ command: string; args: string[] }> = [];
    const pi = {
      async exec(command: string, args: string[]) {
        calls.push({ command, args });
        return { code: 0, stdout: JSON.stringify([{ __time__: 1_700_000_000, message: "ready", password: "log-secret" }]), stderr: "", killed: false };
      },
    } as unknown as ExtensionAPI;
    const output = await readSlsLogs(pi, { project: "srm-test", logstore: "application_log", from: 1_700_000_000, to: 1_700_003_600, query: "level:ERROR", limit: 20 });
    assert.deepEqual(calls, [{ command: cli, args: ["sls", "get-logs", "--project", "srm-test", "--logstore", "application_log", "--from", "1700000000", "--to", "1700003600", "--query", "level:ERROR", "--line", "20", "--offset", "0", "--reverse", "true"] }]);
    assert.match(output.content[0]!.text, /ready/);
    assert.match(output.content[0]!.text, /\[REDACTED\]/);
    assert.doesNotMatch(output.content[0]!.text, /log-secret/);

    const before = Math.floor(Date.now() / 1000);
    await readSlsLogs(pi, { project: "srm-test", logstore: "application_log", trace_id: "8ea38737-7d1e-40bb-8fff-69e71bc985ab", limit: 10 });
    const traceArgs = calls[1]!.args;
    const traceFrom = Number(traceArgs[traceArgs.indexOf("--from") + 1]);
    const traceTo = Number(traceArgs[traceArgs.indexOf("--to") + 1]);
    assert.equal(traceTo - traceFrom, 24 * 60 * 60);
    assert.ok(traceTo >= before && traceTo <= Math.floor(Date.now() / 1000));
    assert.equal(traceArgs[traceArgs.indexOf("--query") + 1], "8ea38737-7d1e-40bb-8fff-69e71bc985ab");
    await assert.rejects(readSlsLogs(pi, { project: "srm-test", logstore: "application_log", trace_id: "8ea38737-7d1e-40bb-8fff-69e71bc985ab", query: "8ea38737" }), /invalid_sls_query/);
    await assert.rejects(readSlsLogs(pi, { project: "srm-test", logstore: "application_log", from: 1_700_000_000 }), /invalid_sls_time_range/);
    await assert.rejects(readSlsLogs(pi, { project: "srm-test", logstore: "application_log", from: 1_700_000_000, to: 1_700_090_000 }), /invalid_sls_time_range/);
    await assert.rejects(readSlsLogs(pi, { project: "INVALID", logstore: "application_log", from: 1_700_000_000, to: 1_700_000_100 }), /invalid_sls_project/);
    await chmod(config, 0o644);
    await assert.rejects(readSlsLogs(pi, { project: "srm-test", logstore: "application_log", from: 1_700_000_000, to: 1_700_000_100 }), /insecure_aliyun_config_file/);
  } finally {
    if (previous.config === undefined) delete process.env.ISSUE_PILOT_ALIYUN_CONFIG_FILE; else process.env.ISSUE_PILOT_ALIYUN_CONFIG_FILE = previous.config;
    if (previous.cli === undefined) delete process.env.ISSUE_PILOT_ALIYUN_CLI; else process.env.ISSUE_PILOT_ALIYUN_CLI = previous.cli;
    await rm(root, { recursive: true, force: true });
  }
});
