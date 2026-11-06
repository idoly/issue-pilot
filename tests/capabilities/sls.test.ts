import assert from "node:assert/strict";
import fs, { access, chmod, readFile, rm, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { CommandExecutor } from "../../src/process.ts";
import { prepareSlsQuery, readSlsLogs } from "../../src/capabilities/sls.ts";
import { capabilityInputSchemas, capabilityToolInputSchema, parseSlsScopeConfiguration } from "../../src/capabilities/registry.ts";
import { compile } from "@earendil-works/pi-schema";

const configured = { region: "cn-test", project: "srm-test", logstores: ["application_log"], accessKeyId: "fixture-key", accessKeySecret: "fixture-secret" };
const base = { region: configured.region, project: configured.project, logstore: "application_log", from: 1_700_000_000, to: 1_700_003_600 };
function fixture(pages: unknown[]) {
  const calls: Array<{ args: string[]; body: Record<string, unknown>; configPath: string }> = [];
  const executor: CommandExecutor = {
    async execute(command, args, options) {
      assert.equal(command, "aliyun");
      assert.deepEqual(args.slice(0, 2), ["sls", "GetLogsV2"]);
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
    },
  };
  return { executor, calls };
}
const page = (data: unknown[], meta: Record<string, unknown> = {}) => ({ data, meta: { progress: "Complete", hasSQL: false, mode: 0, ...meta } });

test("aliyun sls paginates complete results and keeps credentials out of argv, results and the host profile", async () => {
  const f = fixture([
    page(Array.from({ length: 100 }, (_, i) => ({ message: String(i) }))),
    page([{ message: "last", password: "business-value", token: "business-login-token", Authorization: "Bearer business-login-token" }]),
  ]);
  const result = await readSlsLogs(base, configured, undefined, f.executor);
  const output = JSON.parse(result.content[0]!.text);
  assert.equal(output.records.length, 101);
  assert.equal(output.records[100].password, "business-value");
  assert.equal(output.records[100].token, "business-login-token");
  assert.equal(output.records[100].Authorization, "Bearer business-login-token");
  assert.equal(result.details.provider, "aliyun-sls-cli");
  assert.deepEqual(
    f.calls.map((call) => call.body.offset),
    [0, 100],
  );
  assert.equal(f.calls[0]!.body.reverse, true);
  assert.equal(output.query.possiblyIncomplete, false);
  assert.doesNotMatch(JSON.stringify(result), /fixture-key|fixture-secret/);
  await assert.rejects(access(f.calls[0]!.configPath), { code: "ENOENT" });
});

test("a configured wildcard grants exact logstores within the selected project only", async () => {
  const config = { ...configured, ...parseSlsScopeConfiguration({ ...configured, logstores: [" * "] }) };
  const schema = compile(capabilityToolInputSchema("sls", config));
  assert.equal(schema.check({ ...base, logstore: "new_logstore" }), true);
  for (const logstore of ["*", "prefix*", "../other", "", "bad/store"]) {
    assert.equal(schema.check({ ...base, logstore }), false);
    assert.throws(() => prepareSlsQuery({ ...base, logstore }, config), /sls_logstore_not_granted/);
  }
  const f = fixture([page([{ message: "selected project" }])]);
  const result = await readSlsLogs({ ...base, logstore: "new_logstore" }, config, undefined, f.executor);
  assert.equal(f.calls[0]!.args[f.calls[0]!.args.indexOf("--project") + 1], configured.project);
  assert.equal(f.calls[0]!.args[f.calls[0]!.args.indexOf("--logstore") + 1], "new_logstore");
  assert.equal(JSON.parse(result.content[0]!.text).query.logstore, "new_logstore");
  assert.equal(f.calls.length, 1);
  for (const store of ["prefix*", "?", "bad/store"]) assert.throws(() => parseSlsScopeConfiguration({ ...configured, logstores: [store] }));
});

test("target wildcard schemas and execution keep independent logstore permissions", async () => {
  const config = {
    ...configured,
    ...parseSlsScopeConfiguration({
      ...configured,
      targets: [
        { region: "cn-other", project: "other-project", logstores: ["*"] },
        { region: configured.region, project: configured.project, logstores: ["application_log"] },
      ],
    }),
  };
  const schema = compile(capabilityToolInputSchema("sls", config));
  assert.equal(schema.check({ ...base, region: "cn-other", project: "other-project", logstore: "new_store" }), true);
  assert.equal(schema.check({ ...base, logstore: "new_store" }), false);
  assert.equal(schema.check({ ...base, region: "cn-other", project: "other-project", logstore: "*" }), false);
  assert.equal(schema.check({ ...base, target: "any" }), false);
  const f = fixture([page([])]);
  await readSlsLogs({ ...base, region: "cn-other", project: "other-project", logstore: "new_store" }, config, undefined, f.executor);
  assert.equal(f.calls[0]!.args[f.calls[0]!.args.indexOf("--project") + 1], "other-project");
  await assert.rejects(readSlsLogs({ ...base, logstore: "new_store" }, config, undefined, f.executor), /sls_logstore_not_granted/);
  await assert.rejects(readSlsLogs({ ...base, project: "unknown", logstore: "new_store" }, config, undefined, f.executor), /sls_scope_not_granted/);
  await assert.rejects(readSlsLogs({ ...base, region: "cn-other", logstore: "new_store" }, config, undefined, f.executor), /sls_scope_not_granted/);
  assert.equal(f.calls.length, 1);
});

test("SLS scopes retain exact region, project and logstore selection without custom names", async () => {
  const config = {
    ...configured,
    targets: [
      { region: "cn-test", project: "srm-test", logstores: ["application_log"] },
      { region: "cn-other", project: "other-project", logstores: ["gateway"] },
    ],
  };
  const f = fixture([page([{ message: "second target" }])]);
  const result = await readSlsLogs({ ...base, region: "cn-other", project: "other-project", logstore: "gateway" }, config, undefined, f.executor);
  assert.equal(f.calls[0]!.args[f.calls[0]!.args.indexOf("--project") + 1], "other-project");
  const source = JSON.parse(result.content[0]!.text).query;
  assert.equal(source.region, "cn-other");
  assert.equal(source.project, "other-project");
  assert.equal(source.logstore, "gateway");
  assert.equal("target" in source, false);
  await assert.rejects(readSlsLogs({ ...base, region: "cn-other", project: "other-project" }, config, undefined, f.executor), /sls_logstore_not_granted/);
  await assert.rejects(readSlsLogs({ ...base, region: "cn-other" }, config, undefined, f.executor), /sls_scope_not_granted/);
  assert.equal(f.calls.length, 1);
});

test("multiple logstore grants in one region/project remain usable without combining different source tuples", async () => {
  const config = {
    ...configured,
    targets: [
      { region: configured.region, project: configured.project, logstores: ["application_log"] },
      { region: configured.region, project: configured.project, logstores: ["gateway"] },
      { region: "cn-other", project: "other-project", logstores: ["application_log"] },
    ],
  };
  const schema = compile(capabilityToolInputSchema("sls", config));
  assert.equal(schema.check({ ...base, logstore: "gateway" }), true);
  const f = fixture([page([])]);
  await readSlsLogs({ ...base, logstore: "gateway" }, config, undefined, f.executor);
  assert.equal(f.calls.length, 1);
  assert.equal(schema.check({ ...base, region: "cn-other" }), false);
  assert.equal(schema.check({ ...base, project: "other-project" }), false);
  await assert.rejects(readSlsLogs({ ...base, region: "cn-other" }, config, undefined, f.executor), /sls_scope_not_granted/);
  await assert.rejects(readSlsLogs({ ...base, project: "other-project" }, config, undefined, f.executor), /sls_scope_not_granted/);
  assert.equal(f.calls.length, 1);
  const { region: _region, project: _project, ...withoutSource } = base;
  assert.equal(schema.check(withoutSource), false);
});

test("SLS retains exact source selection, time bounds and trace semantics before starting a command", async () => {
  const trace = prepareSlsQuery({ region: base.region, project: base.project, logstore: base.logstore, trace_id: "8ea38737-7d1e-40bb-8fff-69e71bc985ab" }, configured);
  assert.equal(trace.to - trace.from, 24 * 60 * 60);
  assert.throws(() => prepareSlsQuery({ region: base.region, project: base.project, logstore: base.logstore, from: base.from }, configured), /invalid_sls_time_range/);
  assert.throws(() => prepareSlsQuery({ ...base, logstore: "other" }, configured), /sls_logstore_not_granted/);
  assert.throws(() => prepareSlsQuery({ ...base, trace_id: trace.query, query: "other" }, configured), /invalid_sls_query/);
  const f = fixture([]);
  await assert.rejects(readSlsLogs({ ...base, logstore: "other" }, configured, undefined, f.executor), /sls_logstore_not_granted/);
  assert.equal(f.calls.length, 0);
  const schema = capabilityInputSchemas.sls as unknown as { properties: Record<string, unknown> };
  assert.equal("limit" in schema.properties, false);
});

for (const [response, expected] of [
  [page([], { progress: "Incomplete" }), "sls_query_incomplete"],
  [page([], { mode: 2 }), "sls_scan_query_not_supported"],
  [{ data: {}, meta: { progress: "Complete", hasSQL: false } }, "sls_query_invalid_response"],
  [
    page(
      Array.from({ length: 100 }, () => ({})),
      { hasSQL: true, limited: 100 },
    ),
    "sls_sql_limit_required",
  ],
  [page([{ value: "x".repeat(1_100_000) }]), "capability_result_too_large"],
] as const)
  test(`SLS rejects ${expected} instead of returning partial evidence`, async () => {
    const f = fixture([response]);
    await assert.rejects(readSlsLogs(base, configured, undefined, f.executor), { message: expected });
    await assert.rejects(access(f.calls[0]!.configPath), { code: "ENOENT" });
  });

test("SQL analysis returns one page and never replays a failed later page", async () => {
  const sql = fixture([
    page(
      Array.from({ length: 100 }, (_, i) => ({ i })),
      { hasSQL: true },
    ),
  ]);
  const output = await readSlsLogs({ ...base, query: "* | SELECT * LIMIT 100" }, configured, undefined, sql.executor);
  assert.equal(JSON.parse(output.content[0]!.text).query.pagination, "sql_limit");
  assert.equal(sql.calls.length, 1);
  const fail = fixture([page(Array.from({ length: 100 }, () => ({}))), new Error("ERROR: SDKError:\n StatusCode: 403\n Code: Unauthorized\n Message: fixture-secret private query")]);
  await assert.rejects(readSlsLogs(base, configured, undefined, fail.executor), { message: "sls_access_denied" });
  assert.equal(fail.calls.length, 2);
});

for (const [code, expected] of [
  ["ClientConfigError", "sls_client_configuration_invalid"],
  ["SignatureNotMatch", "sls_signature_mismatch"],
  ["AccessKeyIdNotExist", "sls_invalid_access_key"],
  ["ProjectNotExist", "sls_project_not_found"],
  ["LogStoreNotExist", "sls_logstore_not_found"],
  ["Throttling", "sls_rate_limited"],
  ["QuotaExceed", "sls_quota_exceeded"],
] as const)
  test(`SLS CLI exposes only safe diagnostic ${expected}`, async () => {
    const f = fixture([new Error(`\u001b[1;31mERROR:\n Code: ${code}\n Message: fixture-secret\u001b[0m`)]);
    await assert.rejects(readSlsLogs(base, configured, undefined, f.executor), (error) => error instanceof Error && error.message === expected && error.cause === undefined);
    assert.equal(f.calls.length, 1);
  });

test("SLS preserves cancellation and removes its temporary credentials", async () => {
  const controller = new AbortController();
  const reason = new Error("caller_cancelled");
  let configuration = "";
  const executor: CommandExecutor = {
    async execute(_command, args, options) {
      configuration = args[args.indexOf("--config-path") + 1]!;
      controller.abort(reason);
      options?.signal?.throwIfAborted();
      throw new Error("unreachable");
    },
  };
  await assert.rejects(readSlsLogs(base, configured, controller.signal, executor), (error) => error === reason);
  await assert.rejects(access(configuration), { code: "ENOENT" });
  let called = false;
  await assert.rejects(
    readSlsLogs(base, configured, AbortSignal.abort(reason), {
      async execute() {
        called = true;
        throw new Error("unexpected");
      },
    }),
    (error) => error === reason,
  );
  assert.equal(called, false);
});

for (const cancellation of ["caller", "deadline"] as const)
  test(`SLS retains credential cleanup failures after ${cancellation} cancellation`, async (context) => {
    const controller = new AbortController();
    const reason = cancellation === "caller" ? new Error("caller_cancelled") : new DOMException("query expired", "TimeoutError");
    const cleanup = Object.assign(new Error("fixture cleanup failure"), { code: "EACCES" });
    const remove = fs.rm;
    let directory = "";
    context.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      if (args[0] === directory) throw cleanup;
      return remove(...args);
    });
    if (cancellation === "deadline") context.mock.method(AbortSignal, "timeout", () => controller.signal);
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        readSlsLogs(base, configured, cancellation === "caller" ? controller.signal : undefined, {
          async execute(_command, args, options) {
            directory = path.dirname(args[args.indexOf("--config-path") + 1]!);
            controller.abort(reason);
            options!.signal!.throwIfAborted();
            throw new Error("unreachable");
          },
        }),
        (error) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.message, "sls_credential_cleanup_failed");
          assert.deepEqual(error.errors, [reason, cleanup]);
          return true;
        },
      );
      assert.equal(await readFile(path.join(directory, "config.json"), "utf8").then((content) => content.includes(configured.accessKeySecret)), true);
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
    const retry = fixture([page([])]);
    await readSlsLogs(base, configured, undefined, retry.executor);
    await assert.rejects(access(retry.calls[0]!.configPath), { code: "ENOENT" });
  });

test("SLS does not expose raw CLI errors and classifies missing CLI without a fallback identity", async () => {
  const f = fixture([new Error("fixture-secret private log content")]);
  await assert.rejects(readSlsLogs(base, configured, undefined, f.executor), { message: "sls_query_failed" });
  await assert.rejects(
    readSlsLogs(base, configured, undefined, {
      async execute() {
        throw Object.assign(new Error("private executable path"), { code: "ENOENT" });
      },
    }),
    { message: "sls_cli_not_available" },
  );
});

test("a credential profile that cannot be removed is reported with its stable code instead of a generic failure", { skip: process.getuid?.() === 0 }, async () => {
  for (const failQuery of [false, true]) {
    let directory = "";
    const executor: CommandExecutor = {
      async execute(_command, args) {
        directory = path.dirname(args[args.indexOf("--config-path") + 1]!);
        // Removing the profile fails once the directory is no longer writable.
        await chmod(directory, 0o500);
        return failQuery ? { code: 1, killed: false, stdout: "", stderr: "ErrorCode: Unauthorized" } : { code: 0, killed: false, stdout: JSON.stringify(page([])), stderr: "" };
      },
    };
    try {
      await assert.rejects(readSlsLogs(base, configured, undefined, executor), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "sls_credential_cleanup_failed");
        if (failQuery) assert.ok(error instanceof AggregateError && error.errors.length === 2);
        return true;
      });
    } finally {
      if (directory) {
        await chmod(directory, 0o700);
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});

test("a large SQL response within the result budget does not depend on the call argument limit", async () => {
  const rows = Array.from({ length: 130_000 }, () => ({}));
  const f = fixture([page(rows, { hasSQL: true })]);
  const result = await readSlsLogs({ ...base, query: "* | SELECT * LIMIT 130000" }, configured, undefined, f.executor);
  assert.equal(JSON.parse(result.content[0]!.text).records.length, rows.length);
  assert.ok(Buffer.byteLength(result.content[0]!.text) <= issuePilotConfig.limits.capability.resultBytes);
  assert.equal(f.calls.length, 1);
  await assert.rejects(access(f.calls[0]!.configPath), { code: "ENOENT" });
});

test("paginated SLS enforces the exact UTF-8 result budget including metadata", async () => {
  const rows = Array.from({ length: 100 }, () => ({}));
  const pages = () => Array.from({ length: 30 }, () => page(rows));
  const suffix = { message: '订单😀\n"\\', padding: "" };
  const probe = fixture([...pages(), page([suffix])]);
  const minimum = await readSlsLogs(base, configured, undefined, probe.executor);
  const padding = "x".repeat(issuePilotConfig.limits.capability.resultBytes - Buffer.byteLength(minimum.content[0]!.text));
  const within = fixture([...pages(), page([{ ...suffix, padding }])]);
  const result = await readSlsLogs(base, configured, undefined, within.executor);
  assert.equal(Buffer.byteLength(result.content[0]!.text), issuePilotConfig.limits.capability.resultBytes);
  const value = JSON.parse(result.content[0]!.text);
  assert.equal(value.records.length, 3001);
  assert.deepEqual(value.records.at(-1), { ...suffix, padding });
  const over = fixture([...pages(), page([{ ...suffix, padding: padding + "x" }])]);
  await assert.rejects(readSlsLogs(base, configured, undefined, over.executor), { message: "capability_result_too_large" });
  for (const run of [probe, within, over]) {
    assert.equal(run.calls.length, 31);
    await assert.rejects(access(run.calls[0]!.configPath), { code: "ENOENT" });
  }
});

test("SLS stops before requesting another page once accumulated evidence exceeds its budget", async () => {
  const rows = Array.from({ length: 100 }, () => ({ message: "x".repeat(5_400) }));
  const f = fixture([page(rows), page(rows), page([])]);
  await assert.rejects(readSlsLogs(base, configured, undefined, f.executor), { message: "capability_result_too_large" });
  assert.equal(f.calls.length, 2);
  await assert.rejects(access(f.calls[0]!.configPath), { code: "ENOENT" });
});
