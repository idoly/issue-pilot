import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, type ReadStream } from "node:fs";
import { chmod, mkdir, mkdtemp, open, rename, rm, lstat, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { MultipartFile } from "@fastify/multipart";
import type { Database } from "../db/client.ts";
import { issueAttachments } from "../db/schema.ts";
import { issueRoot } from "../workspace/state.ts";
import { ApiError } from "./input.ts";

export interface PendingAttachment {
  fileName: string;
  mediaType: string;
  temporaryPath: string;
  size: number;
  sha256: string;
}

export async function readMultipartAttachment(part: MultipartFile): Promise<PendingAttachment> {
  async function* chunks() {
    yield* part.file;
    if (part.file.truncated) throw new Error("attachment_stream_truncated");
  }
  return stageAttachment(path.basename(part.filename), part.mimetype, chunks());
}

export async function stageAttachment(fileName: string, mediaType: string, chunks: AsyncIterable<Uint8Array>): Promise<PendingAttachment> {
  if (!fileName || /[/\\\u0000-\u001f\u007f]/.test(fileName) || [".", ".."].includes(fileName)) throw new ApiError(400, "invalid_attachment_name");
  const stagingRoot = await mkdtemp(path.join(tmpdir(), "issue-pilot-attachment-"));
  const temporaryPath = path.join(stagingRoot, randomUUID());
  const sha256 = createHash("sha256");
  let size = 0;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    for await (const chunk of chunks) {
      const content = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      await handle.writeFile(content);
      sha256.update(content);
      size += content.length;
    }
    await handle.close();
    return { fileName, mediaType, temporaryPath, size, sha256: sha256.digest("hex") };
  } catch (error) {
    const failures: unknown[] = [error];
    try { await handle?.close(); } catch (failure) { if (!failures.includes(failure)) failures.push(failure); }
    try { await rm(stagingRoot, { recursive: true, force: true }); } catch (failure) { failures.push(failure); }
    if (failures.length > 1) throw new AggregateError(failures, "attachment_staging_cleanup_failed");
    throw error;
  }
}

export async function removePendingAttachments(pendingAttachments: PendingAttachment[], primaryFailures: readonly unknown[] = []): Promise<void> {
  const stagingRoots = [...new Set(pendingAttachments.map(({ temporaryPath }) => path.dirname(temporaryPath)))];
  const results = await Promise.allSettled(stagingRoots.map(stagingRoot => rm(stagingRoot, { recursive: true, force: true })));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
  if (failures.length) throw new AggregateError([...primaryFailures, ...failures], "attachment_staging_cleanup_failed");
}

function validateAttachmentFile(metadata: { isFile(): boolean; mode: number; size: number } | undefined, expectedSize?: number): void {
  if (!metadata?.isFile() || (metadata.mode & 0o7777) !== 0o400 || (expectedSize !== undefined && metadata.size !== expectedSize)) throw new Error("insecure_issue_attachment_file");
}

export async function resolveSecureAttachmentFile(attachmentRoot: string, objectKey: string, expectedSize?: number): Promise<string> {
  const attachmentPath = path.resolve(objectKey);
  const metadata = await lstat(attachmentPath).catch(() => undefined);
  if (path.dirname(attachmentPath) !== attachmentRoot) throw new Error("insecure_issue_attachment_file");
  validateAttachmentFile(metadata, expectedSize);
  return attachmentPath;
}

export async function openVerifiedAttachmentFile(
  attachmentRoot: string,
  objectKey: string,
  size: number,
  sha256: string,
  signal?: AbortSignal,
): Promise<FileHandle> {
  signal?.throwIfAborted();
  const file = await resolveSecureAttachmentFile(attachmentRoot, objectKey, size);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    validateAttachmentFile(await handle.stat(), size);
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (true) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    signal?.throwIfAborted();
    if (position !== size || hash.digest("hex") !== sha256) throw new Error("attachment_integrity_check_failed");
    return handle;
  } catch (error) {
    try { await handle.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "attachment_read_cleanup_failed"); }
    throw error;
  }
}

export async function openVerifiedAttachmentStream(
  attachmentRoot: string,
  objectKey: string,
  size: number,
  sha256: string,
  signal?: AbortSignal,
): Promise<ReadStream> {
  const handle = await openVerifiedAttachmentFile(attachmentRoot, objectKey, size, sha256, signal);
  try {
    // Reuse the verified descriptor rather than reopening a replaceable path.
    return handle.createReadStream({ start: 0, autoClose: true, ...(signal ? { signal } : {}) });
  } catch (error) {
    try { await handle.close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "attachment_read_cleanup_failed"); }
    throw error;
  }
}

export function serializeAttachment(attachment: typeof issueAttachments.$inferSelect) {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    storedFileName: path.basename(attachment.objectKey),
    mediaType: attachment.mediaType,
    size: attachment.size,
    sha256: attachment.sha256,
    createdAt: attachment.createdAt.toISOString(),
  };
}

type AttachmentWriter = Pick<Database, "insert">;

export interface QuarantinedAttachment {
  sourcePath: string;
  temporaryPath: string;
}

export async function restoreQuarantinedAttachments(quarantined: QuarantinedAttachment[]): Promise<void> {
  const failures: unknown[] = [];
  for (const { sourcePath, temporaryPath } of [...quarantined].reverse()) {
    try { await rename(temporaryPath, sourcePath); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) throw new Error("attachment_rollback_failed", { cause: new AggregateError(failures, "attachment_rollback_failed") });
}

export async function removeWrittenAttachments(objectKeys: string[]): Promise<void> {
  const failures: unknown[] = [];
  await Promise.all(objectKeys.map(async (objectKey) => {
    try { await rm(objectKey, { force: true }); }
    catch (error) { failures.push(error); }
  }));
  if (failures.length) throw new Error("attachment_rollback_failed", { cause: new AggregateError(failures, "attachment_rollback_failed") });
}

export async function finalizeQuarantinedAttachments(
  quarantined: QuarantinedAttachment[],
  remove: (candidate: string) => Promise<void> = (candidate) => rm(candidate, { force: true }),
): Promise<void> {
  const failures: unknown[] = [];
  await Promise.all(quarantined.map(async ({ temporaryPath }) => {
    try { await remove(temporaryPath); } catch (error) { failures.push(error); }
  }));
  if (failures.length) throw new Error("attachment_finalize_failed", { cause: new AggregateError(failures, "attachment_finalize_failed") });
}

function attachmentObjectName(fileName: string): string {
  const prefix = `.attachment-${randomUUID()}-`;
  const budget = issuePilotConfig.limits.filesystemNameBytes - Buffer.byteLength(prefix);
  const suffix = path.extname(fileName);
  const extension = Buffer.byteLength(suffix) <= budget ? suffix : "";
  const base = extension ? fileName.slice(0, -extension.length) : fileName;
  const available = budget - Buffer.byteLength(extension);
  // Streaming decode omits an incomplete trailing UTF-8 sequence.
  const name = new TextDecoder().decode(Buffer.from(base).subarray(0, available), { stream: true });
  return `${prefix}${name}${extension}`;
}

export async function writePendingAttachments(
  executor: AttachmentWriter,
  stateRoot: string,
  issue: { id: string; key: string },
  uploadedBy: string,
  pendingAttachments: PendingAttachment[],
  writtenObjectKeys: string[],
): Promise<Array<ReturnType<typeof serializeAttachment>>> {
  if (!pendingAttachments.length) return [];
  const attachmentRoot = issueRoot(stateRoot, issue.key);
  await mkdir(attachmentRoot, { recursive: true, mode: 0o700 });
  await Promise.all([chmod(path.dirname(attachmentRoot), 0o700), chmod(attachmentRoot, 0o700)]);
  const createdAttachments: Array<ReturnType<typeof serializeAttachment>> = [];
  for (const pendingAttachment of pendingAttachments) {
    const objectKey = path.join(attachmentRoot, attachmentObjectName(pendingAttachment.fileName));
    const handle = await open(objectKey, "wx", 0o600);
    // Register only paths exclusively created by this transaction, including partial copies.
    writtenObjectKeys.push(objectKey);
    let failed = false;
    let failure: unknown;
    try {
      for await (const chunk of createReadStream(pendingAttachment.temporaryPath)) {
        await handle.writeFile(chunk);
      }
      await handle.chmod(0o400);
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    } finally {
      try { await handle.close(); }
      catch (error) {
        if (failed) throw new AggregateError([failure, error], "attachment_copy_cleanup_failed");
        throw error;
      }
    }
    const [attachment] = await executor.insert(issueAttachments).values({ issueId: issue.id, fileName: pendingAttachment.fileName, mediaType: pendingAttachment.mediaType, size: pendingAttachment.size, objectKey, sha256: pendingAttachment.sha256, uploadedBy }).returning();
    createdAttachments.push(serializeAttachment(attachment!));
  }
  return createdAttachments;
}
