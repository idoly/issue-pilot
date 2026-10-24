import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { appendQueuedAgentMessage, pendingAgentMessages, selectAgentMessage, startAgentMessage } from "../../src/agent/message-delivery.ts";
import { sessionTranscript } from "../../src/agent/events.ts";

const scope = { serviceId: "service-a", environmentId: "test" };

test("recovers only explicitly queued inputs and keeps delivery bookkeeping out of the visible transcript", () => {
  const manager = SessionManager.inMemory();
  manager.appendCustomEntry("issue-pilot-user", { message: "Historical request" });
  manager.appendCustomEntry("issue-pilot-user", undefined);
  const images = [{ type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" }];
  const id = appendQueuedAgentMessage(manager, scope, "Unstarted request", images);
  assert.deepEqual(pendingAgentMessages(manager), [{ id, message: "Unstarted request", images, scope }]);
  assert.equal(selectAgentMessage(manager, scope, id)?.id, id);
  startAgentMessage(manager, id, scope);
  assert.deepEqual(pendingAgentMessages(manager), []);
  assert.equal(selectAgentMessage(manager, scope, id), undefined);
  assert.throws(() => startAgentMessage(manager, id, scope), /agent_message_state_changed/);
  assert.deepEqual(sessionTranscript(manager, "issue").map(item => item.event), [
    { type: "issue_user", message: "Historical request" },
    { type: "issue_user", message: "Unstarted request", images },
  ]);
});

test("selects pending input in admission order even when a newer request owns the queued callback", () => {
  const manager = SessionManager.inMemory();
  const first = appendQueuedAgentMessage(manager, scope, "First", []);
  const second = appendQueuedAgentMessage(manager, scope, "Second", []);
  assert.equal(selectAgentMessage(manager, scope, second)?.id, first);
  startAgentMessage(manager, first, scope);
  assert.equal(selectAgentMessage(manager, scope, second)?.id, second);
  startAgentMessage(manager, second, scope);
  assert.equal(selectAgentMessage(manager, scope, first), undefined);
  assert.throws(() => selectAgentMessage(manager, scope, "unrepresented-entry"), /agent_message_state_changed/);
});

test("rejects all queued inputs from a changed scope while retaining their original contents", () => {
  const manager = SessionManager.inMemory();
  appendQueuedAgentMessage(manager, scope, "Old scope one", []);
  appendQueuedAgentMessage(manager, scope, "Old scope two", []);
  const changed = { serviceId: "service-b", environmentId: "prod" };
  const current = appendQueuedAgentMessage(manager, changed, "Current scope", []);
  assert.throws(() => selectAgentMessage(manager, changed), /agent_message_scope_changed/);
  assert.deepEqual(pendingAgentMessages(manager).map(message => message.id), [current]);
  assert.equal(selectAgentMessage(manager, changed)?.id, current);
  assert.deepEqual(sessionTranscript(manager, "issue").map(item => item.event.type === "issue_user" ? item.event.message : "unexpected"), ["Old scope one", "Old scope two", "Current scope"]);
});

test("refuses malformed delivery metadata rather than guessing or repairing it", () => {
  for (const data of [
    { message: "bad version", delivery: { ...scope, version: 2, state: "queued" } },
    { message: "bad image", delivery: { ...scope, version: 1, state: "queued" }, images: [{ type: "image", data: 7, mimeType: "image/png" }] },
  ]) {
    const manager = SessionManager.inMemory();
    manager.appendCustomEntry("issue-pilot-user", data);
    const before = manager.getEntries();
    assert.throws(() => pendingAgentMessages(manager), /agent_message_state_invalid/);
    assert.deepEqual(manager.getEntries(), before);
  }
});
