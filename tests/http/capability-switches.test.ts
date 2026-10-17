import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { loadEnabledCapabilities } from "../../src/configuration/capability-switches.ts";
import { openDatabase } from "../../src/db/client.ts";
import { serviceDeployments } from "../../src/db/schema.ts";
import { createAgentSessionContext, sessionToolAllowlist } from "../../src/agent/context.ts";
import { createApiFixture, createIssue, createService, testAgent } from "./fixture.ts";

const headers = { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject };

test("global switches reserve affected Issues and remove capabilities without deleting deployment config", async () => {
  const f = await createApiFixture();
  const db = openDatabase(f.databaseFile);
  try {
    await createService(f.app, "Switches", ["test"]);
    const [deployment] = await db.db.select().from(serviceDeployments).limit(1);
    const config = { redis: { host: "redis.example.test", port: 6379, username: "", database: 0 } };
    await db.db.update(serviceDeployments).set({ config }).where(eq(serviceDeployments.id, deployment!.id));
    await createIssue(f.app, "switches", "test");
    const before = await f.app.inject({ method: "GET", url: "/api/capabilities" });
    assert.equal(before.headers["cache-control"], "private, no-store");
    assert.equal(JSON.parse(before.body).filter((row: { enabled: boolean }) => row.enabled).length, 7);
    const blocked = await f.app.inject({ method: "PATCH", url: "/api/capabilities/redis", headers, payload: { enabled: false } });
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.equal(JSON.parse(blocked.body).error, "capability_has_running_issues");
    // Other capabilities with no affected running Issue can still be changed.
    assert.equal((await f.app.inject({ method: "PATCH", url: "/api/capabilities/dms", headers, payload: { enabled: false } })).statusCode, 200);
    f.engine.running.clear();
    f.engine.closeSessionHook = async () => { throw new Error("stop_failed"); };
    assert.equal((await f.app.inject({ method: "PATCH", url: "/api/capabilities/redis", headers, payload: { enabled: false } })).statusCode, 500);
    assert.ok((await loadEnabledCapabilities(db.db)).includes("redis"));
    f.engine.closeSessionHook = undefined;
    const saved = await f.app.inject({ method: "PATCH", url: "/api/capabilities/redis", headers, payload: { enabled: false } });
    assert.equal(saved.statusCode, 200, saved.body);
    const enabledCapabilities = await loadEnabledCapabilities(db.db);
    assert.equal(enabledCapabilities.includes("redis"), false);
    assert.deepEqual((await db.db.select().from(serviceDeployments).limit(1))[0]!.config, config);
    const context = createAgentSessionContext({ issueKey: "ISSUE-20261016-001", issueType: "smart_analysis", serviceKey: "switches", environmentKey: "test", environmentKind: "test", agentConfiguration: testAgent, deploymentConfig: config, enabledCapabilities, repositoryAccess: ["read"] });
    assert.equal(context.capabilities.includes("redis"), false);
    assert.equal(sessionToolAllowlist(context).includes("service_query"), false);
    assert.equal((await f.app.inject({ method: "PATCH", url: "/api/capabilities/redis", headers, payload: { enabled: true } })).statusCode, 200);
    assert.ok((await loadEnabledCapabilities(db.db)).includes("redis"));
  } finally { db.close(); await f.cleanup(); }
});

test("validates global capability switches and denies product and test mutations", async () => {
  const f = await createApiFixture();
  try {
    for (const role of ["product", "test"]) {
      await f.app.inject({ method: "POST", url: "/api/users", headers, payload: { subject: role, name: role, email: `${role}@example.test`, role } });
      assert.equal((await f.app.inject({ method: "PATCH", url: "/api/capabilities/db", headers: { "x-issue-pilot-subject": role }, payload: { enabled: false } })).statusCode, 403);
    }
    assert.equal((await f.app.inject({ method: "PATCH", url: "/api/capabilities/unknown", headers, payload: { enabled: false } })).statusCode, 400);
    assert.equal((await f.app.inject({ method: "PATCH", url: "/api/capabilities/db", headers, payload: { enabled: "false" } })).statusCode, 400);
  } finally { await f.cleanup(); }
});
