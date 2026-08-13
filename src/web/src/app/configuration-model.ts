import { CAPABILITY_KEYS, type AgentConfiguration, type CapabilityConfiguration, type CapabilityName } from "../../../domain/contracts";

export interface DeploymentCapabilityDraft extends CapabilityConfiguration {
  capabilities: CapabilityName[];
  agent: AgentConfiguration;
}

type CapabilitySerializer = (draft: DeploymentCapabilityDraft) => Partial<CapabilityConfiguration>;

const serializers: Record<CapabilityName, CapabilitySerializer> = {
  playwright: (draft) => draft.playwright ? { playwright: { baseUrl: draft.playwright.baseUrl.trim(), username: draft.playwright.username.trim(), password: draft.playwright.password } } : {},
  nacos: (draft) => draft.nacos ? { nacos: { serverUrl: draft.nacos.serverUrl.trim(), namespace: draft.nacos.namespace.trim(), group: draft.nacos.group.trim(), dataIds: [...draft.nacos.dataIds], username: draft.nacos.username.trim(), password: draft.nacos.password } } : {},
  db: (draft) => draft.db ? { db: { url: draft.db.url.trim(), username: draft.db.username.trim(), password: draft.db.password } } : {},
  redis: (draft) => draft.redis ? { redis: { host: draft.redis.host.trim(), port: draft.redis.port, username: draft.redis.username.trim(), password: draft.redis.password, database: draft.redis.database } } : {},
  mq: (draft) => draft.mq ? { mq: { host: draft.mq.host.trim(), port: draft.mq.port, managementPort: draft.mq.managementPort, username: draft.mq.username.trim(), password: draft.mq.password, virtualHost: draft.mq.virtualHost.trim() } } : {},
  es: (draft) => draft.es ? { es: { url: draft.es.url.trim(), username: draft.es.username.trim(), password: draft.es.password } } : {},
  dms: (draft) => draft.dms ? { dms: { accessKeyId: draft.dms.accessKeyId.trim(), accessKeySecret: draft.dms.accessKeySecret, dbId: draft.dms.dbId.trim(), logic: draft.dms.logic, ...(draft.dms.tid?.trim() ? { tid: draft.dms.tid.trim() } : {}) } } : {},
  sls: (draft) => draft.sls ? { sls: { accessKeyId: draft.sls.accessKeyId.trim(), accessKeySecret: draft.sls.accessKeySecret, region: draft.sls.region.trim(), project: draft.sls.project.trim(), logstores: [...draft.sls.logstores] } } : {},
};

export function serializeCapabilityDraft(draft: DeploymentCapabilityDraft): CapabilityConfiguration {
  const selected = new Set(draft.capabilities);
  return Object.assign({}, ...CAPABILITY_KEYS.filter((key) => selected.has(key)).map((key) => serializers[key](draft)));
}
