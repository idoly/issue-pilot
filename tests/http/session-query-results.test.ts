import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { createPrivateSessionManager } from "../../src/agent/pi-session.ts";
import { persistNestedQuery } from "../../src/agent/query-results.ts";
import { resetIssueSession } from "../../src/agent/session-reset.ts";
import { openDatabase } from "../../src/db/client.ts";
import { agentSessions } from "../../src/db/schema.ts";
import { issueRoot } from "../../src/workspace/state.ts";
import { createApiFixture, createIssue, createService } from "./fixture.ts";

test("full-result API reads exact direct/nested entries through the reset chain without querying or rewriting sessions", async () => {
  const f = await createApiFixture();
  const database = openDatabase(f.databaseFile);
  try {
    await createService(f.app, "Query results");
    const issue = await createIssue(f.app, "query-results");
    const issueId = f.engine.enqueued.at(-1)!;
    const other = await createIssue(f.app, "query-results");
    const root = issueRoot(f.root, String(issue.id));
    const manager = await createPrivateSessionManager(root, root);
    const hidden = manager.appendCustomEntry("issue-pilot-user", { message: "Private application metadata" });
    const text = JSON.stringify({ records: [{ value: "saved query data ".repeat(4_000) }] });
    const result = { content: [{ type: "text" as const, text }], details: { provider: "aliyun-sls-cli" } };
    const direct = manager.appendMessage({ role: "toolResult", toolCallId: "direct", toolName: "service_query", isError: false, ...result, timestamp: 1 });
    const nested = persistNestedQuery(manager, { type: "tool_execution_end", toolCallId: "script/1", parentToolCallId: "script", toolName: "service_query", isError: false, result })!;
    const failed = manager.appendMessage({ role: "toolResult", toolCallId: "failed", toolName: "service_query", isError: true, ...result, timestamp: 2 });
    const huge = manager.appendMessage({
      role: "toolResult",
      toolCallId: "huge",
      toolName: "service_query",
      isError: false,
      ...result,
      content: [{ type: "text", text: "x".repeat(issuePilotConfig.limits.capability.resultBytes + 1) }],
      timestamp: 3,
    });
    const file = manager.getSessionFile()!;
    await database.db.insert(agentSessions).values({ issueId, sessionFile: file, workspacePath: root });
    const before = await readFile(file);
    const get = (key: string, entry: string, sessionId = manager.getSessionId()) => f.app.inject({ url: `/api/issues/${key}/sessions/${sessionId}/query-results/${entry}` });
    for (const entry of [direct, nested.result.queryResult.entryId]) {
      const response = await get(String(issue.id), entry);
      assert.equal(response.statusCode, 200);
      assert.equal(response.body, text);
      assert.equal(response.headers["cache-control"], "private, no-store");
    }
    for (const entry of [hidden, failed, "not-found"]) {
      const response = await get(String(issue.id), entry);
      assert.equal(response.statusCode, 404);
      assert.deepEqual(response.json(), { error: "agent_query_result_not_found" });
    }
    assert.equal((await get(String(other.id), direct)).statusCode, 404);
    assert.equal((await get(String(issue.id), direct, "unknown-session")).statusCode, 404);
    assert.equal((await get(String(issue.id), huge)).statusCode, 413);
    const history = await f.app.inject({ url: `/api/issues/${issue.id}/sessions/${manager.getSessionId()}` });
    const displayed = history.json().events.find((entry: { id: string }) => entry.id === direct);
    assert.equal(displayed.event.result.displayTruncated, true);
    assert.equal(displayed.event.result.queryResult.entryId, direct);
    assert.deepEqual(await readFile(file), before);

    const reset = await resetIssueSession(database.db, f.root, { id: issueId, key: String(issue.id) }, "fixture", manager.getSessionId());
    assert.equal((await get(String(issue.id), direct)).body, text);
    assert.equal((await get(String(issue.id), direct, reset.sessionId)).statusCode, 404);
    assert.deepEqual(await readFile(file), before);
    // A binding into another Issue cannot be used to read its results, even with the correct session/entry IDs.
    await database.db
      .update(agentSessions)
      .set({ issueId: f.engine.enqueued.at(-1)! })
      .where(eq(agentSessions.issueId, issueId));
    assert.equal((await get(String(other.id), direct, reset.sessionId)).statusCode, 500);
    assert.equal(f.engine.enqueued.length, 2);
  } finally {
    database.close();
    await f.cleanup();
  }
});
