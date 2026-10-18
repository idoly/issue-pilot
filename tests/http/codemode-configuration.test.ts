import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiFixture, createIssue, createService, testAgent } from "./fixture.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";

const headers = { "x-issue-pilot-subject": issuePilotConfig.bootstrapUser.subject };
test("enables codemode by default and persists all global modes through the existing session reservation", async () => {
  const f = await createApiFixture();
  try {
    const initial = await f.app.inject({ method: "GET", url: "/api/config" });
    assert.equal(initial.json().agent.codemode, "on");
    await createService(f.app, "Codemode"); await createIssue(f.app, "codemode");
    const id = f.engine.enqueued[0]!;
    const blocked = await f.app.inject({ method: "PUT", url: "/api/config/agent", headers, payload: { ...testAgent, codemode: "only" } });
    assert.equal(blocked.statusCode, 409); assert.equal(blocked.json().error, "global_configuration_has_running_issues");
    assert.equal((await f.app.inject({ method: "GET", url: "/api/config" })).json().agent.codemode, "on");
    f.engine.running.clear();
    for (const codemode of ["off", "on", "only"]) {
      const result = await f.app.inject({ method: "PUT", url: "/api/config/agent", headers, payload: { ...testAgent, codemode } });
      assert.equal(result.statusCode, 200, result.body);
      assert.equal((await f.app.inject({ method: "GET", url: "/api/config" })).json().agent.codemode, codemode);
    }
    assert.ok(f.engine.closedSessions.includes(id));
    for (const codemode of [undefined, null, true, "invalid"]) {
      const invalid = await f.app.inject({ method: "PUT", url: "/api/config/agent", headers, payload: { ...testAgent, codemode } });
      assert.equal(invalid.statusCode, 400, invalid.body);
      assert.equal(invalid.json().error, "invalid_agent_codemode");
    }
    assert.equal((await f.app.inject({ method: "GET", url: "/api/config" })).json().agent.codemode, "only");
  } finally { await f.cleanup(); }
});
