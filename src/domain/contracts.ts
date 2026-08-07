export const CAPABILITY_KEYS = ["playwright", "nacos", "db", "redis", "mq", "es", "sls"] as const;
export type CapabilityName = typeof CAPABILITY_KEYS[number];

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
