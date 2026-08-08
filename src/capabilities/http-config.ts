import { CAPABILITY_KEYS, type CapabilityName } from "../domain/contracts.ts";
import { MAX_NACOS_DATA_IDS } from "./limits.ts";
import { ApiError, optionalText, record, strings, text } from "../http/input.ts";

const selected = (value: unknown, required: boolean) => required ? record(value) : undefined;
const optional = (value: unknown, maximum = 10_000) => optionalText(value, maximum) ?? "";
const NACOS_TARGET = /^[a-zA-Z0-9._-]{1,255}$/;
const SLS_REGION = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SLS_PROJECT = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const SLS_LOGSTORE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,61}[a-zA-Z0-9]$/;

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new ApiError(400, `invalid_${name}`);
  return parsed;
}

function configuredUrl(value: unknown, name: string, protocols: string[], options: { rootOnly?: boolean } = {}): string {
  const configured = text(value, name, 4096);
  let parsed: URL;
  try { parsed = new URL(configured); } catch { throw new ApiError(400, `invalid_${name}`); }
  if (!protocols.includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || (options.rootOnly && parsed.pathname !== "/")) throw new ApiError(400, `invalid_${name}`);
  return configured;
}

export function parseCapabilities(value: unknown): CapabilityName[] {
  const entries = strings(value, "capabilities");
  if (new Set(entries).size !== entries.length || entries.some((entry) => !CAPABILITY_KEYS.includes(entry as CapabilityName))) throw new ApiError(400, "invalid_capabilities");
  return CAPABILITY_KEYS.filter((key) => entries.includes(key));
}

export function nacosConfiguration(value: unknown, required: boolean) {
  const input = selected(value, required);
  if (!input) return undefined;
  const password = optional(input.password);
  const username = optional(input.username, 500);
  if (Boolean(username) !== Boolean(password)) throw new ApiError(400, "invalid_nacos_credentials");
  const dataIds = [...new Set(strings(input.dataIds, "nacos_data_ids").map((value) => text(value, "nacos_data_id", 255)))];
  if (!dataIds.length || dataIds.length > MAX_NACOS_DATA_IDS || dataIds.some((dataId) => !NACOS_TARGET.test(dataId))) throw new ApiError(400, "invalid_nacos_data_ids");
  const group = text(input.group, "nacos_group", 255);
  if (!NACOS_TARGET.test(group)) throw new ApiError(400, "invalid_nacos_group");
  return {
    serverUrl: configuredUrl(input.serverUrl, "nacos_server_url", ["http:", "https:"], { rootOnly: true }),
    namespace: optional(input.namespace, 255),
    group,
    dataIds,
    username,
    ...(password ? { password } : {}),
  };
}

export function dbConfiguration(value: unknown, required: boolean) {
  const input = selected(value, required);
  if (!input) return undefined;
  const url = configuredUrl(input.url, "db_url", ["mysql:"]);
  if (new URL(url).pathname === "/") throw new ApiError(400, "invalid_db_url");
  return { url, username: text(input.username, "db_username", 500), password: text(input.password, "db_password") };
}

export function slsConfiguration(value: unknown, required: boolean) {
  const input = selected(value, required);
  if (!input) return undefined;
  const region = text(input.region, "sls_region", 63);
  const project = text(input.project, "sls_project", 63);
  const logstores = [...new Set(strings(input.logstores, "sls_logstores").map((value) => text(value, "sls_logstore", 63)))];
  if (!SLS_REGION.test(region) || !SLS_PROJECT.test(project) || !logstores.length || logstores.some((logstore) => !SLS_LOGSTORE.test(logstore))) throw new ApiError(400, "invalid_sls_scope");
  return {
    accessKeyId: text(input.accessKeyId, "sls_access_key_id", 500),
    accessKeySecret: text(input.accessKeySecret, "sls_access_key_secret"),
    region,
    project,
    logstores,
  };
}

export function redisConfiguration(value: unknown, required: boolean) {
  const input = selected(value, required);
  if (!input) return undefined;
  const password = optional(input.password);
  return {
    host: text(input.host, "redis_host", 255),
    port: integer(input.port ?? 6379, "redis_port", 1, 65_535),
    username: optional(input.username, 500),
    ...(password ? { password } : {}),
    database: integer(input.database ?? 0, "redis_database", 0, 1_000_000),
  };
}

export function esConfiguration(value: unknown, required: boolean) {
  const input = selected(value, required);
  if (!input) return undefined;
  const password = optional(input.password);
  const username = optional(input.username, 500);
  if (Boolean(username) !== Boolean(password)) throw new ApiError(400, "invalid_es_credentials");
  return { url: configuredUrl(input.url, "es_url", ["http:", "https:"]), username, ...(password ? { password } : {}) };
}

export function mqConfiguration(value: unknown, required: boolean) {
  const input = selected(value, required);
  if (!input) return undefined;
  return {
    host: text(input.host, "mq_host", 255),
    port: integer(input.port ?? 5672, "mq_port", 1, 65_535),
    managementPort: integer(input.managementPort ?? 15672, "mq_management_port", 1, 65_535),
    username: text(input.username, "mq_username", 500),
    password: text(input.password, "mq_password"),
    virtualHost: text(input.virtualHost, "mq_virtual_host", 255),
  };
}

export function browserConfiguration(value: unknown, required: boolean) {
  const input = selected(value, required);
  if (!input) return undefined;
  const username = optional(input.username, 500);
  const password = optional(input.password);
  if (Boolean(username) !== Boolean(password)) throw new ApiError(400, "invalid_browser_credentials");
  return { baseUrl: configuredUrl(input.baseUrl, "browser_base_url", ["http:", "https:"]), username, ...(password ? { password } : {}) };
}
