import { CapabilityConfigurationError, parseDmsScopeConfiguration, parseSlsScopeConfiguration } from "../capabilities/registry.ts";
import { CAPABILITY_KEYS, type CapabilityName, type StoredDeploymentConfig } from "../domain/contracts.ts";
import { CAPABILITY_CREDENTIAL_FIELDS, type ProjectedCapabilityConfiguration } from "./contracts.ts";
function fail(code: string): never { throw new CapabilityConfigurationError(code); }
function inputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_request");
  return value as Record<string, unknown>;
}
export function projectCapabilityConfiguration(configuration: StoredDeploymentConfig): ProjectedCapabilityConfiguration {
  const projected: Record<string, unknown> = {};
  for (const key of CAPABILITY_KEYS) {
    const stored = configuration[key];
    if (!stored) continue;
    const fields = CAPABILITY_CREDENTIAL_FIELDS[key] as readonly string[];
    projected[key] = Object.fromEntries(Object.entries(stored).filter(([field]) => !fields.includes(field)));
  }
  return projected as ProjectedCapabilityConfiguration;
}
function resolveCapabilityConfiguration(key: CapabilityName, value: unknown): NonNullable<StoredDeploymentConfig[CapabilityName]> {
  const input = inputRecord(value);
  const fields = CAPABILITY_CREDENTIAL_FIELDS[key] as readonly string[];
  if (fields.some(field => field in input)) fail("credential_fields_not_allowed");
  if (input.credentialUpdate !== undefined) {
    const update = inputRecord(input.credentialUpdate);
    if (update.mode !== "preserve" || Object.keys(update).length !== 1) fail(`service_${key}_credentials_not_allowed`);
  }
  return key === "dms" ? parseDmsScopeConfiguration(input) : parseSlsScopeConfiguration(input);
}
export function resolveConfiguredCapabilitySections(input: Record<string, unknown>, capabilities: CapabilityName[]): Pick<StoredDeploymentConfig, CapabilityName> {
  const selected = new Set(capabilities);
  return Object.fromEntries(CAPABILITY_KEYS.flatMap(key => selected.has(key) ? [[key, resolveCapabilityConfiguration(key, input[key])]] : [])) as Pick<StoredDeploymentConfig, CapabilityName>;
}
