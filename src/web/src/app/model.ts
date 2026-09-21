import { issuePilotConfig } from "../../../../issue-pilot.config.ts";
import { ISSUE_PRIORITIES, ISSUE_WORK_MODES, type IssuePriority, type IssueStatus, type IssueType, type IssueWorkMode } from "../data/client";

export const priorityColor: Record<IssuePriority, string> = { p0: "red", p1: "volcano", p2: "blue", p3: "default" };
const priorityLabel: Record<IssuePriority, string> = { p0: "P0 · 紧急", p1: "P1 · 高", p2: "P2 · 中", p3: "P3 · 低" };
export const priorityOptions = ISSUE_PRIORITIES.map((value) => ({ value, label: priorityLabel[value] }));
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

export const workModeLabel: Record<IssueWorkMode, string> = {
  production_data: "正式数据处理",
  production_analysis: "正式问题调查",
  test_analysis: "测试问题调查",
  development_fix: "开发缺陷修复",
  development_feature: "开发功能开发",
};

export const workModeOptions = ISSUE_WORK_MODES.map((value) => ({ value, label: workModeLabel[value] }));

const dateFormat = new Intl.DateTimeFormat(issuePilotConfig.regional.locale, {
  timeZone: issuePilotConfig.regional.timeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

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
  return dateFormat.format(new Date(value));
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
