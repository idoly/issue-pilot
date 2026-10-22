import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, open, rename, rm, lstat, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { MultipartFile } from "@fastify/multipart";
import type { Database } from "../db/client.ts";
import { issueAttachments } from "../db/schema.ts";
import { issueAttachmentRoot } from "../workspace/state.ts";
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
    await handle?.close().catch(() => undefined);
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removePendingAttachments(pendingAttachments: PendingAttachment[]): Promise<void> {
  const stagingRoots = [...new Set(pendingAttachments.map(({ temporaryPath }) => path.dirname(temporaryPath)))];
  await Promise.all(stagingRoots.map((stagingRoot) => rm(stagingRoot, { recursive: true, force: true })));
}

export async function resolveSecureAttachmentFile(attachmentRoot: string, objectKey: string, expectedSize?: number): Promise<string> {
  const attachmentPath = path.resolve(objectKey);
  const metadata = await lstat(attachmentPath).catch(() => undefined);
  if (path.dirname(attachmentPath) !== attachmentRoot || !metadata?.isFile() || (metadata.mode & 0o7777) !== 0o400 || (expectedSize !== undefined && metadata.size !== expectedSize)) throw new Error("insecure_issue_attachment_file");
  return attachmentPath;
}

export function serializeAttachment(attachment: typeof issueAttachments.$inferSelect) {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    workingFileName: path.basename(attachment.objectKey),
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
  const prefix = `${randomUUID()}-`;
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
  const attachmentRoot = issueAttachmentRoot(stateRoot, issue.key);
  await mkdir(attachmentRoot, { recursive: true, mode: 0o700 });
  await Promise.all([chmod(path.dirname(attachmentRoot), 0o700), chmod(attachmentRoot, 0o700)]);
  const createdAttachments: Array<ReturnType<typeof serializeAttachment>> = [];
  for (const pendingAttachment of pendingAttachments) {
    const objectKey = path.join(attachmentRoot, attachmentObjectName(pendingAttachment.fileName));
    writtenObjectKeys.push(objectKey);
    await copyFile(pendingAttachment.temporaryPath, objectKey, constants.COPYFILE_EXCL);
    await chmod(objectKey, 0o400);
    const [attachment] = await executor.insert(issueAttachments).values({ issueId: issue.id, fileName: pendingAttachment.fileName, mediaType: pendingAttachment.mediaType, size: pendingAttachment.size, objectKey, sha256: pendingAttachment.sha256, uploadedBy }).returning();
    createdAttachments.push(serializeAttachment(attachment!));
  }
  return createdAttachments;
}
