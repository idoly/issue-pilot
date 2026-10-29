import type { DingtalkColumns } from "../mcp/dingtalk-contracts.ts";
import type { AgentConfiguration, AgentModelDefinition, CapabilityConfiguration, CapabilityName } from "../domain/contracts.ts";

export const CAPABILITY_CREDENTIAL_FIELDS = {
  dms: ["authorization"],
  sls: ["accessKeyId", "accessKeySecret"],
} as const;

type CapabilityCredentialField<Key extends CapabilityName> = (typeof CAPABILITY_CREDENTIAL_FIELDS)[Key][number];
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

interface ServiceDeployment extends ProjectedCapabilityConfiguration {
  dbhub?: Array<Omit<NonNullable<CapabilityConfiguration["dbhub"]>[number], "password"> & { passwordConfigured: boolean }>;
  mysql?: Array<Omit<NonNullable<CapabilityConfiguration["mysql"]>[number], "password"> & { passwordConfigured: boolean }>;
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
  agent: AgentConfiguration;
  agentModels: AgentModelOption[];
  services: ServiceConfiguration[];
}

export interface ServiceConfigurationInput {
  expectedRevision?: number;
  name: string;
  description: string;
  repositories: Array<{ id?: string; alias: string; url: string }>;
  deployments: Array<CapabilityConfigurationInput & {
    dbhub?: CapabilityConfiguration["dbhub"];
    mysql?: CapabilityConfiguration["mysql"];
    environmentKey: string;
    repositoryBranches: Array<{ repositoryAlias: string; baseBranch: string }>;
    capabilities: CapabilityName[];
  }>;
}
