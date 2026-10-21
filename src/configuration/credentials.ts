import { CapabilityConfigurationError, parseCapabilityConfiguration } from "../capabilities/registry.ts";
import { CAPABILITY_KEYS, type CapabilityConfiguration, type CapabilityName, type DeploymentConfig, type StoredDeploymentConfig } from "../domain/contracts.ts";
import { CAPABILITY_CREDENTIALS, type ProjectedCapabilityConfiguration, type ServiceCapabilityConfiguration } from "./contracts.ts";
function fail(code: string): never { throw new CapabilityConfigurationError(code); }
function inputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_request");
  return value as Record<string, unknown>;
}
function configuredCredentialValues(key: CapabilityName, section: Record<string, unknown>): Record<string, string> | undefined {
  const fields = CAPABILITY_CREDENTIALS[key].fields as readonly string[];
  const values = Object.fromEntries(fields.map(field => [field, section[field]]));
  return fields.every(field => typeof values[field] === "string" && values[field].length > 0) ? values as Record<string, string> : undefined;
}
export function projectCapabilityConfiguration(configuration: CapabilityConfiguration): ProjectedCapabilityConfiguration {
  const projected: Record<string, unknown> = {};
  for (const key of CAPABILITY_KEYS) {
    const stored = configuration[key];
    if (!stored) continue;
    const section = stored as Record<string, unknown>;
    const fields = CAPABILITY_CREDENTIALS[key].fields as readonly string[];
    projected[key] = { ...Object.fromEntries(Object.entries(section).filter(([field]) => !fields.includes(field))), credentialConfigured: Boolean(configuredCredentialValues(key, section)) };
  }
  return projected as ProjectedCapabilityConfiguration;
}
export function resolveDeploymentConfiguration(stored: StoredDeploymentConfig): DeploymentConfig {
  return Object.fromEntries(CAPABILITY_KEYS.flatMap(key => stored[key] ? [[key, stored[key]]] : []));
}
export function projectDeploymentConfiguration(stored: StoredDeploymentConfig): ServiceCapabilityConfiguration {
  return projectCapabilityConfiguration(resolveDeploymentConfiguration(stored));
}
function replacementCredentialValues(key: CapabilityName, value: unknown): Record<string, string> {
  const input = inputRecord(value);
  const fields = CAPABILITY_CREDENTIALS[key].fields as readonly string[];
  if (Object.keys(input).length !== fields.length || fields.some(field => typeof input[field] !== "string" || !input[field].trim())) fail(key === "dms" ? "invalid_dms_authorization" : "invalid_credential_replacement");
  return Object.fromEntries(fields.map(field => [field, input[field] as string]));
}
function resolveCapabilityConfiguration(key: CapabilityName, value: unknown, existing: CapabilityConfiguration | undefined): NonNullable<CapabilityConfiguration[CapabilityName]> {
  const input = inputRecord(value);
  const credentialFields = CAPABILITY_CREDENTIALS[key].fields as readonly string[];
  if (credentialFields.some(field => field in input)) fail("credential_fields_not_allowed");
  const update = inputRecord(input.credentialUpdate);
  const base = Object.fromEntries(Object.entries(input).filter(([field]) => field !== "credentialUpdate" && !credentialFields.includes(field)));
  let credentials: Record<string, string>;
  if (update.mode === "preserve") {
    if (Object.keys(update).length !== 1) fail("invalid_credential_update");
    const stored = existing?.[key] as Record<string, unknown> | undefined;
    if (key === "dms" && stored?.url !== base.url) fail("dms_credentials_target_changed");
    credentials = stored ? configuredCredentialValues(key, stored) ?? fail("credential_not_configured") : fail("credential_not_configured");
  } else if (update.mode === "replace") {
    if (Object.keys(update).length !== 2 || !("values" in update)) fail("invalid_credential_update");
    credentials = replacementCredentialValues(key, update.values);
  } else if (update.mode === "clear") {
    if (Object.keys(update).length !== 1) fail("invalid_credential_update");
    return fail("credential_required");
  } else return fail("invalid_credential_update");
  return parseCapabilityConfiguration(key, { ...base, ...credentials });
}
export function resolveConfiguredCapabilitySections(input: Record<string, unknown>, capabilities: CapabilityName[], existing?: CapabilityConfiguration): CapabilityConfiguration {
  const selected = new Set(capabilities);
  return Object.fromEntries(CAPABILITY_KEYS.flatMap(key => selected.has(key) ? [[key, resolveCapabilityConfiguration(key, input[key], existing)]] : [])) as CapabilityConfiguration;
}
