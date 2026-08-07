import { CAPABILITY_KEYS, type CapabilityName } from "../domain/contracts.ts";
import { optionalText, record, strings, text } from "../http/input.ts";

const selected = (value: unknown, required: boolean) => required ? record(value) : undefined;
const optional = (value: unknown, maximum = 10_000) => optionalText(value, maximum) ?? "";

export function parseCapabilities(value: unknown): CapabilityName[] {
  const values = new Set(strings(value, "capabilities"));
  return CAPABILITY_KEYS.filter((key) => values.has(key));
}

export function nacosConfiguration(value: unknown, required: boolean) {
  const input = selected(value, required);
  if (!input) return undefined;
  const password = optional(input.password);
  return {
    serverUrl: text(input.serverUrl, "nacos_server_url", 2048),
    namespace: optional(input.namespace, 255),
    group: text(input.group, "nacos_group", 255),
    username: optional(input.username, 500),
    ...(password ? { password } : {}),
  };
}

export function dbConfiguration(value: unknown, required: boolean) {
  const input = selected(value, required);
  if (!input) return undefined;
  return {
    url: text(input.url, "db_url", 4096).replace(/^jdbc:(?=mysql:|mariadb:)/i, ""),
    username: text(input.username, "db_username", 500),
    password: text(input.password, "db_password"),
  };
}

export function slsConfiguration(value: unknown, required: boolean) {
  const input = selected(value, required);
  if (!input) return undefined;
  return {
    accessKeyId: text(input.accessKeyId, "sls_access_key_id", 500),
    accessKeySecret: text(input.accessKeySecret, "sls_access_key_secret"),
    region: text(input.region, "sls_region", 63),
    project: text(input.project, "sls_project", 63),
    logstores: [...new Set(strings(input.logstores, "sls_logstores"))],
  };
}

export function redisConfiguration(value: unknown, required: boolean) {
  const input = selected(value, required);
  if (!input) return undefined;
  const password = optional(input.password);
  return {
    host: text(input.host, "redis_host", 255),
    port: Number(input.port ?? 6379),
    username: optional(input.username, 500),
    ...(password ? { password } : {}),
    database: Number(input.database ?? 0),
  };
}

export function esConfiguration(value: unknown, required: boolean) {
  const input = selected(value, required);
  if (!input) return undefined;
  const password = optional(input.password);
  return { url: text(input.url, "es_url", 2048), username: optional(input.username, 500), ...(password ? { password } : {}) };
}

export function mqConfiguration(value: unknown, required: boolean) {
  const input = selected(value, required);
  if (!input) return undefined;
  return {
    host: text(input.host, "mq_host", 255),
    port: Number(input.port ?? 5672),
    managementPort: Number(input.managementPort ?? 15672),
    username: text(input.username, "mq_username", 500),
    password: text(input.password, "mq_password"),
    virtualHost: text(input.virtualHost, "mq_virtual_host", 255),
  };
}

export function browserConfiguration(value: unknown, required: boolean) {
  const input = selected(value, required);
  if (!input) return undefined;
  return { baseUrl: text(input.baseUrl, "browser_base_url", 2048), username: optional(input.username, 500), password: optional(input.password) };
}

export function publicCapabilityConfiguration(config: Record<string, unknown>, key: "nacos" | "db" | "sls") {
  const value = config[key];
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (key === "nacos") return { serverUrl: item.serverUrl, namespace: item.namespace, group: item.group, username: item.username, password: item.password };
  if (key === "db") return { url: item.url, username: item.username, password: item.password };
  return { accessKeyId: item.accessKeyId, accessKeySecret: item.accessKeySecret, region: item.region, project: item.project, logstores: item.logstores };
}

export function publicStoredConfiguration(config: Record<string, unknown>, key: "redis" | "es" | "mq"): Record<string, unknown> | null {
  const value = config[key];
  return value && typeof value === "object" ? { ...(value as Record<string, unknown>) } : null;
}

export function publicBrowserConfiguration(config: Record<string, unknown>) {
  const value = config.playwright;
  if (!value || typeof value !== "object") return null;
  const browser = value as Record<string, unknown>;
  return { baseUrl: browser.baseUrl, username: browser.username, password: browser.password };
}
