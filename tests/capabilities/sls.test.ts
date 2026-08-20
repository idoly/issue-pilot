import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { ProcessToolRuntime } from "../../src/tool-runtime.ts";
import type { CommandExecutionOptions, CommandExecutor } from "../../src/process.ts";
import { capabilityDefinitions } from "../../src/capabilities/registry.ts";
import { readSlsLogs } from "../../src/capabilities/sls.ts";

test("exposes SLS queries without a record-count input limit", () => {
  const schema = capabilityDefinitions.sls.inputSchema as unknown as { properties: Record<string, unknown> };
  assert.equal("limit" in schema.properties, false);
});

test("returns complete SLS records through the process Aliyun CLI", async () => {
  const calls: Array<{ command: string; args: string[]; cliArgs: string[]; options: CommandExecutionOptions; profile: Record<string, any> }> = [];
  let responseRecords: unknown | ((args: string[]) => unknown) = [{ __time__: 1_700_000_000, message: "ready", password: "log-secret" }];
  const executor: CommandExecutor = {
    async execute(command: string, args: string[], options: CommandExecutionOptions = {}) {
      const profileRoot = options.environment!.HOME!;
      const profile = JSON.parse(await readFile(join(profileRoot, ".aliyun", "config.json"), "utf8"));
      const cliArgs = args;
      calls.push({ command, args, cliArgs, options, profile });
      const response = typeof responseRecords === "function" ? responseRecords(cliArgs) : responseRecords;
      return { code: 0, stdout: JSON.stringify(response), stderr: "", killed: false };
    },
  };
  const tools = new ProcessToolRuntime(executor);
  const configured = { region: "cn-test", project: "srm-test", logstores: ["application_log"], accessKeyId: "fixture-key", accessKeySecret: "fixture-secret" };
  const read = (input: Parameters<typeof readSlsLogs>[1]) => readSlsLogs(tools, input, configured);
  const output = await read({ logstore: "application_log", from: 1_700_000_000, to: 1_700_003_600, query: "level:ERROR" });
  assert.equal(calls[0]!.command, "aliyun");
  assert.equal(calls[0]!.options.environment!.ALIBABA_CLOUD_ORIGINAL_PRODUCT_HELP, "true");
  assert.doesNotMatch(JSON.stringify({ args: calls[0]!.args, options: calls[0]!.options }), /fixture-key|fixture-secret/);
  assert.deepEqual({ region_id: calls[0]!.profile.profiles[0].region_id, output_format: calls[0]!.profile.profiles[0].output_format }, { region_id: "cn-test", output_format: "json" });
  assert.deepEqual(calls[0]!.cliArgs, ["sls", "GetLogs", "--endpoint", "cn-test.log.aliyuncs.com", "--project", "srm-test", "--logstore", "application_log", "--from", "1700000000", "--to", "1700003600", "--query", "level:ERROR", "--line", "100", "--offset", "0", "--reverse", "true"]);
  const outputBody = JSON.parse(output.content[0]!.text);
  assert.deepEqual({ from: outputBody.query.from, to: outputBody.query.to, order: outputBody.query.order, returnedRows: outputBody.query.returnedRows, possiblyIncomplete: outputBody.query.possiblyIncomplete }, { from: 1_700_000_000, to: 1_700_003_600, order: "newest_first", returnedRows: 1, possiblyIncomplete: false });
  assert.equal(outputBody.records[0].message, "ready");
  assert.equal(outputBody.records[0].password, "log-secret");
  assert.match(output.content[0]!.text, /log-secret/);

  const before = Math.floor(Date.now() / 1000);
  await read({ logstore: "application_log", trace_id: "8ea38737-7d1e-40bb-8fff-69e71bc985ab" });
  const traceArgs = calls[1]!.cliArgs;
  const traceFrom = Number(traceArgs[traceArgs.indexOf("--from") + 1]);
  const traceTo = Number(traceArgs[traceArgs.indexOf("--to") + 1]);
  assert.equal(traceTo - traceFrom, 24 * 60 * 60);
  assert.ok(traceTo >= before && traceTo <= Math.floor(Date.now() / 1000));
  assert.equal(traceArgs[traceArgs.indexOf("--query") + 1], "8ea38737-7d1e-40bb-8fff-69e71bc985ab");
  await assert.rejects(read({ logstore: "application_log", trace_id: "8ea38737-7d1e-40bb-8fff-69e71bc985ab", query: "8ea38737" }), /invalid_sls_query/);
  await assert.rejects(read({ logstore: "application_log", from: 1_700_000_000 }), /invalid_sls_time_range/);
  await read({ logstore: "application_log", from: 1_700_000_000, to: 1_700_090_000 });
  await assert.rejects(read({ logstore: "other", from: 1_700_000_000, to: 1_700_000_100 }), /sls_logstore_not_granted/);

  const longMessage = "x".repeat(80_000);
  responseRecords = [{ TRACE_ID: "8ea38737-7d1e-40bb-8fff-69e71bc985ab", message: longMessage, authorization: "Bearer secret-token" }];
  const unbounded = await read({ logstore: "application_log", trace_id: "8ea38737-7d1e-40bb-8fff-69e71bc985ab" });
  const unboundedBody = JSON.parse(unbounded.content[0]!.text);
  assert.equal(unboundedBody.records[0].message.length, 80_000);
  assert.equal(unboundedBody.records[0].authorization, "Bearer secret-token");
  assert.equal("truncated" in unboundedBody.query, false);
  assert.match(unbounded.content[0]!.text, /secret-token/);

  responseRecords = (args: string[]) => {
    const offset = Number(args[args.indexOf("--offset") + 1]);
    return offset < 200 ? Array.from({ length: 100 }, (_, index) => ({ message: `page-${offset + index}` })) : offset === 200 ? [{ message: "last-page" }] : [];
  };
  const pagingCallStart = calls.length;
  const paged = await read({ logstore: "application_log", from: 1_700_000_000, to: 1_700_000_100 });
  assert.equal((JSON.parse(paged.content[0]!.text) as { records: unknown[] }).records.length, 201);
  const pagingCalls = calls.slice(pagingCallStart);
  assert.ok(pagingCalls[0]!.options.signal);
  assert.ok(pagingCalls.every(({ options }) => options.signal === pagingCalls[0]!.options.signal));
  const finalPageArgs = calls.at(-1)!.cliArgs;
  assert.equal(finalPageArgs[finalPageArgs.indexOf("--line") + 1], "100");
  assert.equal(finalPageArgs[finalPageArgs.indexOf("--offset") + 1], "200");

  responseRecords = [{ message: "x".repeat(600_000) }, { message: "y".repeat(600_000) }];
  await assert.rejects(read({ logstore: "application_log", from: 1_700_000_000, to: 1_700_000_100 }), /capability_result_too_large/);
});
