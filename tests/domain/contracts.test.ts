import assert from "node:assert/strict";
import { test } from "node:test";

import { CAPABILITY_KEYS, ISSUE_WORK_MODES, configuredCapabilities, isWorkspaceBusy, issueScopeForWorkMode, issueWorkMode, normalizeIssueKey, parseIssueKey } from "../../src/domain/contracts.ts";

test("accepts only current date-sequence issue keys", () => {
  assert.equal(normalizeIssueKey("issue-20260810-001"), "ISSUE-20260810-001");
  assert.equal(parseIssueKey("issue-20260810-001"), "ISSUE-20260810-001");
  assert.equal(parseIssueKey(" issue-20260810-001"), undefined);
  assert.equal(parseIssueKey("ISSUE-20260810-10000"), "ISSUE-20260810-10000");
  for (const invalidKey of ["ISSUE-1", "ISSUE-0041", "ISSUE-20260810-01", "ISSUE-2026-001"]) {
    assert.equal(parseIssueKey(invalidKey), undefined);
    assert.throws(() => normalizeIssueKey(invalidKey), /invalid_issue_key/);
  }
});

test("keeps the Agent capability catalog in its shared display order", () => {
  assert.deepEqual(CAPABILITY_KEYS, ["dms", "sls"]);
  assert.deepEqual(configuredCapabilities({ sls: {} }), ["sls"]);
});

test("maps each Issue work mode to one valid environment and type", () => {
  assert.deepEqual(ISSUE_WORK_MODES, ["production_analysis", "test_analysis", "development_fix", "development_feature"]);
  assert.deepEqual(issueScopeForWorkMode("production_analysis"), { environmentKind: "prod", issueType: "smart_analysis", repositoryAccess: "read" });
  assert.deepEqual(issueScopeForWorkMode("development_feature"), { environmentKind: "dev", issueType: "feature_development", repositoryAccess: "write" });
  for (const workMode of ISSUE_WORK_MODES) {
    const scope = issueScopeForWorkMode(workMode);
    assert.equal(issueWorkMode(scope.environmentKind, scope.issueType), workMode);
  }
  assert.equal(issueWorkMode("test", "defect_fix"), undefined);
});

test("keeps the busy workspace predicate in the shared domain contract", () => {
  assert.equal(isWorkspaceBusy("preparing"), true);
  assert.equal(isWorkspaceBusy("running"), true);
  assert.equal(isWorkspaceBusy("ready"), false);
});
