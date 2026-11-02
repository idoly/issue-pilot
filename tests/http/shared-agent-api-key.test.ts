import assert from "node:assert/strict";
import { test } from "node:test";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { createApiFixture, testAgent } from "./fixture.ts";
import { openDatabase } from "../../src/db/client.ts";
import { globalAgentConfiguration } from "../../src/db/schema.ts";

const headers: Record<string, string> = { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject };

test("the shared API key is saved with the global model, hidden, bound to its provider and admin-only", async () => {
  const f = await createApiFixture(); const db = openDatabase(f.databaseFile);
  try {
    const put = (payload: Record<string, unknown>, selected = headers) => f.app.inject({ method: "PUT", url: "/api/config/agent", headers: selected, payload });
    const agent = async () => (await f.app.inject({ method: "GET", url: "/api/config", headers })).json().agent as Record<string, unknown>;
    const stored = async () => (await db.db.select().from(globalAgentConfiguration))[0]!.apiKey;
    assert.equal((await agent()).apiKeyConfigured, false);

    const saved = await put({ ...testAgent, apiKey: { mode: "replace", value: "shared-model-secret" } });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(await stored(), "shared-model-secret");
    const configuration = await f.app.inject({ method: "GET", url: "/api/config", headers });
    assert.equal(configuration.json().agent.apiKeyConfigured, true);
    assert.doesNotMatch(saved.body + configuration.body, /shared-model-secret/);

    assert.equal((await put({ ...testAgent, codemode: "on" })).statusCode, 200);
    assert.equal(await stored(), "shared-model-secret", "an omitted key update preserves the key");
    for (const apiKey of [{ mode: "replace" }, { mode: "replace", value: "" }, { mode: "clear", value: "x" }, { mode: "preserve" }]) {
      assert.equal((await put({ ...testAgent, apiKey })).statusCode, 400, JSON.stringify(apiKey));
    }

    // A stale or switched provider must not inherit a key issued for another provider.
    await db.db.update(globalAgentConfiguration).set({ provider: "previous-provider" });
    const switched = await put(testAgent);
    assert.equal(switched.statusCode, 400); assert.equal(switched.json().error, "agent_api_key_required");
    assert.equal((await db.db.select().from(globalAgentConfiguration))[0]!.provider, "previous-provider");
    assert.equal((await put({ ...testAgent, apiKey: { mode: "replace", value: "replacement" } })).statusCode, 200);
    assert.equal(await stored(), "replacement");

    await f.app.inject({ method: "POST", url: "/api/users", headers, payload: { subject: "plain-developer", name: "Developer", email: "developer@example.test", role: "developer" } });
    const denied = await put({ ...testAgent, apiKey: { mode: "clear" } }, { "x-issue-pilot-subject": "plain-developer" });
    assert.equal(denied.statusCode, 403); assert.equal(denied.json().error, "admin_role_required");
    assert.equal((await f.app.inject({ method: "GET", url: "/api/config/shared-sls-credentials", headers: { "x-issue-pilot-subject": "plain-developer" } })).statusCode, 403);

    assert.equal((await put({ ...testAgent, apiKey: { mode: "clear" } })).statusCode, 200);
    assert.equal(await stored(), "");
    assert.equal((await agent()).apiKeyConfigured, false);
  } finally { await db.close(); await f.cleanup(); }
});
