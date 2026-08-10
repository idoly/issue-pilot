import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { prepareProjectWrappers } from "../../src/workspace/project-wrappers.ts";
import { issueRuntimeRoot } from "../../src/workspace/state.ts";

test("prepares issue project wrappers for native Pi bash", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pi-workspace-"));
  try {
    const runtimeRoot = issueRuntimeRoot(root, "ISSUE-20260810-001");
    const binRoot = await prepareProjectWrappers(runtimeRoot);
    assert.equal(binRoot, path.join(runtimeRoot, "bin"));
    const node = await readFile(path.join(binRoot, "node-project"), "utf8");
    const maven = await readFile(path.join(binRoot, "maven-project"), "utf8");
    assert.match(node, /corepack "\$package_manager" install --frozen-lockfile/);
    assert.match(node, /npm ci/);
    assert.match(node, /cd "\$project"/);
    assert.match(maven, /mvn --batch-mode --no-transfer-progress/);
    assert.doesNotMatch(node, /podman|PI_NODE_CLI_IMAGE/);
    assert.doesNotMatch(maven, /podman|PI_MAVEN_CLI_IMAGE|PI_MAVEN_REPOSITORY/);
    assert.equal((await stat(path.join(binRoot, "node-project"))).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(binRoot, "maven-project"))).mode & 0o777, 0o700);
    assert.equal(await prepareProjectWrappers(runtimeRoot), binRoot);
    assert.deepEqual(await readdir(runtimeRoot), ["bin"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
