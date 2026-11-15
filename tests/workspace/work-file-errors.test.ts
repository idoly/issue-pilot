import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DomainError } from "../../src/domain/errors.ts";
import { claimIssueRoot, issueRoot } from "../../src/workspace/state.ts";
import { listIssueWorkFiles, openIssueWorkFile } from "../../src/workspace/work-files.ts";

const key = "ISSUE-20261115-001";

test("work-file readers declare missing and redirected paths as client errors and keep the cause", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-work-file-errors-"));
  try {
    await claimIssueRoot(root, key);
    const work = issueRoot(root, key);
    await mkdir(path.join(work, "folder"));
    await writeFile(path.join(work, "folder", "evidence.txt"), "evidence");
    const expect = (code: string, status: number, errno: string | undefined) => (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, code);
      assert.equal(error.statusCode, status);
      if (errno) assert.equal((error.cause as NodeJS.ErrnoException).code, errno);
      return true;
    };
    await assert.rejects(listIssueWorkFiles(root, key, "missing"), expect("issue_file_not_found", 404, "ENOENT"));
    await assert.rejects(openIssueWorkFile(root, key, "folder/missing.txt"), expect("issue_file_not_found", 404, "ENOENT"));
    await assert.rejects(openIssueWorkFile(root, key, "folder/evidence.txt/child"), expect("issue_file_not_found", 404, "ENOTDIR"));
    // Owner refusals keep their own category instead of being renamed.
    await assert.rejects(openIssueWorkFile(root, key, "../outside"), expect("invalid_issue_file_path", 400, undefined));
    const opened = await openIssueWorkFile(root, key, "folder/evidence.txt");
    await opened.handle.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
