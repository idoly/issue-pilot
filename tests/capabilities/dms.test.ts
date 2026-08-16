import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { ProcessToolRuntime } from "../../src/tool-runtime.ts";
import { queryDms, validateDmsQuery } from "../../src/capabilities/dms.ts";
import type { CommandExecutionOptions, CommandExecutor } from "../../src/capabilities/local-exec.ts";
import type { IssuePolicy } from "../../src/pi/policy.ts";

const response = (rows: Array<Record<string, unknown>> = [{ order_id: "4300005076", status: "ready" }], wrapped = false) => ({
  RequestId: "request-1",
  Results: [{ ColumnNames: ["order_id", "status"], Rows: wrapped ? [rows] : rows, Success: true, RowCount: rows.length }],
  Success: true,
});

test("accepts only bounded read-only DMS statements", () => {
  assert.equal(validateDmsQuery("SELECT order_id FROM orders LIMIT 100;"), "SELECT order_id FROM orders LIMIT 100");
  assert.equal(validateDmsQuery("SHOW TABLES"), "SHOW TABLES");
  assert.equal(validateDmsQuery("EXPLAIN SELECT order_id FROM orders LIMIT 10"), "EXPLAIN SELECT order_id FROM orders LIMIT 10");
  for (const statement of [
    "SELECT order_id FROM orders",
    "SELECT order_id FROM orders LIMIT 501",
    "SELECT order_id FROM orders LIMIT 0",
    "SELECT order_id FROM orders LIMIT -10",
    "SELECT order_id FROM orders LIMIT +10",
    "SELECT order_id FROM orders LIMIT 10, 20",
    "SELECT order_id FROM orders LIMIT 20 OFFSET 10",
    "SELECT 'limit 20' AS note",
    "SELECT * FROM (SELECT order_id FROM orders LIMIT 20) nested",
  ]) assert.throws(() => validateDmsQuery(statement), /dms_select_requires_bounded_limit/);
  assert.throws(() => validateDmsQuery("SELECT 'unterminated LIMIT 1"), /invalid_database_query/);
  for (const statement of [
    "UPDATE orders SET status = 'done' WHERE id = 1",
    "DELETE FROM orders WHERE id = 1",
    "SELECT SLEEP(10) LIMIT 1",
    "EXPLAIN ANALYZE SELECT * FROM orders LIMIT 1",
    "SELECT 1; SELECT 2 LIMIT 1",
  ]) assert.throws(() => validateDmsQuery(statement), /database_query_must_be/);
});

test("queries the exact frozen DMS database through the process Aliyun CLI", async () => {
  const runtime = { endpoint: "dms-enterprise.aliyuncs.com", cliRegion: "cn-hangzhou" };
  const calls: Array<{ command: string; args: string[]; cliArgs: string[]; options: CommandExecutionOptions; profileRoot: string; profile: Record<string, any>; profileMode: number }> = [];
  let output: unknown = response();
  let killed = false;
  const executor: CommandExecutor = {
    async execute(command: string, args: string[], options: CommandExecutionOptions = {}) {
      const profileRoot = options.environment!.HOME!;
      const profileFile = join(profileRoot, ".aliyun", "config.json");
      calls.push({
        command,
        args,
        cliArgs: args,
        options,
        profileRoot,
        profile: JSON.parse(await readFile(profileFile, "utf8")),
        profileMode: (await stat(profileFile)).mode & 0o777,
      });
      return { code: 0, stdout: JSON.stringify(output), stderr: "", killed };
    },
  };
  const tools = new ProcessToolRuntime(executor);
  const policy = { service: { dms: { deploymentId: "deployment-prod", dbId: "123456", logic: false, tid: "987654" } } } as IssuePolicy;
  const configured = { accessKeyId: "fixture-key", accessKeySecret: "fixture-secret", dbId: "123456", logic: false, tid: "987654" };
  const query = (statement = "SELECT order_id, status FROM orders LIMIT 20") => queryDms(tools, policy, { statement }, configured, undefined, runtime);

  const result = await query();
  assert.equal(calls[0]!.command, "aliyun");
  assert.deepEqual(calls[0]!.cliArgs, ["dms-enterprise", "ExecuteScript", "--DbId", "123456", "--Logic", "false", "--Script", "SELECT order_id, status FROM orders LIMIT 20", "--Tid", "987654", "--endpoint", "dms-enterprise.aliyuncs.com", "--secure"]);
  assert.equal(calls[0]!.options.environment!.ALIBABA_CLOUD_ORIGINAL_PRODUCT_HELP, "true");
  assert.equal(calls[0]!.options.timeout, issuePilotConfig.limits.capability.dms.executionMs);
  assert.equal(calls[0]!.profileMode, 0o600);
  assert.doesNotMatch(JSON.stringify({ args: calls[0]!.args, options: calls[0]!.options }), /fixture-key|fixture-secret/);
  await assert.rejects(stat(calls[0]!.profileRoot), /ENOENT/);
  assert.deepEqual({ mode: calls[0]!.profile.profiles[0].mode, region: calls[0]!.profile.profiles[0].region_id, accessKeyId: calls[0]!.profile.profiles[0].access_key_id }, { mode: "AK", region: "cn-hangzhou", accessKeyId: "fixture-key" });
  const body = JSON.parse(result.content[0]!.text);
  assert.deepEqual(body.query, { dbId: "123456", logic: false, tid: "987654", returnedRows: 1, possiblyIncomplete: false });
  assert.deepEqual(body.rows, [{ order_id: "4300005076", status: "ready" }]);
  assert.doesNotMatch(JSON.stringify(result.details), /fixture-key|fixture-secret/);
  assert.equal(result.details.requestId, "request-1");

  output = response([{ order_id: "4300005077", status: "wrapped" }], true);
  const wrappedBody = JSON.parse((await query()).content[0]!.text);
  assert.deepEqual(wrappedBody.rows, [{ order_id: "4300005077", status: "wrapped" }]);

  const logicalPolicy = { service: { dms: { ...policy.service.dms!, logic: true } } } as IssuePolicy;
  await queryDms(tools, logicalPolicy, { statement: "SELECT 1 LIMIT 1" }, { ...configured, logic: true }, undefined, runtime);
  assert.deepEqual(calls.at(-1)!.cliArgs.slice(2, 6), ["--DbId", "123456", "--Logic", "true"]);

  await assert.rejects(queryDms(tools, policy, { statement: "SELECT 1 LIMIT 1" }, { ...configured, dbId: "654321" }, undefined, runtime), /dms_configuration_changed/);
  await assert.rejects(queryDms(tools, policy, { statement: "SELECT 1 LIMIT 1" }, configured, undefined, { ...runtime, endpoint: "dms-enterprise.cn-hangzhou.aliyuncs.com" }), /invalid_dms_runtime/);
  killed = true;
  await assert.rejects(query(), /dms_query_failed/);
  killed = false;
  output = { ...response(), Success: false, ErrorCode: "Forbidden" };
  await assert.rejects(query(), /dms_query_failed/);
  output = { ...response(), Results: [] };
  await assert.rejects(query(), /dms_query_invalid_response/);
  output = { ...response(), Results: [{ ColumnNames: ["id"], Rows: [[{ id: 1 }], [{ id: 2 }]], Success: true, RowCount: 2 }] };
  await assert.rejects(query(), /dms_query_invalid_response/);
  output = response(Array.from({ length: issuePilotConfig.limits.capability.dms.rows + 1 }, (_, id) => ({ id })));
  await assert.rejects(query("SHOW TABLES"), /capability_result_too_large/);
});
