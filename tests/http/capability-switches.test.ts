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
test("global switches reserve affected Issues and retain private deployment configuration", async () => {
  const f = await createApiFixture(), db = openDatabase(f.databaseFile);
  try {
    await createService(f.app, "Switches", ["test"]);
    const [deployment] = await db.db.select().from(serviceDeployments).limit(1);
    const config = { sls: { region: "cn-test", project: "orders-test", logstores: ["application"], accessKeyId: "key", accessKeySecret: "secret" } };
    await db.db.update(serviceDeployments).set({ config }).where(eq(serviceDeployments.id, deployment!.id));
    await createIssue(f.app, "switches", "test");
    const before = await f.app.inject({ method: "GET", url: "/api/capabilities" });
    assert.equal(before.headers["cache-control"], "private, no-store");
    assert.deepEqual(before.json().map((row: { key: string }) => row.key), ["dms", "sls"]);
    const blocked = await f.app.inject({ method: "PATCH", url: "/api/capabilities/sls", headers, payload: { enabled: false } });
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().error, "capability_has_running_issues");
    assert.equal((await f.app.inject({ method: "PATCH", url: "/api/capabilities/dms", headers, payload: { enabled: false } })).statusCode, 200);
    f.engine.running.clear();
    f.engine.closeSessionHook = async () => { throw new Error("stop_failed"); };
    assert.equal((await f.app.inject({ method: "PATCH", url: "/api/capabilities/sls", headers, payload: { enabled: false } })).statusCode, 500);
    assert.ok((await loadEnabledCapabilities(db.db)).includes("sls"));
    f.engine.closeSessionHook = undefined;
    assert.equal((await f.app.inject({ method: "PATCH", url: "/api/capabilities/sls", headers, payload: { enabled: false } })).statusCode, 200);
    const enabledCapabilities = await loadEnabledCapabilities(db.db);
    assert.equal(enabledCapabilities.includes("sls"), false);
    assert.deepEqual((await db.db.select().from(serviceDeployments).limit(1))[0]!.config, config);
    const context = createAgentSessionContext({ issueKey: "ISSUE-20261016-001", issueType: "smart_analysis", serviceKey: "switches", environmentKey: "test", environmentKind: "test", agentConfiguration: testAgent, deploymentConfig: config, enabledCapabilities, repositoryAccess: ["read"] });
    assert.equal(sessionToolAllowlist(context).includes("service_query"), false);
    assert.equal((await f.app.inject({ method: "PATCH", url: "/api/capabilities/sls", headers, payload: { enabled: true } })).statusCode, 200);
    assert.ok((await loadEnabledCapabilities(db.db)).includes("sls"));
  } finally { db.close(); await f.cleanup(); }
});
test("rejects retired capability keys and denies product and test mutations", async () => {
  const f = await createApiFixture();
  try {
    for (const role of ["product", "test"]) {
      await f.app.inject({ method: "POST", url: "/api/users", headers, payload: { subject: role, name: role, email: `${role}@example.test`, role } });
      assert.equal((await f.app.inject({ method: "PATCH", url: "/api/capabilities/sls", headers: { "x-issue-pilot-subject": role }, payload: { enabled: false } })).statusCode, 403);
    }
    for (const key of ["unknown", "nacos", "redis", "mq", "es", "db"]) assert.equal((await f.app.inject({ method: "PATCH", url: `/api/capabilities/${key}`, headers, payload: { enabled: false } })).statusCode, 400);
  } finally { await f.cleanup(); }
});
