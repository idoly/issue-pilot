import { bool, int, lit, obj, oneOf, opt, str, union, type Static, type Schema } from "@earendil-works/pi-schema";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { CapabilityConfiguration, CapabilityName, DmsScope, SlsScope } from "../domain/contracts.ts";
import { DomainError } from "../domain/errors.ts";
import { record, strings, text } from "../domain/input.ts";

const limits = issuePilotConfig.limits.capability;
const SLS_REGION = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SLS_PROJECT = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
export const SLS_LOGSTORE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,61}[a-zA-Z0-9]$/;
export type CapabilityConfig<Key extends CapabilityName> = NonNullable<CapabilityConfiguration[Key]>;
/** Capability configuration is administrator input, so every parse failure is a bad request. */
export function fail(code: string): never {
  throw new DomainError(code, "bad_request");
}
export function parseDmsConnectionConfiguration(value: unknown): Pick<CapabilityConfig<"dms">, "url" | "authorization"> {
  const input = record(value);
  const authorization = text(input.authorization, "dms_authorization");
  if (!/^Bearer [^\s]+$/.test(authorization)) fail("invalid_dms_authorization");
  const configuredUrl = text(input.url, "dms_url", 4096);
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
  const input = record(value);
  return { accessKeyId: text(input.accessKeyId, "sls_access_key_id", 500), accessKeySecret: text(input.accessKeySecret, "sls_access_key_secret") };
}

export function parseDmsScopeConfiguration(value: unknown): DmsScope {
  const input = record(value);
  if (!Array.isArray(input.databases) || !input.databases.length || input.databases.length > limits.dms.databases) fail("invalid_dms_databases");
  const databases = input.databases.map((value) => {
    const database = record(value);
    // Resolution is server-owned: the browser names the instance alias and schema, and DMS resolves the rest
    // with the acting user's credentials at query time. Client-supplied resolved metadata is ignored.
    return {
      instanceAlias: text(database.instanceAlias, "dms_instance_alias", 255),
      schemaName: text(database.schemaName, "dms_schema_name", 255),
      instanceId: "",
      instanceHost: "",
      instancePort: "",
      databaseId: "",
    };
  });
  if (new Set(databases.map(({ schemaName }) => schemaName)).size !== databases.length) fail("duplicate_dms_database_schema");
  return { databases };
}

function parseSlsTargetScope(input: Record<string, unknown>): Omit<SlsScope, "targets"> {
  const region = text(input.region, "sls_region", 63);
  const project = text(input.project, "sls_project", 63);
  const logstores = [...new Set(strings(input.logstores, "sls_logstores").map((entry) => text(entry, "sls_logstore", 63)))];
  if (!SLS_REGION.test(region) || !SLS_PROJECT.test(project) || !logstores.length || logstores.some((entry) => entry !== "*" && !SLS_LOGSTORE.test(entry))) fail("invalid_sls_scope");
  return { region, project, logstores };
}
function sameSlsTarget(left: Omit<SlsScope, "targets">, right: Omit<SlsScope, "targets">): boolean {
  return left.region === right.region && left.project === right.project && left.logstores.length === right.logstores.length && left.logstores.every((entry, index) => entry === right.logstores[index]);
}
export function parseSlsScopeConfiguration(value: unknown): SlsScope {
  const input = record(value);
  const scope = parseSlsTargetScope(input);
  const targets =
    input.targets === undefined
      ? undefined
      : (Array.isArray(input.targets) ? input.targets : fail("invalid_sls_scope")).map((value) => {
          const target = record(value);
          if ("name" in target) fail("invalid_sls_scope");
          return parseSlsTargetScope(target);
        });
  if (targets && !targets.length) fail("invalid_sls_scope");
  // Runtime reads only targets when present; the top level must restate targets[0] so both shapes agree.
  // This parser runs only on configuration writes; stored rows are read without reparsing.
  if (targets && !sameSlsTarget(scope, targets[0]!)) fail("sls_scope_targets_mismatch");
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
  script: str({ minLength: 1, maxLength: limits.dms.scriptChars, description: "One read-only SELECT, SHOW, DESCRIBE, or EXPLAIN statement." }),
  logic: opt(bool({ description: "Whether DMS should execute the statement as a logical database query." })),
};
export const capabilityInputSchemas = {
  dms: obj({ schema: str({ minLength: 1, maxLength: 255, description: "Exact configured schema for the selected deployment." }), ...dmsQueryProperties, export: opt(dmsExportSchema) }),
  sls: obj({
    region: str({ minLength: 1, maxLength: 63, pattern: SLS_REGION.source }),
    project: str({ minLength: 3, maxLength: 63, pattern: SLS_PROJECT.source }),
    logstore: str({ maxLength: 63, pattern: SLS_LOGSTORE.source }),
    ...slsQueryProperties,
  }),
} as const;
export type CapabilityInputs = { [Key in keyof typeof capabilityInputSchemas]: Static<(typeof capabilityInputSchemas)[Key]> };
export function capabilityToolInputSchema<Key extends CapabilityName>(key: Key, configuration: CapabilityConfig<Key>, options: { exportEnabled?: boolean } = {}): Schema {
  if (key === "sls") {
    const configured = configuration as CapabilityConfig<"sls">;
    const logstoreSchema = (stores: string[]) =>
      stores.includes("*")
        ? str({ maxLength: 63, pattern: SLS_LOGSTORE.source, description: "Any exact logstore name in this configured project. Specify one logstore, never *." })
        : oneOf(stores, { description: "Exact logstore configured for the selected deployment." });
    const schema = union(
      (configured.targets ?? [configured]).map(({ region, project, logstores }) => obj({ region: lit(region), project: lit(project), logstore: logstoreSchema(logstores), ...slsQueryProperties })),
    );
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
