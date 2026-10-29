import assert from "node:assert/strict";
import { test } from "node:test";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { createApiFixture, createService, createIssue, servicePayload } from "./fixture.ts";
import { openDatabase } from "../../src/db/client.ts";
import { applicationSettings, serviceDeployments, userCredentials } from "../../src/db/schema.ts";
import { applyIssueCredentials } from "../../src/configuration/user-credentials.ts";
const headers: Record<string, string> = { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject };
const scope = { region: "cn-test", project: "orders-test", logstores: ["*"] };
const shared = { accessKeyId: "shared-fixture-id", accessKeySecret: "shared-fixture-secret" };

test("shared SLS credentials are private, versioned and reserve active Issues", async () => {
  const f = await createApiFixture(); const db = openDatabase(f.databaseFile);
  try {
    await db.db.insert(applicationSettings).values({ id: 1, maxConcurrentIssues: 4 });
    const get = () => f.app.inject({ method: "GET", url: "/api/config/shared-sls-credentials", headers });
    const put = (payload: Record<string, unknown>, selected = headers) => f.app.inject({ method: "PUT", url: "/api/config/shared-sls-credentials", headers: selected, payload });
    const initial = await get(); assert.equal(initial.headers["cache-control"], "private, no-store"); assert.deepEqual(initial.json(), { configured: false, revision: 0 });
    const save = await put({ mode: "replace", expectedRevision: 0, ...shared });
    assert.equal(save.statusCode, 200, save.body); assert.deepEqual(save.json(), { configured: true, revision: 1 });
    assert.doesNotMatch(save.body + (await get()).body + (await f.app.inject({ method: "GET", url: "/api/config" })).body, /shared-fixture/);
    assert.equal((await db.db.select().from(applicationSettings))[0]!.maxConcurrentIssues, 4);
    assert.equal((await put({ mode: "replace", expectedRevision: 0, ...shared })).statusCode, 409);
    assert.equal((await put({ mode: "replace", expectedRevision: 1, accessKeyId: "partial" })).statusCode, 400);
    await f.app.inject({ method: "POST", url: "/api/users", headers, payload: { subject: "viewer", name: "Viewer", email: "viewer@example.test", role: "product" } });
    const viewer = { "x-issue-pilot-subject": "viewer" };
    assert.equal((await f.app.inject({ method: "GET", url: "/api/config/shared-sls-credentials", headers: viewer })).statusCode, 403);
    assert.equal((await put({ mode: "clear", expectedRevision: 1 }, viewer)).statusCode, 403);
    await createService(f.app, "Busy"); await createIssue(f.app, "busy");
    const blocked = await put({ mode: "clear", expectedRevision: 1 }); assert.equal(blocked.statusCode, 409, blocked.body);
    assert.deepEqual((await get()).json(), { configured: true, revision: 1 });
    f.engine.running.clear();
    const cleared = await put({ mode: "clear", expectedRevision: 1 }); assert.equal(cleared.statusCode, 200, cleared.body);
    assert.deepEqual(cleared.json(), { configured: false, revision: 2 });
    assert.equal((await db.db.select().from(applicationSettings))[0]!.sharedSlsCredentials, null);
    assert.ok(f.engine.closedSessions.length > 0);
  } finally { await db.close(); await f.cleanup(); }
});

test("services save only SLS scope without requiring or storing connection credentials", async () => {
  const f = await createApiFixture(); const db = openDatabase(f.databaseFile);
  try {
    const service = await createService(f.app, "Scope", ["prod", "test"]);
    const input = servicePayload("Scope", ["prod", "test"]);
    const definition = { ...input, deployments: input.deployments.map(row => ({ ...row, capabilities: ["sls"], sls: scope })) };
    const saved = await f.app.inject({ method: "PATCH", url: `/api/services/${service.key}`, headers, payload: definition }); assert.equal(saved.statusCode, 200, saved.body);
    const rows = await db.db.select().from(serviceDeployments); assert.ok(rows.every(row => JSON.stringify(row.config.sls) === JSON.stringify(scope)));
    const publicConfig = await f.app.inject({ method: "GET", url: "/api/config" });
    assert.doesNotMatch(publicConfig.body, /accessKeyId|accessKeySecret/);
    const invalid = { ...definition, deployments: definition.deployments.map(row => ({ ...row, sls: { ...scope, credentialUpdate: { mode: "replace", values: shared } } })) };
    const rejected = await f.app.inject({ method: "PATCH", url: `/api/services/${service.key}`, headers, payload: invalid }); assert.equal(rejected.statusCode, 400, rejected.body);
    assert.equal(rejected.json().error, "service_sls_credentials_not_allowed");
    assert.deepEqual(await db.db.select().from(serviceDeployments), rows);
    assert.equal((await db.db.select().from(applicationSettings)).length, 0);
  } finally { await db.close(); await f.cleanup(); }
});

test("SLS chooses complete personal credentials before shared credentials in both environments", async () => {
  const f = await createApiFixture(); const db = openDatabase(f.databaseFile);
  try {
    await db.db.insert(userCredentials).values({ subject: issuePilotConfig.bootstrapUser.subject, productionSlsAccessKeyId: "personal-id", productionSlsAccessKeySecret: "personal-secret" });
    const [personal] = await db.db.select().from(userCredentials); assert.ok(personal);
    for (const environment of ["prod", "test"]) {
      const original = { sls: { ...scope, ...shared } };
      const selected = applyIssueCredentials(original, environment, personal, shared);
      assert.equal(selected.sls!.accessKeyId, "personal-id"); assert.equal(selected.sls!.accessKeySecret, "personal-secret");
      assert.deepEqual(selected.sls!.logstores, ["*"]); assert.equal(original.sls.accessKeyId, shared.accessKeyId);
      assert.deepEqual(applyIssueCredentials({ sls: scope }, environment, undefined, shared).sls, { ...scope, ...shared });
      assert.throws(() => applyIssueCredentials(original, environment), /sls_credentials_not_configured/);
      assert.throws(() => applyIssueCredentials(original, environment, { ...personal, productionSlsAccessKeySecret: "" }, shared), /personal_sls_credentials_incomplete/);
      assert.equal(applyIssueCredentials({}, environment, personal, shared).sls, undefined);
    }
  } finally { await db.close(); await f.cleanup(); }
});
