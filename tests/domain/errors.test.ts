import assert from "node:assert/strict";
import { test } from "node:test";

import { DomainError, domainError } from "../../src/domain/errors.ts";

test("maps owner codes to one transport-neutral category and keeps their cause", () => {
  assert.equal(domainError("source_path_not_found").statusCode, 404);
  assert.equal(domainError("source_file_changed").statusCode, 409);
  assert.equal(domainError("invalid_source_path").statusCode, 400);
  assert.equal(domainError("source_file_too_large").statusCode, 413);
  assert.equal(domainError("source_history_timeout").statusCode, 500);
  const cause = new Error("fixture");
  const wrapped = domainError("source_git_binding_invalid", { cause });
  assert(wrapped instanceof DomainError);
  assert.equal(wrapped.code, "source_git_binding_invalid");
  assert.equal(wrapped.statusCode, 409);
  assert.equal(wrapped.cause, cause);
});
