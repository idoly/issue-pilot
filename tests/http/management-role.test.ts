import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { eq } from "drizzle-orm";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { openDatabase } from "../../src/db/client.ts";
import { subjects } from "../../src/db/schema.ts";
import { registerMcpRoutes } from "../../src/http/mcp-routes.ts";
import { ApiError } from "../../src/http/input.ts";
import { createApiFixture } from "./fixture.ts";

const owner = issuePilotConfig.bootstrapUser.subject;
const admin = { "x-issue-pilot-subject": owner };

test("only global managers can add MCP services through either API", async () => {
  const f = await createApiFixture();
  try {
    for (const actor of ["product", "test", "developer", "manager"] as const) {
      const subject = `${actor}@example.test`, isAdmin = actor === "manager", role = isAdmin ? "developer" : actor;
      const created = await f.app.inject({ method: "POST", url: "/api/users", headers: admin, payload: { subject, name: actor, email: subject, role, isAdmin } });
      assert.equal(created.statusCode, 201, created.body);
      const headers = { "x-issue-pilot-subject": subject };
      for (const [url, payload] of [
        ["/api/mcp-services", { name: `${actor}-single`, url: "https://mcp.example.test/mcp", transport: "streamable_http", enabled: true, credentialUpdate: { mode: "clear" } }],
        ["/api/mcp-services/import", { mcpServers: { [`${actor}-import`]: { url: "https://mcp.example.test/mcp" } } }],
      ] as const) {
        const response = await f.app.inject({ method: "POST", url, headers, payload });
        assert.equal(response.statusCode, isAdmin ? 201 : 403, response.body);
        if (!isAdmin) assert.equal(response.json().error, "admin_role_required");
      }
    }
  } finally { await f.cleanup(); }
});

test("developers cannot grant global management and the last active manager is preserved", async () => {
  const f = await createApiFixture();
  try {
    await f.app.inject({ method: "POST", url: "/api/users", headers: admin, payload: { subject: "dev@example.test", name: "Dev", email: "dev@example.test", role: "developer" } });
    const headers = { "x-issue-pilot-subject": "dev@example.test" };
    const self = await f.app.inject({ method: "PATCH", url: "/api/users/dev@example.test", headers, payload: { name: "Dev", email: "dev@example.test", active: true, isAdmin: true } });
    assert.equal(self.statusCode, 403, self.body); assert.equal(self.json().error, "admin_role_required");
    const create = await f.app.inject({ method: "POST", url: "/api/users", headers, payload: { subject: "elevated@example.test", name: "Elevated", email: "elevated@example.test", isAdmin: true } });
    assert.equal(create.statusCode, 403, create.body);
    for (const actor of [headers, admin]) {
      const response = await f.app.inject({ method: "PATCH", url: `/api/users/${encodeURIComponent(owner)}`, headers: actor, payload: { name: "Owner", email: owner, active: true, isAdmin: false } });
      assert.equal(response.statusCode, actor === admin ? 409 : 403, response.body);
    }
    const me = await f.app.inject({ method: "GET", url: "/api/me", headers: admin });
    assert.equal(me.json().role, "developer"); assert.equal(me.json().isAdmin, true);
  } finally { await f.cleanup(); }
});

for (const change of ["role", "management", "active"] as const) test(`keeps a developer with management access when changing the last qualified manager's ${change}`, async () => {
  const f = await createApiFixture();
  try {
    for (const [subject, role, isAdmin] of [["dev@example.test", "developer", false], ["manager@example.test", "product", true]] as const) {
      const response = await f.app.inject({ method: "POST", url: "/api/users", headers: admin, payload: { subject, name: subject, email: subject, role, isAdmin } });
      assert.equal(response.statusCode, 201, response.body);
    }
    const independent = await f.app.inject({ method: "POST", url: "/api/mcp-services/import", headers: { "x-issue-pilot-subject": "manager@example.test" }, payload: { mcpServers: { independent: { url: "https://mcp.example.test/mcp" } } } });
    assert.equal(independent.statusCode, 201, independent.body);
    const payload = { name: "Owner", email: owner, active: change !== "active", role: change === "role" ? "product" : "developer", isAdmin: change !== "management" };
    const denied = await f.app.inject({ method: "PATCH", url: `/api/users/${encodeURIComponent(owner)}`, headers: admin, payload });
    assert.equal(denied.statusCode, 409, denied.body); assert.equal(denied.json().error, "last_active_admin");
    const promoted = await f.app.inject({ method: "PATCH", url: "/api/users/dev@example.test", headers: admin, payload: { name: "Dev", email: "dev@example.test", active: true, role: "developer", isAdmin: true } });
    assert.equal(promoted.statusCode, 200, promoted.body);
    const allowed = await f.app.inject({ method: "PATCH", url: `/api/users/${encodeURIComponent(owner)}`, headers: admin, payload });
    assert.equal(allowed.statusCode, 200, allowed.body);
  } finally { await f.cleanup(); }
});

test("reauthorizes global management after a queued MCP import", async () => {
  const f = await createApiFixture(), database = openDatabase(f.databaseFile), app = Fastify();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { entered = resolve; });
  registerMcpRoutes({ app, database, engine: f.engine, runScopeExclusive: async operation => { entered(); await gate; return operation(); } });
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof ApiError ? error.statusCode : 500).send({ error: error instanceof Error ? error.message : "internal_error" }));
  try {
    const pending = app.inject({ method: "POST", url: "/api/mcp-services/import", headers: admin, payload: { mcpServers: { queued: { url: "https://mcp.example.test/mcp" } } } }).then(value => value);
    await waiting;
    await database.db.update(subjects).set({ isAdmin: false }).where(eq(subjects.subject, owner));
    release();
    const response = await pending; assert.equal(response.statusCode, 403, response.body); assert.equal(response.json().error, "admin_role_required");
    assert.deepEqual((await f.app.inject({ method: "GET", url: "/api/mcp-services" })).json(), []);
  } finally { release(); await app.close(); database.close(); await f.cleanup(); }
});
