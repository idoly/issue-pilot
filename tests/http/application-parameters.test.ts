import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiFixture, createIssue, createService } from "./fixture.ts";
import { applicationParameterDefaults } from "../../src/configuration/parameters.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";

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
