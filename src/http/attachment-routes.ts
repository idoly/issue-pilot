import type { ReadStream } from "node:fs";
import { create as contentDisposition } from "content-disposition";

import { and, eq } from "drizzle-orm";

import { issueAttachments } from "../db/schema.ts";
import { errorCode, stableErrorReason } from "../diagnostics.ts";
import { issueRoot } from "../workspace/state.ts";
import { openVerifiedAttachmentStream } from "./attachment-store.ts";
import { ApiError } from "./input.ts";
import { requireIssue, type ApiRouteContext } from "./route-context.ts";

export function registerAttachmentRoutes(context: ApiRouteContext): void {
  const { app, database, stateRoot } = context;
  app.get<{ Params: { key: string; attachmentId: string } }>("/api/issues/:key/attachments/:attachmentId", async (request, reply) => {
    const issue = await requireIssue(database, request.params.key);
    const findAttachment = () =>
      database.db
        .select()
        .from(issueAttachments)
        .where(and(eq(issueAttachments.issueId, issue.id), eq(issueAttachments.id, request.params.attachmentId)))
        .limit(1);
    const [attachment] = await findAttachment();
    if (!attachment) throw new ApiError(404, "attachment_not_found");

    const controller = new AbortController();
    const cancel = () => {
      if (!reply.raw.writableFinished) controller.abort();
    };
    const cleanup = () => {
      request.raw.off("aborted", cancel);
      reply.raw.off("close", cancel);
    };
    request.raw.once("aborted", cancel);
    reply.raw.once("close", cancel);
    if (request.raw.aborted || reply.raw.destroyed) controller.abort();
    let stream: ReadStream | undefined;
    try {
      stream = await openVerifiedAttachmentStream(issueRoot(stateRoot, issue.key), attachment.objectKey, attachment.size, attachment.sha256, controller.signal);
      stream.once("close", cleanup);
      const safeInline = attachment.mediaType.startsWith("text/") || ["application/json", "application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif"].includes(attachment.mediaType);
      reply.header("Content-Disposition", contentDisposition(attachment.fileName, { type: safeInline ? "inline" : "attachment" }));
      reply.header("Content-Length", attachment.size);
      reply.header("X-Content-Type-Options", "nosniff");
      const inlineMediaType = attachment.mediaType.startsWith("image/") || attachment.mediaType === "application/pdf" ? attachment.mediaType : "text/plain; charset=utf-8";
      reply.type(safeInline ? inlineMediaType : "application/octet-stream");
      return reply.send(stream);
    } catch (error) {
      stream?.destroy();
      cleanup();
      if (controller.signal.aborted) {
        reply.hijack();
        // A disconnected client cannot receive an error, but failed descriptor cleanup still needs diagnosis.
        if (error !== controller.signal.reason) request.log.error({ code: errorCode(error), reason: stableErrorReason(error, "attachment_download_failed") }, "attachment_download_failed");
        return reply;
      }
      // An edit can retire the object after the first lookup but before the descriptor is verified.
      if (!stream && (errorCode(error) === "ENOENT" || (error instanceof Error && error.message === "insecure_issue_attachment_file")) && !(await findAttachment()).length)
        throw new ApiError(404, "attachment_not_found");
      throw error;
    }
  });
}
