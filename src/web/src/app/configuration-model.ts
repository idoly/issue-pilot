import { CAPABILITY_KEYS, type CapabilityName } from "../../../domain/contracts";
import { CAPABILITY_CREDENTIALS, type CapabilityConfigurationInput, type CapabilityCredentialUpdate, type CapabilityCredentialValues, type ProjectedCapabilitySection } from "../../../configuration/contracts";

type CapabilityCredentialDraft<Key extends CapabilityName> = ProjectedCapabilitySection<Key> & CapabilityCredentialValues<Key> & { credentialEnabled: boolean };
type CapabilityDraftConfiguration = { [Key in CapabilityName]?: CapabilityCredentialDraft<Key> };

export type DeploymentCapabilityDraft = CapabilityDraftConfiguration & {
  capabilities: CapabilityName[];
};

type CapabilitySerializer<Key extends CapabilityName> = (draft: CapabilityCredentialDraft<Key>) => NonNullable<CapabilityConfigurationInput[Key]>;

function credentialUpdate<Key extends CapabilityName>(key: Key, draft: CapabilityCredentialDraft<Key>): CapabilityCredentialUpdate<Key> {
  if (!draft.credentialEnabled) return { mode: "clear" };
  const fields = CAPABILITY_CREDENTIALS[key].fields as readonly string[];
  const values = Object.fromEntries(fields.map((field) => [field, (draft as Record<string, unknown>)[field]])) as CapabilityCredentialValues<Key>;
  if (fields.some((field) => typeof (values as Record<string, unknown>)[field] === "string" && (values as Record<string, string>)[field].length > 0) || !draft.credentialConfigured) return { mode: "replace", values };
  return { mode: "preserve" };
}

const serializers: { [Key in CapabilityName]: CapabilitySerializer<Key> } = {
  nacos: (draft) => ({ serverUrl: draft.serverUrl.trim(), namespace: draft.namespace.trim(), group: draft.group.trim(), dataIds: [...draft.dataIds], username: draft.credentialEnabled ? draft.username.trim() : "", credentialUpdate: credentialUpdate("nacos", draft) }),
  db: (draft) => ({ url: draft.url.trim(), username: draft.username.trim(), credentialUpdate: credentialUpdate("db", draft) }),
  redis: (draft) => ({ host: draft.host.trim(), port: draft.port, username: draft.username.trim(), database: draft.database, credentialUpdate: credentialUpdate("redis", draft) }),
  mq: (draft) => ({ host: draft.host.trim(), port: draft.port, managementPort: draft.managementPort, username: draft.username.trim(), virtualHost: draft.virtualHost.trim(), credentialUpdate: credentialUpdate("mq", draft) }),
  es: (draft) => ({ url: draft.url.trim(), username: draft.credentialEnabled ? draft.username.trim() : "", credentialUpdate: credentialUpdate("es", draft) }),
  dms: (draft) => ({ url: draft.url.trim(), instanceId: draft.instanceId?.trim() ?? "", instanceHost: draft.instanceHost?.trim() ?? "", instancePort: draft.instancePort?.trim() ?? "", instanceLabel: draft.instanceLabel?.trim() ?? "", databaseId: draft.databaseId?.trim() ?? "", databaseLabel: draft.databaseLabel?.trim() ?? "", credentialUpdate: credentialUpdate("dms", draft) }),
  sls: (draft) => ({ region: draft.region.trim(), project: draft.project.trim(), logstores: [...draft.logstores], credentialUpdate: credentialUpdate("sls", draft) }),
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
