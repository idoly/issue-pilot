import { bool, int, lit, obj, oneOf, opt, str, union, type Static, type Schema } from "@earendil-works/pi-schema";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { CapabilityConfiguration, CapabilityName, DmsScope, SlsScope } from "../domain/contracts.ts";

const limits = issuePilotConfig.limits.capability;
const SLS_REGION = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SLS_PROJECT = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
export const SLS_LOGSTORE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,61}[a-zA-Z0-9]$/;
export type CapabilityConfig<Key extends CapabilityName> = NonNullable<CapabilityConfiguration[Key]>;
export class CapabilityConfigurationError extends Error {}
export function fail(code: string): never {
  throw new CapabilityConfigurationError(code);
}
export function inputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_request");
  return value as Record<string, unknown>;
}
function requiredText(value: unknown, name: string, maximum = 10_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) fail(`invalid_${name}`);
  return value.trim();
}
function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.length > 0)) fail(`invalid_${name}`);
  return value as string[];
}
export function parseDmsConnectionConfiguration(value: unknown): Pick<CapabilityConfig<"dms">, "url" | "authorization"> {
  const input = inputRecord(value);
  const authorization = requiredText(input.authorization, "dms_authorization");
  if (!/^Bearer [^\s]+$/.test(authorization)) fail("invalid_dms_authorization");
  const configuredUrl = requiredText(input.url, "dms_url", 4096);
  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch {
    return fail("invalid_dms_url");
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash) fail("invalid_dms_url");
  return { url: configuredUrl, authorization };
}
export function parseSlsConnectionConfiguration(value: unknown): Pick<CapabilityConfig<"sls">, "accessKeyId" | "accessKeySecret"> {
  const input = inputRecord(value);
  return { accessKeyId: requiredText(input.accessKeyId, "sls_access_key_id", 500), accessKeySecret: requiredText(input.accessKeySecret, "sls_access_key_secret") };
}

export function parseDmsScopeConfiguration(value: unknown): DmsScope {
  const input = inputRecord(value);
  if (!Array.isArray(input.databases) || !input.databases.length || input.databases.length > limits.dms.databases) fail("invalid_dms_databases");
  const databases = input.databases.map((value) => {
    const database = inputRecord(value);
    const instanceAlias = requiredText(database.instanceAlias, "dms_instance_alias", 255);
    const schemaName = requiredText(database.schemaName, "dms_schema_name", 255);
    const resolvedFields = ["instanceId", "instanceHost", "instancePort", "databaseId"] as const;
    const resolved = resolvedFields.some((key) => database[key] !== undefined && database[key] !== "");
    const instanceId = resolved ? requiredText(database.instanceId, "dms_instance_id", 100) : "";
    const instanceHost = resolved ? requiredText(database.instanceHost, "dms_instance_host", 255) : "";
    const instancePort = resolved ? requiredText(database.instancePort, "dms_instance_port", 10) : "";
    const databaseId = resolved ? requiredText(database.databaseId, "dms_database_id", 100) : "";
    if (resolved && (!/^\d{1,5}$/.test(instancePort) || Number(instancePort) < 1 || Number(instancePort) > 65_535)) fail("invalid_dms_database");
    return { instanceAlias, schemaName, instanceId, instanceHost, instancePort, databaseId };
  });
  if (new Set(databases.map(({ schemaName }) => schemaName)).size !== databases.length) fail("duplicate_dms_database_schema");
  if (new Set(databases.filter(({ databaseId }) => databaseId).map(({ databaseId }) => databaseId)).size !== databases.filter(({ databaseId }) => databaseId).length) fail("duplicate_dms_database_id");
  return { databases };
}

function parseSlsTargetScope(input: Record<string, unknown>): Omit<SlsScope, "targets"> {
  const region = requiredText(input.region, "sls_region", 63);
  const project = requiredText(input.project, "sls_project", 63);
  const logstores = [...new Set(stringList(input.logstores, "sls_logstores").map((entry) => requiredText(entry, "sls_logstore", 63)))];
  if (!SLS_REGION.test(region) || !SLS_PROJECT.test(project) || !logstores.length || logstores.some((entry) => entry !== "*" && !SLS_LOGSTORE.test(entry))) fail("invalid_sls_scope");
  return { region, project, logstores };
}
export function parseSlsScopeConfiguration(value: unknown): SlsScope {
  const input = inputRecord(value);
  const scope = parseSlsTargetScope(input);
  const targets =
    input.targets === undefined
      ? undefined
      : (Array.isArray(input.targets) ? input.targets : fail("invalid_sls_scope")).map((value) => {
          const target = inputRecord(value);
          return { name: requiredText(target.name, "sls_target", 100), ...parseSlsTargetScope(target) };
        });
  if (targets && (!targets.length || new Set(targets.map((target) => target.name)).size !== targets.length)) fail("invalid_sls_scope");
  return { ...scope, ...(targets ? { targets } : {}) };
}

const slsQueryProperties = {
  from: opt(int({ minimum: 0 })),
  to: opt(int({ minimum: 1 })),
  query: opt(str({ maxLength: limits.sls.queryChars, description: "Log filter or SQL analysis. SQL uses its LIMIT/ORDER BY for pagination; incomplete results fail explicitly." })),
  trace_id: opt(str({ maxLength: limits.sls.traceIdChars })),
};
const dmsExportSchema = obj({
  fileName: str({
    minLength: 1,
    maxLength: issuePilotConfig.limits.filesystemNameBytes,
    description: "Save the complete MCP result as a JSON work file in this Issue instead of returning query rows to the conversation. The UTF-8 basename byte limit also applies.",
  }),
});
const dmsQueryProperties = {
  script: str({ minLength: 1, description: "One read-only SELECT, SHOW, DESCRIBE, or EXPLAIN statement." }),
  logic: opt(bool({ description: "Whether DMS should execute the statement as a logical database query." })),
};
export const capabilityInputSchemas = {
  dms: obj({ schema: str({ minLength: 1, maxLength: 255, description: "Exact configured schema for the selected deployment." }), ...dmsQueryProperties, export: opt(dmsExportSchema) }),
  sls: obj({ target: opt(str({ minLength: 1, maxLength: 100 })), logstore: str({ maxLength: 63, pattern: SLS_LOGSTORE.source }), ...slsQueryProperties }),
} as const;
export type CapabilityInputs = { [Key in keyof typeof capabilityInputSchemas]: Static<(typeof capabilityInputSchemas)[Key]> };
export function capabilityToolInputSchema<Key extends CapabilityName>(key: Key, configuration: CapabilityConfig<Key>, options: { exportEnabled?: boolean } = {}): Schema {
  if (key === "sls") {
    const configured = configuration as CapabilityConfig<"sls">;
    const logstoreSchema = (stores: string[]) =>
      stores.includes("*")
        ? str({ maxLength: 63, pattern: SLS_LOGSTORE.source, description: "Any exact logstore name in this configured project. Specify one logstore, never *." })
        : oneOf(stores, { description: "Exact logstore configured for the selected deployment." });
    const schema = configured.targets
      ? union(configured.targets.map((target) => obj({ target: lit(target.name), logstore: logstoreSchema(target.logstores), ...slsQueryProperties })))
      : obj({ logstore: logstoreSchema(configured.logstores), ...slsQueryProperties });
    return structuredClone(schema);
  }
  return structuredClone(
    obj({
      schema: oneOf(
        (configuration as CapabilityConfig<"dms">).databases.map(({ schemaName }) => schemaName),
        { description: "Exact schema configured for the selected deployment." },
      ),
      ...dmsQueryProperties,
      ...(options.exportEnabled ? { export: opt(dmsExportSchema) } : {}),
    }),
  );
}
