import assert from "node:assert/strict";
import test from "node:test";

import { formatToolOutput, renderTerminalEvent, renderTerminalFooter, terminalColumns } from "../../src/agent/terminal.ts";
import type { RunEvent } from "../../src/agent/events.ts";

const event = (value: Omit<RunEvent, "id" | "issueId" | "createdAt">): RunEvent => ({
  id: "event-1", issueId: "issue-1", createdAt: "2026-08-06T00:00:00.000Z", ...value,
});

test("renders persisted Agent events with native Pi TUI components", () => {
  assert.equal(terminalColumns("20"), 100);
  assert.equal(terminalColumns("80"), 80);

  const user = renderTerminalEvent(event({ kind: "user", message: "hello **world**\x1b]8;;https://invalid\x07" }), 80, "/workspace");
  assert.match(user.ansi, /\x1b\[48;2;52;53;65m/);
  assert.doesNotMatch(user.ansi, /\x1b]8;;https:\/\/invalid\x07/);
  assert.equal(user.text, "User: hello **world**]8;;https://invalid");
  assert.ok(user.lines >= 3);

  const assistant = renderTerminalEvent(event({ kind: "assistant", message: "result **ok**" }), 80, "/workspace");
  assert.match(assistant.ansi, /result/);
  assert.doesNotMatch(assistant.ansi, /48;2;52;53;65/);

  const pending = renderTerminalEvent(event({ kind: "tool_call", toolCallId: "call-1", toolName: "sls", arguments: { limit: 1 } }), 80, "/workspace");
  assert.equal(pending.toolCallId, "call-1");
  assert.equal(pending.replaceTool, undefined);
  assert.match(pending.ansi, /sls/);

  const complete = renderTerminalEvent(event({ kind: "tool_result", toolCallId: "call-1", toolName: "sls", result: { content: [{ type: "text", text: "latest log" }] }, isError: false }), 80, "/workspace");
  assert.equal(complete.toolCallId, "call-1");
  assert.equal(complete.replaceTool, true);
  assert.match(complete.ansi, /latest log/);
  assert.match(complete.text, /Tool sls, completed/);
  assert.match(complete.text, /Result:\nlatest log/);
  assert.match(complete.ansi, /\x1b\[48;2;40;50;40m/);
});

test("formats database JSON as connection details and a result table", () => {
  const formatted = formatToolOutput("db", JSON.stringify({
    provider: "mysql",
    connection: {
      url: "mysql://192.168.27.122:3306/srm_prod?useUnicode=true&serverTimezone=Asia%2FShanghai",
      username: "test_db",
      password: "Test_db+110",
    },
    columns: ["database_name", "server_hostname"],
    rows: [{ database_name: "srm_prod", server_hostname: "localhost.domain.com" }],
    truncated: false,
    runtime: "container",
  }));

  assert.match(formatted, /Database connection/);
  assert.match(formatted, /Address: mysql:\/\/192\.168\.27\.122:3306\/srm_prod/);
  assert.match(formatted, /serverTimezone: Asia\/Shanghai/);
  assert.match(formatted, /password: Test_db\+110/);
  assert.match(formatted, /database_name \| server_hostname/);
  assert.match(formatted, /srm_prod \| localhost\.domain\.com/);
  assert.match(formatted, /truncated: false/);
  assert.match(formatted, /runtime: container/);
  assert.doesNotMatch(formatted, /^\s*\{/);
});

test("renders a bounded Pi-style footer without terminal control injection", () => {
  const footer = renderTerminalFooter({
    workspace: "workspace/issue-1",
    provider: "managed\x1b]8;;invalid\x07",
    model: "model-with-a-long-name",
    thinkingLevel: "medium",
  }, 40);

  assert.equal(footer.lines, 2);
  assert.match(footer.ansi, /workspace\/issue-1/);
  assert.doesNotMatch(footer.ansi, /\x1b]8/);
  assert.doesNotMatch(footer.text, /context/);
  assert.match(footer.text, /model .*\/model-with-a-long-name \| thinking medium/);

  const status = renderTerminalEvent(event({ kind: "status", status: "complete" }), 80, "/workspace");
  assert.equal(status.ansi, "");
  assert.equal(status.text, "");

  const completionTool = renderTerminalEvent(event({ kind: "tool_call", toolCallId: "complete-1", toolName: "complete_issue", arguments: {} }), 80, "/workspace");
  assert.equal(completionTool.ansi, "");
  assert.equal(completionTool.text, "");
});
