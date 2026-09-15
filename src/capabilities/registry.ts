import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static, type TSchema } from "typebox";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { CAPABILITY_KEYS, type CapabilityConfiguration, type CapabilityName } from "../domain/contracts.ts";

const defaults = issuePilotConfig.defaults;
const limits = issuePilotConfig.limits.capability;
const NACOS_TARGET = /^[a-zA-Z0-9._-]{1,255}$/;
const SLS_REGION = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SLS_PROJECT = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const SLS_LOGSTORE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,61}[a-zA-Z0-9]$/;

interface ToolMetadata {
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
}

export type CapabilityConfig<Key extends CapabilityName> = NonNullable<CapabilityConfiguration[Key]>;

type CapabilityDefinition<Key extends CapabilityName> = {
  key: Key;
  inputSchema: TSchema;
  metadata: ToolMetadata;
  parseConfiguration(value: unknown): CapabilityConfig<Key>;
};

export class CapabilityConfigurationError extends Error {}

function fail(code: string): never {
  throw new CapabilityConfigurationError(code);
}

function inputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_request");
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, name: string, maximum = 10_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) fail(`invalid_${name}`);
  return value.trim();
}

function optionalText(value: unknown, maximum = 10_000): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value !== "string" || value.length > maximum) fail("invalid_text");
  return value.trim();
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) fail(`invalid_${name}`);
  return value as string[];
}

function optionalCredentials(input: Record<string, unknown>, name: string) {
  const username = optionalText(input.username, 500);
  const password = optionalText(input.password);
  if (Boolean(username) !== Boolean(password)) fail(`invalid_${name}_credentials`);
  return { username, ...(password ? { password } : {}) };
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) fail(`invalid_${name}`);
  return parsed;
}

function connectionUrl(value: unknown, name: string, protocols: string[], options: { rootOnly?: boolean } = {}): string {
  const configuredUrl = requiredText(value, name, 4096);
  let url: URL;
  try { url = new URL(configuredUrl); } catch { return fail(`invalid_${name}`); }
  if (!protocols.includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || (options.rootOnly && url.pathname !== "/")) fail(`invalid_${name}`);
  return configuredUrl;
}

export function parseDmsConnectionConfiguration(value: unknown): Pick<CapabilityConfig<"dms">, "url" | "authorization"> {
  const input = inputRecord(value);
  const authorization = requiredText(input.authorization, "dms_authorization");
  if (!/^Bearer [^\s]+$/.test(authorization)) fail("invalid_dms_authorization");
  return { url: connectionUrl(input.url, "dms_url", ["https:"]), authorization };
}

const slsQueryProperties = {
  from: Type.Optional(Type.Integer({ minimum: 0 })),
  to: Type.Optional(Type.Integer({ minimum: 1 })),
  query: Type.Optional(Type.String({ maxLength: limits.sls.queryChars })),
  trace_id: Type.Optional(Type.String({ maxLength: limits.sls.traceIdChars })),
};

const capabilityInputSchemas = {
  nacos: Type.Object({}, { additionalProperties: false }),
  db: Type.Object({ statement: Type.String({ maxLength: limits.database.queryChars }) }, { additionalProperties: false }),
  redis: Type.Object({
    action: StringEnum(["get", "mget", "hget", "hgetall", "type", "ttl", "scan"] as const),
    key: Type.Optional(Type.String({ maxLength: limits.redis.keyChars })),
    keys: Type.Optional(Type.Array(Type.String({ maxLength: limits.redis.keyChars }), { maxItems: limits.redis.keys })),
    field: Type.Optional(Type.String({ maxLength: limits.redis.keyChars })),
    pattern: Type.Optional(Type.String({ maxLength: limits.redis.keyChars })),
    cursor: Type.Optional(Type.String({ maxLength: limits.redis.cursorChars })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: limits.redis.results })),
  }, { additionalProperties: false }),
  mq: Type.Object({
    action: StringEnum(["overview", "queues", "queue", "bindings"] as const),
    queue: Type.Optional(Type.String({ maxLength: limits.rabbitmq.queueChars })),
  }, { additionalProperties: false }),
  es: Type.Object({
    action: StringEnum(["search", "count", "mapping"] as const),
    query: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: limits.elasticsearch.results })),
  }, { additionalProperties: false }),
  dms: Type.Object({
    schema: Type.String({ minLength: 1, maxLength: 255, description: "Exact configured schema for the selected deployment." }),
    script: Type.String({ minLength: 1, description: "One read-only SELECT, SHOW, DESCRIBE, or EXPLAIN statement." }),
    logic: Type.Optional(Type.Boolean({ description: "Whether DMS should execute the statement as a logical database query." })),
  }, { additionalProperties: false }),
  sls: Type.Object({
    logstore: Type.String({ maxLength: 63, pattern: SLS_LOGSTORE.source }),
    ...slsQueryProperties,
  }, { additionalProperties: false }),
} as const;

export type CapabilityInputs = {
  [Key in keyof typeof capabilityInputSchemas]: Static<(typeof capabilityInputSchemas)[Key]>;
};

const definitions = {
  nacos: {
    key: "nacos",
    inputSchema: capabilityInputSchemas.nacos,
    metadata: {
      label: "Read Service Configuration",
      description: "Return the raw configuration for the deployment's authorized Nacos data IDs.",
      promptSnippet: "Read every exact Nacos Data ID authorized for this deployment",
      promptGuidelines: ["Use nacos only for the deployment configuration scope supplied by Issue Pilot."],
    },
    parseConfiguration(value) {
      const input = inputRecord(value);
      const credentials = optionalCredentials(input, "nacos");
      const dataIds = [...new Set(stringList(input.dataIds, "nacos_data_ids").map((entry) => requiredText(entry, "nacos_data_id", 255)))];
      if (!dataIds.length || dataIds.length > limits.nacos.dataIds || dataIds.some((entry) => !NACOS_TARGET.test(entry))) fail("invalid_nacos_data_ids");
      const group = requiredText(input.group, "nacos_group", 255);
      if (!NACOS_TARGET.test(group)) fail("invalid_nacos_group");
      return { serverUrl: connectionUrl(input.serverUrl, "nacos_server_url", ["http:", "https:"], { rootOnly: true }), namespace: optionalText(input.namespace, 255), group, dataIds, ...credentials };
    },
  },
  db: {
    key: "db",
    inputSchema: capabilityInputSchemas.db,
    metadata: {
      label: "Query Database",
      description: "Run one read-only SQL statement against the selected deployment database.",
      promptSnippet: "Run one bounded read-only MySQL statement",
      promptGuidelines: ["Use db only for read-only SQL evidence and request the complete bounded result."],
    },
    parseConfiguration(value) {
      const input = inputRecord(value);
      const url = connectionUrl(input.url, "db_url", ["mysql:"]);
      const parsed = new URL(url);
      let database = "";
      try { database = decodeURIComponent(parsed.pathname.slice(1)); } catch { return fail("invalid_db_url"); }
      if (!parsed.port || Number(parsed.port) < 1 || !/^\/[^/]+$/.test(parsed.pathname) || !database || database.includes("/")) fail("invalid_db_url");
      return { url, username: requiredText(input.username, "db_username", 500), password: requiredText(input.password, "db_password") };
    },
  },
  redis: {
    key: "redis",
    inputSchema: capabilityInputSchemas.redis,
    metadata: {
      label: "Read Redis",
      description: "Run one read-only Redis operation.",
      promptSnippet: "Run an allowlisted read-only Redis operation",
      promptGuidelines: ["Use redis only for the allowlisted read operations; arbitrary Redis commands are unavailable."],
    },
    parseConfiguration(value) {
      const input = inputRecord(value);
      const password = optionalText(input.password);
      return { host: requiredText(input.host, "redis_host", 255), port: boundedInteger(input.port ?? defaults.redis.port, "redis_port", 1, 65_535), username: optionalText(input.username, 500), ...(password ? { password } : {}), database: boundedInteger(input.database ?? defaults.redis.database, "redis_database", 0, 1_000_000) };
    },
  },
  mq: {
    key: "mq",
    inputSchema: capabilityInputSchemas.mq,
    metadata: {
      label: "Read RabbitMQ",
      description: "Read RabbitMQ management metadata without consuming messages.",
      promptSnippet: "Read RabbitMQ management metadata without consuming messages",
      promptGuidelines: ["Use mq only for management metadata; message consumption is unavailable."],
    },
    parseConfiguration(value) {
      const input = inputRecord(value);
      return { host: requiredText(input.host, "mq_host", 255), port: boundedInteger(input.port ?? defaults.rabbitmq.port, "mq_port", 1, 65_535), managementPort: boundedInteger(input.managementPort ?? defaults.rabbitmq.managementPort, "mq_management_port", 1, 65_535), username: requiredText(input.username, "mq_username", 500), password: requiredText(input.password, "mq_password"), virtualHost: requiredText(input.virtualHost ?? defaults.rabbitmq.virtualHost, "mq_virtual_host", 255) };
    },
  },
  es: {
    key: "es",
    inputSchema: capabilityInputSchemas.es,
    metadata: {
      label: "Read Elasticsearch",
      description: "Run a search, count, or mapping request against the selected deployment.",
      promptSnippet: "Read Elasticsearch search, count, or mapping evidence",
      promptGuidelines: ["Use es only for search, count, or mapping reads against the selected deployment."],
    },
    parseConfiguration(value) {
      const input = inputRecord(value);
      return { url: connectionUrl(input.url, "es_url", ["http:", "https:"]), ...optionalCredentials(input, "es") };
    },
  },
  dms: {
    key: "dms",
    inputSchema: capabilityInputSchemas.dms,
    metadata: {
      label: "Query DMS Database",
      description: "Run one read-only SQL statement against a schema authorized by the deployment through Alibaba Cloud DMS MCP executeScript.",
      promptSnippet: "Run read-only SQL against one configured DMS schema through executeScript",
      promptGuidelines: ["Select one configured schema and submit one SELECT, SHOW, DESCRIBE, or EXPLAIN statement. Database IDs and write operations are unavailable."],
    },
    parseConfiguration(value) {
      const input = inputRecord(value);
      const { url, authorization } = parseDmsConnectionConfiguration(input);
      if (!Array.isArray(input.databases) || !input.databases.length || input.databases.length > limits.dms.databases) fail("invalid_dms_databases");
      const databases = input.databases.map((value) => {
        const database = inputRecord(value);
        const instanceAlias = requiredText(database.instanceAlias, "dms_instance_alias", 255);
        const schemaName = requiredText(database.schemaName, "dms_schema_name", 255);
        const instanceId = requiredText(database.instanceId, "dms_instance_id", 100);
        const instanceHost = requiredText(database.instanceHost, "dms_instance_host", 255);
        const instancePort = requiredText(database.instancePort, "dms_instance_port", 10);
        const databaseId = requiredText(database.databaseId, "dms_database_id", 100);
        if (!/^\d{1,5}$/.test(instancePort) || Number(instancePort) < 1 || Number(instancePort) > 65_535) fail("invalid_dms_database");
        return { instanceAlias, schemaName, instanceId, instanceHost, instancePort, databaseId };
      });
      if (new Set(databases.map(({ schemaName }) => schemaName)).size !== databases.length) fail("duplicate_dms_database_schema");
      if (new Set(databases.map(({ databaseId }) => databaseId)).size !== databases.length) fail("duplicate_dms_database_id");
      return { url, authorization, databases };
    },
  },
  sls: {
    key: "sls",
    inputSchema: capabilityInputSchemas.sls,
    metadata: {
      label: "Read SLS Logs",
      description: "Query the selected deployment's Simple Log Service.",
      promptSnippet: "Query an authorized SLS logstore with bounded inputs",
      promptGuidelines: ["Use sls only for logstores authorized by the Issue Pilot deployment policy."],
    },
    parseConfiguration(value) {
      const input = inputRecord(value);
      const region = requiredText(input.region, "sls_region", 63);
      const project = requiredText(input.project, "sls_project", 63);
      const logstores = [...new Set(stringList(input.logstores, "sls_logstores").map((entry) => requiredText(entry, "sls_logstore", 63)))];
      if (!SLS_REGION.test(region) || !SLS_PROJECT.test(project) || !logstores.length || logstores.some((entry) => !SLS_LOGSTORE.test(entry))) fail("invalid_sls_scope");
      return { accessKeyId: requiredText(input.accessKeyId, "sls_access_key_id", 500), accessKeySecret: requiredText(input.accessKeySecret, "sls_access_key_secret"), region, project, logstores };
    },
  },
} satisfies { [Key in CapabilityName]: CapabilityDefinition<Key> };

export const capabilityDefinitions: { [Key in CapabilityName]: CapabilityDefinition<Key> } = definitions;

export function capabilityToolInputSchema<Key extends CapabilityName>(key: Key, configuration: CapabilityConfig<Key>): TSchema {
  if (key === "sls") {
    const logstores = (configuration as CapabilityConfig<"sls">).logstores;
    return Type.Object({
      logstore: StringEnum(logstores, { description: "Exact logstore configured for the selected deployment." }),
      ...slsQueryProperties,
    }, { additionalProperties: false });
  }
  if (key === "dms") {
    const schemas = (configuration as CapabilityConfig<"dms">).databases.map(({ schemaName }) => schemaName);
    return Type.Object({
      schema: StringEnum(schemas, { description: "Exact schema configured for the selected deployment." }),
      script: Type.String({ minLength: 1, description: "One read-only SELECT, SHOW, DESCRIBE, or EXPLAIN statement." }),
      logic: Type.Optional(Type.Boolean({ description: "Whether DMS should execute the statement as a logical database query." })),
    }, { additionalProperties: false });
  }
  return capabilityDefinitions[key].inputSchema;
}

export function parseCapabilityConfiguration<Key extends CapabilityName>(key: Key, value: unknown): CapabilityConfig<Key> {
  return capabilityDefinitions[key].parseConfiguration(value);
}

export function storedCapabilitySections(input: CapabilityConfiguration): CapabilityConfiguration {
  return Object.fromEntries(CAPABILITY_KEYS.flatMap((key) => input[key] ? [[key, input[key]]] : [])) as CapabilityConfiguration;
}
