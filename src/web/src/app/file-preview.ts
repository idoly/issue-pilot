import { issuePilotConfig } from "../../../../issue-pilot.config.ts";
import type { IssueDetail } from "../data/client";

export type AttachmentPreviewKind = "image" | "text" | "pdf" | "unsupported";

export function attachmentPreviewKind(attachment: IssueDetail["attachments"][number]): AttachmentPreviewKind {
  if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(attachment.mediaType)) return "image";
  if (attachment.mediaType === "application/pdf") return "pdf";
  if (attachment.mediaType.startsWith("text/") || ["application/json", "application/xml", "application/yaml", "application/x-yaml"].includes(attachment.mediaType) || /\.(txt|log|md|csv|json|xml|ya?ml|properties)$/i.test(attachment.fileName)) return "text";
  return "unsupported";
}

export function outputPreviewUnavailable(output: Pick<IssueDetail["outputs"][number], "fileName" | "size">): string | undefined {
  if (!/\.(csv|json|jsonl|sql|txt|md|markdown|log|ya?ml|xml|tsv)$/i.test(output.fileName)) return "此格式暂不支持预览，请下载查看";
  if (output.size > issuePilotConfig.web.outputPreviewBytes) return "文件过大，请下载查看完整内容";
  return undefined;
}
