import type { IssuePriority, IssueStatus, IssueType } from "../data/client";

export const priorityColor: Record<IssuePriority, string> = { p0: "red", p1: "volcano", p2: "blue", p3: "default" };
export const statusLabel: Record<IssueStatus, string> = {
  open: "待处理",
  in_progress: "处理中",
  pending: "待确认",
  resolved: "已解决",
};
export const statusBadge: Record<IssueStatus, "default" | "processing" | "warning" | "success"> = {
  open: "default",
  in_progress: "processing",
  pending: "warning",
  resolved: "success",
};

export const typeLabel: Record<IssueType, string> = {
  data_processing: "数据处理",
  smart_analysis: "智能分析",
  defect_fix: "缺陷修复",
  feature_development: "功能开发",
};

export function relativeTime(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed)) return value;
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function codeServerUrl(value: string): URL {
  const url = new URL(value, window.location.href);
  const loopbackCodeServer = (url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.port === "18080";
  if (loopbackCodeServer && url.origin !== window.location.origin) {
    url.protocol = window.location.protocol;
    url.host = window.location.host;
    url.pathname = `/code-server${url.pathname.startsWith("/") ? url.pathname : `/${url.pathname}`}`;
  }
  return url;
}

export function workspaceUrl(value: string | null): string | null {
  return value ? codeServerUrl(value).toString() : null;
}

export function folderUrl(value: string | null, folder: string | null): string | null {
  if (!value || !folder) return workspaceUrl(value);
  const url = codeServerUrl(value);
  url.searchParams.set("folder", folder);
  return url.toString();
}
