import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { AttachmentGrant, IssuePolicy } from "./policy.ts";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isTextAttachment(attachment: AttachmentGrant): boolean {
  const extension = path.extname(attachment.fileName).toLowerCase();
  return attachment.mediaType.startsWith("text/") || [
    "application/json", "application/xml", "application/yaml", "application/x-yaml", "application/sql", "application/javascript",
  ].includes(attachment.mediaType) || [
    ".txt", ".md", ".json", ".yaml", ".yml", ".xml", ".csv", ".log", ".sql", ".ts", ".tsx", ".js", ".jsx", ".java", ".properties", ".conf", ".ini",
  ].includes(extension);
}

export async function readAttachment(policy: IssuePolicy, attachmentId: string) {
  const attachment = policy.attachments.find((candidate) => candidate.id === attachmentId);
  if (!attachment) throw new Error("attachment_not_granted_for_issue");
  const stateRoot = path.dirname(path.dirname(path.dirname(attachment.attachmentPath)));
  const expectedRoot = path.join(stateRoot, "attachments", policy.issueKey.toLowerCase());
  const [canonicalRoot, canonicalPath, metadata] = await Promise.all([realpath(expectedRoot), realpath(attachment.attachmentPath), stat(attachment.attachmentPath)]);
  if (!isWithin(canonicalRoot, canonicalPath) || !metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size !== attachment.size) throw new Error("attachment_grant_changed");
  const data = await readFile(canonicalPath);
  if (createHash("sha256").update(data).digest("hex") !== attachment.sha256) throw new Error("attachment_integrity_check_failed");

  const metadataText = JSON.stringify({ id: attachment.id, fileName: attachment.fileName, mediaType: attachment.mediaType, size: attachment.size, sha256: attachment.sha256 }, null, 2);
  if (isTextAttachment(attachment)) {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); }
    catch { throw new Error("attachment_text_is_not_utf8"); }
    if (text.includes("\0")) throw new Error("attachment_text_is_binary");
    return { content: [{ type: "text" as const, text: `${metadataText}\n\n${text}` }], details: { attachmentId } };
  }
  if (IMAGE_TYPES.has(attachment.mediaType)) {
    return { content: [{ type: "text" as const, text: metadataText }, { type: "image" as const, data: data.toString("base64"), mimeType: attachment.mediaType }], details: { attachmentId } };
  }
  throw new Error("attachment_media_type_not_supported");
}
