import type { IssueDetail } from "../data/client";

export type AttachmentPreviewKind = "image" | "text" | "pdf" | "unsupported";

export function attachmentPreviewKind(attachment: IssueDetail["attachments"][number]): AttachmentPreviewKind {
  if (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(attachment.mediaType)) return "image";
  if (attachment.mediaType === "application/pdf") return "pdf";
  if (attachment.mediaType.startsWith("text/") || ["application/json", "application/xml", "application/yaml", "application/x-yaml"].includes(attachment.mediaType) || /\.(txt|log|md|csv|json|xml|ya?ml|properties)$/i.test(attachment.fileName)) return "text";
  return "unsupported";
}

export function workingFileMediaType(fileName: string): string | undefined {
  const extension = fileName.split(".").at(-1)?.toLowerCase() ?? "";
  const images: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
  if (images[extension]) return images[extension];
  if (extension === "pdf") return "application/pdf";
  if (["txt", "log", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml", "properties", "sql", "js", "mjs", "cjs", "ts", "tsx", "jsx", "java", "kt", "py", "sh", "bash", "css", "html", "vue", "svelte", "c", "h", "cpp", "hpp", "go", "rs", "toml", "ini"].includes(extension) || /^(?:Dockerfile|Makefile|\.gitignore)$/i.test(fileName)) return "text/plain";
  return undefined;
}
