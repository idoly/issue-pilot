import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { capabilityDefinitions } from "../../src/capabilities/registry.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SLS_QUERY_ERRORS, prepareSlsQuery, readSlsLogs } from "../../src/capabilities/sls.ts";
import { readSlsHttp, type SlsSdkFactory } from "../../src/capabilities/sls-http.ts";
import { runReadWorker } from "../../src/capabilities/read-worker.ts";

const { GetLogsV2Response } = createRequire(import.meta.url)("@alicloud/sls20201230") as typeof import("@alicloud/sls20201230");
const configured = { region: "cn-test", project: "srm-test", logstores: ["application_log"], accessKeyId: "fixture-key", accessKeySecret: "fixture-secret" };
const base = { logstore: "application_log", from: 1_700_000_000, to: 1_700_003_600 };

test("SLS HTTPS uses the official signed SDK, preserves complete pages and keeps credentials outside requests", async () => {
  const calls: Array<{ project: string; logstore: string; request: Record<string, unknown>; runtime: Record<string, unknown> }> = [];
  let records: unknown | ((offset: number) => unknown) = [{ __time__: 1_700_000_000, message: "ready", password: "business-log-value" }];
  let meta: Record<string, unknown> = { progress: "Complete", hasSQL: false, mode: 0 };
  const factory: SlsSdkFactory = config => {
    assert.equal(config.protocol, "https"); assert.equal(config.endpoint, "cn-test.log.aliyuncs.com");
    assert.equal(config.accessKeyId, "fixture-key"); assert.equal(config.accessKeySecret, "fixture-secret");
    return { async getLogsV2WithOptions(project, logstore, request, _headers, runtime) {
      calls.push({ project, logstore, request: request as unknown as Record<string, unknown>, runtime: runtime as unknown as Record<string, unknown> });
      const data = typeof records === "function" ? records(request.offset ?? 0) : records;
      return new GetLogsV2Response({ statusCode: 200, body: { data, meta } });
    } };
  };
  const read = (input: Parameters<typeof prepareSlsQuery>[0]) => readSlsHttp(configured, prepareSlsQuery(input, configured), factory);
  const output = await read({ ...base, query: "level:ERROR" });
  assert.doesNotMatch(JSON.stringify(calls), /fixture-key|fixture-secret/);
  assert.equal(calls[0]!.request.reverse, true);
  assert.equal(calls[0]!.runtime.autoretry, false);
  assert.equal(calls[0]!.runtime.readTimeout, issuePilotConfig.limits.capability.sls.executionMs);
  const body = JSON.parse(output.content[0]!.text);
  assert.equal(body.records[0].password, "business-log-value");
  assert.deepEqual({ from: body.query.from, to: body.query.to, returnedRows: body.query.returnedRows, possiblyIncomplete: body.query.possiblyIncomplete }, { from: base.from, to: base.to, returnedRows: 1, possiblyIncomplete: false });
  const trace = prepareSlsQuery({ logstore: base.logstore, trace_id: "8ea38737-7d1e-40bb-8fff-69e71bc985ab" }, configured);
  assert.equal(trace.to - trace.from, 24 * 60 * 60);
  assert.equal(trace.query, "8ea38737-7d1e-40bb-8fff-69e71bc985ab");
  assert.throws(() => prepareSlsQuery({ logstore: base.logstore, from: base.from }, configured), /invalid_sls_time_range/);
  assert.throws(() => prepareSlsQuery({ ...base, logstore: "other" }, configured), /sls_logstore_not_granted/);
  assert.throws(() => prepareSlsQuery({ ...base, trace_id: trace.query, query: "other" }, configured), /invalid_sls_query/);
  records = (offset: number) => offset < 200 ? Array.from({ length: 100 }, (_, i) => ({ message: `page-${offset + i}` })) : [{ message: "last-page" }];
  const start = calls.length;
  const paged = await read(base);
  assert.equal(JSON.parse(paged.content[0]!.text).records.length, 201);
  assert.deepEqual(calls.slice(start).map(call => call.request.offset), [0, 100, 200]);
  records = Array.from({ length: 100 }, (_, i) => ({ value: i })); meta = { progress: "Complete", hasSQL: true, mode: 0 };
  const beforeSql = calls.length;
  const sql = await read({ ...base, query: "* | SELECT * LIMIT 100" });
  assert.equal(calls.length - beforeSql, 1);
  assert.equal(JSON.parse(sql.content[0]!.text).query.pagination, "sql_limit");
  meta = { ...meta, limited: 100 };
  await assert.rejects(read({ ...base, query: "* | SELECT *" }), /sls_sql_limit_required/);
  meta = { progress: "Incomplete", hasSQL: false };
  await assert.rejects(read(base), /sls_query_incomplete/);
  meta = { progress: "Complete", hasSQL: false, mode: 2 };
  await assert.rejects(read(base), /sls_scan_query_not_supported/);
  meta = { progress: "Complete", hasSQL: false, mode: 0 }; records = {};
  await assert.rejects(read(base), /sls_query_failed/);
  records = [{ message: "x".repeat(600_000) }, { message: "y".repeat(600_000) }];
  await assert.rejects(read(base), /capability_result_too_large/);
  const schema = capabilityDefinitions.sls.inputSchema as unknown as { properties: Record<string, unknown> };
  assert.equal("limit" in schema.properties, false);
});

for (const [fields, expected] of [
  [{ code: "Unauthorized", statusCode: 403 }, "sls_access_denied"],
  [{ code: "SignatureNotMatch", statusCode: 403 }, "sls_signature_mismatch"],
  [{ code: "AccessKeyIdNotExist", statusCode: 403 }, "sls_invalid_access_key"],
  [{ code: "ProjectNotExist", statusCode: 404 }, "sls_project_not_found"],
  [{ code: "LogStoreNotExist", statusCode: 404 }, "sls_logstore_not_found"],
  [{ code: "BadRequest", statusCode: 400 }, "sls_invalid_request"],
  [{ code: "RequestTimeExpired", statusCode: 403 }, "sls_request_time_expired"],
  [{ code: "Throttling", statusCode: 429 }, "sls_rate_limited"],
  [{ code: "QuotaExceed", statusCode: 403 }, "sls_quota_exceeded"],
  [{ code: "RequestTimeout" }, "sls_query_timeout"],
  [{ code: "private-remote-code", statusCode: 503 }, "sls_http_503"],
  [{ code: "private-remote-code", statusCode: "404" }, "sls_http_404"],
  [{ data: { Code: "SignatureNotMatch", statusCode: 403, message: "fixture-secret" } }, "sls_signature_mismatch"],
  [{ cause: { code: "ENOTFOUND", message: "private hostname" } }, "sls_dns_failed"],
  [{ code: "ECONNRESET" }, "sls_network_failed"],
  [{ code: "CERT_HAS_EXPIRED" }, "sls_tls_failed"],
] as const) test(`SLS preserves safe diagnostic ${expected}`, async () => {
  let calls = 0;
  const remote = Object.assign(new Error("fixture-key fixture-secret private query text"), fields);
  const factory: SlsSdkFactory = () => ({ async getLogsV2WithOptions() { calls++; throw remote; } });
  await assert.rejects(readSlsHttp(configured, prepareSlsQuery(base, configured), factory), error => error instanceof Error && error.message === expected && error.cause === undefined);
  assert.equal(calls, 1, "failed evidence queries are not automatically replayed");
});

for (const [failure, expected] of [
  [{ code: "SignatureNotMatch", statusCode: 403, message: "fixture-secret" }, "sls_signature_mismatch"],
  [{ code: "private-code", statusCode: 429, message: "fixture-secret" }, "sls_http_429"],
] as const) test(`SLS diagnostic ${expected} survives the worker allowlist without private details`, async () => {
  const result = runReadWorker(new URL("../helpers/sls-worker.ts", import.meta.url), { configured, query: prepareSlsQuery(base, configured), hang: false, failure }, issuePilotConfig.runtime.slsWorker, AbortSignal.timeout(10_000), "sls_query_failed", SLS_QUERY_ERRORS);
  await assert.rejects(result, { message: expected });
});

test("reports a missing evidence worker module as initialization failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-missing-worker-"));
  try {
    await assert.rejects(runReadWorker(pathToFileURL(path.join(root, "missing.ts")), {}, issuePilotConfig.runtime.slsWorker, AbortSignal.timeout(5_000), "sls_query_failed"), { message: "capability_worker_initialization_failed" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reports uncloneable evidence worker input as initialization failure", async () => {
  await assert.rejects(runReadWorker(new URL("../helpers/sls-worker.ts", import.meta.url), { invalid: () => undefined }, issuePilotConfig.runtime.slsWorker, AbortSignal.timeout(5_000), "sls_query_failed"), { message: "capability_worker_initialization_failed" });
});

test("SLS sanitizes client initialization failures before any request", async () => {
  const remote = Object.assign(new Error("fixture-key fixture-secret private configuration"), { code: "ClientConfigError" });
  const factory: SlsSdkFactory = () => { throw remote; };
  await assert.rejects(readSlsHttp(configured, prepareSlsQuery(base, configured), factory), error => error instanceof Error && error.message === "sls_client_configuration_invalid" && error.cause === undefined);
});

test("SLS decodes the SDK's actual response error without exposing its private details", async () => {
  const sdk = createRequire(import.meta.url)("@alicloud/tea-typescript") as typeof import("@alicloud/tea-typescript");
  const remote = sdk.newError({ code: "SignatureNotMatch", message: "fixture-key fixture-secret private upstream detail", data: { statusCode: 403, requestId: "synthetic-request" } });
  const factory: SlsSdkFactory = () => ({ async getLogsV2WithOptions() { throw remote; } });
  await assert.rejects(readSlsHttp(configured, prepareSlsQuery(base, configured), factory), error => error instanceof Error && error.message === "sls_signature_mismatch" && error.cause === undefined);
});

test("SLS discards earlier pages when a later page fails", async () => {
  const offsets: number[] = [];
  const factory: SlsSdkFactory = () => ({ async getLogsV2WithOptions(_project, _logstore, request) {
    offsets.push(request.offset ?? 0);
    if (offsets.length > 1) throw Object.assign(new Error("private error message"), { code: "Unauthorized", statusCode: 403 });
    return new GetLogsV2Response({ statusCode: 200, body: { data: Array.from({ length: 100 }, (_, index) => ({ message: `row-${index}` })), meta: { progress: "Complete", hasSQL: false, mode: 0 } } });
  } });
  await assert.rejects(readSlsHttp(configured, prepareSlsQuery(base, configured), factory), { message: "sls_access_denied" });
  assert.deepEqual(offsets, [0, 100]);
});

test("SLS preserves a non-throwing SDK HTTP failure", async () => {
  const factory: SlsSdkFactory = () => ({ async getLogsV2WithOptions() { return new GetLogsV2Response({ statusCode: 429 }); } });
  await assert.rejects(readSlsHttp(configured, prepareSlsQuery(base, configured), factory), { message: "sls_http_429" });
});

test("SLS error classification does not read raw messages or echo cyclic unknown errors", async () => {
  const remote = Object.assign(new Error(), { code: "ClientConfigError" });
  Object.defineProperty(remote, "message", { get() { throw new Error("must_not_read_remote_message"); } });
  let failure: Error = remote;
  const factory: SlsSdkFactory = () => ({ async getLogsV2WithOptions() { throw failure; } });
  await assert.rejects(readSlsHttp(configured, prepareSlsQuery(base, configured), factory), { message: "sls_client_configuration_invalid" });
  failure = new Error("fixture-secret private query"); failure.cause = failure;
  await assert.rejects(readSlsHttp(configured, prepareSlsQuery(base, configured), factory), { message: "sls_query_failed" });
});

test("SLS SDK errors are stable and do not echo credential-like remote errors", async () => {
  const factory: SlsSdkFactory = () => ({ getLogsV2WithOptions: async () => { throw new Error("fixture-secret"); } });
  await assert.rejects(readSlsHttp(configured, prepareSlsQuery(base, configured), factory), error => error instanceof Error && error.message === "sls_query_failed");
  await assert.rejects(readSlsLogs({ ...base, logstore: "unconfigured" }, configured), /sls_logstore_not_granted/);
});

test("SLS SDK runs within the real worker heap and cancellation terminates pending work", async () => {
  const fixture = new URL("../helpers/sls-worker.ts", import.meta.url);
  const result = await runReadWorker(fixture, { configured, query: prepareSlsQuery(base, configured), hang: false }, issuePilotConfig.runtime.slsWorker, AbortSignal.timeout(10_000), "sls_query_failed");
  assert.equal(JSON.parse(result.text).records[0].message, "worker-ready");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("cancelled")), 300);
  try { await assert.rejects(runReadWorker(fixture, { configured, query: prepareSlsQuery(base, configured), hang: true }, issuePilotConfig.runtime.slsWorker, controller.signal, "sls_query_failed"), /cancelled/); }
  finally { clearTimeout(timer); }
});
