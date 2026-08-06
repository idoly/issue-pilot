export const CAPABILITY_KEYS = ["playwright", "nacos", "db", "redis", "mq", "es", "sls"] as const;

export type CapabilityName = typeof CAPABILITY_KEYS[number];

export function configuredCapabilities(config: Record<string, unknown>): CapabilityName[] {
  return CAPABILITY_KEYS.filter((key) => {
    const value = config[key];
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  });
}
