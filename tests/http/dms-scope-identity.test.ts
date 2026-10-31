import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { openDatabase } from "../../src/db/client.ts";
import { userCredentials } from "../../src/db/schema.ts";
import { createApiFixture } from "./fixture.ts";

test("DMS scope resolution selects the caller's personal credentials and never falls back after failure", async () => {
  const f = await createApiFixture(), db = openDatabase(f.databaseFile), original = globalThis.fetch;
  const headers = { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject };
  const requests: Array<{ url: string; authorization: string | null }> = [];
  try {
    const shared = await f.app.inject({ method: "PUT", url: "/api/config/shared-dms-credentials", headers, payload: { expectedRevision: 0, mode: "replace", url: "https://shared.example.test/sse", authorization: "Bearer shared-secret" } });
    assert.equal(shared.statusCode, 200, shared.body);
    const personal = await f.app.inject({ method: "PUT", url: "/api/me/credentials", headers, payload: { production: { dms: { mode: "replace", url: "https://personal.example.test/sse", authorization: "Bearer personal-secret" } } } });
    assert.equal(personal.statusCode, 200, personal.body);
    globalThis.fetch = async (input, init) => { requests.push({ url: String(input), authorization: new Headers(init?.headers).get("Authorization") }); return new Response("private details", { status: 401 }); };
    const resolve = () => f.app.inject({ method: "POST", url: "/api/dms/scope/resolve", headers, payload: { instanceAlias: "ORDERS", schemaName: "orders" } });
    const failed = await resolve();
    assert.equal(failed.statusCode, 502, failed.body); assert.equal(failed.json().error, "dms_mcp_http_401");
    assert.doesNotMatch(failed.body, /personal-secret|shared-secret|private details/);
    assert.deepEqual(requests, [{ url: "https://personal.example.test/sse", authorization: "Bearer personal-secret" }]);
    await db.db.update(userCredentials).set({ productionDmsAuthorization: "" }).where(eq(userCredentials.subject, issuePilotConfig.bootstrapUser.subject));
    const partial = await resolve(); assert.equal(partial.statusCode, 400, partial.body); assert.equal(partial.json().error, "personal_dms_credentials_incomplete");
    assert.equal(requests.length, 1);
    await db.db.update(userCredentials).set({ productionDmsUrl: "" }).where(eq(userCredentials.subject, issuePilotConfig.bootstrapUser.subject));
    await resolve();
    assert.deepEqual(requests[1], { url: "https://shared.example.test/sse", authorization: "Bearer shared-secret" });
  } finally { globalThis.fetch = original; await db.close(); await f.cleanup(); }
});
