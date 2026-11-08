import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { fauxAssistantMessage } from "@earendil-works/pi-ai";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { AgentEventBus, type RunEvent } from "../../src/agent/events.ts";
import { createPrivateSessionManager } from "../../src/agent/pi-session.ts";
import { openDatabase } from "../../src/db/client.ts";
import { agentSessions } from "../../src/db/schema.ts";
import { issueRoot } from "../../src/workspace/state.ts";
import { createApiFixture, createIssue, createService } from "./fixture.ts";

test("SSE replay, live results and history pages bound display text without rewriting durable results", { timeout: 10_000 }, async () => {
  const events = new AgentEventBus();
  const fixture = await createApiFixture({ events });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    await createService(fixture.app, "Display");
    const issue = await createIssue(fixture.app, "display");
    const issueId = fixture.engine.enqueued[0]!;
    fixture.engine.running.clear();
    const work = issueRoot(fixture.root, String(issue.id));
    const manager = await createPrivateSessionManager(work, work);
    manager.appendMessage(fauxAssistantMessage("A completed answer makes this session durable."));
    const maximum = issuePilotConfig.web.agentToolOutputCharacters;
    const result = { content: [{ type: "text" as const, text: `start:${"x".repeat(maximum * 3)}:end` }] };
    manager.appendMessage({ role: "toolResult", toolCallId: "tool-1", toolName: "bash", ...result, isError: false, timestamp: Date.now() });
    const file = manager.getSessionFile()!;
    const original = await readFile(file, "utf8");
    const database = openDatabase(fixture.databaseFile);
    try {
      await database.db.insert(agentSessions).values({ issueId, sessionFile: file, workspacePath: work });
    } finally {
      await database.close();
    }
    const address = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/api/issues/${issue.id}/agent-stream`);
    assert.equal(response.status, 200);
    reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    const readFrame = async (): Promise<string> => {
      while (!pending.includes("\n\n")) {
        const chunk = await reader!.read();
        assert.equal(chunk.done, false);
        pending += decoder.decode(chunk.value, { stream: true });
      }
      const end = pending.indexOf("\n\n");
      const frame = pending.slice(0, end);
      pending = pending.slice(end + 2);
      return frame;
    };
    const assertBounded = (event: RunEvent) => {
      assert.equal(event.event.type, "tool_execution_end");
      if (event.event.type !== "tool_execution_end") return;
      assert.equal(event.event.result.displayTruncated, true);
      const content = event.event.result.content;
      assert.equal(content[0]?.type === "text" && content[0].text.length, maximum);
    };
    let replayed = false;
    for (;;) {
      const frame = await readFrame();
      if (frame.startsWith("event: snapshot_ready\n")) break;
      const event = JSON.parse(
        frame
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice(6),
      ) as RunEvent;
      if (event.event.type === "tool_execution_end") {
        assertBounded(event);
        replayed = true;
      }
    }
    assert.equal(replayed, true);
    const live: RunEvent = { id: "live-result", issueId, createdAt: new Date().toISOString(), event: { type: "tool_execution_end", toolCallId: "tool-2", toolName: "bash", result, isError: false } };
    events.publish(live);
    const liveFrame = await readFrame();
    assertBounded(
      JSON.parse(
        liveFrame
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice(6),
      ),
    );
    assert.equal(live.event.type === "tool_execution_end" && live.event.result.content[0]?.type === "text" && live.event.result.content[0].text.length, maximum * 3 + 10);
    const history = await fixture.app.inject({ method: "GET", url: `/api/issues/${issue.id}/sessions/${manager.getSessionId()}` });
    assert.equal(history.statusCode, 200, history.body);
    const savedResult = (history.json() as { events: RunEvent[] }).events.find((event) => event.event.type === "tool_execution_end");
    assert.ok(savedResult);
    assertBounded(savedResult);
    assert.equal(await readFile(file, "utf8"), original);
  } finally {
    await reader?.cancel();
    await fixture.cleanup();
  }
});
