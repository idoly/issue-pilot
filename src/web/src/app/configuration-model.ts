import { CAPABILITY_KEYS, type CapabilityName, type DmsScope } from "../../../domain/contracts";
import type { CapabilityConfigurationInput, ProjectedCapabilityConfiguration, ProjectedCapabilitySection } from "../../../configuration/contracts";

export type DeploymentCapabilityDraft = ProjectedCapabilityConfiguration & {
  capabilities: CapabilityName[];
};

/** Trim every DMS identity field once for both the editor preview and the save payload. */
export function normalizeDmsScope(draft: Pick<DmsScope, "databases">): DmsScope {
  return {
    databases: draft.databases.map((database) => ({
      instanceAlias: database.instanceAlias.trim(),
      schemaName: database.schemaName.trim(),
      instanceId: database.instanceId.trim(),
      instanceHost: database.instanceHost.trim(),
      instancePort: database.instancePort.trim(),
      databaseId: database.databaseId.trim(),
    })),
  };
}

type CapabilitySerializer<Key extends CapabilityName> = (draft: ProjectedCapabilitySection<Key>) => NonNullable<CapabilityConfigurationInput[Key]>;

const serializers: { [Key in CapabilityName]: CapabilitySerializer<Key> } = {
  dms: (draft) => normalizeDmsScope(draft),
  sls: (draft) => ({
    region: draft.region.trim(),
    project: draft.project.trim(),
    logstores: [...draft.logstores],
    ...(draft.targets ? { targets: draft.targets.map((target) => ({ ...target, logstores: [...target.logstores] })) } : {}),
  }),
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
