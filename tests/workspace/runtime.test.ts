import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { prepareReadOnlyRuntime } from "../../src/workspace/runtime.ts";
import { issueAttachmentRoot, issueRuntimeRoot, issueWorkspaceRoot, sharedCheckoutsRoot } from "../../src/workspace/state.ts";

test("prepares an issue session runtime from shared repositories without an issue workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-runtime-"));
  const issueKey = "ISSUE-20260810-001";
  try {
    const checkout = path.join(sharedCheckoutsRoot(root), "repository", "commit");
    await mkdir(checkout, { recursive: true });
    await writeFile(path.join(checkout, "README.md"), "shared checkout\n", "utf8");
    const attachments = issueAttachmentRoot(root, issueKey);
    await mkdir(attachments, { recursive: true, mode: 0o700 });
    await writeFile(path.join(attachments, "evidence.txt"), "evidence\n", { mode: 0o600 });

    const runtime = await prepareReadOnlyRuntime(root, issueKey, [{ name: "orders", checkoutPath: checkout }]);
    assert.equal(runtime, issueRuntimeRoot(root, issueKey));
    assert.equal((await lstat(path.join(runtime, "orders"))).isSymbolicLink(), true);
    assert.equal((await lstat(path.join(runtime, "attachments"))).isSymbolicLink(), true);
    const repositoryLink = await readlink(path.join(runtime, "orders"));
    const attachmentLink = await readlink(path.join(runtime, "attachments"));
    assert.equal(path.isAbsolute(repositoryLink), false);
    assert.equal(path.resolve(runtime, repositoryLink), checkout);
    assert.equal(path.isAbsolute(attachmentLink), false);
    assert.equal(path.resolve(runtime, attachmentLink), attachments);
    assert.equal(await readFile(path.join(runtime, "orders", "README.md"), "utf8"), "shared checkout\n");
    assert.equal(await readFile(path.join(runtime, "attachments", "evidence.txt"), "utf8"), "evidence\n");
    await assert.rejects(access(issueWorkspaceRoot(root, issueKey)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
