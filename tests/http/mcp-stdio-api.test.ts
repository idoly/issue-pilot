import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { eq } from "drizzle-orm";
import { createApiFixture, createIssue, createService } from "./fixture.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { openDatabase } from "../../src/db/client.ts";
import { mcpServices, subjects } from "../../src/db/schema.ts";
import { registerMcpRoutes } from "../../src/http/mcp-routes.ts";
import { ApiError } from "../../src/http/input.ts";

const headers = { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject };
const server = fileURLToPath(new URL("../helpers/mcp-stdio-server.mjs", import.meta.url));
const launch = { command: process.execPath, args: [server], env: { MCP_FIXTURE_SECRET: "private-env-token" } };
const input = { name: "Local", url: "", transport: "stdio", enabled: true, credentialUpdate: { mode: "replace", values: { stdio: launch } } };

test("stores private stdio configuration, preserves it and treats repeated replacements as a no-op", async () => {
  const f = await createApiFixture(), database = openDatabase(f.databaseFile);
  try {
    const added = await f.app.inject({ method: "POST", url: "/api/mcp-services", headers, payload: input });
    assert.equal(added.statusCode, 201, added.body);
    const row = added.json(); assert.equal(row.transport, "stdio"); assert.equal(row.credentialConfigured, true);
    assert.equal(added.body.includes("private-env-token"), false); assert.equal("stdio" in row, false);
    const tested = await f.app.inject({ method: "POST", url: `/api/mcp-services/${row.id}/test`, headers });
    assert.equal(tested.statusCode, 200, tested.body); assert.equal(tested.json().tools.length, 6);
    assert.equal(tested.body.includes("private-env-token"), false);
    await createService(f.app, "Running", ["test"]); await createIssue(f.app, "running", "test");
    const repeated = await f.app.inject({ method: "PATCH", url: `/api/mcp-services/${row.id}`, headers, payload: input });
    assert.equal(repeated.statusCode, 200, repeated.body);
    f.engine.running.clear();
    const preserved = await f.app.inject({ method: "PATCH", url: `/api/mcp-services/${row.id}`, headers, payload: { ...input, name: "Renamed", credentialUpdate: { mode: "preserve" } } });
    assert.equal(preserved.statusCode, 200, preserved.body);
    const [stored] = await database.db.select().from(mcpServices).where(eq(mcpServices.id, row.id));
    assert.deepEqual(stored!.stdio, launch);
    const listing = await f.app.inject({ method: "GET", url: "/api/mcp-services" });
    assert.equal(listing.body.includes("private-env-token"), false); assert.equal(listing.body.includes(server), false);
    const invalidClear = await f.app.inject({ method: "PATCH", url: `/api/mcp-services/${row.id}`, headers, payload: { ...input, credentialUpdate: { mode: "clear" } } });
    assert.equal(invalidClear.statusCode, 400);
    const cleared = await f.app.inject({ method: "PATCH", url: `/api/mcp-services/${row.id}`, headers, payload: { ...input, enabled: false, credentialUpdate: { mode: "clear" } } });
    assert.equal(cleared.statusCode, 200, cleared.body); assert.equal(cleared.json().credentialConfigured, false);
  } finally { database.close(); await f.cleanup(); }
});

test("imports standard mcpServers atomically and never executes an import", async () => {
  const f = await createApiFixture();
  try {
    const payload = { mcpServers: { playwright: { command: "npx", args: ["@playwright/mcp@latest"], env: { API_TOKEN: "private-import-token" } }, remote: { url: "https://example.test/mcp", headers: { Authorization: "Bearer private-http-token" } } } };
    const added = await f.app.inject({ method: "POST", url: "/api/mcp-services/import", headers, payload });
    assert.equal(added.statusCode, 201, added.body); assert.equal(added.json().length, 2);
    assert.equal(added.body.includes("private-import-token"), false); assert.equal(added.body.includes("private-http-token"), false);
    assert.deepEqual(added.json().map((row: { transport: string }) => row.transport).sort(), ["stdio", "streamable_http"]);
    const duplicate = await f.app.inject({ method: "POST", url: "/api/mcp-services/import", headers, payload: { mcpServers: { new_server: launch, playwright: launch } } });
    assert.equal(duplicate.statusCode, 409, duplicate.body);
    const invalid = await f.app.inject({ method: "POST", url: "/api/mcp-services/import", headers, payload: { mcpServers: { another: launch, invalid: { ...launch, env: { TOKEN: 123 } } } } });
    assert.equal(invalid.statusCode, 400);
    const malformed = await f.app.inject({ method: "POST", url: "/api/mcp-services/import", headers: { ...headers, "content-type": "application/json" }, payload: '{"mcpServers":{"local":{"env":{"TOKEN":"private-parse-token"' });
    assert.equal(malformed.statusCode, 400, malformed.body);
    assert.deepEqual(malformed.json(), { error: "invalid_json" });
    const listing = await f.app.inject({ method: "GET", url: "/api/mcp-services" });
    assert.deepEqual(listing.json().map((row: { name: string }) => row.name).sort(), ["playwright", "remote"]);
    assert.equal(listing.body.includes("private-import-token"), false);
  } finally { await f.cleanup(); }
});

test("reauthorizes a queued connection test before starting a local process", { timeout: 10_000 }, async () => {
  const f = await createApiFixture(), database = openDatabase(f.databaseFile), app = Fastify();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { entered = resolve; });
  registerMcpRoutes({ app, database, engine: f.engine, runScopeExclusive: async operation => { entered(); await gate; return operation(); } });
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof ApiError ? error.statusCode : 500).send({ error: error instanceof Error ? error.message : "internal_error" }));
  try {
    await f.app.inject({ method: "POST", url: "/api/users", headers, payload: { subject: "other-developer", name: "Other", email: "other@example.test", role: "developer" } });
    const created = await f.app.inject({ method: "POST", url: "/api/mcp-services", headers, payload: { ...input, credentialUpdate: { mode: "replace", values: { stdio: { ...launch, cwd: path.resolve(f.root) } } } } });
    assert.equal(created.statusCode, 201, created.body);
    const pending = app.inject({ method: "POST", url: `/api/mcp-services/${created.json().id}/test`, headers }).then(value => value);
    await waiting;
    await database.db.update(subjects).set({ role: "product" }).where(eq(subjects.subject, issuePilotConfig.bootstrapUser.subject));
    release(); const result = await pending;
    assert.equal(result.statusCode, 403, result.body); assert.equal(result.json().error, "developer_role_required");
  } finally { release(); await app.close(); database.close(); await f.cleanup(); }
});
