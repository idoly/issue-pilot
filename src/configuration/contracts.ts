import type { DingtalkColumns } from "../mcp/dingtalk-contracts.ts";
import type { AgentConfiguration, AgentModelDefinition, CapabilityConfiguration, CapabilityName } from "../domain/contracts.ts";

export const CAPABILITY_CREDENTIALS = {
  dms: { fields: ["authorization"], required: true },
  sls: { fields: ["accessKeyId", "accessKeySecret"], required: true },
} as const;

type CapabilityCredentialField<Key extends CapabilityName> = (typeof CAPABILITY_CREDENTIALS)[Key]["fields"][number];
export type CapabilityCredentialValues<Key extends CapabilityName> = Pick<NonNullable<CapabilityConfiguration[Key]>, Extract<CapabilityCredentialField<Key>, keyof NonNullable<CapabilityConfiguration[Key]>>>;
export type CapabilityCredentialUpdate<Key extends CapabilityName> =
  | { mode: "preserve" }
  | { mode: "replace"; values: CapabilityCredentialValues<Key> }
  | { mode: "clear" };
export type ProjectedCapabilitySection<Key extends CapabilityName> = Omit<NonNullable<CapabilityConfiguration[Key]>, CapabilityCredentialField<Key>> & { credentialConfigured: boolean };
export type ProjectedCapabilityConfiguration = { [Key in CapabilityName]?: ProjectedCapabilitySection<Key> };
export type CapabilityConfigurationInput = {
  [Key in CapabilityName]?: Omit<NonNullable<CapabilityConfiguration[Key]>, CapabilityCredentialField<Key>> & { credentialUpdate: CapabilityCredentialUpdate<Key> };
};

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
  environments: EnvironmentOption[];
  services: ServiceCatalogItem[];
}

export type ServiceCapabilityConfiguration = ProjectedCapabilityConfiguration;

interface ServiceDeployment extends ServiceCapabilityConfiguration {
  environmentKey: string;
  repositoryBranches: Array<{ repositoryId: string; repositoryAlias: string; baseBranch: string }>;
  capabilities: CapabilityName[];
}

export interface ServiceConfiguration {
  key: string;
  name: string;
  description: string;
  context?: string;
  deployments: ServiceDeployment[];
  repositories: Array<{ id: string; alias: string; url: string }>;
}

export interface DingtalkConnectionSettings { apiKey: string; url?: string }
export interface DingtalkSourceSettings { mcp: string; url: string; assignee: string; intervalMinutes?: number; environment?: "dev" | "test" | "prod" }
export interface DingtalkUserSettings { fields?: Partial<DingtalkColumns>; source?: DingtalkSourceSettings; personal?: DingtalkConnectionSettings; shared?: DingtalkConnectionSettings }

export interface FileConfigurationState { services: boolean; mcp: boolean; userSubject?: string; maxConcurrentIssues?: number; userSubjects?: string[]; mcpServiceNames?: string[] }

export interface Configuration extends ConfigurationCatalog {
  fileManaged?: FileConfigurationState;
  agent: AgentConfiguration;
  agentModels: AgentModelOption[];
  services: ServiceConfiguration[];
}

export interface ServiceConfigurationInput {
  name: string;
  description: string;
  repositories: Array<{ id?: string; alias: string; url: string }>;
  deployments: Array<CapabilityConfigurationInput & {
    environmentKey: string;
    repositoryBranches: Array<{ repositoryAlias: string; baseBranch: string }>;
    capabilities: CapabilityName[];
  }>;
}
