import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { openDatabase } from "../../src/db/client.ts";
import { subjects, userCredentials } from "../../src/db/schema.ts";
import { createApiFixture, createService, issuePayload } from "./fixture.ts";

const owner = issuePilotConfig.bootstrapUser.subject;

async function streamedAgent(address: string, key: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${address}/api/issues/${key}/agent-stream`, { headers });
  assert.equal(response.status, 200);
  for await (const chunk of response.body!) {
    const block = new TextDecoder()
      .decode(chunk)
      .split("\n\n")
      .find((candidate) => candidate.startsWith("event: snapshot_ready\n"));
    if (block) return JSON.parse(block.slice(block.indexOf("data: ") + 6)).agent as { provider: string; model: string; thinkingLevel: string };
  }
  assert.fail("missing snapshot_ready");
}

test("the stream shows the owner's personal model group only while that owner can run the Issue", async () => {
  const fixture = await createApiFixture();
  try {
    await fixture.app.inject({ method: "POST", url: "/api/users", payload: { subject: "stream-viewer", name: "Viewer", email: "viewer@example.test", role: "product" } });
    await createService(fixture.app, "Owner");
    // Pin the reporter so ad-hoc users created above cannot become the default owner.
    const created = await fixture.app.inject({ method: "POST", url: "/api/issues", headers: { "x-issue-pilot-subject": owner }, payload: issuePayload("owner", "test", "Owner fallback") });
    assert.equal(created.statusCode, 201, created.body);
    const issueId = (created.json() as { id: string }).id;
    const database = openDatabase(fixture.databaseFile);
    await database.db.insert(userCredentials).values({
      subject: owner,
      modelCredentials: { provider: "personal-provider", model: "personal-model", thinkingLevel: "high", codemode: "on", apiKey: "personal-key" },
    });
    await database.close();
    const address = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    assert.deepEqual(await streamedAgent(address, issueId), { provider: "personal-provider", model: "personal-model", thinkingLevel: "high" });

    // Execution refuses an inactive owner; this read-only view must not advertise a group it would never use.
    const inactive = openDatabase(fixture.databaseFile);
    await inactive.db.update(subjects).set({ active: false }).where(eq(subjects.subject, owner));
    await inactive.close();
    assert.deepEqual(await streamedAgent(address, issueId, { "x-issue-pilot-subject": "stream-viewer" }), { provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "medium" });
  } finally {
    await fixture.cleanup();
  }
});
