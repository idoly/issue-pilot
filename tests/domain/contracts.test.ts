import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CAPABILITY_KEYS,
  ISSUE_WORK_MODES,
  USER_ROLES,
  canEditManagedUser,
  canManageDevelopmentConfiguration,
  configuredCapabilities,
  hasAdministratorAccess,
  hasPersonalGitIdentity,
  managedUserChangeRequiresAdministrator,
  isWorkspaceBusy,
  issueScopeForWorkMode,
  issueWorkMode,
  normalizeIssueKey,
  parseIssueKey,
} from "../../src/domain/contracts.ts";

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

test("role and isAdmin gate configuration, administration and user edits independently", () => {
  for (const role of USER_ROLES)
    for (const isAdmin of [false, true]) {
      const actor = { role, isAdmin };
      assert.equal(canManageDevelopmentConfiguration(actor), role === "developer");
      assert.equal(hasAdministratorAccess(actor), isAdmin);
      assert.equal(hasPersonalGitIdentity(role), role === "developer");
      // Ordinary accounts follow the developer gate; administrator targets or grants also require isAdmin.
      assert.equal(canEditManagedUser(actor, { isAdmin: false }), role === "developer");
      assert.equal(canEditManagedUser(actor, undefined), role === "developer");
      assert.equal(canEditManagedUser(actor, { isAdmin: true }), role === "developer" && isAdmin);
      assert.equal(canEditManagedUser(actor, { isAdmin: false }, true), role === "developer" && isAdmin);
    }
  for (const missing of [null, undefined]) {
    assert.equal(canManageDevelopmentConfiguration(missing), false);
    assert.equal(hasAdministratorAccess(missing), false);
    assert.equal(canEditManagedUser(missing), false);
  }
  assert.equal(hasPersonalGitIdentity(undefined), false);
  assert.equal(managedUserChangeRequiresAdministrator(undefined), false);
  assert.equal(managedUserChangeRequiresAdministrator(undefined, true), true);
  assert.equal(managedUserChangeRequiresAdministrator({ isAdmin: true }), true);
});
