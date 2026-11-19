// One transcript entry larger than the MCP response budget must not make the conversation unreadable: pasted
// images are projected to their size and the page still honors limit=1.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { createApiFixture, createIssue, createService } = await import("./fixture.ts");
const { openDatabase } = await import("../../src/db/client.ts");
const { agentSessions, issues } = await import("../../src/db/schema.ts");
const { issueRoot } = await import("../../src/workspace/state.ts");
const { createPrivateSessionManager } = await import("../../src/agent/pi-session.ts");
const { eq } = await import("drizzle-orm");

test("issue_conversation projects a pasted screenshot instead of failing the page budget", { timeout: 20_000 }, async () => {
  const f = await createApiFixture();
  const database = openDatabase(f.databaseFile);
  const client = new Client({ name: "repro", version: "1" });
  try {
    await createService(f.app, "Large transcript");
    const created = await createIssue(f.app, "large-transcript");
    f.engine.running.clear();
    const [issue] = await database.db
      .select()
      .from(issues)
      .where(eq(issues.key, String(created.id)));
    const root = issueRoot(f.root, issue!.key);
    const manager = await createPrivateSessionManager(root, root);
    // ~900 KB PNG-sized payload -> ~1.2 MB base64, below the 20 MiB per-image admission limit.
    const image = { type: "image", mimeType: "image/png", data: randomBytes(900 * 1024).toString("base64") };
    manager.appendCustomEntry("issue-pilot-user", { message: "first" });
    manager.appendCustomEntry("issue-pilot-user", { message: "see screenshot", images: [image] });
    manager.appendCustomEntry("issue-pilot-user", { message: "third" });
    const sessionFile = manager.getSessionFile()!;
    await database.db.insert(agentSessions).values({ issueId: issue!.id, sessionFile, workspacePath: root });

    const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
    await client.connect(new StreamableHTTPClientTransport(new URL(address + "/mcp")));
    const page = async (offset: number, limit: number) => client.callTool({ name: "issue_conversation", arguments: { key: issue!.key, offset, limit } });
    const results = { first: await page(0, 1), screenshot: await page(1, 1), third: await page(2, 1), all: await page(0, 30) };
    const http = await f.app.inject(`/api/issues/${issue!.key}/sessions/${manager.getSessionId()}`);
    const summary = Object.fromEntries(Object.entries(results).map(([name, result]) => [name, result.isError ? JSON.stringify(result.content).slice(0, 80) : "ok"]));
    console.log(JSON.stringify({ ...summary, httpHistory: http.statusCode, httpBytes: http.body.length }));
    assert.equal(results.first.isError, undefined);
    assert.equal(results.third.isError, undefined);
    // The image entry is projected to its size, so every page stays readable.
    assert.equal(results.screenshot.isError, undefined);
    const payload = JSON.parse((results.screenshot.content as Array<{ text: string }>)[0]!.text) as { items: Array<{ event: { images: Array<{ bytes: number; data?: string }> } }> };
    assert.equal(payload.items[0]!.event.images[0]!.bytes, 900 * 1024);
    assert.equal(payload.items[0]!.event.images[0]!.data, undefined);
    assert.equal(results.all.isError, undefined);
    assert.equal(http.statusCode, 200);
  } finally {
    await client.close();
    database.close();
    await f.cleanup();
  }
});
