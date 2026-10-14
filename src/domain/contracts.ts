const ISSUE_KEY = /^ISSUE-[0-9]{8}-[0-9]{3,}$/i;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseIssueKey(value: string): string | undefined {
  const normalized = value.toUpperCase();
  return ISSUE_KEY.test(normalized) ? normalized : undefined;
}

export function normalizeIssueKey(value: string): string {
  const normalized = parseIssueKey(value.trim());
  if (!normalized) throw new Error("invalid_issue_key");
  return normalized;
}

export const CAPABILITY_KEYS = ["nacos", "db", "redis", "mq", "es", "dms", "sls"] as const;
export type CapabilityName = typeof CAPABILITY_KEYS[number];

export const AGENT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type AgentThinkingLevel = typeof AGENT_THINKING_LEVELS[number];

export interface AgentConfiguration {
  provider: string;
  model: string;
  thinkingLevel: AgentThinkingLevel;
}

export interface AgentModelDefinition {
  provider: string;
  id: string;
  contextWindow: number;
  thinkingLevels: AgentThinkingLevel[];
}

export interface AgentFooterStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  latestCacheHitRate: number | null;
  contextPercent: number | null;
  contextWindow: number;
  autoCompact: boolean;
}

export interface CapabilityConfiguration {
  nacos?: { serverUrl: string; namespace: string; group: string; dataIds: string[]; username: string; password?: string };
  db?: { databases: Array<{ url: string; username: string; password: string }> };
  dms?: { url: string; authorization: string; databases: Array<{ instanceAlias: string; schemaName: string; instanceId: string; instanceHost: string; instancePort: string; databaseId: string }> };
  sls?: { accessKeyId: string; accessKeySecret: string; region: string; project: string; logstores: string[] };
  redis?: { host: string; port: number; username: string; password?: string; database: number };
  mq?: { host: string; port: number; managementPort: number; username: string; password: string; virtualHost: string };
  es?: { url: string; username: string; password?: string };
}

export type DeploymentConfig = CapabilityConfiguration;

export function configuredCapabilities(config: DeploymentConfig): CapabilityName[] {
  return CAPABILITY_KEYS.filter((key) => config[key] !== undefined);
}

export const ENVIRONMENT_KINDS = ["prod", "test", "dev"] as const;
export type EnvironmentKind = typeof ENVIRONMENT_KINDS[number];

export const ISSUE_TYPES = ["data_processing", "smart_analysis", "defect_fix", "feature_development"] as const;
export type IssueType = typeof ISSUE_TYPES[number];

export const ISSUE_TYPES_BY_ENVIRONMENT: Record<EnvironmentKind, readonly IssueType[]> = {
  prod: ["data_processing", "smart_analysis"],
  test: ["smart_analysis"],
  dev: ["defect_fix", "feature_development"],
};

export const ISSUE_WORK_MODES = ["production_data", "production_analysis", "test_analysis", "development_fix", "development_feature"] as const;
export type IssueWorkMode = typeof ISSUE_WORK_MODES[number];

const ISSUE_SCOPE_BY_WORK_MODE: Record<IssueWorkMode, { environmentKind: EnvironmentKind; issueType: IssueType; repositoryAccess: "read" | "write" }> = {
  production_data: { environmentKind: "prod", issueType: "data_processing", repositoryAccess: "read" },
  production_analysis: { environmentKind: "prod", issueType: "smart_analysis", repositoryAccess: "read" },
  test_analysis: { environmentKind: "test", issueType: "smart_analysis", repositoryAccess: "read" },
  development_fix: { environmentKind: "dev", issueType: "defect_fix", repositoryAccess: "write" },
  development_feature: { environmentKind: "dev", issueType: "feature_development", repositoryAccess: "write" },
};

export function issueScopeForWorkMode(workMode: IssueWorkMode): Readonly<{ environmentKind: EnvironmentKind; issueType: IssueType; repositoryAccess: "read" | "write" }> {
  return ISSUE_SCOPE_BY_WORK_MODE[workMode];
}

export function issueWorkMode(environmentKind: EnvironmentKind, issueType: IssueType): IssueWorkMode | undefined {
  return ISSUE_WORK_MODES.find((workMode) => {
    const scope = ISSUE_SCOPE_BY_WORK_MODE[workMode];
    return scope.environmentKind === environmentKind && scope.issueType === issueType;
  });
}

export const ISSUE_STATUSES = ["open", "in_progress", "pending", "resolved"] as const;
export type IssueStatus = typeof ISSUE_STATUSES[number];

export const WORKSPACE_STATUSES = ["not_created", "preparing", "running", "ready", "stopped", "failed"] as const;
export type WorkspaceStatus = typeof WORKSPACE_STATUSES[number];

const WORKSPACE_BUSY_STATUSES: readonly WorkspaceStatus[] = ["preparing", "running"];

export function isWorkspaceBusy(status: WorkspaceStatus): boolean {
  return WORKSPACE_BUSY_STATUSES.includes(status);
}

export const ISSUE_PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export type IssuePriority = typeof ISSUE_PRIORITIES[number];
