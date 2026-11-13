import assert from "node:assert/strict";
import { test } from "node:test";

import { hasErrorCode } from "../../src/diagnostics.ts";

test("matches a stable error code exactly or in its code:detail form across the error chain", () => {
  assert.equal(hasErrorCode(new Error("issue_root_missing"), "issue_root_missing"), true);
  assert.equal(hasErrorCode(new Error("unmanaged_issue_state:workspaces/issue-20261113-001"), "unmanaged_issue_state"), true);
  assert.equal(hasErrorCode(new Error("issue_root_missing_extra"), "issue_root_missing"), false);
  assert.equal(hasErrorCode(new Error("SQLITE_CONSTRAINT: issue_deployment_required"), "issue_deployment_required"), true);
  assert.equal(hasErrorCode(new Error("SQLITE_CONSTRAINT: other_trigger"), "issue_deployment_required"), false);
  assert.equal(hasErrorCode(new AggregateError([new Error("outer"), new Error("workspace_release_rollback_failed")], "wrapper"), "workspace_release_rollback_failed"), true);
  assert.equal(hasErrorCode(new Error("outer", { cause: new Error("agent_session_file_missing") }), "agent_session_file_missing"), true);
  assert.equal(hasErrorCode("plain_code", "plain_code"), true);
});
