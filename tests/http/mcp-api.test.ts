import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiFixture, createIssue, createService } from "./fixture.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { eq } from "drizzle-orm";
import { openDatabase } from "../../src/db/client.ts";
import { serviceDeployments, services } from "../../src/db/schema.ts";

const headers = { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject };
const input = { name: "Docs", url: "https://mcp.example.test/mcp", transport: "streamable_http", enabled: false, credentialUpdate: { mode: "replace", values: { authorization: "Bearer secret-token" } } };

test("manages MCP configs without returning credentials and reserves all running sessions", async () => {
  const f = await createApiFixture();
  try {
    const added = await f.app.inject({ method: "POST", url: "/api/mcp-services", headers, payload: input });
    assert.equal(added.statusCode, 201, added.body);
    const row = JSON.parse(added.body);
    assert.equal(row.credentialConfigured, true);
    assert.equal(added.body.includes("secret-token"), false);
    const list = await f.app.inject({ method: "GET", url: "/api/mcp-services" });
    assert.equal(list.headers["cache-control"], "private, no-store");
    assert.equal(list.body.includes("secret-token"), false);
    const duplicate = await f.app.inject({ method: "POST", url: "/api/mcp-services", headers, payload: input });
    assert.equal(duplicate.statusCode, 409, duplicate.body);
    assert.equal(duplicate.body.includes("secret-token"), false);
    await createService(f.app, "Running", ["test"]); await createIssue(f.app, "running", "test");
    const enable = { ...input, enabled: true, credentialUpdate: { mode: "preserve" } };
    const blocked = await f.app.inject({ method: "PATCH", url: `/api/mcp-services/${row.id}`, headers, payload: enable });
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.equal(JSON.parse(blocked.body).error, "mcp_has_running_issues");
    f.engine.running.clear();
    const saved = await f.app.inject({ method: "PATCH", url: `/api/mcp-services/${row.id}`, headers, payload: enable });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(JSON.parse(saved.body).enabled, true);
    assert.equal(saved.body.includes("secret-token"), false);
    const moved = await f.app.inject({ method: "PATCH", url: `/api/mcp-services/${row.id}`, headers, payload: { ...enable, url: "https://other.example.test/mcp" } });
    assert.equal(moved.statusCode, 400);
    assert.equal(JSON.parse(moved.body).error, "mcp_credentials_target_changed");
    const cleared = await f.app.inject({ method: "PATCH", url: `/api/mcp-services/${row.id}`, headers, payload: { ...enable, credentialUpdate: { mode: "clear" } } });
    assert.equal(cleared.statusCode, 200, cleared.body);
    assert.equal(JSON.parse(cleared.body).credentialConfigured, false);
    assert.equal((await f.app.inject({ method: "DELETE", url: `/api/mcp-services/${row.id}`, headers })).statusCode, 204);
  } finally { await f.cleanup(); }
});

test("unowned MCP entries and historical bindings do not leak into service descriptions or block deletion", async () => {
  const f = await createApiFixture(), database = openDatabase(f.databaseFile);
  try {
    await createService(f.app, "Global", ["test"]);
    const added = await f.app.inject({ method: "POST", url: "/api/mcp-services", headers, payload: { ...input, enabled: true } });
    assert.equal(added.statusCode, 201, added.body);
    const id = added.json().id;
    const [service] = await database.db.select().from(services).where(eq(services.key, "global"));
    await database.db.update(serviceDeployments).set({ config: { mcpServices: [id, "obsolete-binding"] } }).where(eq(serviceDeployments.serviceId, service!.id));
    const config = (await f.app.inject({ method: "GET", url: "/api/config" })).json();
    const projected = config.services.find((row: { key: string }) => row.key === "global");
    assert.equal("mcpServices" in projected.deployments[0], false);
    assert.doesNotMatch(projected.context, /MCP|mcp\.example\.test/);
    const bind = await f.app.inject({ method: "PATCH", url: "/api/services/global", headers, payload: { name: projected.name, description: projected.description, repositories: projected.repositories, deployments: projected.deployments.map((row: object) => ({ ...row, mcpServices: [id] })) } });
    assert.equal(bind.statusCode, 400, bind.body);
    assert.equal(bind.json().error, "mcp_services_are_global");
    assert.equal((await f.app.inject({ method: "DELETE", url: `/api/mcp-services/${id}`, headers })).statusCode, 204);
    const after = await f.app.inject({ method: "GET", url: "/api/config" });
    assert.equal(after.statusCode, 200, after.body);
    assert.doesNotMatch(after.body, /obsolete-binding/);
  } finally { database.close(); await f.cleanup(); }
});

test("keeps query credentials private and preserves them when toggling a projected MCP URL", async () => {
  const f = await createApiFixture();
  try {
    const added = await f.app.inject({ method: "POST", url: "/api/mcp-services", payload: { ...input, url: "https://mcp.example.test/mcp?key=private-query-key" } });
    assert.equal(added.statusCode, 201, added.body);
    const row = added.json();
    assert.equal(row.url, "https://mcp.example.test/mcp");
    assert.doesNotMatch(added.body, /private-query-key/);
    const toggled = await f.app.inject({ method: "PATCH", url: `/api/mcp-services/${row.id}`, payload: { name: row.name, url: row.url, transport: row.transport, enabled: true, credentialUpdate: { mode: "preserve" } } });
    assert.equal(toggled.statusCode, 200, toggled.body);
    const selected = await f.app.inject({ method: "GET", url: `/api/mcp-services/${row.id}/configuration` });
    assert.equal(selected.json().mcpServers.Docs.url, "https://mcp.example.test/mcp?key=private-query-key");
  } finally { await f.cleanup(); }
});

test("rejects unsafe MCP URLs and unauthorized changes", async () => {
  const f = await createApiFixture();
  try {
    for (const url of ["http://example.test/mcp", "https://token@example.test/mcp", "file:///tmp/mcp"]) {
      const response = await f.app.inject({ method: "POST", url: "/api/mcp-services", headers, payload: { ...input, url } });
      assert.equal(response.statusCode, 400, response.body);
    }
    await f.app.inject({ method: "POST", url: "/api/users", headers, payload: { subject: "product", name: "Product", email: "product@example.test", role: "product" } });
    const response = await f.app.inject({ method: "POST", url: "/api/mcp-services", headers: { "x-issue-pilot-subject": "product" }, payload: input });
    assert.equal(response.statusCode, 403);
  } finally { await f.cleanup(); }
});
