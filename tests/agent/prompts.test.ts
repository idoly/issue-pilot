import assert from "node:assert/strict";
import { test } from "node:test";

import { continuationPrompt, initialPrompt, promptWithRuntimeTime, runtimeTimeContext } from "../../src/agent/prompts.ts";

const now = new Date("2026-08-06T01:52:43.000Z");

test("injects the current UTC and Asia/Shanghai time into every Agent prompt", () => {
  const expected = "2026-08-06T09:52:43+08:00";
  assert.match(runtimeTimeContext(now), new RegExp(expected.replaceAll("+", "\\+")));
  assert.match(promptWithRuntimeTime("sls latest record", now), /User request:\nsls latest record/);

  const repositories = [{ url: "git@example/repo.git", branch: "main", path: "/workspace/repo", readOnly: true }];
  const continuation = continuationPrompt("ISSUE-1", repositories, undefined, now);
  assert.match(continuation, new RegExp(expected.replaceAll("+", "\\+")));
  assert.match(continuation, /defect_fix and feature_development, make only the minimum changes required/);
  assert.match(continuation, /unless the user explicitly asks you to commit or push them/);
  const initial = initialPrompt({
    issueKey: "ISSUE-1",
    title: "Latest log",
    description: "Read the latest SLS record",
    issueType: "smart_analysis",
    repositories,
    service: { key: "service", name: "Service" },
  }, now);
  assert.match(initial, new RegExp(expected.replaceAll("+", "\\+")));
  assert.match(initial, /unless the user explicitly asks you to commit or push them/);
});
