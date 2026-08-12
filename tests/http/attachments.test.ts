import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { finalizeQuarantinedAttachments, removeWrittenAttachments } from "../../src/http/attachments.ts";
import { claimIssueRoot, issueAttachmentRoot, issueRoot, removeEmptyIssueRoot } from "../../src/workspace/state.ts";

test("rolls back only empty state claimed for a failed Issue creation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-attachment-rollback-"));
  const issueKey = "ISSUE-20260813-001";
  try {
    await claimIssueRoot(root, issueKey);
    const attachmentRoot = issueAttachmentRoot(root, issueKey);
    await mkdir(attachmentRoot, { mode: 0o700 });
    const objectKey = path.join(attachmentRoot, "new.txt");
    await writeFile(objectKey, "new", { mode: 0o400 });
    await removeWrittenAttachments([objectKey]);
    await removeEmptyIssueRoot(root, issueKey);
    await assert.rejects(access(issueRoot(root, issueKey)));

    await claimIssueRoot(root, issueKey);
    await mkdir(attachmentRoot, { mode: 0o700 });
    const evidence = path.join(attachmentRoot, "unexpected.txt");
    await writeFile(evidence, "preserve", { mode: 0o400 });
    await assert.rejects(removeEmptyIssueRoot(root, issueKey), /issue_state_rollback_failed/);
    assert.equal(await readFile(evidence, "utf8"), "preserve");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports quarantine finalize failures without hiding retained evidence", async () => {
  const quarantined = [
    { sourcePath: "/attachments/one", temporaryPath: "/attachments/.one.deleting" },
    { sourcePath: "/attachments/two", temporaryPath: "/attachments/.two.deleting" },
  ];
  const attempts: string[] = [];
  await assert.rejects(finalizeQuarantinedAttachments(quarantined, async (candidate) => {
    attempts.push(candidate);
    if (candidate.includes(".one.")) throw new Error("remove_failed");
  }), /attachment_finalize_failed/);
  assert.deepEqual(attempts.sort(), quarantined.map(({ temporaryPath }) => temporaryPath).sort());
});
