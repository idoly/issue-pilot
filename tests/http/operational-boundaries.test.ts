import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { createClient, type Client } from "@libsql/client";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { applicationParameters, installApplicationParameters } from "../../src/configuration/parameters.ts";
import { buildApi } from "../../src/http/api.ts";
import { modelCatalog, TestAgentController } from "./fixture.ts";

const headers = { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject };

async function withApi(run: (app: Awaited<ReturnType<typeof buildApi>>) => Promise<void>, sync?: () => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-operational-"));
  const databaseFile = path.join(root, "issues.db");
  const original = applicationParameters();
  const app = await buildApi({ stateRoot: root, databaseFile, engine: new TestAgentController(databaseFile), modelCatalog, logger: false, ...(sync ? { applyIssueSandboxNetwork: sync } : {}) });
  try {
    await run(app);
  } finally {
    await app.close();
    installApplicationParameters(original);
    await rm(root, { recursive: true, force: true });
  }
}

test("a sandbox network sync failure after the parameter commit reports the committed outcome", async () => {
  const syncs: string[][] = [];
  await withApi(
    async (app) => {
      const response = await app.inject({ method: "PUT", url: "/api/config/parameters", headers, payload: { expectedRevision: 0, overrides: { networkAllowedDomains: ["registry.example.test"] } } });
      assert.equal(response.statusCode, 500, response.body);
      assert.deepEqual(response.json(), { error: "issue_sandbox_network_sync_failed", outcome: "committed" });
      // The sync ran after the new values were installed, and the save is durable rather than rolled back.
      assert.deepEqual(syncs, [["registry.example.test"]]);
      const state = (await app.inject({ method: "GET", url: "/api/config/parameters" })).json();
      assert.equal(state.revision, 1);
      assert.deepEqual(state.overrides, { networkAllowedDomains: ["registry.example.test"] });
      assert.deepEqual(applicationParameters().networkAllowedDomains, ["registry.example.test"]);
      // Unchanged network lists do not retry the sync.
      const other = await app.inject({
        method: "PUT",
        url: "/api/config/parameters",
        headers,
        payload: { expectedRevision: 1, overrides: { networkAllowedDomains: ["registry.example.test"], maxConcurrentIssues: 2 } },
      });
      assert.equal(other.statusCode, 200, other.body);
      assert.equal(syncs.length, 1);
    },
    async () => {
      syncs.push([...applicationParameters().networkAllowedDomains]);
      throw new Error("sandbox_update_failed");
    },
  );
});

test("health probes the open database connection and reports 503 once it is closed", async () => {
  const prototype = Object.getPrototypeOf(createClient({ url: ":memory:" })) as Client;
  await withApi(async (app) => {
    const clients = new Set<Client>();
    const execute = prototype.execute;
    const probe = mock.method(prototype, "execute", function (this: Client, ...args: Parameters<Client["execute"]>) {
      clients.add(this);
      return execute.apply(this, args);
    });
    try {
      const healthy = await app.inject({ method: "GET", url: "/health" });
      assert.equal(healthy.statusCode, 200);
      assert.deepEqual(healthy.json(), { ok: true });
    } finally {
      probe.mock.restore();
    }
    // Only the application's connection served the probe; close it as a failed or shut-down connection would be.
    assert.equal(clients.size, 1);
    for (const client of clients) client.close();
    const unhealthy = await app.inject({ method: "GET", url: "/health" });
    assert.equal(unhealthy.statusCode, 503);
    assert.deepEqual(unhealthy.json(), { ok: false, error: "database_unavailable" });
  });
});

test("refuses browser-marked cross-site writes while reads and header-less clients stay available", async () => {
  await withApi(async (app) => {
    const blocked = await app.inject({ method: "POST", url: "/api/issues", headers: { ...headers, "sec-fetch-site": "cross-site" }, payload: {} });
    assert.equal(blocked.statusCode, 403);
    assert.deepEqual(blocked.json(), { error: "cross_site_request_refused" });
    for (const extra of [{ "sec-fetch-site": "same-site" }, { origin: "https://other.example.test" }, { origin: "null" }]) {
      const refused = await app.inject({ method: "POST", url: "/api/issues", headers: { ...headers, ...extra }, payload: {} });
      assert.equal(refused.statusCode, 403);
      assert.equal(refused.json().error, "cross_site_request_refused");
    }
    const sameOrigin = await app.inject({ method: "POST", url: "/api/issues", headers: { ...headers, "sec-fetch-site": "same-origin" }, payload: {} });
    assert.notEqual(sameOrigin.statusCode, 403);
    // Reads are not state-changing, and CLI/MCP clients send no Sec-Fetch-Site header.
    const read = await app.inject({ method: "GET", url: "/api/issues", headers: { ...headers, "sec-fetch-site": "cross-site" } });
    assert.equal(read.statusCode, 200);
    const headerless = await app.inject({ method: "POST", url: "/api/issues", headers, payload: {} });
    assert.notEqual(headerless.statusCode, 403);
  });
});
