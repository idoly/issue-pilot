import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { openDatabase } from "../../src/db/client.ts";
import { mcpServices } from "../../src/db/schema.ts";
import { createApiFixture } from "./fixture.ts";

const headers = { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject };

test("edits MCP JSON while preserving omitted credentials and requiring explicit replacement on target changes", async () => {
  const f = await createApiFixture(), database = openDatabase(f.databaseFile);
  try {
    const created = await f.app.inject({ method: "POST", url: "/api/mcp-services/import", headers, payload: { mcpServers: { Docs: { url: "https://docs.example.test/mcp", headers: { Authorization: "Bearer private-json-token" } } } } });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json()[0].id, endpoint = `/api/mcp-services/${id}`;
    const configuration = await f.app.inject({ method: "GET", url: `${endpoint}/configuration`, headers });
    assert.equal(configuration.statusCode, 200, configuration.body);
    assert.equal(configuration.headers["cache-control"], "private, no-store");
    assert.equal(configuration.headers.pragma, "no-cache");
    assert.deepEqual(configuration.json(), { mcpServers: { Docs: { url: "https://docs.example.test/mcp", headers: { Authorization: "Bearer private-json-token" } } } });
    const saved = await f.app.inject({ method: "PATCH", url: endpoint, headers, payload: { mcpServers: { Renamed: { type: "http", url: "https://docs.example.test/mcp", enabled: false } } } });
    assert.equal(saved.statusCode, 200, saved.body); assert.equal(saved.json().name, "Renamed");
    assert.equal(saved.body.includes("private-json-token"), false);
    const [stored] = await database.db.select().from(mcpServices).where(eq(mcpServices.id, id));
    assert.equal(stored!.authorization, "Bearer private-json-token"); assert.equal(stored!.enabled, false);
    const moved = await f.app.inject({ method: "PATCH", url: endpoint, headers, payload: { mcpServers: { Renamed: { url: "https://other.example.test/mcp" } } } });
    assert.equal(moved.statusCode, 400); assert.equal(moved.json().error, "mcp_credentials_target_changed");
    const cleared = await f.app.inject({ method: "PATCH", url: endpoint, headers, payload: { mcpServers: { Renamed: { url: "https://other.example.test/mcp", headers: {} } } } });
    assert.equal(cleared.statusCode, 200, cleared.body); assert.equal(cleared.json().credentialConfigured, false);
    for (const mcpServers of [{}, { one: { url: "https://one.example.test" }, two: { url: "https://two.example.test" } }]) {
      const invalid = await f.app.inject({ method: "PATCH", url: endpoint, headers, payload: { mcpServers } });
      assert.equal(invalid.statusCode, 400); assert.equal(invalid.json().error, "invalid_mcp_servers");
    }
  } finally { database.close(); await f.cleanup(); }
});

test("stdio JSON edits preserve hidden process configuration or replace it completely", async () => {
  const f = await createApiFixture(), database = openDatabase(f.databaseFile);
  try {
    const processConfig = { command: "fixture-command", args: ["private-argument"], env: { TOKEN: "private-env" }, cwd: "fixture-directory" };
    const created = await f.app.inject({ method: "POST", url: "/api/mcp-services/import", headers, payload: { mcpServers: { Local: processConfig } } });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json()[0].id, endpoint = `/api/mcp-services/${id}`;
    const configuration = await f.app.inject({ method: "GET", url: `${endpoint}/configuration`, headers });
    assert.equal(configuration.statusCode, 200, configuration.body);
    assert.deepEqual(configuration.json(), { mcpServers: { Local: processConfig } });
    const listing = await f.app.inject({ method: "GET", url: "/api/mcp-services" });
    assert.doesNotMatch(listing.body, /private-env|private-argument|fixture-directory/);
    await f.app.inject({ method: "POST", url: "/api/users", headers, payload: { subject: "product@example.test", name: "Product", email: "product@example.test", role: "product" } });
    const forbidden = await f.app.inject({ method: "GET", url: `${endpoint}/configuration`, headers: { "x-issue-pilot-subject": "product@example.test" } });
    assert.equal(forbidden.statusCode, 403); assert.doesNotMatch(forbidden.body, /private-env|private-argument|fixture-directory/);
    const preserved = await f.app.inject({ method: "PATCH", url: endpoint, headers, payload: { mcpServers: { Renamed: { type: "stdio", enabled: false } } } });
    assert.equal(preserved.statusCode, 200, preserved.body);
    assert.doesNotMatch(preserved.body, /private-env|private-argument|fixture-directory/);
    const [stored] = await database.db.select().from(mcpServices).where(eq(mcpServices.id, id));
    assert.deepEqual(stored!.stdio, processConfig);
    const partial = await f.app.inject({ method: "PATCH", url: endpoint, headers, payload: { mcpServers: { Renamed: { type: "stdio", args: ["partial"] } } } });
    assert.equal(partial.statusCode, 400); assert.equal(partial.json().error, "invalid_mcp_stdio");
    const replaced = await f.app.inject({ method: "PATCH", url: endpoint, headers, payload: { mcpServers: { Renamed: { command: "replacement", args: [], env: {}, enabled: true } } } });
    assert.equal(replaced.statusCode, 200, replaced.body);
    const [next] = await database.db.select().from(mcpServices).where(eq(mcpServices.id, id));
    assert.deepEqual(next!.stdio, { command: "replacement", args: [], env: {} }); assert.equal(next!.enabled, true);
  } finally { database.close(); await f.cleanup(); }
});
