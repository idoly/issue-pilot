import { createHash } from "node:crypto";
import path from "node:path";

import type { MultipartFile } from "@fastify/multipart";

import type { issueAttachments } from "../db/schema.ts";
import { ApiError } from "./input.ts";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_FILES = 20;
export const MAX_ATTACHMENT_REQUEST_BYTES = 40 * 1024 * 1024;

export interface PendingAttachment {
  fileName: string;
  mediaType: string;
  data: Buffer;
  sha256: string;
}

export async function readAttachment(part: MultipartFile, currentBytes: number): Promise<PendingAttachment> {
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

export function attachmentItem(attachment: typeof issueAttachments.$inferSelect) {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    mediaType: attachment.mediaType,
    size: attachment.size,
    sha256: attachment.sha256,
    createdAt: attachment.createdAt.toISOString(),
  };
}
