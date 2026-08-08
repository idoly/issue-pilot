import assert from "node:assert/strict";
import test from "node:test";

import { execLocal } from "../../src/capabilities/local-exec.ts";

test("bounds output captured from local capability processes", async () => {
  const normal = await execLocal(process.execPath, ["-e", "process.stdout.write('ok')"]);
  assert.equal(normal.stdout, "ok");
  await assert.rejects(
    execLocal(process.execPath, ["-e", "process.stdout.write('x'.repeat(6 * 1024 * 1024))"]),
    /command_output_too_large/,
  );
});
