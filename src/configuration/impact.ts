import { eq, inArray, or } from "drizzle-orm";

import type { Database } from "../db/client.ts";
import { environments, issues, issueServiceScopes, serviceDeployments, serviceRepositories } from "../db/schema.ts";
import { isDevelopmentEnvironment, type CapabilityName } from "../domain/contracts.ts";

/**
 * One owner for "which Issues can observe configuration change X". Routes reserve the result
 * (scope queue → Issue reservation) and close those sessions before writing. Every rule may
 * over-approximate; narrowing one requires proving that no session reads the changed value.
 */
type Reader = Pick<Database, "select">;
export type AffectedIssue = { id: string };

async function issuesInEnvironments(reader: Reader, environmentIds: Iterable<string>): Promise<AffectedIssue[]> {
  const ids = [...new Set(environmentIds)];
  return ids.length ? reader.select({ id: issues.id }).from(issues).where(inArray(issues.environmentId, ids)) : [];
}

/** Development Issues read prod/test deployments as evidence, so a change to any deployed target reaches them too. */
async function developmentEnvironmentIds(reader: Reader): Promise<string[]> {
  const rows = await reader.select({ id: environments.id, kind: environments.kind }).from(environments);
  return rows.filter((row) => isDevelopmentEnvironment(row.kind)).map((row) => row.id);
}

/**
 * Global inputs (shared model/runtime, shared DMS/SLS credentials, MCP connections and their
 * generated DBHub launch shapes) reach every session, so every Issue is affected.
 */
export function issuesAffectedByGlobalChange(reader: Reader): Promise<AffectedIssue[]> {
  return reader.select({ id: issues.id }).from(issues);
}

/**
 * A service's description, deployments and service MCP are visible to every Issue in an environment
 * where it is or will be deployed (not only its entry/included Issues: the workspace tool lists and
 * describes all of them), plus development Issues. DBHub targets generate global MCP connections, so a
 * DBHub change (or deleting a service that has targets) affects every Issue.
 */
export async function issuesAffectedByServiceChange(reader: Reader, serviceId: string, change: { environmentKeys?: readonly string[]; dbHubChanged?: boolean } = {}): Promise<AffectedIssue[]> {
  const deployments = await reader.select().from(serviceDeployments).where(eq(serviceDeployments.serviceId, serviceId));
  if (change.dbHubChanged ?? deployments.some((row) => row.config.dbhub?.length)) return issuesAffectedByGlobalChange(reader);
  const added = change.environmentKeys?.length
    ? await reader
        .select({ id: environments.id })
        .from(environments)
        .where(inArray(environments.key, [...change.environmentKeys]))
    : [];
  return issuesInEnvironments(reader, [...deployments.map((row) => row.environmentId), ...added.map((row) => row.id), ...(await developmentEnvironmentIds(reader))]);
}

/** A native capability switch affects every Issue in an environment with a deployment configuring it, plus development Issues when any does. */
export async function issuesAffectedByCapabilityChange(reader: Reader, capability: CapabilityName): Promise<AffectedIssue[]> {
  const deployments = (await reader.select().from(serviceDeployments)).filter((row) => Boolean(row.config[capability]));
  if (!deployments.length) return [];
  return issuesInEnvironments(reader, [...deployments.map((row) => row.environmentId), ...(await developmentEnvironmentIds(reader))]);
}

/** A repository URL change affects Issues whose entry or included service binds that URL. */
export async function issuesAffectedByRepositoryChange(reader: Reader, url: string): Promise<AffectedIssue[]> {
  const bindings = await reader.select({ serviceId: serviceRepositories.serviceId }).from(serviceRepositories).where(eq(serviceRepositories.url, url));
  const serviceIds = [...new Set(bindings.map((row) => row.serviceId))];
  if (!serviceIds.length) return [];
  return reader
    .select({ id: issues.id })
    .from(issues)
    .where(
      or(
        inArray(issues.serviceId, serviceIds),
        inArray(issues.id, reader.select({ issueId: issueServiceScopes.issueId }).from(issueServiceScopes).where(inArray(issueServiceScopes.serviceId, serviceIds))),
      ),
    );
}

/** A user's role, activity or personal credentials matter wherever the user is reporter or assignee, either of which can be the credential owner. */
export function issuesAffectedByUserChange(reader: Reader, subject: string): Promise<AffectedIssue[]> {
  return reader
    .select({ id: issues.id })
    .from(issues)
    .where(or(eq(issues.reporterSubject, subject), eq(issues.assigneeSubject, subject)));
}
