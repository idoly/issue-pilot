import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { MultipartFile } from "@fastify/multipart";
import { and, eq, inArray } from "drizzle-orm";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { Database } from "../db/client.ts";
import { issueAttachments } from "../db/schema.ts";
import { issueAttachmentRoot } from "../workspace/state.ts";
import { ApiError, record, strings } from "./input.ts";
import { ensureCurrentSubject, requireIssue, runIssueExclusive, touchIssue, type ApiRouteContext } from "./route-context.ts";

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

export function registerAttachmentRoutes(context: ApiRouteContext): void {
  const { app, database, engine, stateRoot } = context;

  app.get<{ Params: { key: string; attachmentId: string } }>("/api/issues/:key/attachments/:attachmentId", async (request, reply) => {
    const issue = await requireIssue(database, request.params.key);
    const [attachment] = await database.db.select().from(issueAttachments).where(and(eq(issueAttachments.issueId, issue.id), eq(issueAttachments.id, request.params.attachmentId))).limit(1);
    if (!attachment) throw new ApiError(404, "attachment_not_found");
    const attachmentRoot = issueAttachmentRoot(stateRoot, issue.key);
    const attachmentPath = await resolveSecureAttachmentFile(attachmentRoot, attachment.objectKey, attachment.size);
    const attachmentData = await readFile(attachmentPath);
    if (createHash("sha256").update(attachmentData).digest("hex") !== attachment.sha256) throw new Error("attachment_integrity_check_failed");
    const safeInline = attachment.mediaType.startsWith("text/")
      || ["application/json", "application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"].includes(attachment.mediaType);
    const fallbackName = attachment.fileName.replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
    reply.header("Content-Disposition", `${safeInline ? "inline" : "attachment"}; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`);
    reply.header("Cache-Control", "private, no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    const inlineMediaType = attachment.mediaType.startsWith("image/") || attachment.mediaType === "application/pdf" ? attachment.mediaType : "text/plain; charset=utf-8";
    reply.type(safeInline ? inlineMediaType : "application/octet-stream");
    return reply.send(attachmentData);
  });

  app.delete<{ Params: { key: string } }>("/api/issues/:key/attachments", async (request, reply) => {
    const issue = await requireIssue(database, request.params.key);
    const attachmentIds = [...new Set(strings(record(request.body).attachmentIds, "attachment_ids"))];
    if (!attachmentIds.length) return reply.code(204).send();
    await runIssueExclusive(engine, [issue.id], async (reservation) => {
      const attachments = await database.db.select().from(issueAttachments).where(and(eq(issueAttachments.issueId, issue.id), inArray(issueAttachments.id, attachmentIds)));
      if (attachments.length !== attachmentIds.length) throw new ApiError(404, "attachment_not_found");

      const attachmentRoot = issueAttachmentRoot(stateRoot, issue.key);
      const removableFiles = await Promise.all(attachments.map(async (attachment) => ({
        attachment,
        sourcePath: await resolveSecureAttachmentFile(attachmentRoot, attachment.objectKey, attachment.size),
      })));
      await reservation.closeSession(issue.id);
      const quarantined: QuarantinedAttachment[] = [];
      try {
        for (const { attachment, sourcePath } of removableFiles) {
          const temporaryPath = path.join(attachmentRoot, `.${attachment.id}-${randomUUID()}.deleting`);
          await rename(sourcePath, temporaryPath);
          quarantined.push({ sourcePath, temporaryPath });
        }
        await database.db.transaction(async (transaction) => {
          await transaction.delete(issueAttachments).where(and(eq(issueAttachments.issueId, issue.id), inArray(issueAttachments.id, attachmentIds)));
          await touchIssue(transaction, issue.id);
        });
      } catch (error) {
        try { await restoreQuarantinedAttachments(quarantined); }
        catch (rollbackError) { throw new Error("attachment_rollback_failed", { cause: new AggregateError([error, rollbackError], "attachment_rollback_failed") }); }
        throw error;
      }
      await finalizeQuarantinedAttachments(quarantined);
    });
    return reply.code(204).send();
  });

  app.post<{ Params: { key: string } }>("/api/issues/:key/attachments", async (request, reply) => {
    const issue = await requireIssue(database, request.params.key);
    const uploader = await ensureCurrentSubject(database, request);
    const pendingAttachments: PendingAttachment[] = [];
    let attachmentBytes = 0;
    for await (const part of request.files()) {
      const attachment = await readMultipartAttachment(part, attachmentBytes);
      attachmentBytes += attachment.content.length;
      pendingAttachments.push(attachment);
    }
    if (!pendingAttachments.length) return reply.code(201).send([]);
    const createdAttachments = await runIssueExclusive(engine, [issue.id], async (reservation) => {
      await reservation.closeSession(issue.id);
      const writtenObjectKeys: string[] = [];
      try {
        return await database.db.transaction(async (transaction) => {
          const attachments = await writePendingAttachments(transaction, stateRoot, issue, uploader, pendingAttachments, writtenObjectKeys);
          await touchIssue(transaction, issue.id);
          return attachments;
        });
      } catch (error) {
        try { await removeWrittenAttachments(writtenObjectKeys); }
        catch (rollbackError) { throw new Error("attachment_rollback_failed", { cause: new AggregateError([error, rollbackError], "attachment_rollback_failed") }); }
        throw error;
      }
    });
    return reply.code(201).send(createdAttachments);
  });
}
