import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static, type TSchema } from "typebox";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { CapabilityConfiguration, CapabilityName } from "../domain/contracts.ts";

const defaults = issuePilotConfig.defaults;
const limits = issuePilotConfig.limits.capability;
const NACOS_TARGET = /^[a-zA-Z0-9._-]{1,255}$/;
const SLS_REGION = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SLS_PROJECT = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const SLS_LOGSTORE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,61}[a-zA-Z0-9]$/;

export type CapabilityConfig<Key extends CapabilityName> = NonNullable<CapabilityConfiguration[Key]>;

type CapabilityDefinition<Key extends CapabilityName> = {
  key: Key;
  inputSchema: TSchema;
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

export function parseSlsConnectionConfiguration(value: unknown): Pick<CapabilityConfig<"sls">, "accessKeyId" | "accessKeySecret"> {
  const input = inputRecord(value);
  return { accessKeyId: requiredText(input.accessKeyId, "sls_access_key_id", 500), accessKeySecret: requiredText(input.accessKeySecret, "sls_access_key_secret") };
}

const slsQueryProperties = {
  from: Type.Optional(Type.Integer({ minimum: 0 })),
  to: Type.Optional(Type.Integer({ minimum: 1 })),
  query: Type.Optional(Type.String({ maxLength: limits.sls.queryChars, description: "Log filter or SQL analysis. SQL uses its LIMIT/ORDER BY for pagination; incomplete results fail explicitly." })),
  trace_id: Type.Optional(Type.String({ maxLength: limits.sls.traceIdChars })),
};

const databaseOutputSchema = Type.Object({
  fileName: Type.String({ minLength: 1, maxLength: 255, description: "Durable Issue output file name." }),
  format: StringEnum(["csv", "jsonl"] as const),
}, { additionalProperties: false });

const dmsOutputSchema = Type.Object({ fileName: Type.String({ minLength: 1, maxLength: 255, description: "Save the complete MCP result as this Issue's JSON output instead of returning query rows to the conversation." }) }, { additionalProperties: false });

const capabilityInputSchemas = {
  nacos: Type.Object({}, { additionalProperties: false }),
  db: Type.Object({
    database: Type.String({ minLength: 1, maxLength: 255, description: "Exact database configured for the selected deployment." }),
    statement: Type.String({ maxLength: limits.database.queryChars }),
    output: Type.Optional(databaseOutputSchema),
  }, { additionalProperties: false }),
  redis: Type.Object({
    action: StringEnum(["get", "mget", "hget", "hgetall", "type", "ttl", "scan"] as const),
    key: Type.Optional(Type.String({ maxLength: limits.redis.keyChars })),
    keys: Type.Optional(Type.Array(Type.String({ maxLength: limits.redis.keyChars }), { maxItems: limits.redis.keys })),
    field: Type.Optional(Type.String({ maxLength: limits.redis.keyChars })),
    pattern: Type.Optional(Type.String({ maxLength: limits.redis.keyChars })),
    cursor: Type.Optional(Type.String({ maxLength: limits.redis.cursorChars, pattern: "^[0-9]+$" })),
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
    output: Type.Optional(dmsOutputSchema),
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
    parseConfiguration(value) {
      const input = inputRecord(value);
      if (!Array.isArray(input.databases) || !input.databases.length || input.databases.length > limits.database.databases) fail("invalid_db_databases");
      const databases = input.databases.map((value) => {
        const databaseInput = inputRecord(value);
        const url = connectionUrl(databaseInput.url, "db_url", ["mysql:"]);
        const parsed = new URL(url);
        let database = "";
        try { database = decodeURIComponent(parsed.pathname.slice(1)); } catch { return fail("invalid_db_url"); }
        if (!parsed.port || Number(parsed.port) < 1 || !/^\/[^/]+$/.test(parsed.pathname) || !database || database.includes("/")) fail("invalid_db_url");
        return { url, database, username: requiredText(databaseInput.username, "db_username", 500), password: requiredText(databaseInput.password, "db_password") };
      });
      if (new Set(databases.map(({ url }) => url)).size !== databases.length) fail("duplicate_db_url");
      if (new Set(databases.map(({ database }) => database)).size !== databases.length) fail("duplicate_db_database");
      return { databases: databases.map(({ url, username, password }) => ({ url, username, password })) };
    },
  },
  redis: {
    key: "redis",
    inputSchema: capabilityInputSchemas.redis,
    parseConfiguration(value) {
      const input = inputRecord(value);
      const password = optionalText(input.password);
      return { host: requiredText(input.host, "redis_host", 255), port: boundedInteger(input.port ?? defaults.redis.port, "redis_port", 1, 65_535), username: optionalText(input.username, 500), ...(password ? { password } : {}), database: boundedInteger(input.database ?? defaults.redis.database, "redis_database", 0, 1_000_000) };
    },
  },
  mq: {
    key: "mq",
    inputSchema: capabilityInputSchemas.mq,
    parseConfiguration(value) {
      const input = inputRecord(value);
      return { host: requiredText(input.host, "mq_host", 255), managementPort: boundedInteger(input.managementPort ?? defaults.rabbitmq.managementPort, "mq_management_port", 1, 65_535), username: requiredText(input.username, "mq_username", 500), password: requiredText(input.password, "mq_password"), virtualHost: requiredText(input.virtualHost ?? defaults.rabbitmq.virtualHost, "mq_virtual_host", 255) };
    },
  },
  es: {
    key: "es",
    inputSchema: capabilityInputSchemas.es,
    parseConfiguration(value) {
      const input = inputRecord(value);
      return { url: connectionUrl(input.url, "es_url", ["http:", "https:"]), ...optionalCredentials(input, "es") };
    },
  },
  dms: {
    key: "dms",
    inputSchema: capabilityInputSchemas.dms,
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
    parseConfiguration(value) {
      const input = inputRecord(value);
      const region = requiredText(input.region, "sls_region", 63);
      const project = requiredText(input.project, "sls_project", 63);
      const logstores = [...new Set(stringList(input.logstores, "sls_logstores").map((entry) => requiredText(entry, "sls_logstore", 63)))];
      if (!SLS_REGION.test(region) || !SLS_PROJECT.test(project) || !logstores.length || logstores.some((entry) => !SLS_LOGSTORE.test(entry))) fail("invalid_sls_scope");
      return { ...parseSlsConnectionConfiguration(input), region, project, logstores };
    },
  },
} satisfies { [Key in CapabilityName]: CapabilityDefinition<Key> };

export const capabilityDefinitions: { [Key in CapabilityName]: CapabilityDefinition<Key> } = definitions;

export function capabilityToolInputSchema<Key extends CapabilityName>(key: Key, configuration: CapabilityConfig<Key>, options: { outputEnabled?: boolean } = {}): TSchema {
  if (key === "db") {
    const databases = (configuration as CapabilityConfig<"db">).databases.map(({ url }) => decodeURIComponent(new URL(url).pathname.slice(1)));
    return Type.Object({
      database: StringEnum(databases, { description: "Exact database configured for the selected deployment." }),
      statement: Type.String({ maxLength: limits.database.queryChars }),
      ...(options.outputEnabled ? { output: Type.Optional(databaseOutputSchema) } : {}),
    }, { additionalProperties: false });
  }
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
      ...(options.outputEnabled ? { output: Type.Optional(dmsOutputSchema) } : {}),
      logic: Type.Optional(Type.Boolean({ description: "Whether DMS should execute the statement as a logical database query." })),
    }, { additionalProperties: false });
  }
  return capabilityDefinitions[key].inputSchema;
}

export function parseCapabilityConfiguration<Key extends CapabilityName>(key: Key, value: unknown): CapabilityConfig<Key> {
  return capabilityDefinitions[key].parseConfiguration(value);
}
