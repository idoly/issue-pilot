import { eq } from "drizzle-orm";
import { NetworkConfigSchema } from "@anthropic-ai/sandbox-runtime";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { Database } from "../db/client.ts";
import { applicationSettings } from "../db/schema.ts";
import type {
  ApplicationParameterBounds,
  ApplicationParameterKey,
  ApplicationParameterOverrides,
  ApplicationParameters,
  ApplicationParameterState,
  NumericApplicationParameterKey,
} from "./contracts.ts";

const hour = 60 * 60 * 1000;
const day = 24 * hour;

export const applicationParameterDefaults: ApplicationParameters = Object.freeze({ ...issuePilotConfig.parameters });

export const applicationParameterBounds: ApplicationParameterBounds = Object.freeze({
  numbers: Object.freeze({
    maxConcurrentIssues: { minimum: 1, maximum: 64 },
    modelResponseIdleMs: { minimum: 10_000, maximum: day },
    workspaceRetentionMs: { minimum: hour, maximum: 365 * day },
    // Zero disables high-water release.
    workspaceHighWaterBytes: { minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    workspaceTargetBytes: { minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    // Zero disables the timer; otherwise the cycle is at least one minute.
    workspaceMaintenanceIntervalMs: { minimum: 0, maximum: day },
    capabilityConnectionMs: { minimum: 1_000, maximum: 120_000 },
    mcpExecutionMs: { minimum: 1_000, maximum: 30 * 60 * 1000 },
    dmsExecutionMs: { minimum: 1_000, maximum: 30 * 60 * 1000 },
    slsExecutionMs: { minimum: 1_000, maximum: 30 * 60 * 1000 },
  }),
  listEntries: 100,
});

const numericKeys = Object.keys(applicationParameterBounds.numbers) as NumericApplicationParameterKey[];
const listKeys = ["dingtalkAttachmentHosts", "networkAllowedDomains"] as const satisfies readonly ApplicationParameterKey[];
const hostname = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export class ApplicationParameterError extends Error {}
const invalid = (key: string) => new ApplicationParameterError(`invalid_application_parameter:${key}`);

/** Domain lists share one rule set wherever they are configured: admin parameters and per-agent runtime additions. */
export function parseAllowedDomains(value: unknown): readonly string[] {
  return parseList("networkAllowedDomains", value);
}

function parseList(key: (typeof listKeys)[number], value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > applicationParameterBounds.listEntries || value.some((entry) => typeof entry !== "string")) throw invalid(key);
  const entries = value as string[];
  if (new Set(entries).size !== entries.length) throw invalid(key);
  const valid = key === "networkAllowedDomains" ? NetworkConfigSchema.safeParse({ allowedDomains: entries, deniedDomains: [] }).success : entries.every((entry) => hostname.test(entry));
  if (!valid) throw invalid(key);
  return Object.freeze([...entries]);
}

/** Validates admin overrides and the cross-field rules of the effective values. */
export function parseApplicationParameterOverrides(value: unknown): ApplicationParameterOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("overrides");
  const overrides: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if ((numericKeys as string[]).includes(key)) {
      const { minimum, maximum } = applicationParameterBounds.numbers[key as NumericApplicationParameterKey];
      if (!Number.isSafeInteger(entry) || (entry as number) < minimum || (entry as number) > maximum) throw invalid(key);
      overrides[key] = entry;
    } else if ((listKeys as readonly string[]).includes(key)) overrides[key] = parseList(key as (typeof listKeys)[number], entry);
    else throw invalid(key);
  }
  const values = resolveApplicationParameters(overrides);
  if (values.workspaceMaintenanceIntervalMs > 0 && values.workspaceMaintenanceIntervalMs < 60_000) throw invalid("workspaceMaintenanceIntervalMs");
  if (values.workspaceHighWaterBytes > 0 && values.workspaceTargetBytes >= values.workspaceHighWaterBytes) throw invalid("workspaceTargetBytes");
  return Object.freeze(overrides);
}

export function resolveApplicationParameters(overrides: ApplicationParameterOverrides): ApplicationParameters {
  return Object.freeze({ ...applicationParameterDefaults, ...overrides });
}

// One application owns the process (state lease); buildApi installs its database values before serving and
// each saved update replaces the snapshot. Readers take the snapshot when an operation starts.
let current = applicationParameterDefaults;
export function applicationParameters(): ApplicationParameters {
  return current;
}
export function installApplicationParameters(values: ApplicationParameters): void {
  current = values;
}

export async function loadApplicationParameterState(database: Pick<Database, "select">): Promise<ApplicationParameterState> {
  const [row] = await database
    .select({ overrides: applicationSettings.parameters, revision: applicationSettings.parametersRevision })
    .from(applicationSettings)
    .where(eq(applicationSettings.id, 1))
    .limit(1);
  // Stored values passed the same validation; a failure here means the row was edited outside the application.
  const overrides = parseApplicationParameterOverrides(row?.overrides ?? {});
  return { revision: row?.revision ?? 0, overrides, values: resolveApplicationParameters(overrides), defaults: applicationParameterDefaults, bounds: applicationParameterBounds };
}

export async function saveApplicationParameters(database: Pick<Database, "insert">, overrides: ApplicationParameterOverrides, revision: number): Promise<void> {
  const values = { parameters: { ...overrides }, parametersRevision: revision };
  await database
    .insert(applicationSettings)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: applicationSettings.id, set: values });
}
