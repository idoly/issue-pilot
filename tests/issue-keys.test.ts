import assert from "node:assert/strict";
import { test } from "node:test";

import { formatIssueDate, isIssueKey, nextDatedIssueKey } from "../src/issue-keys.ts";

test("accepts legacy and dated issue keys", () => {
  assert.equal(isIssueKey("ISSUE-0001"), true);
  assert.equal(isIssueKey("ISSUE-20260803-001"), true);
  assert.equal(isIssueKey("ISSUE-20260803-0001"), true); // Compatibility with the briefly published four-digit format.
  assert.equal(isIssueKey("ISSUE-20260803"), true); // Valid under the legacy numeric format.
  assert.equal(isIssueKey("ISSUE-20260803-1"), false);
});

test("formats issue dates in the configured business timezone", () => {
  const instant = new Date("2026-08-02T16:30:00.000Z");
  assert.equal(formatIssueDate(instant, "Asia/Shanghai"), "20260803");
  assert.equal(formatIssueDate(instant, "UTC"), "20260802");
});

test("allocates a daily sequence without considering legacy or other-day keys", () => {
  const keys = ["ISSUE-0009", "ISSUE-20260802-099", "ISSUE-20260803-001", "ISSUE-20260803-0003"];
  assert.equal(nextDatedIssueKey(keys, new Date("2026-08-03T02:00:00.000Z"), "UTC"), "ISSUE-20260803-004");
});
