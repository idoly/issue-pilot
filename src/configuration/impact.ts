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

/** Inverse of listEnvironmentServices: even an unincluded service is describable in the Issue's own environment; dev sees every environment. */
export async function issuesObservingDeployments(reader: Reader, environmentIds: Iterable<string>): Promise<AffectedIssue[]> {
  const ids = new Set(environmentIds);
  if (!ids.size) return [];
  const rows = await reader.select({ id: environments.id, kind: environments.kind }).from(environments);
  for (const row of rows) if (isDevelopmentEnvironment(row.kind)) ids.add(row.id);
  return reader
    .select({ id: issues.id })
    .from(issues)
    .where(inArray(issues.environmentId, [...ids]));
}

/**
 * Shared model/runtime and shared credential writes retain their application-wide reservation.
 * Global MCP rows are excluded: Agent sessions read only deployment-owned service rows.
 */
export function issuesAffectedByGlobalChange(reader: Reader): Promise<AffectedIssue[]> {
  return reader.select({ id: issues.id }).from(issues);
}

export async function issuesAffectedByServiceDeletion(reader: Reader, serviceId: string): Promise<AffectedIssue[]> {
  const deployments = await reader.select({ environmentId: serviceDeployments.environmentId }).from(serviceDeployments).where(eq(serviceDeployments.serviceId, serviceId));
  return issuesObservingDeployments(
    reader,
    deployments.map((row) => row.environmentId),
  );
}

/** A native capability switch affects every Issue in an environment with a deployment configuring it, plus development Issues when any does. */
export async function issuesAffectedByCapabilityChange(reader: Reader, capability: CapabilityName): Promise<AffectedIssue[]> {
  const deployments = (await reader.select().from(serviceDeployments)).filter((row) => Boolean(row.config[capability]));
  return issuesObservingDeployments(
    reader,
    deployments.map((row) => row.environmentId),
  );
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
