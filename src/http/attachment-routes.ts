import type { ReadStream } from "node:fs";

import { and, eq } from "drizzle-orm";

import { issueAttachments } from "../db/schema.ts";
import { issueAttachmentRoot } from "../workspace/state.ts";
import { openVerifiedAttachmentStream } from "./attachment-store.ts";
import { ApiError } from "./input.ts";
import { requireIssue, type ApiRouteContext } from "./route-context.ts";

export function registerAttachmentRoutes(context: ApiRouteContext): void {
  const { app, database, stateRoot } = context;
  app.get<{ Params: { key: string; attachmentId: string } }>("/api/issues/:key/attachments/:attachmentId", async (request, reply) => {
    const issue = await requireIssue(database, request.params.key);
    const [attachment] = await database.db.select().from(issueAttachments).where(and(eq(issueAttachments.issueId, issue.id), eq(issueAttachments.id, request.params.attachmentId))).limit(1);
    if (!attachment) throw new ApiError(404, "attachment_not_found");

    const controller = new AbortController();
    const cancel = () => { if (!reply.raw.writableFinished) controller.abort(); };
    const cleanup = () => {
      request.raw.off("aborted", cancel);
      reply.raw.off("close", cancel);
    };
    request.raw.once("aborted", cancel);
    reply.raw.once("close", cancel);
    if (request.raw.aborted || reply.raw.destroyed) controller.abort();
    let stream: ReadStream | undefined;
    try {
      stream = await openVerifiedAttachmentStream(
        issueAttachmentRoot(stateRoot, issue.key), attachment.objectKey,
        attachment.size, attachment.sha256, controller.signal,
      );
      stream.once("close", cleanup);
      const safeInline = attachment.mediaType.startsWith("text/")
        || ["application/json", "application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"].includes(attachment.mediaType);
      const fallbackName = attachment.fileName.replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
      reply.header("Content-Disposition", `${safeInline ? "inline" : "attachment"}; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`);
      reply.header("Content-Length", attachment.size);
      reply.header("Cache-Control", "private, no-store");
      reply.header("X-Content-Type-Options", "nosniff");
      const inlineMediaType = attachment.mediaType.startsWith("image/") || attachment.mediaType === "application/pdf" ? attachment.mediaType : "text/plain; charset=utf-8";
      reply.type(safeInline ? inlineMediaType : "application/octet-stream");
      return reply.send(stream);
    } catch (error) {
      stream?.destroy();
      cleanup();
      if (controller.signal.aborted) {
        reply.hijack();
        return reply;
      }
      throw error;
    }
  });
}
