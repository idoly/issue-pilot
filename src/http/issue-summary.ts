import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import type { DatabaseReader } from "../db/client.ts";
import { environments, issueCcRecipients, issues, issueWorkspaces, services, subjects } from "../db/schema.ts";
import type { AgentRunState } from "../domain/contracts.ts";

export function issueSummaryQuery(reader: DatabaseReader) {
  return reader
    .select({
      issue: {
        id: issues.id,
        key: issues.key,
        title: issues.title,
        priority: issues.priority,
        type: issues.type,
        status: issues.status,
        assigneeSubject: issues.assigneeSubject,
        reporterSubject: issues.reporterSubject,
        resolvedAt: issues.resolvedAt,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
        detailRevision: issues.detailRevision,
      },
      assignee: subjects.displayName,
      // Read recipients in the same SQLite statement, without a separate query or list of bound Issue IDs.
      ccSubjects: sql<string>`(select json_group_array(${issueCcRecipients.subject}) from ${issueCcRecipients} where ${issueCcRecipients.issueId} = ${issues.id})`,
      service: { key: services.key, name: services.name },
      environmentKey: environments.key,
      workspace: {
        status: issueWorkspaces.status,
        updatedAt: issueWorkspaces.updatedAt,
        runtimeReady: issueWorkspaces.runtimeReady,
        releasedAt: issueWorkspaces.releasedAt,
        lastError: issueWorkspaces.lastError,
      },
    })
    .from(issues)
    .leftJoin(subjects, eq(subjects.subject, issues.assigneeSubject))
    .innerJoin(services, eq(services.id, issues.serviceId))
    .innerJoin(environments, eq(environments.id, issues.environmentId))
    .leftJoin(issueWorkspaces, eq(issueWorkspaces.issueId, issues.id));
}

export type IssueSummaryRow = Awaited<ReturnType<typeof issueSummaryQuery>>[number];

/** List, detail, related Issues and SSE share one projection and opaque change token. */
export function serializeIssueSummary({ issue, assignee, ccSubjects, service, environmentKey, workspace }: IssueSummaryRow, runState: AgentRunState) {
  const summary = {
    id: issue.key,
    title: issue.title,
    priority: issue.priority,
    type: issue.type,
    status: issue.status,
    assignee,
    assigneeSubject: issue.assigneeSubject,
    reporterSubject: issue.reporterSubject,
    // Comparing the actual recipients also detects changes within one SQLite timestamp second.
    ccSubjects: (JSON.parse(ccSubjects) as string[]).sort(),
    service,
    environmentKey,
    workspaceStatus: workspace?.status ?? "not_created",
    agentRunning: runState !== "idle",
    resolvedAt: issue.resolvedAt?.toISOString() ?? null,
    createdAt: issue.createdAt.toISOString(),
    updatedAt: issue.updatedAt.toISOString(),
  };
  const revision = createHash("sha256")
    .update(JSON.stringify([summary, issue.detailRevision, runState, workspace?.updatedAt ?? null, workspace?.runtimeReady === true, workspace?.releasedAt ?? null, workspace?.lastError ?? null]))
    .digest("hex");
  return { ...summary, revision };
}
