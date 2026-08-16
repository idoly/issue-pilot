import assert from "node:assert/strict";
import { test } from "node:test";

import { CAPABILITY_KEYS, configuredCapabilities, isDmsDatabaseId, isDmsTenantId, isIssueKey, isWorkspaceBusy, normalizeIssueKey, parseIssueKey } from "../../src/domain/contracts.ts";

test("accepts only current date-sequence issue keys", () => {
  assert.equal(normalizeIssueKey("issue-20260810-001"), "ISSUE-20260810-001");
  assert.equal(parseIssueKey("issue-20260810-001"), "ISSUE-20260810-001");
  assert.equal(parseIssueKey(" issue-20260810-001"), undefined);
  assert.equal(isIssueKey("ISSUE-20260810-10000"), true);
  for (const invalidKey of ["ISSUE-1", "ISSUE-0041", "ISSUE-20260810-01", "ISSUE-2026-001"]) {
    assert.equal(isIssueKey(invalidKey), false);
    assert.throws(() => normalizeIssueKey(invalidKey), /invalid_issue_key/);
  }
});

test("keeps the Agent capability catalog in its shared display order", () => {
  assert.deepEqual(CAPABILITY_KEYS, ["nacos", "db", "redis", "mq", "es", "dms", "sls"]);
  assert.deepEqual(configuredCapabilities({ db: {}, unknown: {} }), ["db"]);
});

test("enforces the official DMS numeric identifier bounds", () => {
  assert.equal(isDmsDatabaseId("2147483647"), true);
  assert.equal(isDmsDatabaseId("2147483648"), false);
  assert.equal(isDmsTenantId("9007199254740991"), true);
  assert.equal(isDmsTenantId("9007199254740992"), false);
});

test("keeps the busy workspace predicate in the shared domain contract", () => {
  assert.equal(isWorkspaceBusy("preparing"), true);
  assert.equal(isWorkspaceBusy("running"), true);
  assert.equal(isWorkspaceBusy("ready"), false);
});
