import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { prepareReadOnlyRuntime } from "../../src/workspace/runtime.ts";
import { issueRuntimeRoot, issueWorkspaceRoot, sharedCheckoutsRoot } from "../../src/workspace/state.ts";

test("prepares an issue runtime from shared repositories without an issue workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-runtime-"));
  const issueKey = "ISSUE-20260810-001";
  try {
    const checkout = path.join(sharedCheckoutsRoot(root), "repository", "commit");
    await mkdir(checkout, { recursive: true });
    await writeFile(path.join(checkout, "README.md"), "shared checkout\n", "utf8");

    const runtime = await prepareReadOnlyRuntime(root, issueKey, [{ name: "orders", checkoutPath: checkout }]);
    assert.equal(runtime, issueRuntimeRoot(root, issueKey));
    assert.equal((await lstat(path.join(runtime, "orders"))).isSymbolicLink(), true);
    const repositoryLink = await readlink(path.join(runtime, "orders"));
    assert.equal(path.isAbsolute(repositoryLink), false);
    assert.equal(path.resolve(runtime, repositoryLink), checkout);
    assert.equal(await readFile(path.join(runtime, "orders", "README.md"), "utf8"), "shared checkout\n");
    await assert.rejects(access(issueWorkspaceRoot(root, issueKey)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
