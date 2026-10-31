import assert from "node:assert/strict";
import { test } from "node:test";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { createApiFixture, createService, createIssue, servicePayload } from "./fixture.ts";
import { openDatabase } from "../../src/db/client.ts";
import { applicationSettings, serviceDeployments, userCredentials } from "../../src/db/schema.ts";
import { applyIssueCredentials } from "../../src/configuration/user-credentials.ts";
const headers: Record<string, string> = { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject };
const shared = { url: "https://shared.example.test/sse", authorization: "Bearer shared-dms-secret" };
const scope = { databases: [{ instanceAlias: "ORDERS", schemaName: "orders", instanceId: "1", instanceHost: "db", instancePort: "3306", databaseId: "2" }] };

test("shared DMS credentials are private, versioned, developer-only and reserve Issues", async () => {
  const f = await createApiFixture(); const db = openDatabase(f.databaseFile);
  try {
    await db.db.insert(applicationSettings).values({ id: 1, maxConcurrentIssues: 4, sharedSlsCredentials: { accessKeyId: "other-id", accessKeySecret: "other-secret" } });
    const get = () => f.app.inject({ method: "GET", url: "/api/config/shared-dms-credentials", headers });
    const put = (payload: Record<string, unknown>, selected = headers) => f.app.inject({ method: "PUT", url: "/api/config/shared-dms-credentials", headers: selected, payload });
    assert.deepEqual((await get()).json(), { configured: false, url: "", revision: 0 });
    const saved = await put({ mode: "replace", expectedRevision: 0, ...shared });
    assert.equal(saved.statusCode, 200, saved.body); assert.deepEqual(saved.json(), { configured: true, url: shared.url, revision: 1 });
    assert.equal(saved.headers["cache-control"], "private, no-store");
    assert.doesNotMatch(saved.body + (await get()).body + (await f.app.inject({ method: "GET", url: "/api/config" })).body, /shared-dms-secret|other-secret/);
    assert.equal((await db.db.select().from(applicationSettings))[0]!.maxConcurrentIssues, 4);
    assert.equal((await put({ mode: "replace", expectedRevision: 0, ...shared })).statusCode, 409);
    for (const payload of [{ mode: "replace", url: shared.url }, { mode: "replace", ...shared, url: "http://unsafe.example.test" }, { mode: "clear", authorization: shared.authorization }]) assert.equal((await put(payload)).statusCode, 400);
    await f.app.inject({ method: "POST", url: "/api/users", headers, payload: { subject: "viewer", name: "Viewer", email: "viewer@example.test", role: "product" } });
    const viewer = { "x-issue-pilot-subject": "viewer" };
    assert.equal((await f.app.inject({ method: "GET", url: "/api/config/shared-dms-credentials", headers: viewer })).statusCode, 403);
    assert.equal((await put({ mode: "clear", expectedRevision: 1 }, viewer)).statusCode, 403);
    await createService(f.app, "Busy"); await createIssue(f.app, "busy");
    assert.equal((await put({ mode: "clear", expectedRevision: 1 })).statusCode, 409);
    assert.equal((await get()).json().configured, true);
    f.engine.running.clear();
    assert.deepEqual((await put({ mode: "clear", expectedRevision: 1 })).json(), { configured: false, url: "", revision: 2 });
    const [row] = await db.db.select().from(applicationSettings);
    assert.equal(row!.sharedDmsCredentials, null); assert.equal(row!.sharedSlsCredentials!.accessKeySecret, "other-secret");
    assert.ok(f.engine.closedSessions.length > 0);
  } finally { await db.close(); await f.cleanup(); }
});

test("services save DMS targets without requiring or storing connection credentials", async () => {
  const f = await createApiFixture(); const db = openDatabase(f.databaseFile);
  try {
    const service = await createService(f.app, "Scope", ["prod", "test"]);
    const input = servicePayload("Scope", ["prod", "test"]);
    const definition = { ...input, deployments: input.deployments.map(row => ({ ...row, capabilities: ["dms"], dms: scope })) };
    const saved = await f.app.inject({ method: "PATCH", url: `/api/services/${service.key}`, headers, payload: definition }); assert.equal(saved.statusCode, 200, saved.body);
    const rows = await db.db.select().from(serviceDeployments);
    assert.ok(rows.every(row => JSON.stringify(row.config.dms) === JSON.stringify(scope)));
    for (const extra of [{ authorization: shared.authorization }, { url: shared.url }, { credentialUpdate: { mode: "replace", values: shared } }]) {
      const result = await f.app.inject({ method: "PATCH", url: `/api/services/${service.key}`, headers, payload: { ...definition, deployments: definition.deployments.map(row => ({ ...row, dms: { ...scope, ...extra } })) } });
      assert.equal(result.statusCode, 400, result.body);
    }
    assert.deepEqual(await db.db.select().from(serviceDeployments), rows);
    assert.equal((await db.db.select().from(applicationSettings)).length, 0);
  } finally { await db.close(); await f.cleanup(); }
});

test("DMS selects complete personal credentials before shared credentials in both environments", async () => {
  const f = await createApiFixture(); const db = openDatabase(f.databaseFile);
  try {
    await db.db.insert(userCredentials).values({ subject: issuePilotConfig.bootstrapUser.subject, productionDmsUrl: "https://personal.example.test/sse", productionDmsAuthorization: "Bearer personal-secret" });
    const [personal] = await db.db.select().from(userCredentials); assert.ok(personal);
    const stored = { dms: { ...scope, url: "https://retired.example.test/sse", authorization: "Bearer retired" } };
    assert.deepEqual(applyIssueCredentials(stored, personal, { dms: shared }).dms, { ...scope, url: personal.productionDmsUrl, authorization: personal.productionDmsAuthorization });
    assert.deepEqual(applyIssueCredentials(stored, undefined, { dms: shared }).dms, { ...scope, ...shared });
    assert.throws(() => applyIssueCredentials(stored), /dms_credentials_not_configured/);
    assert.throws(() => applyIssueCredentials(stored, { ...personal, productionDmsUrl: "" }, { dms: shared }), /personal_dms_credentials_incomplete/);
    assert.throws(() => applyIssueCredentials(stored, { ...personal, productionDmsAuthorization: "" }, { dms: shared }), /personal_dms_credentials_incomplete/);
    assert.equal(applyIssueCredentials({}, personal, { dms: shared }).dms, undefined);
    assert.equal(stored.dms.authorization, "Bearer retired");
  } finally { await db.close(); await f.cleanup(); }
});
