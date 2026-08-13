import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { and, eq } from "drizzle-orm";

import { issueAttachments } from "../db/schema.ts";
import { issueAttachmentRoot } from "../workspace/state.ts";
import { resolveSecureAttachmentFile } from "./attachment-store.ts";
import { ApiError } from "./input.ts";
import { requireIssue, type ApiRouteContext } from "./route-context.ts";

export function registerAttachmentRoutes(context: ApiRouteContext): void {
  const { app, database, stateRoot } = context;
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
}
