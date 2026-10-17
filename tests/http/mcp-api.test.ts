import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiFixture, createIssue, createService } from "./fixture.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";

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

test("rejects unsafe MCP URLs and unauthorized changes", async () => {
  const f = await createApiFixture();
  try {
    for (const url of ["http://example.test/mcp", "https://token@example.test/mcp", "https://example.test/mcp?apiKey=secret", "file:///tmp/mcp"]) {
      const response = await f.app.inject({ method: "POST", url: "/api/mcp-services", headers, payload: { ...input, url } });
      assert.equal(response.statusCode, 400, response.body);
    }
    await f.app.inject({ method: "POST", url: "/api/users", headers, payload: { subject: "product", name: "Product", email: "product@example.test", role: "product" } });
    const response = await f.app.inject({ method: "POST", url: "/api/mcp-services", headers: { "x-issue-pilot-subject": "product" }, payload: input });
    assert.equal(response.statusCode, 403);
  } finally { await f.cleanup(); }
});
