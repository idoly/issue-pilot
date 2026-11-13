import { eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { credentialOwnerSubject, type CapabilityName, type DeploymentConfig, type StoredDeploymentConfig, type DmsCredentials, type SlsCredentials } from "../domain/contracts.ts";
import { issues, subjects, userCredentials } from "../db/schema.ts";

export async function loadIssueCredentialOwner(database: Database, issueId: string) {
  const [issue] = await database.select().from(issues).where(eq(issues.id, issueId)).limit(1);
  if (!issue) throw new Error("issue_not_found");
  const subject = credentialOwnerSubject(issue);
  const [user] = await database.select().from(subjects).where(eq(subjects.subject, subject)).limit(1);
  if (!user?.active) throw new Error("issue_credential_owner_inactive");
  const [credentials] = await database.select().from(userCredentials).where(eq(userCredentials.subject, subject)).limit(1);
  return { user, credentials };
}

type CredentialGroup<Value> = { ok: true; value: Value } | { ok: false; error: string };
type PersonalCredentials = typeof userCredentials.$inferSelect;
type ConfiguredCapabilities = Pick<StoredDeploymentConfig, "dms" | "sls">;
type SharedCredentials = { dms?: DmsCredentials | null; sls?: SlsCredentials | null };

/**
 * Completeness is one fact shared by selection, execution and status projection.
 * An incomplete personal group fails; it never falls back to the shared group.
 */
function dmsCredentialGroup(credentials?: PersonalCredentials, shared?: DmsCredentials | null): CredentialGroup<DmsCredentials> {
  const url = credentials?.productionDmsUrl,
    authorization = credentials?.productionDmsAuthorization;
  if (Boolean(url) !== Boolean(authorization)) return { ok: false, error: "personal_dms_credentials_incomplete" };
  const selected = url && authorization ? { url, authorization } : shared;
  if (!selected?.url || !selected.authorization) return { ok: false, error: "dms_credentials_not_configured" };
  return { ok: true, value: selected };
}

function slsCredentialGroup(credentials?: PersonalCredentials, shared?: SlsCredentials | null): CredentialGroup<SlsCredentials> {
  const accessKeyId = credentials?.productionSlsAccessKeyId,
    accessKeySecret = credentials?.productionSlsAccessKeySecret;
  if (Boolean(accessKeyId) !== Boolean(accessKeySecret)) return { ok: false, error: "personal_sls_credentials_incomplete" };
  const selected = accessKeyId && accessKeySecret ? { accessKeyId, accessKeySecret } : shared;
  if (!selected?.accessKeyId || !selected.accessKeySecret) return { ok: false, error: "sls_credentials_not_configured" };
  return { ok: true, value: selected };
}

export function selectDmsCredentials(credentials?: PersonalCredentials, shared?: DmsCredentials | null): DmsCredentials {
  const group = dmsCredentialGroup(credentials, shared);
  if (!group.ok) throw new Error(group.error);
  return group.value;
}

export interface ResolvedIssueCapabilities {
  configuration: DeploymentConfig;
  /** The selection failure for one capability; other capabilities remain usable. */
  errors: Partial<Record<CapabilityName, string>>;
}

/**
 * Resolve each configured capability independently so a missing DMS group does not discard SLS.
 * A failed group stays an error for that capability and is surfaced only when it is selected.
 */
export function resolveIssueCapabilities(configuration: ConfiguredCapabilities, credentials?: PersonalCredentials, shared: SharedCredentials = {}): ResolvedIssueCapabilities {
  // Keep the configured scope even when its credential group fails: the target stays visible so
  // service_query can report the actionable credential error instead of hiding the capability.
  const resolved: DeploymentConfig = { ...(configuration as DeploymentConfig) };
  const errors: Partial<Record<CapabilityName, string>> = {};
  if (configuration.dms) {
    const group = dmsCredentialGroup(credentials, shared.dms);
    if (group.ok) resolved.dms = { databases: configuration.dms.databases, ...group.value };
    else errors.dms = group.error;
  }
  if (configuration.sls) {
    const group = slsCredentialGroup(credentials, shared.sls);
    if (group.ok) resolved.sls = { ...configuration.sls, ...group.value };
    else errors.sls = group.error;
  }
  return { configuration: resolved, errors };
}

export function credentialStatus(credentials?: PersonalCredentials) {
  const model = credentials?.modelCredentials;
  const dms = credentials ? dmsCredentialGroup(credentials) : undefined;
  const sls = credentials ? slsCredentialGroup(credentials) : undefined;
  return {
    model: model ? { provider: model.provider, model: model.model, thinkingLevel: model.thinkingLevel, codemode: model.codemode } : null,
    gitSshConfigured: Boolean(credentials?.gitPrivateKey),
    // Status uses the same completeness rule as selection, so both views cannot drift.
    ...(dms?.ok ? { productionDmsConfigured: true, productionDmsUrl: dms.value.url } : {}),
    ...(sls?.ok ? { productionSlsConfigured: true } : {}),
  };
}
