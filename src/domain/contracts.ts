import type { SettingsManager } from "@earendil-works/pi-coding-agent";

export const USER_ROLES = ["product", "test", "developer"] as const;
export type UserRole = (typeof USER_ROLES)[number];
export function canUseIssueWorkMode(role: UserRole, workMode: IssueWorkMode): boolean {
  return role === "developer" || issueScopeForWorkMode(workMode).repositoryAccess !== "write";
}

/** Role and isAdmin are independent; these predicates are the one definition the server enforces and the Web mirrors. */
export interface AccessHolder {
  role: UserRole;
  isAdmin?: boolean;
}

/** Services, repositories, DMS scope resolution and the user directory follow the developer gate. */
export function canManageDevelopmentConfiguration(user: AccessHolder | null | undefined): boolean {
  return user?.role === "developer";
}

/** Shared credentials, application parameters, MCP services and administrator accounts require isAdmin. */
export function hasAdministratorAccess(user: Pick<AccessHolder, "isAdmin"> | null | undefined): boolean {
  return user?.isAdmin === true;
}

/** Changing an administrator account, or granting administration, additionally requires isAdmin. */
export function managedUserChangeRequiresAdministrator(target: Pick<AccessHolder, "isAdmin"> | null | undefined, grantsAdministrator = false): boolean {
  return target?.isAdmin === true || grantsAdministrator;
}

export function canEditManagedUser(actor: AccessHolder | null | undefined, target?: Pick<AccessHolder, "isAdmin">, grantsAdministrator = false): boolean {
  return canManageDevelopmentConfiguration(actor) && (!managedUserChangeRequiresAdministrator(target, grantsAdministrator) || hasAdministratorAccess(actor));
}

/** Only developers own a personal Git SSH identity; other roles never push code. */
export function hasPersonalGitIdentity(role: UserRole | undefined): boolean {
  return role === "developer";
}

export const ISSUE_KEY_PATTERN = "^ISSUE-[0-9]{8}-[0-9]{3,}$";
const ISSUE_KEY = new RegExp(ISSUE_KEY_PATTERN, "i");

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

/** Name of the read-only entry a related Issue occupies inside an Issue root's runtime view and work-file paths. */
export function relatedIssueEntryName(issueKey: string): string {
  return `.related-${issueKey.toLowerCase()}`;
}

export const MCP_TRANSPORTS = ["streamable_http", "sse", "stdio"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];
export interface McpStdioConfiguration {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

export const CAPABILITY_KEYS = ["dms", "sls"] as const;
export type CapabilityName = (typeof CAPABILITY_KEYS)[number];

// Queued work remains active for reservations, but has not acquired an execution slot.
export const AGENT_RUN_STATES = ["idle", "queued", "running"] as const;
export type AgentRunState = (typeof AGENT_RUN_STATES)[number];

export const AGENT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type AgentThinkingLevel = (typeof AGENT_THINKING_LEVELS)[number];

export const AGENT_CODEMODE_MODES = ["off", "on", "only"] as const;
export type AgentCodemodeMode = (typeof AGENT_CODEMODE_MODES)[number];

export const AGENT_PI_SETTING_KEYS = [
  "compaction",
  "retry",
  "branchSummary",
  "steeringMode",
  "followUpMode",
  "thinkingBudgets",
  "transport",
  "httpIdleTimeoutMs",
  "websocketConnectTimeoutMs",
  "cacheWarming",
  "images",
  "shellPath",
  "shellCommandPrefix",
  "codemode",
] as const;
type PiSettings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;
export type AgentPiSettings = Omit<Pick<PiSettings, (typeof AGENT_PI_SETTING_KEYS)[number]>, "codemode"> & { codemode?: { inlineBudget?: number } };
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

export type AgentModelSelection = Pick<AgentConfiguration, "provider" | "model" | "thinkingLevel" | "codemode">;

/** A complete personal model group; developers who own one use it instead of the shared model and key. */
export interface PersonalModelCredentials extends AgentModelSelection {
  apiKey: string;
}

export interface AgentModelDefinition {
  provider: string;
  id: string;
  contextWindow: number;
  thinkingLevels: AgentThinkingLevel[];
}

export type AgentCostSource = "provider" | "estimated" | "unknown" | "mixed";

/** Only nonzero charges contribute to the total's provenance; absent SDK flags stay unknown. */
export function mergeAgentCostSource(current: AgentCostSource | null, cost: { total: number; totalFromProvider?: boolean }): AgentCostSource | null {
  if (cost.total === 0) return current;
  const source = cost.totalFromProvider === true ? "provider" : cost.totalFromProvider === false ? "estimated" : "unknown";
  return current === null || current === source ? source : "mixed";
}

export interface AgentFooterStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costSource: AgentCostSource | null;
  latestCacheHitRate: number | null;
  contextPercent: number | null;
  contextWindow: number;
  autoCompact: boolean;
}

export const DBHUB_DATABASES = [
  { value: "postgres", label: "PostgreSQL", port: 5432 },
  { value: "mysql", label: "MySQL", port: 3306 },
  { value: "mariadb", label: "MariaDB", port: 3306 },
  { value: "sqlserver", label: "SQL Server", port: 1433 },
  { value: "oracle", label: "Oracle", port: 1521 },
] as const;
export type DbHubDatabaseType = (typeof DBHUB_DATABASES)[number]["value"];
export interface DbHubTarget {
  type: DbHubDatabaseType;
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
}

export interface DmsCredentials {
  url: string;
  authorization: string;
}
export interface DmsScope {
  databases: Array<{ instanceAlias: string; schemaName: string; instanceId: string; instanceHost: string; instancePort: string; databaseId: string }>;
}
export interface SlsCredentials {
  accessKeyId: string;
  accessKeySecret: string;
}
export interface SlsScope {
  region: string;
  project: string;
  logstores: string[];
  targets?: Array<{ region: string; project: string; logstores: string[] }>;
}

export interface CapabilityConfiguration {
  dbhub?: DbHubTarget[];
  dms?: DmsScope & DmsCredentials;
  sls?: SlsScope & SlsCredentials;
}

export type DeploymentConfig = CapabilityConfiguration;
export type StoredDeploymentConfig = Omit<CapabilityConfiguration, "dms" | "sls"> & {
  dms?: DmsScope & Partial<DmsCredentials>;
  sls?: SlsScope & Partial<SlsCredentials>;
  /** Private pre-upgrade development settings; never projected or executed. */
  archivedDevelopment?: unknown;
  /** Historical deployment bindings removed by migration 0082; MCP availability is now global. */
  mcpServices?: string[];
};

/** Credential owner is the assignee, else the reporter; callers still enforce that the owner is active. */
export function credentialOwnerSubject(issue: { assigneeSubject: string | null; reporterSubject: string }): string {
  return issue.assigneeSubject ?? issue.reporterSubject;
}

/** Commits stay attributable when a person has no display name or email address on record. */
export function personGitIdentity(person: { subject: string; displayName: string | null; email: string | null }): { name: string; email: string } {
  return { name: person.displayName ?? person.subject, email: person.email ?? `${person.subject}@localhost` };
}

export function configuredCapabilities(config: Partial<Record<CapabilityName, unknown>>): CapabilityName[] {
  return CAPABILITY_KEYS.filter((key) => config[key] !== undefined);
}

export const ENVIRONMENT_KINDS = ["prod", "test", "dev"] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

export const ISSUE_TYPES = ["smart_analysis", "defect_fix", "feature_development"] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const ISSUE_WORK_MODES = ["production_analysis", "test_analysis", "development_fix", "development_feature"] as const;
export type IssueWorkMode = (typeof ISSUE_WORK_MODES)[number];

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
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const WORKSPACE_STATUSES = ["not_created", "preparing", "running", "ready", "stopped", "failed"] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

const WORKSPACE_BUSY_STATUSES: readonly WorkspaceStatus[] = ["preparing", "running"];

export function isWorkspaceBusy(status: WorkspaceStatus): boolean {
  return WORKSPACE_BUSY_STATUSES.includes(status);
}

export const ISSUE_PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

/** Queued/executing Agent work or an in-flight preparation; reservations and restores refuse such Issues. */
export function isIssueActive(issue: { agentRunning: boolean; workspaceStatus: WorkspaceStatus }): boolean {
  return issue.agentRunning || isWorkspaceBusy(issue.workspaceStatus);
}

/**
 * Repository access belongs to the environment kind: every work mode of one kind shares it, which is
 * checked here when the module loads. ISSUE_SCOPE_BY_WORK_MODE therefore stays the single table for
 * work-mode authorization, preparation mode, Agent code tools and the developer-owner rule.
 */
const REPOSITORY_ACCESS_BY_ENVIRONMENT = Object.fromEntries(
  ENVIRONMENT_KINDS.map((kind) => {
    const accesses = new Set(ISSUE_WORK_MODES.map((workMode) => ISSUE_SCOPE_BY_WORK_MODE[workMode]).flatMap((scope) => (scope.environmentKind === kind ? [scope.repositoryAccess] : [])));
    if (accesses.size !== 1) throw new Error("issue_scope_mapping_invalid");
    return [kind, [...accesses][0]!];
  }),
) as Record<EnvironmentKind, "read" | "write">;

/** Remote Git URLs that can use the developer's personal SSH identity. URL syntax is validated at admission. */
export function isSshRepositoryUrl(url: string): boolean {
  return url.startsWith("ssh://") || /^[^/]+@[^:]+:/.test(url);
}

/** Issues in this environment kind use isolated writable worktrees; the others read shared snapshots. */
export function canModifyIssueCode(environmentKind: EnvironmentKind): boolean {
  return REPOSITORY_ACCESS_BY_ENVIRONMENT[environmentKind] === "write";
}

/** Code-writing Issues commit and push with the credential owner's personal Git identity, so that owner must be a developer. Callers still require an active owner. */
export function requiresDeveloperOwner(environmentKind: EnvironmentKind): boolean {
  return canModifyIssueCode(environmentKind);
}

/**
 * Whether an actor may start code-affecting work (Agent rounds, source mutations) in this Issue's environment.
 * Analysis-only environments accept every role; code-writable ones require a developer, and isAdmin is independent.
 */
export function canWriteIssueCode(user: AccessHolder | null | undefined, environmentKind: EnvironmentKind | undefined): boolean {
  return environmentKind === undefined || !canModifyIssueCode(environmentKind) || canManageDevelopmentConfiguration(user);
}

/** The development environment derives baselines from production and has no capability targets of its own. Identify it by kind, never by its configurable key. */
export function isDevelopmentEnvironment(environmentKind: EnvironmentKind | undefined): boolean {
  return environmentKind === "dev";
}

export interface IssueScopeState {
  environmentKind: EnvironmentKind;
  issueType: IssueType;
  status: IssueStatus;
  workspaceStatus: WorkspaceStatus;
}

const CODE_TRANSITION_STATUSES: readonly IssueStatus[] = ["open", "pending"];

/**
 * Eligibility of a code-changing scope transition, shared by the planner and the lifecycle rechecks after waits.
 * Returns the refusal code, or null when the Issue may be converted/migrated toward targetEnvironmentKind.
 */
export function scopeTransitionRefusal(
  action: "convert_to_development" | "migrate_development",
  current: IssueScopeState,
  targetEnvironmentKind: EnvironmentKind | undefined,
): "issue_not_convertible_to_development" | "issue_not_migratable_between_development_scopes" | null {
  const settled = CODE_TRANSITION_STATUSES.includes(current.status) && current.workspaceStatus === "ready";
  const targetWrites = targetEnvironmentKind !== undefined && canModifyIssueCode(targetEnvironmentKind);
  if (action === "convert_to_development")
    return settled && targetWrites && !canModifyIssueCode(current.environmentKind) && current.issueType === "smart_analysis" ? null : "issue_not_convertible_to_development";
  return settled && targetWrites && canModifyIssueCode(current.environmentKind) && issueWorkMode(current.environmentKind, current.issueType) !== undefined
    ? null
    : "issue_not_migratable_between_development_scopes";
}

/**
 * Whether any scope transition can be planned now. Read-only Issues can always be rebound to another
 * read-only scope (including resolved ones); code-changing transitions need a settled ready workspace.
 * Active work conflicts with the transition's reservation.
 */
export function canChangeIssueScope(issue: Omit<IssueScopeState, "issueType"> & { agentRunning: boolean }): boolean {
  if (isIssueActive(issue)) return false;
  return !canModifyIssueCode(issue.environmentKind) || (CODE_TRANSITION_STATUSES.includes(issue.status) && issue.workspaceStatus === "ready");
}

/**
 * Related Issues change only on an unresolved Issue whose prepared runtime view can be rebuilt. Removing
 * existing relations needs no rebuild, so it stays available while that context is unavailable, including
 * on a never-run Issue (the caller still enforces idleness). Returns the refusal code or null.
 */
export function relatedIssueUpdateRefusal(
  issue: {
    status: IssueStatus;
    workspace: { status: WorkspaceStatus; runtimeReady: boolean } | undefined;
  },
  options: { onlyRemoves?: boolean } = {},
): "related_issue_update_not_allowed" | "related_issue_context_unavailable" | null {
  if (issue.status === "resolved") return "related_issue_update_not_allowed";
  if (options.onlyRemoves) return null;
  if (!issue.workspace || !["ready", "stopped"].includes(issue.workspace.status) || !issue.workspace.runtimeReady) return "related_issue_context_unavailable";
  return null;
}

/** Session reset requires a developer actor and an unresolved Issue without active work (the reset reservation refuses it). */
export function canResetIssueSession(input: { actorRole: UserRole; status: IssueStatus; agentRunning: boolean }): boolean {
  return input.actorRole === "developer" && input.status !== "resolved" && !input.agentRunning;
}
