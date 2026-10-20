import type { AgentConfiguration, AgentModelDefinition, CapabilityConfiguration, CapabilityName } from "../domain/contracts.ts";

export const CAPABILITY_CREDENTIALS = {
  nacos: { fields: ["password"], required: false },
  db: { fields: ["password"], required: true },
  redis: { fields: ["password"], required: false },
  mq: { fields: ["password"], required: true },
  es: { fields: ["password"], required: false },
  dms: { fields: ["authorization"], required: true },
  sls: { fields: ["accessKeyId", "accessKeySecret"], required: true },
} as const;

type CapabilityCredentialField<Key extends CapabilityName> = (typeof CAPABILITY_CREDENTIALS)[Key]["fields"][number];
export type CapabilityCredentialValues<Key extends CapabilityName> = Key extends "db"
  ? { password: string }
  : Pick<NonNullable<CapabilityConfiguration[Key]>, Extract<CapabilityCredentialField<Key>, keyof NonNullable<CapabilityConfiguration[Key]>>>;
export type CapabilityCredentialUpdate<Key extends CapabilityName> =
  | { mode: "preserve" }
  | { mode: "replace"; values: CapabilityCredentialValues<Key> }
  | { mode: "clear" };
type DbConfiguration = NonNullable<CapabilityConfiguration["db"]>;
type DbConfigurationTarget = DbConfiguration["databases"][number];
export type ProjectedCapabilitySection<Key extends CapabilityName> = Key extends "db"
  ? { databases: Array<Omit<DbConfigurationTarget, "password"> & { credentialConfigured: boolean }> }
  : Omit<NonNullable<CapabilityConfiguration[Key]>, CapabilityCredentialField<Key>> & { credentialConfigured: boolean };
export type ProjectedCapabilityConfiguration = { [Key in CapabilityName]?: ProjectedCapabilitySection<Key> };
export type CapabilityConfigurationInput = {
  [Key in CapabilityName]?: Key extends "db"
    ? { databases: Array<Omit<DbConfigurationTarget, "password"> & { credentialUpdate: CapabilityCredentialUpdate<"db"> }> }
    : Omit<NonNullable<CapabilityConfiguration[Key]>, CapabilityCredentialField<Key>> & { credentialUpdate: CapabilityCredentialUpdate<Key> };
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

export interface Configuration extends ConfigurationCatalog {
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
