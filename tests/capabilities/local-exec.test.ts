import assert from "node:assert/strict";
import { test } from "node:test";

import { executeLocalCommand } from "../../src/capabilities/local-exec.ts";

test("bounds output and applies scoped environment overrides for local capability processes", async () => {
  const normal = await executeLocalCommand(process.execPath, ["-e", "process.stdout.write('ok')"]);
  assert.equal(normal.stdout, "ok");
  const scoped = await executeLocalCommand(process.execPath, ["-e", "process.stdout.write(`${process.env.HOME}:${process.env.ISSUE_PILOT_TEST_MARKER}`)"], {
    environment: { HOME: "/tmp/issue-pilot-profile", ISSUE_PILOT_TEST_MARKER: "scoped" },
  });
  assert.equal(scoped.stdout, "/tmp/issue-pilot-profile:scoped");
  await assert.rejects(
    executeLocalCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(6 * 1024 * 1024))"]),
    /command_output_too_large/,
  );
});
