import assert from "node:assert/strict";
import { test } from "node:test";
import { DrizzleQueryError } from "drizzle-orm";
import Fastify from "fastify";

import { errorChain, errorDiagnostic, hasErrorCode } from "../../src/diagnostics.ts";

test("matches a stable error code exactly or in its code:detail form across the error chain", () => {
  assert.equal(hasErrorCode(new Error("issue_root_missing"), "issue_root_missing"), true);
  assert.equal(hasErrorCode(new Error("unmanaged_issue_state:workspaces/issue-20261113-001"), "unmanaged_issue_state"), true);
  assert.equal(hasErrorCode(new Error("issue_root_missing_extra"), "issue_root_missing"), false);
  assert.equal(hasErrorCode(new Error("xissue_root_missing"), "issue_root_missing"), false);
  assert.equal(hasErrorCode(new Error("SQLITE_CONSTRAINT: issue_deployment_required"), "issue_deployment_required"), true);
  assert.equal(hasErrorCode(new Error("SQLITE_CONSTRAINT: other_trigger"), "issue_deployment_required"), false);
  assert.equal(hasErrorCode(new AggregateError([new Error("outer"), new Error("workspace_release_rollback_failed")], "wrapper"), "workspace_release_rollback_failed"), true);
  assert.equal(hasErrorCode(new Error("outer", { cause: new Error("agent_session_file_missing") }), "agent_session_file_missing"), true);
  assert.equal(hasErrorCode("plain_code", "plain_code"), true);
});

async function loggedDiagnostic(error: unknown): Promise<{ message: string; output: string }> {
  let output = "";
  const app = Fastify({
    logger: {
      stream: {
        write: (chunk: string) => {
          output += chunk;
        },
      },
    },
  });
  app.log.error(errorDiagnostic(error));
  await app.close();
  return { message: JSON.parse(output).err.message, output };
}

test("logging aggregate failures does not serialize private nested errors", async () => {
  const failure = new AggregateError([new Error("transport_failed", { cause: new Error("fixture-secret") }), new Error("cleanup_failed")], "agent_failure_cleanup_failed");
  const logged = await loggedDiagnostic(failure);
  assert.equal(logged.message, "agent_failure_cleanup_failed");
  assert.doesNotMatch(logged.output, /fixture-secret/);
  assert.equal(errorChain(failure).length, 4, "the original diagnostic chain must remain intact");
});

test("resource disposal failures retain both errors for classification and database redaction", async () => {
  const databaseFailure = new DrizzleQueryError("insert into credentials values (?)", ["fixture-secret"], Object.assign(new Error("constraint failed"), { code: "SQLITE_CONSTRAINT" }));
  const cleanup = new Error("cleanup_failed");
  const failure = new SuppressedError(cleanup, databaseFailure, "resource_cleanup_failed");
  assert.ok(errorChain(failure).includes(databaseFailure));
  assert.ok(errorChain(failure).includes(cleanup));
  const logged = await loggedDiagnostic(failure);
  assert.equal(logged.message, "database_operation_failed:SQLITE_CONSTRAINT");
  assert.doesNotMatch(logged.output, /fixture-secret|insert into credentials/);
  cleanup.cause = failure;
  assert.equal(errorChain(failure).length, 4, "cyclic diagnostic chains must terminate");
});
