import assert from "node:assert/strict";
import { test } from "node:test";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { createApiFixture, createIssue, createService, testAgent } from "./fixture.ts";

const headers = { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject };
test("saves Pi settings while resources remain a read-only file catalog", async () => {
  const f = await createApiFixture();
  try {
    const preview = await f.app.inject({ method: "GET", url: "/api/config/agent/resources", headers });
    assert.equal(preview.statusCode, 200, preview.body); assert.equal(preview.headers["cache-control"], "private, no-store");
    assert.ok(Array.isArray(preview.json().skills)); assert.ok(Array.isArray(preview.json().prompts)); assert.ok(Array.isArray(preview.json().extensions));
    const runtime = { settings: { retry: { maxRetries: 2 }, compaction: { enabled: false }, cacheWarming: "off" } };
    const initial = await f.app.inject({ method: "GET", url: "/api/config" }); assert.deepEqual(initial.json().agent.runtime, {});
    await createService(f.app, "Runtime"); await createIssue(f.app, "runtime");
    const blocked = await f.app.inject({ method: "PUT", url: "/api/config/agent", headers, payload: { ...testAgent, runtime } });
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.deepEqual((await f.app.inject({ method: "GET", url: "/api/config" })).json().agent.runtime, {});
    f.engine.running.clear();
    const saved = await f.app.inject({ method: "PUT", url: "/api/config/agent", headers, payload: { ...testAgent, runtime } });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual((await f.app.inject({ method: "GET", url: "/api/config" })).json().agent.runtime, runtime);
    for (const value of [{ settings: { defaultModel: "other" } }, { settings: { retry: { maxRetries: -1 } } }, { settings: { codemode: { mode: "only" } } }, { skills: ["/other"] }, { extensions: ["/other"] }, { prompts: ["/other"] }]) {
      const invalid = await f.app.inject({ method: "PUT", url: "/api/config/agent", headers, payload: { ...testAgent, runtime: value } }); assert.equal(invalid.statusCode, 400, invalid.body);
    }
    await f.app.inject({ method: "POST", url: "/api/users", headers, payload: { subject: "viewer", name: "Viewer", email: "viewer@example.test", role: "product" } });
    assert.equal((await f.app.inject({ method: "GET", url: "/api/config/agent/resources", headers: { "x-issue-pilot-subject": "viewer" } })).statusCode, 403);
    assert.equal((await f.app.inject({ method: "PUT", url: "/api/config/agent", headers: { "x-issue-pilot-subject": "viewer" }, payload: { ...testAgent, runtime } })).statusCode, 403);
  } finally { await f.cleanup(); }
});
