import assert from "node:assert/strict";
import { test } from "node:test";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { executeLocalCommand } from "../../src/capabilities/local-exec.ts";

test("bounds output and applies scoped environment overrides for local capability processes", async () => {
  const normal = await executeLocalCommand(process.execPath, ["-e", "process.stdout.write('ok')"]);
  assert.equal(normal.stdout, "ok");
  const scoped = await executeLocalCommand("/bin/sh", ["-c", "printf '%s:%s' \"$HOME\" \"$TEST_MARKER\""], {
    environment: { HOME: "/tmp/issue-pilot-profile", TEST_MARKER: "scoped" },
  });
  assert.equal(scoped.stdout, "/tmp/issue-pilot-profile:scoped");
  await assert.rejects(
    executeLocalCommand(process.execPath, ["-e", `process.stdout.write('x'.repeat(${issuePilotConfig.limits.process.commandOutputBytes + 1}))`]),
    /command_output_too_large/,
  );
});
