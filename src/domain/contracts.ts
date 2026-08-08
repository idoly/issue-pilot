export const CAPABILITY_KEYS = ["playwright", "nacos", "db", "redis", "mq", "es", "sls"] as const;
export type CapabilityName = typeof CAPABILITY_KEYS[number];

export const AGENT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type AgentThinkingLevel = typeof AGENT_THINKING_LEVELS[number];

export interface AgentConfiguration {
  provider: string;
  model: string;
  thinkingLevel: AgentThinkingLevel;
}

export interface DeploymentConfig extends Record<string, unknown> {
  agent?: AgentConfiguration;
  nacos?: { serverUrl: string; namespace: string; group: string; dataIds: string[]; username: string; password?: string };
  db?: { url: string; username: string; password: string };
  sls?: { accessKeyId: string; accessKeySecret: string; region: string; project: string; logstores: string[] };
  playwright?: { baseUrl: string; username: string; password?: string };
  redis?: { host: string; port: number; username: string; password?: string; database: number };
  mq?: { host: string; port: number; managementPort: number; username: string; password: string; virtualHost: string };
  es?: { url: string; username: string; password?: string };
}

export function configuredCapabilities(config: Record<string, unknown>): CapabilityName[] {
  return CAPABILITY_KEYS.filter((key) => {
    const value = config[key];
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  });
}

export const ENVIRONMENT_KINDS = ["prod", "test", "dev"] as const;
export type EnvironmentKind = typeof ENVIRONMENT_KINDS[number];

export const ISSUE_TYPES = ["data_processing", "smart_analysis", "defect_fix", "feature_development"] as const;
export type IssueType = typeof ISSUE_TYPES[number];

export const ISSUE_TYPES_BY_ENVIRONMENT: Record<EnvironmentKind, readonly IssueType[]> = {
  prod: ["data_processing", "smart_analysis"],
  test: ["smart_analysis"],
  dev: ["defect_fix", "feature_development"],
};

export const ISSUE_STATUSES = ["open", "in_progress", "pending", "resolved"] as const;
export type IssueStatus = typeof ISSUE_STATUSES[number];
