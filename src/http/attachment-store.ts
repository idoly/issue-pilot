import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { MultipartFile } from "@fastify/multipart";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { Database } from "../db/client.ts";
import { issueAttachments } from "../db/schema.ts";
import { issueAttachmentRoot } from "../workspace/state.ts";
import { ApiError } from "./input.ts";

const limits = issuePilotConfig.limits.attachment;

export interface PendingAttachment {
  fileName: string;
  mediaType: string;
  content: Buffer;
  sha256: string;
}

export async function readMultipartAttachment(part: MultipartFile, consumedBytes: number): Promise<PendingAttachment> {
  const chunks: Buffer[] = [];
  let totalBytes = consumedBytes;
  for await (const chunk of part.file) {
    const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += chunkBuffer.length;
    if (totalBytes > limits.requestBytes) throw new ApiError(413, "attachment_limit_exceeded");
    chunks.push(chunkBuffer);
  }
  if (part.file.truncated) throw new ApiError(413, "attachment_limit_exceeded");
  const content = Buffer.concat(chunks);
  const fileName = path.basename(part.filename);
  if (!fileName) throw new ApiError(400, "invalid_attachment_name");
  return { fileName, mediaType: part.mimetype, content, sha256: createHash("sha256").update(content).digest("hex") };
}

export async function resolveSecureAttachmentFile(attachmentRoot: string, objectKey: string, expectedSize?: number): Promise<string> {
  const attachmentPath = path.resolve(objectKey);
  const metadata = await stat(attachmentPath).catch(() => undefined);
  if (path.dirname(attachmentPath) !== attachmentRoot || !metadata?.isFile() || (metadata.mode & 0o077) !== 0 || (expectedSize !== undefined && (metadata.size !== expectedSize || metadata.size > limits.fileBytes))) throw new Error("insecure_issue_attachment_file");
  return attachmentPath;
}

export function serializeAttachment(attachment: typeof issueAttachments.$inferSelect) {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
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
    const objectKey = path.join(attachmentRoot, `${randomUUID()}-${pendingAttachment.fileName}`);
    writtenObjectKeys.push(objectKey);
    await writeFile(objectKey, pendingAttachment.content, { mode: 0o400 });
    const [attachment] = await executor.insert(issueAttachments).values({ issueId: issue.id, fileName: pendingAttachment.fileName, mediaType: pendingAttachment.mediaType, size: pendingAttachment.content.length, objectKey, sha256: pendingAttachment.sha256, uploadedBy }).returning();
    createdAttachments.push(serializeAttachment(attachment!));
  }
  return createdAttachments;
}
