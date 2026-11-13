import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SessionManager, type JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createPrivateSessionManager } from "../../src/agent/pi-session.ts";
import { persistNestedQuery, readQueryResult, savedQueryCompletion } from "../../src/agent/query-results.ts";
import { sessionTranscript } from "../../src/agent/events.ts";
import { agentDisplayEvent } from "../../src/agent/event-display.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";

const completion = (text: string): Extract<JsonAgentSessionEvent, { type: "tool_execution_end" }> => ({
  type: "tool_execution_end",
  toolName: "service_query",
  toolCallId: "script/1",
  parentToolCallId: "script",
  isError: false,
  durationMs: 10,
  result: { content: [{ type: "text", text }], details: { provider: "aliyun-sls-cli", environment: "prod", service: "demo" } },
});

test("nested query evidence survives reopening, stays out of model context and shares the live/replay display bound", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-query-results-"));
  try {
    const manager = await createPrivateSessionManager(root, root);
    manager.appendMessage({ role: "user", content: "Fixture", timestamp: 1 });
    const text = JSON.stringify({ records: [{ payload: "独立查询结果".repeat(15_000) }] });
    const event = persistNestedQuery(manager, completion(text))!;
    assert.equal(event.result.queryResult.sessionId, manager.getSessionId());
    const reopened = SessionManager.open(manager.getSessionFile()!);
    assert.equal(readQueryResult(reopened, event.result.queryResult.entryId), text);
    assert.ok(!JSON.stringify(reopened.buildSessionContext()).includes("独立查询结果"));
    const replay = sessionTranscript(reopened, "issue");
    assert.equal(replay.length, 1);
    assert.deepEqual(replay[0]!.event, event);
    const displayed = agentDisplayEvent(replay[0]!);
    assert.equal(displayed.event.type, "tool_execution_end");
    if (displayed.event.type !== "tool_execution_end") return;
    assert.equal(displayed.event.result.displayTruncated, true);
    assert.deepEqual(displayed.event.result.queryResult, event.result.queryResult);
    assert.ok(JSON.stringify(displayed).length < text.length);
    assert.equal(readQueryResult(reopened, event.result.queryResult.entryId), text);
    const lines = (await readFile(manager.getSessionFile()!, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(lines.filter((line) => line.customType === "issue-pilot-query-result").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("full reads select only native success results on the displayed branch and enforce UTF-8 bytes", () => {
  const manager = SessionManager.inMemory();
  const root = manager.appendMessage({ role: "user", content: "Fixture", timestamp: 1 });
  const { result, toolCallId, toolName, isError } = completion("exact result");
  const direct = manager.appendMessage({ role: "toolResult", toolCallId, toolName, isError, ...result, timestamp: 2 });
  assert.equal(readQueryResult(manager, direct), "exact result");
  assert.deepEqual(savedQueryCompletion(manager.getSessionId(), manager.getEntry(direct)!)!.result.queryResult, { sessionId: manager.getSessionId(), entryId: direct });
  assert.throws(() => readQueryResult(manager, root), /agent_query_result_not_found/);
  const failed = manager.appendMessage({ role: "toolResult", toolCallId: "failed", toolName, isError: true, ...result, timestamp: 3 });
  assert.throws(() => readQueryResult(manager, failed), /agent_query_result_not_found/);
  manager.branch(root);
  assert.throws(() => readQueryResult(manager, direct), /agent_query_result_not_found/);
  const oversized = "中".repeat(Math.ceil(issuePilotConfig.limits.capability.resultBytes / 3));
  assert.throws(() => persistNestedQuery(manager, completion(oversized)), /agent_query_result_too_large/);
  const huge = manager.appendMessage({ role: "toolResult", toolCallId, toolName, isError, content: [{ type: "text", text: oversized }], details: result.details, timestamp: 4 });
  assert.throws(() => readQueryResult(manager, huge), /agent_query_result_too_large/);
});

test("does not duplicate direct queries, save exports/errors or capture unrelated tool outputs", () => {
  const manager = SessionManager.inMemory();
  const event = completion("payload");
  const { parentToolCallId: _parent, ...direct } = event;
  for (const candidate of [
    direct,
    { ...event, isError: true },
    { ...event, toolName: "read" },
    { ...event, result: { ...event.result, details: { provider: "aliyun-dms-mcp", fileName: "export.json" } } },
    { ...event, result: { ...event.result, details: { provider: "other" } } },
  ])
    assert.equal(persistNestedQuery(manager, candidate), undefined);
  assert.equal(manager.getEntries().length, 0);
});
