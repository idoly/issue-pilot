import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { MultipartFile } from "@fastify/multipart";
import { and, eq, inArray, sql } from "drizzle-orm";

import { issueAttachments, issues } from "../db/schema.ts";
import { issueAttachmentRoot } from "../workspace/state.ts";
import { ApiError, record, strings } from "./input.ts";
import { assertIssueIdle, ensureCurrentSubject, requireIssue, type ApiRouteContext } from "./route-context.ts";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_FILES = 20;
export const MAX_ATTACHMENT_REQUEST_BYTES = 40 * 1024 * 1024;

export interface PendingAttachment {
  fileName: string;
  mediaType: string;
  data: Buffer;
  sha256: string;
}

export async function readMultipartAttachment(part: MultipartFile, currentBytes: number): Promise<PendingAttachment> {
  const chunks: Buffer[] = [];
  let size = currentBytes;
  for await (const chunk of part.file) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > MAX_ATTACHMENT_REQUEST_BYTES) throw new ApiError(413, "attachment_limit_exceeded");
    chunks.push(data);
  }
  if (part.file.truncated) throw new ApiError(413, "attachment_limit_exceeded");
  const data = Buffer.concat(chunks);
  const fileName = path.basename(part.filename);
  if (!fileName) throw new ApiError(400, "invalid_attachment_name");
  return { fileName, mediaType: part.mimetype, data, sha256: createHash("sha256").update(data).digest("hex") };
}

export async function resolveSecureAttachmentFile(directory: string, objectKey: string, expectedSize?: number): Promise<string> {
  const source = path.resolve(objectKey);
  const metadata = await stat(source).catch(() => undefined);
  if (path.dirname(source) !== directory || !metadata?.isFile() || (metadata.mode & 0o077) !== 0 || (expectedSize !== undefined && (metadata.size !== expectedSize || metadata.size > MAX_ATTACHMENT_BYTES))) throw new Error("insecure_issue_attachment_file");
  return source;
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

export function registerAttachmentRoutes(context: ApiRouteContext): void {
  const { app, database, engine, stateRoot } = context;

  app.get<{ Params: { key: string; attachmentId: string } }>("/api/issues/:key/attachments/:attachmentId", async (request, reply) => {
    const issue = await requireIssue(database, request.params.key);
    const [attachment] = await database.db.select().from(issueAttachments).where(and(eq(issueAttachments.issueId, issue.id), eq(issueAttachments.id, request.params.attachmentId))).limit(1);
    if (!attachment) throw new ApiError(404, "attachment_not_found");
    const directory = issueAttachmentRoot(stateRoot, issue.key);
    const source = await resolveSecureAttachmentFile(directory, attachment.objectKey, attachment.size);
    const data = await readFile(source);
    if (createHash("sha256").update(data).digest("hex") !== attachment.sha256) throw new Error("attachment_integrity_check_failed");
    const safeInline = attachment.mediaType.startsWith("text/")
      || ["application/json", "application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"].includes(attachment.mediaType);
    const fallbackName = attachment.fileName.replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
    reply.header("Content-Disposition", `${safeInline ? "inline" : "attachment"}; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`);
    reply.header("Cache-Control", "private, no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    const inlineMediaType = attachment.mediaType.startsWith("image/") || attachment.mediaType === "application/pdf" ? attachment.mediaType : "text/plain; charset=utf-8";
    reply.type(safeInline ? inlineMediaType : "application/octet-stream");
    return reply.send(data);
  });

  app.delete<{ Params: { key: string } }>("/api/issues/:key/attachments", async (request, reply) => {
    const issue = await requireIssue(database, request.params.key);
    const attachmentIds = [...new Set(strings(record(request.body).attachmentIds, "attachment_ids"))];
    if (!attachmentIds.length) return reply.code(204).send();
    assertIssueIdle(engine, issue.id);
    await engine.closeSession(issue.id);
    const attachments = await database.db.select().from(issueAttachments).where(and(eq(issueAttachments.issueId, issue.id), inArray(issueAttachments.id, attachmentIds)));
    if (attachments.length !== attachmentIds.length) throw new ApiError(404, "attachment_not_found");

    const directory = issueAttachmentRoot(stateRoot, issue.key);
    const quarantined: Array<{ source: string; temporary: string }> = [];
    try {
      for (const attachment of attachments) {
        const source = await resolveSecureAttachmentFile(directory, attachment.objectKey);
        const temporary = path.join(directory, `.${attachment.id}-${randomUUID()}.deleting`);
        await rename(source, temporary);
        quarantined.push({ source, temporary });
      }
      await database.db.transaction(async (transaction) => {
        await transaction.delete(issueAttachments).where(and(eq(issueAttachments.issueId, issue.id), inArray(issueAttachments.id, attachmentIds)));
        await transaction.update(issues).set({ version: sql`${issues.version} + 1`, updatedAt: new Date() }).where(eq(issues.id, issue.id));
      });
    } catch (error) {
      await Promise.all(quarantined.map(({ source, temporary }) => rename(temporary, source).catch(() => undefined)));
      throw error;
    }
    await Promise.all(quarantined.map(({ temporary }) => rm(temporary, { force: true }).catch(() => undefined)));
    return reply.code(204).send();
  });

  app.post<{ Params: { key: string } }>("/api/issues/:key/attachments", async (request, reply) => {
    const issue = await requireIssue(database, request.params.key);
    assertIssueIdle(engine, issue.id);
    const uploader = await ensureCurrentSubject(database);
    const pending: PendingAttachment[] = [];
    let attachmentBytes = 0;
    for await (const part of request.files()) {
      const attachment = await readMultipartAttachment(part, attachmentBytes);
      attachmentBytes += attachment.data.length;
      pending.push(attachment);
    }
    if (!pending.length) return reply.code(201).send([]);
    await engine.closeSession(issue.id);

    const directory = issueAttachmentRoot(stateRoot, issue.key);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const written: string[] = [];
    try {
      const created = await database.db.transaction(async (transaction) => {
        const rows: Array<ReturnType<typeof serializeAttachment>> = [];
        for (const file of pending) {
          const objectKey = path.join(directory, `${randomUUID()}-${file.fileName}`);
          await writeFile(objectKey, file.data, { mode: 0o600 });
          written.push(objectKey);
          const [attachment] = await transaction.insert(issueAttachments).values({ issueId: issue.id, fileName: file.fileName, mediaType: file.mediaType, size: file.data.length, objectKey, sha256: file.sha256, uploadedBy: uploader }).returning();
          rows.push(serializeAttachment(attachment!));
        }
        await transaction.update(issues).set({ version: sql`${issues.version} + 1`, updatedAt: new Date() }).where(eq(issues.id, issue.id));
        return rows;
      });
      return reply.code(201).send(created);
    } catch (error) {
      await Promise.all(written.map((objectKey) => rm(objectKey, { force: true }).catch(() => undefined)));
      throw error;
    }
  });
}
