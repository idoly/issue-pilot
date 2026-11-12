import { OperationError } from "../operation-error.ts";
import { createHash, randomUUID } from "node:crypto";
import { constants, type ReadStream } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, realpath, rm, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { MultipartFile } from "@fastify/multipart";
import type { Database } from "../db/client.ts";
import { issueAttachments, retiredIssueAttachments } from "../db/schema.ts";
import { issueRoot } from "../workspace/state.ts";
import { ApiError } from "./input.ts";

export interface PendingAttachment {
  fileName: string;
  mediaType: string;
  temporaryPath: string;
  size: number;
  sha256: string;
}

export async function readMultipartAttachment(stateRoot: string, part: MultipartFile): Promise<PendingAttachment> {
  async function* chunks() {
    yield* part.file;
    if (part.file.truncated) throw new Error("attachment_stream_truncated");
  }
  // A file part without a filename is client input, not a server fault.
  const fileName = typeof part.filename === "string" ? part.filename : "";
  return stageAttachment(stateRoot, path.basename(fileName), part.mimetype, chunks());
}

export async function stageAttachment(stateRoot: string, fileName: string, mediaType: string, chunks: AsyncIterable<Uint8Array>): Promise<PendingAttachment> {
  if (!fileName || /[/\\\u0000-\u001f\u007f]/.test(fileName) || [".", ".."].includes(fileName)) throw new ApiError(400, "invalid_attachment_name");
  const control = path.resolve(stateRoot, "control");
  await mkdir(control, { recursive: true, mode: 0o700 });
  await assertAttachmentRoot(control);
  const stagingRoot = await mkdtemp(path.join(control, "attachment-upload-"));
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
    await handle.chmod(0o400);
    await handle.sync();
    await handle.close();
    return { fileName, mediaType, temporaryPath, size, sha256: sha256.digest("hex") };
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await handle?.close();
    } catch (failure) {
      if (!failures.includes(failure)) failures.push(failure);
    }
    try {
      await rm(stagingRoot, { recursive: true, force: true });
    } catch (failure) {
      failures.push(failure);
    }
    if (failures.length > 1) throw new AggregateError(failures, "attachment_staging_cleanup_failed");
    throw error;
  }
}

export async function removePendingAttachments(pendingAttachments: PendingAttachment[], primaryFailures: readonly unknown[] = []): Promise<void> {
  const stagingRoots = [...new Set(pendingAttachments.map(({ temporaryPath }) => path.dirname(temporaryPath)))];
  const results = await Promise.allSettled(stagingRoots.map((stagingRoot) => rm(stagingRoot, { recursive: true, force: true })));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
  if (failures.length) throw new AggregateError([...primaryFailures, ...failures], "attachment_staging_cleanup_failed");
}

function validateAttachmentFile(metadata: { isFile(): boolean; mode: number; size: number } | undefined, expectedSize?: number): void {
  if (!metadata?.isFile() || (metadata.mode & 0o7777) !== 0o400 || (expectedSize !== undefined && metadata.size !== expectedSize)) throw new Error("insecure_issue_attachment_file");
}

async function assertAttachmentRoot(attachmentRoot: string): Promise<void> {
  if (!(await lstat(attachmentRoot)).isDirectory() || (await realpath(attachmentRoot)) !== attachmentRoot) throw new Error("insecure_issue_attachment_file");
}

export async function resolveSecureAttachmentFile(attachmentRoot: string, objectKey: string, expectedSize?: number): Promise<string> {
  const attachmentPath = path.resolve(objectKey);
  if (path.dirname(attachmentPath) !== attachmentRoot) throw new Error("insecure_issue_attachment_file");
  await assertAttachmentRoot(attachmentRoot);
  const metadata = await lstat(attachmentPath).catch(() => undefined);
  validateAttachmentFile(metadata, expectedSize);
  return attachmentPath;
}

export async function openVerifiedAttachmentFile(attachmentRoot: string, objectKey: string, size: number, sha256: string, signal?: AbortSignal): Promise<FileHandle> {
  signal?.throwIfAborted();
  const file = await resolveSecureAttachmentFile(attachmentRoot, objectKey, size);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    // O_NOFOLLOW protects only the last component; reject an ancestor redirected before open().
    if ((await realpath(`/proc/self/fd/${handle.fd}`)) !== file) throw new Error("insecure_issue_attachment_file");
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
    try {
      await handle.close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "attachment_read_cleanup_failed");
    }
    throw error;
  }
}

export async function openVerifiedAttachmentStream(attachmentRoot: string, objectKey: string, size: number, sha256: string, signal?: AbortSignal): Promise<ReadStream> {
  const handle = await openVerifiedAttachmentFile(attachmentRoot, objectKey, size, sha256, signal);
  try {
    // Reuse the verified descriptor rather than reopening a replaceable path.
    return handle.createReadStream({ start: 0, autoClose: true, ...(signal ? { signal } : {}) });
  } catch (error) {
    try {
      await handle.close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "attachment_read_cleanup_failed");
    }
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

export async function removeWrittenAttachments(objectKeys: string[]): Promise<void> {
  const failures: unknown[] = [];
  await Promise.all(
    objectKeys.map(async (objectKey) => {
      try {
        await rm(objectKey, { force: true });
      } catch (error) {
        failures.push(error);
      }
    }),
  );
  if (failures.length) throw new OperationError("attachment_rollback_failed", "unknown", { cause: new AggregateError(failures, "attachment_rollback_failed") });
}

export async function retireAttachments(
  transaction: Pick<Database, "insert" | "delete">,
  issueId: string,
  attachments: Array<Pick<typeof issueAttachments.$inferSelect, "id" | "objectKey" | "size" | "sha256">>,
): Promise<void> {
  if (!attachments.length) return;
  await transaction.insert(retiredIssueAttachments).values(attachments.map(({ id, objectKey, size, sha256 }) => ({ id, issueId, objectKey, size, sha256 })));
  await transaction.delete(issueAttachments).where(
    and(
      eq(issueAttachments.issueId, issueId),
      inArray(
        issueAttachments.id,
        attachments.map(({ id }) => id),
      ),
    ),
  );
}

/** Only process recorded retirements while the caller holds the Issue reservation. */
export async function finalizeRetiredAttachments(database: Database, attachmentRoot: string, issueId: string): Promise<void> {
  const failures: unknown[] = [];
  const retired = await database.select().from(retiredIssueAttachments).where(eq(retiredIssueAttachments.issueId, issueId));
  for (const { id, objectKey, size, sha256 } of retired) {
    try {
      await assertAttachmentRoot(attachmentRoot);
      if (path.resolve(objectKey) !== objectKey || path.dirname(objectKey) !== attachmentRoot || !path.basename(objectKey).startsWith(".attachment-"))
        throw new Error("insecure_issue_attachment_file");
      const [active] = await database
        .select({ id: issueAttachments.id })
        .from(issueAttachments)
        .where(and(eq(issueAttachments.issueId, issueId), eq(issueAttachments.objectKey, objectKey)))
        .limit(1);
      if (active) throw new Error("attachment_still_referenced");
      const metadata = await lstat(objectKey).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (metadata) {
        await using original = await openVerifiedAttachmentFile(attachmentRoot, objectKey, size, sha256);
        const current = await lstat(objectKey);
        const opened = await original.stat();
        if (current.dev !== opened.dev || current.ino !== opened.ino) throw new Error("insecure_issue_attachment_file");
        await unlink(objectKey);
      }
      // The name may already be gone if the process stopped after unlinking it.
      await syncAttachmentDirectory(attachmentRoot);
      await database.delete(retiredIssueAttachments).where(eq(retiredIssueAttachments.id, id));
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new OperationError("attachment_finalize_failed", "committed", { cause: new AggregateError(failures, "attachment_finalize_failed") });
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

interface PublishedAttachment {
  pending: PendingAttachment;
  objectKey: string;
}

async function syncAttachmentDirectory(attachmentRoot: string): Promise<void> {
  await using directory = await open(attachmentRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  await directory.sync();
}

/** Publish the staged inode without overwriting an existing name or copying bytes. */
export async function publishPendingAttachments(stateRoot: string, issueKey: string, pendingAttachments: PendingAttachment[], writtenObjectKeys: string[]): Promise<PublishedAttachment[]> {
  if (!pendingAttachments.length) return [];
  const attachmentRoot = issueRoot(stateRoot, issueKey);
  // Creation has already claimed this root. Edits must not recreate missing state or follow a replacement link.
  await assertAttachmentRoot(attachmentRoot);
  const published: PublishedAttachment[] = [];
  for (const pendingAttachment of pendingAttachments) {
    const objectKey = path.join(attachmentRoot, attachmentObjectName(pendingAttachment.fileName));
    validateAttachmentFile(await lstat(pendingAttachment.temporaryPath), pendingAttachment.size);
    await link(pendingAttachment.temporaryPath, objectKey);
    writtenObjectKeys.push(objectKey);
    await unlink(pendingAttachment.temporaryPath);
    published.push({ pending: pendingAttachment, objectKey });
  }
  await syncAttachmentDirectory(attachmentRoot);
  return published;
}

/** Register originals inside the Issue transaction; the caller removes writtenObjectKeys if it rolls back. */
export async function insertPublishedAttachments(
  executor: AttachmentWriter,
  issueId: string,
  uploadedBy: string,
  published: PublishedAttachment[],
): Promise<Array<ReturnType<typeof serializeAttachment>>> {
  const createdAttachments: Array<ReturnType<typeof serializeAttachment>> = [];
  for (const { pending, objectKey } of published) {
    const [attachment] = await executor
      .insert(issueAttachments)
      .values({
        issueId,
        fileName: pending.fileName,
        mediaType: pending.mediaType,
        size: pending.size,
        objectKey,
        sha256: pending.sha256,
        uploadedBy,
      })
      .returning();
    createdAttachments.push(serializeAttachment(attachment!));
  }
  return createdAttachments;
}
