import assert from "node:assert/strict";
import { readFile, stat, access } from "node:fs/promises";
import { test } from "node:test";
import type { CommandExecutor } from "../../src/process.ts";
import { prepareSlsQuery, readSlsLogs } from "../../src/capabilities/sls.ts";
import { slsFailureCode } from "../../src/capabilities/sls-errors.ts";
import { capabilityDefinitions } from "../../src/capabilities/registry.ts";

const configured = { region: "cn-test", project: "srm-test", logstores: ["application_log"], accessKeyId: "fixture-key", accessKeySecret: "fixture-secret" };
const base = { logstore: "application_log", from: 1_700_000_000, to: 1_700_003_600 };
function fixture(pages: unknown[]) {
  const calls: Array<{ args: string[]; body: Record<string, unknown>; configPath: string }> = [];
  const executor: CommandExecutor = { async execute(command, args, options) {
    assert.equal(command, "aliyun"); assert.deepEqual(args.slice(0, 2), ["sls", "GetLogsV2"]);
    const configPath = args[args.indexOf("--config-path") + 1]!;
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    const profile = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(profile.profiles[0].access_key_id, configured.accessKeyId);
    assert.equal(profile.profiles[0].access_key_secret, configured.accessKeySecret);
    assert.doesNotMatch(JSON.stringify(args), /fixture-key|fixture-secret/);
    assert.equal(options?.environment?.HOME, configPath.slice(0, configPath.lastIndexOf("/")));
    assert.equal(options?.environment?.ALIBABA_CLOUD_ACCESS_KEY_ID, undefined);
    assert.equal(args[args.indexOf("--retry-count") + 1], "0");
    const body = JSON.parse(args[args.indexOf("--body") + 1]!);
    calls.push({ args, body, configPath });
    const page = pages.shift();
    if (page instanceof Error) return { code: 1, killed: false, stdout: "", stderr: page.message };
    return { code: 0, killed: false, stdout: JSON.stringify(page), stderr: "" };
  } };
  return { executor, calls };
}
const page = (data: unknown[], meta: Record<string, unknown> = {}) => ({ data, meta: { progress: "Complete", hasSQL: false, mode: 0, ...meta } });

test("aliyun sls paginates complete results and keeps credentials out of argv, results and the host profile", async () => {
  const f = fixture([page(Array.from({ length: 100 }, (_, i) => ({ message: String(i) }))), page([{ message: "last", password: "business-value" }])]);
  const result = await readSlsLogs(base, configured, undefined, f.executor);
  const output = JSON.parse(result.content[0]!.text);
  assert.equal(output.records.length, 101);
  assert.equal(output.records[100].password, "business-value");
  assert.equal(result.details.provider, "aliyun-sls-cli");
  assert.deepEqual(f.calls.map(call => call.body.offset), [0, 100]);
  assert.equal(f.calls[0]!.body.reverse, true);
  assert.equal(output.query.possiblyIncomplete, false);
  assert.doesNotMatch(JSON.stringify(result), /fixture-key|fixture-secret/);
  await assert.rejects(access(f.calls[0]!.configPath), { code: "ENOENT" });
});

test("named SLS targets retain exact project and logstore selection", async () => {
  const config = { ...configured, targets: [
    { name: "first", region: "cn-test", project: "srm-test", logstores: ["application_log"] },
    { name: "second", region: "cn-other", project: "other-project", logstores: ["gateway"] },
  ] };
  const f = fixture([page([{ message: "second target" }])]);
  const result = await readSlsLogs({ ...base, target: "second", logstore: "gateway" }, config, undefined, f.executor);
  assert.equal(f.calls[0]!.args[f.calls[0]!.args.indexOf("--project") + 1], "other-project");
  assert.equal(JSON.parse(result.content[0]!.text).query.target, "second");
  await assert.rejects(readSlsLogs({ ...base, target: "second" }, config, undefined, f.executor), /sls_logstore_not_granted/);
  await assert.rejects(readSlsLogs(base, config, undefined, f.executor), /sls_target_not_granted/);
  assert.equal(f.calls.length, 1);
});

test("SLS retains exact source selection, time bounds and trace semantics before starting a command", async () => {
  const trace = prepareSlsQuery({ logstore: base.logstore, trace_id: "8ea38737-7d1e-40bb-8fff-69e71bc985ab" }, configured);
  assert.equal(trace.to - trace.from, 24 * 60 * 60);
  assert.throws(() => prepareSlsQuery({ logstore: base.logstore, from: base.from }, configured), /invalid_sls_time_range/);
  assert.throws(() => prepareSlsQuery({ ...base, logstore: "other" }, configured), /sls_logstore_not_granted/);
  assert.throws(() => prepareSlsQuery({ ...base, trace_id: trace.query, query: "other" }, configured), /invalid_sls_query/);
  const f = fixture([]);
  await assert.rejects(readSlsLogs({ ...base, logstore: "other" }, configured, undefined, f.executor), /sls_logstore_not_granted/);
  assert.equal(f.calls.length, 0);
  const schema = capabilityDefinitions.sls.inputSchema as unknown as { properties: Record<string, unknown> };
  assert.equal("limit" in schema.properties, false);
});

for (const [response, expected] of [
  [page([], { progress: "Incomplete" }), "sls_query_incomplete"],
  [page([], { mode: 2 }), "sls_scan_query_not_supported"],
  [{ data: {}, meta: { progress: "Complete", hasSQL: false } }, "sls_query_invalid_response"],
  [page(Array.from({ length: 100 }, () => ({})), { hasSQL: true, limited: 100 }), "sls_sql_limit_required"],
  [page([{ value: "x".repeat(1_100_000) }]), "capability_result_too_large"],
] as const) test(`SLS rejects ${expected} instead of returning partial evidence`, async () => {
  const f = fixture([response]);
  await assert.rejects(readSlsLogs(base, configured, undefined, f.executor), { message: expected });
  await assert.rejects(access(f.calls[0]!.configPath), { code: "ENOENT" });
});

test("SQL analysis returns one page and never replays a failed later page", async () => {
  const sql = fixture([page(Array.from({ length: 100 }, (_, i) => ({ i })), { hasSQL: true })]);
  const output = await readSlsLogs({ ...base, query: "* | SELECT * LIMIT 100" }, configured, undefined, sql.executor);
  assert.equal(JSON.parse(output.content[0]!.text).query.pagination, "sql_limit");
  assert.equal(sql.calls.length, 1);
  const fail = fixture([page(Array.from({ length: 100 }, () => ({}))), new Error("ERROR: SDKError:\n StatusCode: 403\n Code: Unauthorized\n Message: fixture-secret private query")]);
  await assert.rejects(readSlsLogs(base, configured, undefined, fail.executor), { message: "sls_access_denied" });
  assert.equal(fail.calls.length, 2);
});

for (const [code, expected] of [
  ["SignatureNotMatch", "sls_signature_mismatch"], ["AccessKeyIdNotExist", "sls_invalid_access_key"], ["ProjectNotExist", "sls_project_not_found"], ["LogStoreNotExist", "sls_logstore_not_found"], ["Throttling", "sls_rate_limited"], ["QuotaExceed", "sls_quota_exceeded"],
] as const) test(`SLS CLI exposes only safe diagnostic ${expected}`, async () => {
  const f = fixture([new Error(`\u001b[1;31mERROR:\n Code: ${code}\n Message: fixture-secret\u001b[0m`)]);
  await assert.rejects(readSlsLogs(base, configured, undefined, f.executor), error => error instanceof Error && error.message === expected && error.cause === undefined);
  assert.equal(f.calls.length, 1);
});

test("SLS preserves cancellation and removes its temporary credentials", async () => {
  const controller = new AbortController(); const reason = new Error("caller_cancelled");
  let configuration = "";
  const executor: CommandExecutor = { async execute(_command, args, options) {
    configuration = args[args.indexOf("--config-path") + 1]!;
    controller.abort(reason);
    options?.signal?.throwIfAborted();
    throw new Error("unreachable");
  } };
  await assert.rejects(readSlsLogs(base, configured, controller.signal, executor), error => error === reason);
  await assert.rejects(access(configuration), { code: "ENOENT" });
  let called = false;
  await assert.rejects(readSlsLogs(base, configured, AbortSignal.abort(reason), { async execute() { called = true; throw new Error("unexpected"); } }), error => error === reason);
  assert.equal(called, false);
});

test("SLS does not expose raw CLI errors and classifies missing CLI without a fallback identity", async () => {
  const f = fixture([new Error("fixture-secret private log content")]);
  await assert.rejects(readSlsLogs(base, configured, undefined, f.executor), { message: "sls_query_failed" });
  await assert.rejects(readSlsLogs(base, configured, undefined, { async execute() { throw Object.assign(new Error("private executable path"), { code: "ENOENT" }); } }), { message: "sls_cli_not_available" });
  const failure = Object.assign(new Error(), { code: "ClientConfigError" });
  Object.defineProperty(failure, "message", { get() { throw new Error("must_not_read_message"); } });
  assert.equal(slsFailureCode(failure), "sls_client_configuration_invalid");
});
