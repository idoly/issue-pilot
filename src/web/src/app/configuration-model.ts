import { CAPABILITY_KEYS, type CapabilityName } from "../../../domain/contracts";
import { type CapabilityConfigurationInput, type ProjectedCapabilityConfiguration, type ProjectedCapabilitySection } from "../../../configuration/contracts";

export type DeploymentCapabilityDraft = ProjectedCapabilityConfiguration & {
  capabilities: CapabilityName[];
};

type CapabilitySerializer<Key extends CapabilityName> = (draft: ProjectedCapabilitySection<Key>) => NonNullable<CapabilityConfigurationInput[Key]>;

const serializers: { [Key in CapabilityName]: CapabilitySerializer<Key> } = {
  dms: (draft) => ({
    databases: draft.databases.map((database) => ({
      instanceAlias: database.instanceAlias.trim(),
      schemaName: database.schemaName.trim(),
      instanceId: database.instanceId.trim(),
      instanceHost: database.instanceHost.trim(),
      instancePort: database.instancePort.trim(),
      databaseId: database.databaseId.trim(),
    })),
  }),
  sls: (draft) => ({ region: draft.region.trim(), project: draft.project.trim(), logstores: [...draft.logstores], ...(draft.targets ? { targets: draft.targets.map(target => ({ ...target, logstores: [...target.logstores] })) } : {}) }),
};

export function serializeCapabilityDraft(draft: DeploymentCapabilityDraft): CapabilityConfigurationInput {
  const selected = new Set(draft.capabilities);
  const serialized: Record<string, unknown> = {};
  for (const key of CAPABILITY_KEYS) {
    const section = draft[key];
    if (!selected.has(key) || !section) continue;
    serialized[key] = (serializers[key] as (value: typeof section) => unknown)(section);
  }
  return serialized as CapabilityConfigurationInput;
}
