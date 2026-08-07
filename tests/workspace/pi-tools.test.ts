import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { preparePiWorkspace } from "../../src/workspace/pi-tools.ts";

test("prepares containerized project wrappers for native Pi bash", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pi-workspace-"));
  try {
    await preparePiWorkspace(root);
    const node = await readFile(path.join(root, ".issue-pilot", "bin", "node-project"), "utf8");
    const maven = await readFile(path.join(root, ".issue-pilot", "bin", "maven-project"), "utf8");
    assert.match(node, /node:26\.5\.1-bookworm-slim/);
    assert.match(maven, /maven:3\.9\.16-eclipse-temurin-8/);
    assert.doesNotMatch(node, /--network none/);
    assert.doesNotMatch(maven, /--network none/);
    assert.match(node, /packageManager/);
    assert.match(node, /yarn@\*/);
    assert.match(node, /--frozen-lockfile/);
    assert.match(node, /\/root\/\.npmrc:ro/);
    assert.match(maven, /\/root\/\.m2\/settings\.xml:ro/);
    assert.match(maven, /"\$action" "\$@"/);
    assert.equal((await stat(path.join(root, ".issue-pilot", "bin", "node-project"))).mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
