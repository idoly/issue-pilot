import assert from "node:assert/strict";
import { test } from "node:test";
import { createApiFixture, workspaceStatistics } from "./fixture.ts";

test("workspace statistics expose a sampled snapshot and explicit refresh bypasses it", async (context) => {
  const fixture = await createApiFixture();
  try {
    context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const initial = await fixture.app.inject({ method: "GET", url: "/api/workspaces/stats" });
    assert.equal(initial.statusCode, 200, initial.body);
    assert.equal(initial.headers["cache-control"], "private, no-store");
    assert.deepEqual(initial.json(), { snapshot: null, sampling: true, error: null });
    const first = await workspaceStatistics(fixture.app);
    assert.ok(Number.isFinite(Date.parse(first.sampledAt)));
    context.mock.timers.tick(1_000);
    const cached = await workspaceStatistics(fixture.app);
    assert.equal(cached.sampledAt, first.sampledAt);
    const fresh = await workspaceStatistics(fixture.app, true);
    assert.notEqual(fresh.sampledAt, first.sampledAt);
    assert.equal(fresh.totalBytes, first.totalBytes);
    assert.equal(fresh.sharedGitBytes, first.sharedGitBytes);
    assert.deepEqual(fresh.workspaces, first.workspaces);
    assert.equal((await workspaceStatistics(fixture.app)).sampledAt, fresh.sampledAt);
  } finally {
    await fixture.cleanup();
  }
});

test("an unreadable directory inside one Issue root does not break workspace statistics", { skip: process.getuid?.() === 0 }, async () => {
  const { chmod, mkdir } = await import("node:fs/promises");
  const path = await import("node:path");
  const { createIssue, createService } = await import("./fixture.ts");
  const { issueRoot } = await import("../../src/workspace/state.ts");
  const fixture = await createApiFixture();
  const locked = { path: "" };
  try {
    await createService(fixture.app, "Unreadable stats", ["test"]);
    const issue = await createIssue(fixture.app, "unreadable-stats", "test", "Unreadable directory");
    locked.path = path.join(issueRoot(fixture.root, String(issue.id)), "locked", "inner");
    await mkdir(locked.path, { recursive: true });
    await chmod(locked.path, 0);
    const response = await workspaceStatistics(fixture.app, true);
    assert.ok(response.workspaces.some((row: { issueKey: string }) => row.issueKey === issue.id));
  } finally {
    if (locked.path) await chmod(locked.path, 0o700);
    await fixture.cleanup();
  }
});
