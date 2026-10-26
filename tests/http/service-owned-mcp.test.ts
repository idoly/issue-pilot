import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { createApiFixture, createService } from "./fixture.ts";
import { openDatabase } from "../../src/db/client.ts";
import { mcpServices, serviceDeployments, services, environments, userPreferences } from "../../src/db/schema.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { dingtalkMcpNames, serviceMcpConnections } from "../../src/configuration/service-mcp.ts";
import { createCapabilityTools } from "../../src/agent/service-query-tool.ts";
import { Compile } from "typebox/compile";

test("service descriptions and executable MCP selection use deployment ownership and exclude import connections", async () => {
  const f = await createApiFixture(), database = openDatabase(f.databaseFile);
  try {
    await createService(f.app, "Selected", ["test", "prod"]);
    await createService(f.app, "Other", ["test"]);
    const scopes = await database.db.select({ deployment: serviceDeployments, service: services.key, environment: environments.key }).from(serviceDeployments).innerJoin(services, eq(services.id, serviceDeployments.serviceId)).innerJoin(environments, eq(environments.id, serviceDeployments.environmentId));
    const selected = scopes.find(row => row.service === "selected" && row.environment === "test")!;
    const other = scopes.find(row => row.service === "other")!;
    await database.db.insert(userPreferences).values({ subject: issuePilotConfig.bootstrapUser.subject, dingtalk: { source: { mcp: "imports-custom", url: "https://docs.example.test/record" } } });
    await database.db.insert(mcpServices).values([
      { id: "selected-tool", name: "Selected evidence", url: "https://selected.example.test/mcp", transport: "streamable_http", enabled: true, deploymentId: selected.deployment.id },
      { id: "other-tool", name: "Other evidence", url: "https://other.example.test/mcp", transport: "streamable_http", enabled: true, deploymentId: other.deployment.id },
      { id: "unowned", name: "Unowned evidence", url: "https://unowned.example.test/mcp", transport: "streamable_http", enabled: true },
      { id: "import", name: "dingtalk", url: "https://imports.example.test/mcp", transport: "streamable_http", enabled: true, deploymentId: selected.deployment.id },
      { id: "custom-import", name: "imports-custom", url: "https://custom-import.example.test/mcp", transport: "streamable_http", enabled: true, deploymentId: selected.deployment.id },
    ]);
    const rows = await database.db.select().from(mcpServices);
    assert.deepEqual(serviceMcpConnections(rows, [selected.deployment.id], await dingtalkMcpNames(database.db)).map(row => row.id), ["selected-tool"]);
    const dms = { url: "https://dms.example.test/sse", authorization: "Bearer private-fixture", databases: [{ instanceAlias: "TEST-DB", schemaName: "configured_test", instanceId: "", instanceHost: "", instancePort: "", databaseId: "" }] };
    await database.db.update(serviceDeployments).set({ config: { dms } }).where(eq(serviceDeployments.id, selected.deployment.id));
    const config = (await f.app.inject({ method: "GET", url: "/api/config" })).json();
    const service = config.services.find((row: { key: string }) => row.key === "selected");
    assert.match(service.context, /Selected evidence|configured_test/);
    assert.doesNotMatch(service.context, /Other evidence|Unowned evidence|imports-custom|dingtalk|MCP（全局）|private-fixture|SLS/);
    assert.deepEqual(service.deployments.find((row: { environmentKey: string }) => row.environmentKey === "test").capabilities, ["dms"]);
    const description = await f.app.inject({ method: "GET", url: "/api/services/selected/configuration-description", headers: { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject } });
    assert.match(description.json().context, /Selected evidence/);
    assert.doesNotMatch(description.body, /Other evidence|Unowned evidence|imports-custom|MCP（全局）/);
    // Configuration controls availability, irrespective of a test/prod label.
    const [tool] = createCapabilityTools({ serviceKey: "selected", environmentKey: "test", capabilities: ["dms", "sls"] }, { dms });
    assert.ok(tool);
    assert.equal(Compile(tool.parameters).Check({ service: "selected", environment: "test", capability: "dms", schema: "configured_test", script: "SELECT 1" }), true);
    assert.deepEqual(createCapabilityTools({ serviceKey: "other", environmentKey: "test", capabilities: ["dms", "sls"] }, {}), []);
  } finally { await database.close(); await f.cleanup(); }
});
