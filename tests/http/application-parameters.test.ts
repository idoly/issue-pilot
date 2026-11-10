import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createApiFixture, createIssue, createService, modelCatalog } from "./fixture.ts";
import { applicationParameterDefaults, applicationParameters } from "../../src/configuration/parameters.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { buildApi } from "../../src/http/api.ts";
import { openDatabase } from "../../src/db/client.ts";
import { issueRoot } from "../../src/workspace/state.ts";

const headers = { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject };

test("applies saved application parameters without reserving Issues or closing sessions", async () => {
  const f = await createApiFixture();
  try {
    const get = async () => (await f.app.inject({ method: "GET", url: "/api/config/parameters" })).json();
    const put = (payload: unknown, requestHeaders: Record<string, string> = headers) =>
      f.app.inject({ method: "PUT", url: "/api/config/parameters", headers: requestHeaders, payload: payload as object });

    const initial = await get();
    assert.equal(initial.revision, 0);
    assert.deepEqual(initial.overrides, {});
    assert.deepEqual(initial.values, applicationParameterDefaults);
    assert.equal(initial.values.networkMode, "open");
    assert.equal(initial.bounds.numbers.maxConcurrentIssues.maximum, 64);
    assert.equal(initial.bounds.listEntries, 100);

    await createService(f.app, "Parameters");
    await createIssue(f.app, "parameters");
    const running = f.engine.enqueued[0]!;
    const overrides = {
      maxConcurrentIssues: 3,
      modelResponseIdleMs: 60_000,
      workspaceHighWaterBytes: 4 * 1024 ** 3,
      workspaceTargetBytes: 2 * 1024 ** 3,
      workspaceMaintenanceIntervalMs: 60_000,
      mcpExecutionMs: 30_000,
      dingtalkAttachmentHosts: ["files.example.test"],
      networkMode: "allowlist",
      networkAllowedDomains: ["registry.example.test", "*.example.test:443"],
    };
    const saved = await put({ expectedRevision: 0, overrides });
    assert.equal(saved.statusCode, 200, saved.body);
    const state = saved.json();
    assert.equal(state.revision, 1);
    assert.deepEqual(state.overrides, overrides);
    assert.deepEqual(state.values, { ...applicationParameterDefaults, ...overrides });
    assert.deepEqual(f.engine.concurrencyUpdates, [3]);
    assert.equal(f.engine.isRunning(running), true);
    assert.deepEqual(f.engine.closedSessions, []);
    // Omitted keys fall back to the project configuration default.
    assert.equal(state.values.slsExecutionMs, applicationParameterDefaults.slsExecutionMs);
    assert.deepEqual((await get()).values, state.values);
    assert.equal((await f.app.inject({ method: "GET", url: "/api/workspaces/stats" })).json().policy.maintenanceIntervalMinutes, 1);

    const stale = await put({ expectedRevision: 0, overrides: {} });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error, "configuration_changed");
    assert.deepEqual((await get()).values, state.values);

    const invalid = [
      { expectedRevision: 1, overrides: { maxConcurrentIssues: 0 } },
      { expectedRevision: 1, overrides: { modelResponseIdleMs: 1 } },
      { expectedRevision: 1, overrides: { workspaceHighWaterBytes: 1, workspaceTargetBytes: 1 } },
      { expectedRevision: 1, overrides: { workspaceMaintenanceIntervalMs: 30_000 } },
      { expectedRevision: 1, overrides: { dingtalkAttachmentHosts: ["not a host"] } },
      { expectedRevision: 1, overrides: { networkAllowedDomains: ["not a host"] } },
      { expectedRevision: 1, overrides: { networkAllowedDomains: ["a.test", "a.test"] } },
      ...["all", "OPEN", "", null, false, 1, []].map((networkMode) => ({ expectedRevision: 1, overrides: { networkMode } })),
      { expectedRevision: 1, overrides: { unknownParameter: 1 } },
      { expectedRevision: 1, overrides: { maxConcurrentIssues: "4" } },
      { overrides: {} },
    ];
    for (const payload of invalid) {
      const response = await put(payload);
      assert.equal(response.statusCode, 400, JSON.stringify(payload));
      assert.match(response.json().error, /^invalid_/);
    }
    assert.deepEqual((await get()).values, state.values);

    const cleared = await put({ expectedRevision: 1, overrides: {} });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.deepEqual(cleared.json().values, applicationParameterDefaults);
    assert.deepEqual(f.engine.concurrencyUpdates, [3, applicationParameterDefaults.maxConcurrentIssues]);

    await f.app.inject({ method: "POST", url: "/api/users", headers, payload: { subject: "developer", name: "Developer", email: "developer@example.test", role: "developer" } });
    const developer = { "x-issue-pilot-subject": "developer" };
    assert.equal((await f.app.inject({ method: "GET", url: "/api/config/parameters", headers: developer })).statusCode, 200);
    assert.equal((await put({ expectedRevision: 2, overrides: { maxConcurrentIssues: 5 } }, developer)).statusCode, 403);
    assert.deepEqual((await get()).values, applicationParameterDefaults);
  } finally {
    await f.cleanup();
  }
});

test("unrelated hot parameters keep the workspace measurement cache and execution limit", async () => {
  const f = await createApiFixture();
  try {
    await createService(f.app, "Parameter sampling");
    const issue = await createIssue(f.app, "parameter-sampling");
    const stats = async () => {
      const result = await f.app.inject({ url: "/api/workspaces/stats" });
      assert.equal(result.statusCode, 200, result.body);
      return result.json();
    };
    const save = async (expectedRevision: number, overrides: object) => {
      const result = await f.app.inject({ method: "PUT", url: "/api/config/parameters", headers, payload: { expectedRevision, overrides } });
      assert.equal(result.statusCode, 200, result.body);
    };
    const before = await stats();
    await writeFile(join(issueRoot(f.root, String(issue.id)), "fixture-report.txt"), "a".repeat(4_096));
    await save(0, { mcpExecutionMs: 60_000, dingtalkAttachmentHosts: ["files.example.test"] });
    assert.deepEqual(await stats(), before);
    assert.deepEqual(f.engine.concurrencyUpdates, []);
    await save(1, { mcpExecutionMs: 60_000, workspaceRetentionMs: 7_200_000 });
    const changed = await stats();
    assert.equal(changed.policy.retentionHours, 2);
    assert.equal(changed.totalBytes, before.totalBytes + 4_096);
  } finally {
    await f.cleanup();
  }
});

test("parameter editor protects the search configuration and saves both revisions atomically", async () => {
  const f = await createApiFixture();
  const database = openDatabase(f.databaseFile);
  const url = "/api/config/parameters";
  const editorUrl = `${url}?include=issueSearch`;
  const reader = { "x-issue-pilot-subject": "parameter-reader" };
  const accountId = "a".repeat(32);
  const token = "fixture-parameter-token";
  const read = async () => {
    const response = await f.app.inject({ url: editorUrl, headers });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(!response.body.includes(token));
    return response.json();
  };
  const put = (payload: object, actor: Record<string, string> = headers) => f.app.inject({ method: "PUT", url, headers: actor, payload });
  const overrides = { maxConcurrentIssues: 4 };
  const issueSearch = { expectedRevision: 0, enabled: true, accountId, apiToken: token };
  try {
    const user = await f.app.inject({
      method: "POST",
      url: "/api/users",
      headers,
      payload: { subject: reader["x-issue-pilot-subject"], name: "Reader", email: "reader@example.test", role: "product" },
    });
    assert.equal(user.statusCode, 201, user.body);
    assert.equal((await f.app.inject({ url: editorUrl, headers: reader })).statusCode, 403);
    assert.equal((await put({ expectedRevision: 0, overrides, issueSearch }, reader)).statusCode, 403);
    const initial = await read();

    for (const [payload, status] of [
      [{ expectedRevision: 1, overrides, issueSearch }, 409],
      [{ expectedRevision: 0, overrides, issueSearch: { ...issueSearch, expectedRevision: 1 } }, 409],
      [{ expectedRevision: 0, overrides, issueSearch: { ...issueSearch, accountId: "" } }, 400],
    ] as const) {
      assert.equal((await put(payload)).statusCode, status);
      assert.deepEqual(await read(), initial);
    }
    await database.client.execute("CREATE TRIGGER reject_parameters BEFORE UPDATE OF parameters ON application_settings BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    assert.equal((await put({ expectedRevision: 0, overrides, issueSearch })).statusCode, 500);
    assert.deepEqual(await read(), initial);
    assert.deepEqual(f.engine.concurrencyUpdates, []);
    await database.client.execute("DROP TRIGGER reject_parameters");

    const saved = await put({ expectedRevision: 0, overrides, issueSearch });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.ok(!saved.body.includes(token));
    assert.equal(saved.json().revision, 1);
    assert.deepEqual(saved.json().overrides, overrides);
    assert.deepEqual(saved.json().issueSearch, { enabled: true, accountId, tokenConfigured: true, revision: 1 });
    assert.deepEqual(await read(), saved.json());
    const ordinary = await f.app.inject({ url, headers: reader });
    assert.equal(ordinary.statusCode, 200);
    assert.equal(ordinary.json().issueSearch, undefined);
  } finally {
    database.close();
    await f.cleanup();
  }
});

test("restores the saved network mode on startup and clears it back to the project default", async () => {
  const f = await createApiFixture();
  let restarted: Awaited<ReturnType<typeof buildApi>> | undefined;
  try {
    const saved = await f.app.inject({ method: "PUT", url: "/api/config/parameters", headers, payload: { expectedRevision: 0, overrides: { networkMode: "allowlist" } } });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(applicationParameters().networkMode, "allowlist");
    await f.stop();
    restarted = await buildApi({ stateRoot: f.root, databaseFile: f.databaseFile, engine: f.engine, modelCatalog, logger: false });
    const state = (await restarted.inject({ method: "GET", url: "/api/config/parameters" })).json();
    assert.equal(state.revision, 1);
    assert.deepEqual(state.overrides, { networkMode: "allowlist" });
    assert.equal(state.values.networkMode, "allowlist");
    assert.equal(applicationParameters().networkMode, "allowlist");
    const cleared = await restarted.inject({ method: "PUT", url: "/api/config/parameters", headers, payload: { expectedRevision: 1, overrides: {} } });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(cleared.json().values.networkMode, "open");
    assert.equal(applicationParameters().networkMode, "open");
  } finally {
    await restarted?.close();
    await f.cleanup();
  }
});
