import type { SettingsManager } from "@earendil-works/pi-coding-agent";

export const USER_ROLES = ["product", "test", "developer"] as const;
export type UserRole = typeof USER_ROLES[number];
export function canCreateDevelopmentIssues(role: UserRole): boolean { return role === "developer"; }
export function canUseIssueWorkMode(role: UserRole, workMode: IssueWorkMode): boolean {
  return role === "developer" || issueScopeForWorkMode(workMode).repositoryAccess !== "write";
}

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

export const MCP_TRANSPORTS = ["streamable_http", "sse", "stdio"] as const;
export type McpTransport = typeof MCP_TRANSPORTS[number];
export interface McpStdioConfiguration { command: string; args: string[]; env: Record<string, string>; cwd?: string }

export const CAPABILITY_KEYS = ["dms", "sls"] as const;
export type CapabilityName = typeof CAPABILITY_KEYS[number];

export const AGENT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type AgentThinkingLevel = typeof AGENT_THINKING_LEVELS[number];

export const AGENT_CODEMODE_MODES = ["off", "on", "only"] as const;
export type AgentCodemodeMode = typeof AGENT_CODEMODE_MODES[number];

export const AGENT_PI_SETTING_KEYS = ["compaction", "retry", "branchSummary", "steeringMode", "followUpMode", "thinkingBudgets", "transport", "httpIdleTimeoutMs", "websocketConnectTimeoutMs", "cacheWarming", "images", "shellPath", "shellCommandPrefix", "codemode"] as const;
type PiSettings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;
export type AgentPiSettings = Omit<Pick<PiSettings, typeof AGENT_PI_SETTING_KEYS[number]>, "codemode"> & { codemode?: { inlineBudget?: number } };
export interface AgentRuntimeConfiguration {
  networkAllowedDomains?: string[];
  settings?: AgentPiSettings;
}

export interface AgentConfiguration {
  runtime: AgentRuntimeConfiguration;
  codemode: AgentCodemodeMode;
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

export interface MysqlTarget { host: string; port: number; username: string; password: string; database: string }
export const DBHUB_DATABASES = [
  { value: "postgres", label: "PostgreSQL", port: 5432 },
  { value: "mysql", label: "MySQL", port: 3306 },
  { value: "mariadb", label: "MariaDB", port: 3306 },
  { value: "sqlserver", label: "SQL Server", port: 1433 },
  { value: "oracle", label: "Oracle", port: 1521 },
] as const;
export type DbHubDatabaseType = typeof DBHUB_DATABASES[number]["value"];
export interface DbHubTarget extends MysqlTarget { type: DbHubDatabaseType }

export interface SlsCredentials { accessKeyId: string; accessKeySecret: string }
export interface SlsScope { region: string; project: string; logstores: string[]; targets?: Array<{ name: string; region: string; project: string; logstores: string[] }> }

export interface CapabilityConfiguration {
  mysql?: MysqlTarget[];
  dbhub?: DbHubTarget[];
  dms?: { url: string; authorization: string; databases: Array<{ instanceAlias: string; schemaName: string; instanceId: string; instanceHost: string; instancePort: string; databaseId: string }> };
  sls?: SlsScope & SlsCredentials;
}

/** Historical private deployment fields retained for migration/recovery; never executed or projected. */
interface RetiredCapabilityConfiguration {
  nacos?: { serverUrl: string; namespace: string; group: string; dataIds: string[]; username: string; password?: string };
  db?: { databases: Array<{ url: string; username: string; password: string }> };
  redis?: { host: string; port: number; username: string; password?: string; database: number };
  mq?: { host: string; managementPort: number; username: string; password: string; virtualHost: string };
  es?: { url: string; username: string; password?: string };
}

export type DeploymentConfig = CapabilityConfiguration;
export type StoredDeploymentConfig = Omit<CapabilityConfiguration, "sls"> & { sls?: SlsScope & Partial<SlsCredentials> } & RetiredCapabilityConfiguration & {
  /** Private pre-upgrade development settings; never projected or executed. */
  archivedDevelopment?: unknown;
  /** Historical deployment bindings; MCP availability is now global. */
  mcpServices?: string[];
};

export function configuredCapabilities(config: Partial<Record<CapabilityName, unknown>>): CapabilityName[] {
  return CAPABILITY_KEYS.filter((key) => config[key] !== undefined);
}

export const ENVIRONMENT_KINDS = ["prod", "test", "dev"] as const;
export type EnvironmentKind = typeof ENVIRONMENT_KINDS[number];

export const ISSUE_TYPES = ["smart_analysis", "defect_fix", "feature_development"] as const;
export type IssueType = typeof ISSUE_TYPES[number];

export const ISSUE_TYPES_BY_ENVIRONMENT: Record<EnvironmentKind, readonly IssueType[]> = {
  prod: ["smart_analysis"],
  test: ["smart_analysis"],
  dev: ["defect_fix", "feature_development"],
};

export const ISSUE_WORK_MODES = ["production_analysis", "test_analysis", "development_fix", "development_feature"] as const;
export type IssueWorkMode = typeof ISSUE_WORK_MODES[number];

const ISSUE_SCOPE_BY_WORK_MODE: Record<IssueWorkMode, { environmentKind: EnvironmentKind; issueType: IssueType; repositoryAccess: "read" | "write" }> = {
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
