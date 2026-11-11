import type { DingtalkColumns } from "../mcp/dingtalk-contracts.ts";
import type { AgentConfiguration, AgentModelDefinition, CapabilityConfiguration, CapabilityName, DmsScope, SlsScope } from "../domain/contracts.ts";
import type { IssueSearchConfiguration, IssueSearchConfigurationUpdate } from "../search/contracts.ts";

export const CAPABILITY_CREDENTIAL_FIELDS = {
  dms: ["url", "authorization"],
  sls: ["accessKeyId", "accessKeySecret"],
} as const;

type CapabilityScopes = { dms: DmsScope; sls: SlsScope };
export type ProjectedCapabilitySection<Key extends CapabilityName> = CapabilityScopes[Key];
export type ProjectedCapabilityConfiguration = Partial<CapabilityScopes>;
export type CapabilityConfigurationInput = Partial<CapabilityScopes>;

export type AgentModelOption = Pick<AgentModelDefinition, "provider" | "id" | "thinkingLevels">;

interface EnvironmentOption {
  key: string;
  name: string;
}

interface ServiceCatalogItem {
  key: string;
  name: string;
  deployments: Array<{ environmentKey: string }>;
}

export interface ConfigurationCatalog {
  issueSearchEnabled?: true;
  environments: EnvironmentOption[];
  services: ServiceCatalogItem[];
}

interface ServiceDeployment extends ProjectedCapabilityConfiguration {
  dbhub?: Array<Omit<NonNullable<CapabilityConfiguration["dbhub"]>[number], "password"> & { passwordConfigured: boolean }>;
  environmentKey: string;
  repositoryBranches: Array<{ repositoryId: string; repositoryAlias: string; baseBranch: string }>;
  capabilities: CapabilityName[];
}

export interface ServiceConfiguration {
  revision: number;
  key: string;
  name: string;
  description: string;
  context?: string;
  deployments: ServiceDeployment[];
  repositories: Array<{ id: string; alias: string; url: string }>;
}

export interface DingtalkUserSettings {
  fields?: Partial<DingtalkColumns>;
  source?: { mcp: string; url: string; environment?: "dev" | "test" | "prod" };
}

export interface Configuration extends ConfigurationCatalog {
  agent: AgentConfiguration & { apiKeyConfigured: boolean };
  agentModels: AgentModelOption[];
  services: ServiceConfiguration[];
}

export interface ServiceConfigurationInput {
  name: string;
  description: string;
  repositories: Array<{ id?: string; alias: string; url: string }>;
  deployments: Array<
    CapabilityConfigurationInput & {
      dbhub?: CapabilityConfiguration["dbhub"];
      environmentKey: string;
      repositoryBranches: Array<{ repositoryAlias: string; baseBranch: string }>;
      capabilities: CapabilityName[];
    }
  >;
}

export type AgentNetworkMode = "open" | "allowlist";

/** Operational parameters that apply without restart. Durations are milliseconds and sizes are bytes. */
export interface ApplicationParameters {
  maxConcurrentIssues: number;
  modelResponseIdleMs: number;
  workspaceRetentionMs: number;
  workspaceHighWaterBytes: number;
  workspaceTargetBytes: number;
  workspaceMaintenanceIntervalMs: number;
  capabilityConnectionMs: number;
  mcpExecutionMs: number;
  dmsExecutionMs: number;
  slsExecutionMs: number;
  dingtalkAttachmentHosts: readonly string[];
  networkMode: AgentNetworkMode;
  networkAllowedDomains: readonly string[];
}
export type ApplicationParameterKey = keyof ApplicationParameters;
export type NumericApplicationParameterKey = { [Key in ApplicationParameterKey]: ApplicationParameters[Key] extends number ? Key : never }[ApplicationParameterKey];
export type ApplicationParameterOverrides = Partial<ApplicationParameters>;
export interface ApplicationParameterBounds {
  numbers: Record<NumericApplicationParameterKey, { minimum: number; maximum: number }>;
  listEntries: number;
}
export interface ApplicationParameterState {
  revision: number;
  /** Saved admin values; omitted keys use the project configuration default. */
  overrides: ApplicationParameterOverrides;
  values: ApplicationParameters;
  defaults: ApplicationParameters;
  bounds: ApplicationParameterBounds;
}
export interface ApplicationParameterUpdate {
  expectedRevision: number;
  overrides: ApplicationParameterOverrides;
  issueSearch?: IssueSearchConfigurationUpdate;
}
export type ApplicationParameterEditorState = ApplicationParameterState & { issueSearch: IssueSearchConfiguration };
