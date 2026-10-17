import assert from "node:assert/strict";
import { test } from "node:test";

import { IssueOutputStore } from "../../src/outputs/store.ts";
import { createApiFixture, createService, issueMetadataPayload } from "./fixture.ts";

test("lists and downloads durable production-data output files without exposing a write route", async () => {
  const fixture = await createApiFixture();
  try {
    await createService(fixture.app, "Reports", ["prod"]);
    const created = await fixture.app.inject({
      method: "POST",
      url: "/api/issues",
      payload: { ...issueMetadataPayload("Export report"), workMode: "production_data", serviceKey: "reports" },
    });
    assert.equal(created.statusCode, 201, created.body);
    const issue = JSON.parse(created.body) as { id: string };
    fixture.engine.running.clear();

    await new IssueOutputStore(fixture.root, issue.id).write("orders.csv", '"id"\n"1"\n');
    const detail = await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}` });
    assert.equal(detail.statusCode, 200);
    const outputs = (JSON.parse(detail.body) as { outputs: Array<{ fileName: string; size: number }> }).outputs;
    assert.deepEqual(outputs.map(({ fileName, size }) => ({ fileName, size })), [{ fileName: "orders.csv", size: 9 }]);

    const download = await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}/outputs/orders.csv` });
    assert.equal(download.statusCode, 200);
    assert.equal(download.body, '"id"\n"1"\n');
    assert.equal(download.headers["content-type"], "text/csv; charset=utf-8");
    assert.match(String(download.headers["content-disposition"]), /orders\.csv/);
    assert.equal(download.headers["cache-control"], "private, no-store");

    const noWriteRoute = await fixture.app.inject({ method: "POST", url: `/api/issues/${issue.id}/outputs/orders.csv`, payload: "changed" });
    assert.equal(noWriteRoute.statusCode, 404);
  } finally {
    await fixture.cleanup();
  }
});
