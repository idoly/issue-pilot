import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { prepareProjectWrappers } from "../../src/workspace/project-wrappers.ts";

test("prepares session-runtime project wrappers for native Pi bash", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pi-workspace-"));
  try {
    await prepareProjectWrappers(root);
    const node = await readFile(path.join(root, "bin", "node-project"), "utf8");
    const maven = await readFile(path.join(root, "bin", "maven-project"), "utf8");
    assert.match(node, /corepack "\$package_manager" install --frozen-lockfile/);
    assert.match(node, /npm ci/);
    assert.match(node, /cd "\$project"/);
    assert.match(maven, /mvn --batch-mode --no-transfer-progress/);
    assert.doesNotMatch(node, /podman|PI_NODE_CLI_IMAGE/);
    assert.doesNotMatch(maven, /podman|PI_MAVEN_CLI_IMAGE|PI_MAVEN_REPOSITORY/);
    assert.equal((await stat(path.join(root, "bin", "node-project"))).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(root, "bin", "maven-project"))).mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
