import crypto from "node:crypto";
import { once } from "node:events";
import assert from "node:assert/strict";
import fs, { access, chmod, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createApiFixture, createService, issueMetadataPayload } from "./fixture.ts";
import type { MultipartFile } from "@fastify/multipart";
import { finalizeQuarantinedAttachments, readMultipartAttachment, stageAttachment, removePendingAttachments, openVerifiedAttachmentStream, removeWrittenAttachments, resolveSecureAttachmentFile, writePendingAttachments } from "../../src/http/attachment-store.ts";
import { claimIssueRoot, issueRoot, removeEmptyIssueRoot } from "../../src/workspace/state.ts";

for (const stage of ["open", "close"] as const) test(`removes attachment staging after a file ${stage} failure`, async context => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-attachment-io-"));
  const createDirectory = fs.mkdtemp, openFile = fs.open, reason = new Error(`fixture_${stage}_failed`);
  let staging: string | undefined;
  const part = { filename: "evidence.txt", mimetype: "text/plain", file: Object.assign(Readable.from([Buffer.from("evidence")]), { truncated: false }) } as MultipartFile;
  try {
    context.mock.method(fs, "mkdtemp", async () => {
      staging = await createDirectory(path.join(root, "stage-"));
      return staging;
    });
    if (stage === "open") context.mock.method(fs, "open", async () => { throw reason; });
    else context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await openFile(...args), close = handle.close.bind(handle);
      context.mock.method(handle, "close", async () => { await close(); throw reason; });
      return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(readMultipartAttachment(part), error => error === reason);
    assert.ok(staging);
    await assert.rejects(access(staging), { code: "ENOENT" });
  } finally {
    context.mock.restoreAll(); syncBuiltinESMExports();
    part.file.destroy(); await rm(root, { recursive: true, force: true });
  }
});

test("staging keeps both a stream failure and a cleanup failure", async context => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-stage-cleanup-"));
  const createDirectory = fs.mkdtemp;
  const failure = new Error("stream failed");
  const cleanup = new Error("staging removal failed");
  try {
    context.mock.method(fs, "mkdtemp", () => createDirectory(path.join(root, "stage-")));
    context.mock.method(fs, "rm", async () => { throw cleanup; });
    syncBuiltinESMExports();
    const chunks = async function* () { yield Buffer.from("partial"); throw failure; };
    await assert.rejects(stageAttachment("input.txt", "text/plain", chunks()), error => error instanceof AggregateError && error.errors.includes(failure) && error.errors.includes(cleanup));
  } finally {
    context.mock.restoreAll(); syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("pending cleanup drains every staging root and retains the original failure", async context => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-pending-drain-"));
  const first = path.join(root, "first"), second = path.join(root, "second");
  const primary = new Error("issue operation failed"), cleanup = new Error("first removal failed");
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let settled = false, operation: Promise<void> | undefined;
  const calls: string[] = [];
  try {
    context.mock.method(fs, "rm", async (candidate: Parameters<typeof fs.rm>[0]) => {
      calls.push(String(candidate));
      if (candidate === first) throw cleanup;
      entered(); await gate;
    });
    syncBuiltinESMExports();
    const pending = [first, second, first].map(directory => ({ fileName: "input.txt", mediaType: "text/plain", temporaryPath: path.join(directory, "file"), size: 0, sha256: "fixture" }));
    operation = removePendingAttachments(pending, [primary]);
    const observed = operation.then(() => { settled = true; }, () => { settled = true; });
    await started; await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    release();
    await assert.rejects(operation, error => error instanceof AggregateError && error.errors.includes(primary) && error.errors.includes(cleanup));
    await observed;
    assert.deepEqual(calls.sort(), [first, second].sort());
  } finally {
    release(); await Promise.allSettled([operation]);
    context.mock.restoreAll(); syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("Issue validation and staging cleanup failures reach the HTTP error owner together", async context => {
  const fixture = await createApiFixture();
  const failures: unknown[] = [];
  const createDirectory = fs.mkdtemp, remove = fs.rm;
  let staging: string | undefined;
  const cleanup = new Error("fixture_pending_cleanup_failed");
  try {
    fixture.app.addHook("onError", async (_request, _reply, error) => { failures.push(error); });
    await createService(fixture.app, "Cleanup", ["test"]);
    context.mock.method(fs, "mkdtemp", async () => {
      staging = await createDirectory(path.join(fixture.root, "stage-"));
      return staging;
    });
    context.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      if (args[0] === staging) throw cleanup;
      return remove(...args);
    });
    syncBuiltinESMExports();
    const boundary = "cleanup-error";
    const input = { ...issueMetadataPayload(""), serviceKey: "cleanup", workMode: "test_analysis" };
    const payload = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="issue"\r\n\r\n${JSON.stringify(input)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="input.txt"\r\nContent-Type: text/plain\r\n\r\nevidence\r\n--${boundary}--\r\n`);
    const response = await fixture.app.inject({ method: "POST", url: "/api/issues", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
    assert.equal(response.statusCode, 500);
    const failure = failures.find(error => error instanceof AggregateError) as AggregateError | undefined;
    assert.ok(failure);
    assert.ok(failure.errors.includes(cleanup));
    assert.ok(failure.errors.some(error => error instanceof Error && error.message === "invalid_title"));
    assert.equal((await fixture.app.inject({ method: "GET", url: "/api/issues" })).json().length, 0);
  } finally {
    context.mock.restoreAll(); syncBuiltinESMExports();
    await fixture.cleanup();
  }
});

test("rolls back only empty state claimed for a failed Issue creation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-attachment-rollback-"));
  const issueKey = "ISSUE-20260813-001";
  try {
    await claimIssueRoot(root, issueKey);
    const attachmentRoot = issueRoot(root, issueKey);
    assert.equal(attachmentRoot, issueRoot(root, issueKey));
    const objectKey = path.join(attachmentRoot, "new.txt");
    await writeFile(objectKey, "new", { mode: 0o400 });
    await removeWrittenAttachments([objectKey]);
    await removeEmptyIssueRoot(root, issueKey);
    await assert.rejects(access(issueRoot(root, issueKey)));

    await claimIssueRoot(root, issueKey);
    const evidence = path.join(attachmentRoot, "unexpected.txt");
    await writeFile(evidence, "preserve", { mode: 0o400 });
    await assert.rejects(removeEmptyIssueRoot(root, issueKey), /issue_state_rollback_failed/);
    assert.equal(await readFile(evidence, "utf8"), "preserve");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an attachment collision never registers another transaction's original for rollback", async context => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-original-collision-"));
  const key = "ISSUE-20261023-001", id = "11111111-1111-4111-8111-111111111111";
  try {
    await claimIssueRoot(root, key);
    const original = path.join(issueRoot(root, key), `.attachment-${id}-evidence.txt`);
    const pending = path.join(root, "pending.txt");
    await writeFile(original, "original evidence", { mode: 0o400 });
    await writeFile(pending, "new content");
    context.mock.method(crypto, "randomUUID", () => id);
    syncBuiltinESMExports();
    const written: string[] = [];
    await assert.rejects(writePendingAttachments({} as never, root, { id: "issue", key }, "uploader", [{ fileName: "evidence.txt", mediaType: "text/plain", temporaryPath: pending, size: 11, sha256: "fixture" }], written), { code: "EEXIST" });
    await removeWrittenAttachments(written);
    assert.equal(await readFile(original, "utf8"), "original evidence");
    assert.deepEqual(written, []);
  } finally {
    context.mock.restoreAll(); syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed attachment copy registers and removes only its owned partial file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-partial-original-"));
  const key = "ISSUE-20261023-001";
  try {
    await claimIssueRoot(root, key);
    const written: string[] = [];
    await assert.rejects(writePendingAttachments({} as never, root, { id: "issue", key }, "uploader", [{ fileName: "input.txt", mediaType: "text/plain", temporaryPath: path.join(root, "missing-source"), size: 0, sha256: "fixture" }], written), { code: "ENOENT" });
    assert.equal(written.length, 1);
    await removeWrittenAttachments(written);
    await assert.rejects(access(written[0]!), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("verified downloads keep the validated descriptor when the pathname is replaced", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-download-descriptor-"));
  try {
    const file = path.join(root, "evidence.txt");
    await writeFile(file, "original", { mode: 0o400 });
    const hash = crypto.createHash("sha256").update("original").digest("hex");
    const stream = await openVerifiedAttachmentStream(root, file, 8, hash);
    const closed = once(stream, "close");
    await rename(file, path.join(root, "retired.txt"));
    await writeFile(file, "replaced", { mode: 0o400 });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    await closed;
    assert.equal(Buffer.concat(chunks).toString(), "original");
    assert.equal(stream.closed, true);
    await assert.rejects(openVerifiedAttachmentStream(root, file, 8, hash), /attachment_integrity_check_failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cancelling attachment verification closes the owned descriptor", async context => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-download-cancel-"));
  const openFile = fs.open, controller = new AbortController(), reason = new Error("download cancelled");
  let closed = false;
  try {
    const file = path.join(root, "evidence.txt");
    await writeFile(file, "original", { mode: 0o400 });
    context.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await openFile(...args), read = handle.read.bind(handle), close = handle.close.bind(handle);
      context.mock.method(handle, "read", async (...args: Parameters<typeof handle.read>) => { const result = await read(...args); controller.abort(reason); return result; });
      context.mock.method(handle, "close", async () => { await close(); closed = true; });
      return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(openVerifiedAttachmentStream(root, file, 8, "unused", controller.signal), error => error === reason);
    assert.equal(closed, true);
  } finally { context.mock.restoreAll(); syncBuiltinESMExports(); await rm(root, { recursive: true, force: true }); }
});

test("accepts only readonly 0400 attachment files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-attachment-modes-"));
  try {
    const attachmentRoot = path.join(root, "attachments"); await mkdir(attachmentRoot, { mode: 0o700 });
    const file = path.join(attachmentRoot, "evidence.txt"); await writeFile(file, "evidence", { mode: 0o400 });
    assert.equal(await resolveSecureAttachmentFile(attachmentRoot, file, 8), file);
    for (const mode of [0o600, 0o500, 0o4400]) {
      await chmod(file, mode);
      await assert.rejects(resolveSecureAttachmentFile(attachmentRoot, file, 8), /insecure_issue_attachment_file/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects an attachment symlink while preserving its target and evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-attachment-symlink-"));
  try {
    const attachmentRoot = path.join(root, "attachments");
    await mkdir(attachmentRoot, { mode: 0o700 });
    const target = path.join(root, "outside.txt");
    await writeFile(target, "evidence", { mode: 0o400 });
    const objectKey = path.join(attachmentRoot, "linked.txt");
    await symlink(target, objectKey);
    await assert.rejects(resolveSecureAttachmentFile(attachmentRoot, objectKey, 8), /insecure_issue_attachment_file/);
    assert.equal(await readlink(objectKey), target);
    assert.equal(await readFile(target, "utf8"), "evidence");
  } finally { await rm(root, { recursive: true, force: true }); }
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
