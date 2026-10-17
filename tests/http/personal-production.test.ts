import assert from "node:assert/strict";
import { test } from "node:test";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { createApiFixture } from "./fixture.ts";
import { openDatabase } from "../../src/db/client.ts";
import { userCredentials } from "../../src/db/schema.ts";
import { applyProductionCredentials } from "../../src/configuration/user-credentials.ts";
import type { DeploymentConfig } from "../../src/domain/contracts.ts";

test("personal production credentials are private and override each configured production capability independently", async () => {
  const f = await createApiFixture(); const db = openDatabase(f.databaseFile);
  const headers = { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject };
  try {
    const saved = await f.app.inject({ method: "PUT", url: "/api/me/credentials", headers, payload: { production: { dms: { mode: "replace", url: "https://personal.example.test/sse", authorization: "Bearer personal-token" }, sls: { mode: "replace", accessKeyId: "personal-id", accessKeySecret: "personal-secret" } } } });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.doesNotMatch(saved.body, /personal-token|personal-id|personal-secret/);
    assert.equal(JSON.parse(saved.body).productionDmsUrl, "https://personal.example.test/sse");
    const [credentials] = await db.db.select().from(userCredentials);
    const config: DeploymentConfig = { dms: { url: "https://service.example.test/sse", authorization: "Bearer service-token", databases: [] }, sls: { accessKeyId: "service-id", accessKeySecret: "service-secret", region: "cn-hangzhou", project: "orders", logstores: ["application"] } };
    assert.equal(applyProductionCredentials(config, "test", credentials), config);
    assert.equal(applyProductionCredentials(config, "prod"), config);
    const personal = applyProductionCredentials(config, "prod", credentials);
    assert.equal(personal.dms!.authorization, "Bearer personal-token"); assert.equal(personal.sls!.accessKeySecret, "personal-secret");
    assert.equal(personal.sls!.project, "orders"); assert.equal(config.dms!.authorization, "Bearer service-token");
    assert.equal((await f.app.inject({ method: "PUT", url: "/api/me/credentials", headers, payload: { production: { dms: { mode: "clear" } } } })).statusCode, 200);
    const [cleared] = await db.db.select().from(userCredentials);
    const mixed = applyProductionCredentials(config, "prod", cleared);
    assert.equal(mixed.dms!.authorization, "Bearer service-token"); assert.equal(mixed.sls!.accessKeySecret, "personal-secret");
    const invalid = await f.app.inject({ method: "PUT", url: "/api/me/credentials", headers, payload: { production: { dms: { mode: "replace", url: "http://unsafe.example.test", authorization: "Bearer token" } } } });
    assert.equal(invalid.statusCode, 400);
    for (const role of ["product", "test"]) {
      const created = await f.app.inject({ method: "POST", url: "/api/users", headers, payload: { subject: `production-${role}`, name: role, email: `${role}@example.test`, role } });
      assert.equal(created.statusCode, 201);
      const personalHeaders = { "x-issue-pilot-subject": `production-${role}` };
      const response = await f.app.inject({ method: "PUT", url: "/api/me/credentials", headers: personalHeaders, payload: { production: { sls: { mode: "replace", accessKeyId: `${role}-id`, accessKeySecret: `${role}-secret` } } } });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(JSON.parse(response.body).productionSlsConfigured, true);
      assert.doesNotMatch(response.body, new RegExp(`${role}-secret|${role}-id`));
      assert.equal((await f.app.inject({ method: "PUT", url: "/api/me/credentials", headers: personalHeaders, payload: { git: { mode: "clear" } } })).statusCode, 403);
    }
    const read = await f.app.inject({ method: "GET", url: "/api/me/credentials", headers }); assert.doesNotMatch(read.body, /personal-token|personal-id|personal-secret/);
  } finally { await db.close(); await f.cleanup(); }
});
