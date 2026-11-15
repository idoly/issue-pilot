import { sharedConfig } from "../../../../issue-pilot.config.ts";
import {
  canUseIssueWorkMode,
  ENVIRONMENT_KINDS,
  ISSUE_PRIORITIES,
  ISSUE_WORK_MODES,
  issueScopeForWorkMode,
  type EnvironmentKind,
  type IssueExecutionItem,
  type IssuePriority,
  type IssueStatus,
  type IssueType,
  type IssueWorkMode,
  type UserRole,
} from "../data/client";

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

export type ExecutionState = "running" | "preparing" | "failed" | IssueStatus;
export const executionBadge: Record<ExecutionState, "default" | "processing" | "warning" | "success" | "error"> = {
  ...statusBadge,
  running: "processing",
  preparing: "processing",
  failed: "error",
};

/** Agent/Workspace execution state takes precedence over business status until the Issue is resolved. */
export function executionState(issue: Pick<IssueExecutionItem, "status" | "workspaceStatus" | "agentRunning">): { key: ExecutionState; label: string } {
  if (issue.status !== "resolved") {
    if (issue.agentRunning || issue.workspaceStatus === "running") return { key: "running", label: "执行中" };
    if (issue.workspaceStatus === "preparing") return { key: "preparing", label: "环境准备中" };
    if (issue.workspaceStatus === "failed") return { key: "failed", label: "执行失败" };
  }
  return { key: issue.status, label: statusLabel[issue.status] };
}

export const typeLabel: Record<IssueType, string> = {
  smart_analysis: "智能分析",
  defect_fix: "缺陷修复",
  feature_development: "功能开发",
};

export const workModeLabel: Record<IssueWorkMode, string> = {
  production_analysis: "正式问题调查",
  test_analysis: "测试问题调查",
  development_fix: "开发缺陷修复",
  development_feature: "开发功能开发",
};

export const workModeOptions = ISSUE_WORK_MODES.map((value) => ({ value, label: workModeLabel[value] }));

/** Issue and deployment environment keys name the environment kind; an unknown key has no kind-based rules. */
export function environmentKind(environmentKey: string): EnvironmentKind | undefined {
  return ENVIRONMENT_KINDS.find((kind) => kind === environmentKey);
}

type DeployedService = { deployments: ReadonlyArray<{ environmentKey: string }> };

/** Services with a deployment in the work mode's environment; Issue scope must match such a deployment. */
export function servicesForWorkMode<T extends DeployedService>(services: readonly T[], workMode: IssueWorkMode): T[] {
  const kind = issueScopeForWorkMode(workMode).environmentKind;
  return services.filter((service) => service.deployments.some((deployment) => deployment.environmentKey === kind));
}

/** Work modes the role may use and that at least one service is deployed for. */
export function availableWorkModes(role: UserRole | undefined, services: readonly DeployedService[]) {
  return workModeOptions.filter(({ value }) => canUseIssueWorkMode(role ?? "product", value) && servicesForWorkMode(services, value).length > 0);
}

/** People pickers show the name with the email when one is on record. */
export function personLabel(person: { name: string; email?: string | null | undefined }): string {
  return person.email ? `${person.name} · ${person.email}` : person.name;
}

const dateFormat = new Intl.DateTimeFormat(sharedConfig.regional.locale, {
  timeZone: sharedConfig.regional.timeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const dateTimeFormat = new Intl.DateTimeFormat(sharedConfig.regional.locale, {
  timeZone: sharedConfig.regional.timeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
/** Environments are addressed by key; the display name falls back to that key. */
export function environmentName(environments: ReadonlyArray<{ key: string; name: string }>, key: string): string {
  return environments.find((environment) => environment.key === key)?.name ?? key;
}

/** Dates and times display in the configured regional locale and time zone, not the browser's. */
export const localDate = (value: string | number | Date) => dateFormat.format(new Date(value));
export const localDateTime = (value: string | number | Date) => dateTimeFormat.format(new Date(value));

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

/**
 * Attachment names are stored verbatim from their external source (browser upload, DingTalk record cell
 * filename or application MCP caller); the application never renames them. Such sources can supply opaque
 * content-hash names for images, which say nothing to a reader, so those are labelled by position instead.
 * The stored name stays unchanged for download and preview.
 */
export function attachmentDisplayName(fileName: string, isImage: boolean, position: number): string {
  return isImage && /^[a-f0-9]{24,}\.[a-z0-9]+$/i.test(fileName) ? `图片附件 ${position}` : fileName;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
