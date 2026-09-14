import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { GeneratedDirectoryRollbackFailure, replaceGeneratedDirectory, type GeneratedDirectoryOperations } from "../../src/workspace/generated-directory.ts";

async function directory(root: string, name: string, contents: string): Promise<string> {
  const target = path.join(root, name);
  await mkdir(target);
  await writeFile(path.join(target, "value.txt"), contents, "utf8");
  return target;
}

const remove = (candidate: string) => rm(candidate, { recursive: true });

test("atomically replaces generated directories and restores the previous target on failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-generated-directory-"));
  try {
    const target = await directory(root, "target", "old\n");
    const replacement = await directory(root, "replacement", "new\n");
    const previous = path.join(root, "previous");
    await replaceGeneratedDirectory(target, replacement, previous);
    assert.equal(await readFile(path.join(target, "value.txt"), "utf8"), "new\n");
    await Promise.all([assert.rejects(access(replacement)), assert.rejects(access(previous))]);

    const failedReplacement = await directory(root, "failed-replacement", "failed\n");
    const failedPrevious = path.join(root, "failed-previous");
    const installFailure = new Error("simulated_install_failure");
    const operations: GeneratedDirectoryOperations = {
      async rename(source, destination) {
        if (source === failedReplacement && destination === target) throw installFailure;
        await rename(source, destination);
      },
      remove,
    };
    await assert.rejects(replaceGeneratedDirectory(target, failedReplacement, failedPrevious, operations), (error: unknown) => error === installFailure);
    assert.equal(await readFile(path.join(target, "value.txt"), "utf8"), "new\n");
    assert.equal(await readFile(path.join(failedReplacement, "value.txt"), "utf8"), "failed\n");
    await assert.rejects(access(failedPrevious));

    const rollbackReplacement = await directory(root, "rollback-replacement", "rollback\n");
    const rollbackPrevious = path.join(root, "rollback-previous");
    const rollbackOperations: GeneratedDirectoryOperations = {
      async rename(source, destination) {
        if (source === rollbackReplacement && destination === target) throw installFailure;
        if (source === rollbackPrevious && destination === target) throw new Error("simulated_rollback_failure");
        await rename(source, destination);
      },
      remove,
    };
    await assert.rejects(replaceGeneratedDirectory(target, rollbackReplacement, rollbackPrevious, rollbackOperations), GeneratedDirectoryRollbackFailure);
    await assert.rejects(access(target));
    assert.equal(await readFile(path.join(rollbackPrevious, "value.txt"), "utf8"), "new\n");
    assert.equal(await readFile(path.join(rollbackReplacement, "value.txt"), "utf8"), "rollback\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("commits the replacement even when obsolete generated cleanup fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-generated-cleanup-"));
  try {
    const target = await directory(root, "target", "old\n");
    const replacement = await directory(root, "replacement", "new\n");
    const previous = path.join(root, "previous");
    await replaceGeneratedDirectory(target, replacement, previous, {
      rename,
      async remove() { throw new Error("simulated_cleanup_failure"); },
    });
    assert.equal(await readFile(path.join(target, "value.txt"), "utf8"), "new\n");
    assert.equal(await readFile(path.join(previous, "value.txt"), "utf8"), "old\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
