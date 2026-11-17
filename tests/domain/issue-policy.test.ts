import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ENVIRONMENT_KINDS,
  ISSUE_WORK_MODES,
  canChangeIssueScope,
  canModifyIssueCode,
  canResetIssueSession,
  canUseIssueWorkMode,
  isDevelopmentEnvironment,
  isIssueActive,
  issueScopeForWorkMode,
  relatedIssueUpdateRefusal,
  requiresDeveloperOwner,
  scopeTransitionRefusal,
  type IssueScopeState,
} from "../../src/domain/contracts.ts";

test("code write access, the developer-owner rule and work-mode authorization share the work-mode table", () => {
  for (const workMode of ISSUE_WORK_MODES) {
    const scope = issueScopeForWorkMode(workMode);
    assert.equal(canModifyIssueCode(scope.environmentKind), scope.repositoryAccess === "write", workMode);
    assert.equal(requiresDeveloperOwner(scope.environmentKind), scope.repositoryAccess === "write", workMode);
    assert.equal(canUseIssueWorkMode("product", workMode), !requiresDeveloperOwner(scope.environmentKind), workMode);
  }
  assert.deepEqual(
    ENVIRONMENT_KINDS.filter((kind) => canModifyIssueCode(kind)),
    ["dev"],
  );
});

test("identifies the development environment by kind only", () => {
  assert.deepEqual(
    ENVIRONMENT_KINDS.filter((kind) => isDevelopmentEnvironment(kind)),
    ["dev"],
  );
  assert.equal(isDevelopmentEnvironment(undefined), false);
});

test("scope transition eligibility returns the lifecycle refusal code or null", () => {
  const analysis: IssueScopeState = { environmentKind: "prod", issueType: "smart_analysis", status: "open", workspaceStatus: "ready" };
  assert.equal(scopeTransitionRefusal("convert_to_development", analysis, "dev"), null);
  assert.equal(scopeTransitionRefusal("convert_to_development", { ...analysis, environmentKind: "test", status: "pending" }, "dev"), null);
  for (const changed of [
    { status: "in_progress" },
    { status: "resolved" },
    { workspaceStatus: "stopped" },
    { workspaceStatus: "preparing" },
    { environmentKind: "dev", issueType: "defect_fix" },
    { issueType: "defect_fix" },
  ] as const)
    assert.equal(scopeTransitionRefusal("convert_to_development", { ...analysis, ...changed }, "dev"), "issue_not_convertible_to_development", JSON.stringify(changed));
  assert.equal(scopeTransitionRefusal("convert_to_development", analysis, "test"), "issue_not_convertible_to_development");

  const development: IssueScopeState = { environmentKind: "dev", issueType: "feature_development", status: "pending", workspaceStatus: "ready" };
  assert.equal(scopeTransitionRefusal("migrate_development", development, "dev"), null);
  assert.equal(scopeTransitionRefusal("migrate_development", { ...development, issueType: "defect_fix" }, "dev"), null);
  for (const [changed, target] of [
    [{}, undefined],
    [{}, "prod"],
    [{ issueType: "smart_analysis" }, "dev"],
    [{ environmentKind: "test", issueType: "smart_analysis" }, "dev"],
    [{ status: "resolved" }, "dev"],
    [{ workspaceStatus: "running" }, "dev"],
  ] as const)
    assert.equal(scopeTransitionRefusal("migrate_development", { ...development, ...changed }, target), "issue_not_migratable_between_development_scopes", JSON.stringify(changed));
});

test("client predicates mirror the server's scope, related-Issue, reset and activity checks", () => {
  const readOnly = { environmentKind: "prod" as const, status: "resolved" as const, workspaceStatus: "stopped" as const, agentRunning: false };
  assert.equal(canChangeIssueScope(readOnly), true, "read-only rebinding has no status or workspace requirement");
  assert.equal(canChangeIssueScope({ ...readOnly, agentRunning: true }), false);
  assert.equal(canChangeIssueScope({ ...readOnly, workspaceStatus: "preparing" }), false);
  const development = { environmentKind: "dev" as const, status: "open" as const, workspaceStatus: "ready" as const, agentRunning: false };
  assert.equal(canChangeIssueScope(development), true);
  assert.equal(canChangeIssueScope({ ...development, status: "in_progress" }), false);
  assert.equal(canChangeIssueScope({ ...development, workspaceStatus: "stopped" }), false);

  const ready = { status: "pending" as const, workspace: { status: "stopped" as const, runtimeReady: true } };
  assert.equal(relatedIssueUpdateRefusal(ready), null);
  assert.equal(relatedIssueUpdateRefusal({ ...ready, status: "resolved" }), "related_issue_update_not_allowed");
  assert.equal(relatedIssueUpdateRefusal({ ...ready, workspace: undefined }), "related_issue_context_unavailable");
  assert.equal(relatedIssueUpdateRefusal({ ...ready, workspace: { status: "ready", runtimeReady: false } }), "related_issue_context_unavailable");
  assert.equal(relatedIssueUpdateRefusal({ ...ready, workspace: { status: "failed", runtimeReady: true } }), "related_issue_context_unavailable");
  // Detaching existing relations needs no prepared view, including on a never-run Issue.
  assert.equal(relatedIssueUpdateRefusal({ ...ready, workspace: undefined }, { onlyRemoves: true }), null);
  assert.equal(relatedIssueUpdateRefusal({ status: "open", workspace: { status: "not_created", runtimeReady: false } }, { onlyRemoves: true }), null);
  assert.equal(relatedIssueUpdateRefusal({ ...ready, status: "resolved" }, { onlyRemoves: true }), "related_issue_update_not_allowed");

  assert.equal(canResetIssueSession({ actorRole: "developer", status: "pending", agentRunning: false }), true);
  assert.equal(canResetIssueSession({ actorRole: "test", status: "pending", agentRunning: false }), false);
  assert.equal(canResetIssueSession({ actorRole: "developer", status: "resolved", agentRunning: false }), false);
  assert.equal(canResetIssueSession({ actorRole: "developer", status: "open", agentRunning: true }), false);

  assert.equal(isIssueActive({ agentRunning: false, workspaceStatus: "ready" }), false);
  assert.equal(isIssueActive({ agentRunning: true, workspaceStatus: "ready" }), true);
  assert.equal(isIssueActive({ agentRunning: false, workspaceStatus: "running" }), true);
});
