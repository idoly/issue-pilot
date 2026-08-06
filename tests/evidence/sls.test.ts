import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { readSlsLogs } from "../../src/evidence/sls.ts";
import type { IssuePolicy } from "../../src/pi/policy.ts";

test("returns complete SLS records through the secured local Aliyun CLI", async () => {
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
    const calls: Array<{ command: string; args: string[]; profile: Record<string, any> }> = [];
    let responseRecords: unknown = [{ __time__: 1_700_000_000, message: "ready", password: "log-secret" }];
    const pi = {
      async exec(command: string, args: string[]) {
        const profile = JSON.parse(await readFile(join(args[0]!, ".aliyun", "config.json"), "utf8"));
        calls.push({ command, args, profile });
        return { code: 0, stdout: JSON.stringify(responseRecords), stderr: "", killed: false };
      },
    } as unknown as ExtensionAPI;
    const policy = { service: { sls: { deploymentId: "deployment-test", region: "cn-test", project: "srm-test", logstores: ["application_log"] } } } as IssuePolicy;
    const configured = { region: "cn-test", project: "srm-test", logstores: ["application_log"], accessKeyId: "fixture-key", accessKeySecret: "fixture-secret" };
    const read = (input: Parameters<typeof readSlsLogs>[2]) => readSlsLogs(pi, policy, input, undefined, configured);
    const output = await read({ project: "srm-test", logstore: "application_log", from: 1_700_000_000, to: 1_700_003_600, query: "level:ERROR", limit: 20 });
    assert.match(calls[0]!.command, /aliyun-profile\.sh$/);
    assert.deepEqual({ region_id: calls[0]!.profile.profiles[0].region_id, output_format: calls[0]!.profile.profiles[0].output_format }, { region_id: "cn-test", output_format: "json" });
    assert.deepEqual(calls[0]!.args.slice(2), ["sls", "get-logs", "--endpoint", "cn-test.log.aliyuncs.com", "--project", "srm-test", "--logstore", "application_log", "--from", "1700000000", "--to", "1700003600", "--query", "level:ERROR", "--line", "20", "--offset", "0", "--reverse", "true"]);
    const outputBody = JSON.parse(output.content[0]!.text);
    assert.deepEqual({ from: outputBody.query.from, to: outputBody.query.to, order: outputBody.query.order, returnedRows: outputBody.query.returnedRows, truncated: outputBody.query.truncated }, { from: 1_700_000_000, to: 1_700_003_600, order: "newest_first", returnedRows: 1, truncated: false });
    assert.equal(outputBody.records[0].message, "ready");
    assert.equal(outputBody.records[0].password, "log-secret");
    assert.match(output.content[0]!.text, /log-secret/);

    const before = Math.floor(Date.now() / 1000);
    await read({ project: "srm-test", logstore: "application_log", trace_id: "8ea38737-7d1e-40bb-8fff-69e71bc985ab", limit: 10 });
    const traceArgs = calls[1]!.args;
    const traceFrom = Number(traceArgs[traceArgs.indexOf("--from") + 1]);
    const traceTo = Number(traceArgs[traceArgs.indexOf("--to") + 1]);
    assert.equal(traceTo - traceFrom, 24 * 60 * 60);
    assert.ok(traceTo >= before && traceTo <= Math.floor(Date.now() / 1000));
    assert.equal(traceArgs[traceArgs.indexOf("--query") + 1], "8ea38737-7d1e-40bb-8fff-69e71bc985ab");
    await assert.rejects(read({ project: "srm-test", logstore: "application_log", trace_id: "8ea38737-7d1e-40bb-8fff-69e71bc985ab", query: "8ea38737" }), /invalid_sls_query/);
    await assert.rejects(read({ project: "srm-test", logstore: "application_log", from: 1_700_000_000 }), /invalid_sls_time_range/);
    await read({ project: "srm-test", logstore: "application_log", from: 1_700_000_000, to: 1_700_090_000 });
    await assert.rejects(read({ project: "INVALID", logstore: "application_log", from: 1_700_000_000, to: 1_700_000_100 }), /invalid_sls_project/);

    const longMessage = "x".repeat(80_000);
    responseRecords = [{ TRACE_ID: "8ea38737-7d1e-40bb-8fff-69e71bc985ab", message: longMessage, authorization: "Bearer secret-token" }];
    const unbounded = await read({ project: "srm-test", logstore: "application_log", trace_id: "8ea38737-7d1e-40bb-8fff-69e71bc985ab", limit: 100 });
    const unboundedBody = JSON.parse(unbounded.content[0]!.text);
    assert.equal(unboundedBody.records[0].message.length, 80_000);
    assert.equal(unboundedBody.records[0].authorization, "Bearer secret-token");
    assert.equal(unboundedBody.query.truncated, false);
    assert.match(unbounded.content[0]!.text, /secret-token/);

    await chmod(config, 0o644);
    await assert.rejects(read({ project: "srm-test", logstore: "application_log", from: 1_700_000_000, to: 1_700_000_100 }), /insecure_aliyun_config_file/);
  } finally {
    if (previous.config === undefined) delete process.env.ISSUE_PILOT_ALIYUN_CONFIG_FILE; else process.env.ISSUE_PILOT_ALIYUN_CONFIG_FILE = previous.config;
    if (previous.cli === undefined) delete process.env.ISSUE_PILOT_ALIYUN_CLI; else process.env.ISSUE_PILOT_ALIYUN_CLI = previous.cli;
    await rm(root, { recursive: true, force: true });
  }
});
