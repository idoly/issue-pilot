import assert from "node:assert/strict";
import test from "node:test";

import { continuationPrompt, initialPrompt, promptWithRuntimeTime, runtimeTimeContext } from "../../src/agent/prompts.ts";

const now = new Date("2026-08-06T01:52:43.000Z");

test("injects the current UTC and Asia/Shanghai time into every Agent prompt", () => {
  const expected = "2026-08-06T09:52:43+08:00";
  assert.match(runtimeTimeContext(now), new RegExp(expected.replaceAll("+", "\\+")));
  assert.match(promptWithRuntimeTime("sls latest record", now), /User request:\nsls latest record/);
  assert.match(promptWithRuntimeTime("sls latest record", now), /Never reuse a timestamp from an earlier session message/);

  const repositories = [{ url: "git@example/repo.git", branch: "main", path: "/workspace/repo", readOnly: true }];
  assert.match(continuationPrompt("ISSUE-1", repositories, undefined, now), new RegExp(expected.replaceAll("+", "\\+")));
  assert.match(initialPrompt({
    issueKey: "ISSUE-1",
    title: "Latest log",
    description: "Read the latest SLS record",
    issueType: "question",
    repositories,
    service: { key: "service", name: "Service" },
  }, now), new RegExp(expected.replaceAll("+", "\\+")));
});
