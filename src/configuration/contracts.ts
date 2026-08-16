import type { AgentConfiguration, AgentModelDefinition, CapabilityConfiguration, CapabilityName } from "../domain/contracts.ts";

export const CAPABILITY_CREDENTIALS = {
  nacos: { fields: ["password"], required: false },
  db: { fields: ["password"], required: true },
  redis: { fields: ["password"], required: false },
  mq: { fields: ["password"], required: true },
  es: { fields: ["password"], required: false },
  dms: { fields: ["accessKeyId", "accessKeySecret"], required: true },
  sls: { fields: ["accessKeyId", "accessKeySecret"], required: true },
} as const satisfies { [Key in CapabilityName]: { fields: readonly (keyof NonNullable<CapabilityConfiguration[Key]>)[]; required: boolean } };

export type CapabilityCredentialField<Key extends CapabilityName> = (typeof CAPABILITY_CREDENTIALS)[Key]["fields"][number];
export type CapabilityCredentialValues<Key extends CapabilityName> = Pick<NonNullable<CapabilityConfiguration[Key]>, Extract<CapabilityCredentialField<Key>, keyof NonNullable<CapabilityConfiguration[Key]>>>;
export type PublicCapabilitySection<Key extends CapabilityName> = Omit<NonNullable<CapabilityConfiguration[Key]>, CapabilityCredentialField<Key>> & { credentialConfigured: boolean };
export type PublicCapabilityConfiguration = { [Key in CapabilityName]?: PublicCapabilitySection<Key> };
export type CapabilityCredentialUpdate<Key extends CapabilityName> =
  | { mode: "preserve" }
  | { mode: "replace"; values: CapabilityCredentialValues<Key> }
  | { mode: "clear" };
export type CapabilityConfigurationInput = {
  [Key in CapabilityName]?: Omit<NonNullable<CapabilityConfiguration[Key]>, CapabilityCredentialField<Key>> & { credentialUpdate: CapabilityCredentialUpdate<Key> };
};

export type AgentModelOption = Pick<AgentModelDefinition, "provider" | "id" | "thinkingLevels">;

export interface EnvironmentOption {
  key: string;
  name: string;
}

export interface ServiceCatalogItem {
  key: string;
  name: string;
  deployments: Array<{ environmentKey: string }>;
}

export interface ConfigurationCatalog {
  environments: EnvironmentOption[];
  services: ServiceCatalogItem[];
}

export interface ServiceDeployment extends PublicCapabilityConfiguration {
  environmentKey: string;
  repositoryBranches: Array<{ repositoryId: string; repositoryAlias: string; baseBranch: string }>;
  capabilities: CapabilityName[];
  agent: AgentConfiguration | null;
}

export interface ServiceConfiguration {
  key: string;
  revision: string;
  name: string;
  description: string;
  deployments: ServiceDeployment[];
  repositories: Array<{ id: string; alias: string; url: string }>;
}

export interface Configuration extends ConfigurationCatalog {
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
    agent: AgentConfiguration;
  }>;
}
