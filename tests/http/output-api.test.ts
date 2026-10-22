import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { IssueWorkFileStore } from "../../src/workspace/work-file-store.ts";
import { legacyOutputLinksFile } from "../../src/outputs/store.ts";
import { createApiFixture, createService, issueMetadataPayload } from "./fixture.ts";

test("working files download directly while legacy output links resolve to the same mutable file", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Reports", ["prod"]);
    const created = await fixture.app.inject({ method: "POST", url: "/api/issues", payload: { ...issueMetadataPayload("Export report"), workMode: "production_analysis", serviceKey: "reports" } });
    assert.equal(created.statusCode, 201, created.body);
    const issue = created.json(), store = new IssueWorkFileStore(fixture.root, issue.id); fixture.engine.running.clear();
    await store.write("orders.csv", '"id"\n"1"\n');
    const initial = (await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` })).json();
    assert.deepEqual(initial.outputs, []);
    const direct = await fixture.app.inject({ method: "GET", url: store.downloadPath("orders.csv") });
    assert.equal(direct.statusCode, 200); assert.equal(direct.body, '"id"\n"1"\n');
    await writeFile(path.join(store.directory, legacyOutputLinksFile), JSON.stringify({ version: 1, files: { "old-orders.csv": "orders.csv" } }), { mode: 0o600 });
    const legacy = await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}/outputs/old-orders.csv` });
    assert.equal(legacy.statusCode, 200, legacy.body); assert.equal(legacy.body, direct.body);
    assert.equal(legacy.headers["cache-control"], "private, no-store");
    await store.write("orders.csv", "updated");
    assert.equal((await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}/outputs/old-orders.csv` })).body, "updated");
    assert.equal((await fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/outputs/old-orders.csv`, payload: "changed" })).statusCode, 404);
    assert.equal((await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}/outputs/%2e%2e%2fissues.db` })).statusCode, 400);
  } finally { await fixture.cleanup(); }
});
