import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiFixture } from "./fixture.ts";

test("workspace statistics expose a sampled snapshot and explicit refresh bypasses it", async context => {
  const fixture = await createApiFixture();
  try {
    context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const initial = await fixture.app.inject({ method: "GET", url: "/api/workspaces/stats" });
    assert.equal(initial.statusCode, 200, initial.body);
    assert.equal(initial.headers["cache-control"], "private, no-store");
    const first = initial.json(); assert.ok(Number.isFinite(Date.parse(first.sampledAt)));
    context.mock.timers.tick(1_000);
    const cached = (await fixture.app.inject({ method: "GET", url: "/api/workspaces/stats" })).json();
    assert.equal(cached.sampledAt, first.sampledAt);
    const fresh = (await fixture.app.inject({ method: "GET", url: "/api/workspaces/stats?refresh=true" })).json();
    assert.notEqual(fresh.sampledAt, first.sampledAt);
    assert.equal(fresh.totalBytes, first.totalBytes); assert.equal(fresh.sharedGitBytes, first.sharedGitBytes);
    assert.deepEqual(fresh.workspaces, first.workspaces);
    assert.equal((await fixture.app.inject({ method: "GET", url: "/api/workspaces/stats" })).json().sampledAt, fresh.sampledAt);
  } finally { await fixture.cleanup(); }
});
