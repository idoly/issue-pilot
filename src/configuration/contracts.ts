import type { AgentConfiguration, AgentModelDefinition, CapabilityConfiguration, CapabilityName } from "../domain/contracts.ts";

export const CAPABILITY_CREDENTIALS = {
  nacos: { fields: ["password"], required: false },
  db: { fields: ["password"], required: true },
  redis: { fields: ["password"], required: false },
  mq: { fields: ["password"], required: true },
  es: { fields: ["password"], required: false },
  dms: { fields: ["authorization"], required: true },
  sls: { fields: ["accessKeyId", "accessKeySecret"], required: true },
} as const satisfies { [Key in CapabilityName]: { fields: readonly (keyof NonNullable<CapabilityConfiguration[Key]>)[]; required: boolean } };

type CapabilityCredentialField<Key extends CapabilityName> = (typeof CAPABILITY_CREDENTIALS)[Key]["fields"][number];
export type CapabilityCredentialValues<Key extends CapabilityName> = Pick<NonNullable<CapabilityConfiguration[Key]>, Extract<CapabilityCredentialField<Key>, keyof NonNullable<CapabilityConfiguration[Key]>>>;
export type ProjectedCapabilitySection<Key extends CapabilityName> = NonNullable<CapabilityConfiguration[Key]> & { credentialConfigured: boolean };
export type ProjectedCapabilityConfiguration = { [Key in CapabilityName]?: ProjectedCapabilitySection<Key> };
export type CapabilityCredentialUpdate<Key extends CapabilityName> =
  | { mode: "preserve" }
  | { mode: "replace"; values: CapabilityCredentialValues<Key> }
  | { mode: "clear" };
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
  environmentKey: string;
  repositoryBranches: Array<{ repositoryId: string; repositoryAlias: string; baseBranch: string }>;
  capabilities: CapabilityName[];
}

export interface ServiceConfiguration {
  key: string;
  name: string;
  description: string;
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
