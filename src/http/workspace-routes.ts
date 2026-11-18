import { eq } from "drizzle-orm";
import { create as contentDisposition } from "content-disposition";
import { issueRelations, issues } from "../db/schema.ts";
import { withSharedCheckout } from "../workspace/git.ts";
import { issueRoot } from "../workspace/state.ts";
import { listIssueWorkFiles, openIssueWorkFile } from "../workspace/work-files.ts";
import { ISSUE_WORK_MODES, relatedIssueEntryName } from "../domain/contracts.ts";
import { errorDiagnostic } from "../diagnostics.ts";
import { choice, record, text } from "./input.ts";
import { authorizeWorkMode, requireCurrentUser, requireIssue, type ApiRouteContext } from "./route-context.ts";
import type { IdentityRequest } from "../configuration/access.ts";
import { DomainError } from "../domain/errors.ts";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { IssueScopeTransitionPlan, WorkspaceStatsState } from "./contracts.ts";

function serializeInspection(inspection: Awaited<ReturnType<ApiRouteContext["workspaces"]["inspectIssue"]>>) {
  return {
    issueKey: inspection.issueKey,
    issueStatus: inspection.issueStatus,
    workspaceStatus: inspection.workspaceStatus,
    resolvedAt: inspection.resolvedAt,
    bytes: inspection.bytes,
    releasable: inspection.releasable,
    blockedReason: inspection.blockedReason,
  };
}

export function registerWorkspaceRoutes(context: ApiRouteContext): void {
  const { app, database, workspaces, scopeTransitions, runScopeExclusive } = context;

  const fileAccess = (issue: { id: string; key: string }, request: IdentityRequest) =>
    runScopeExclusive(async () => {
      // The checkout lock and scope queue can outlive the reader's authorization.
      await requireCurrentUser(database, request);
      // Assemble paths here; the file reader verifies the root and any selected repository.
      const repositories = await context.sourceBrowser.workFileRepositories(issue);
      const readRoots: Record<string, string> = {};
      const related = await database.db
        .select({ id: issues.id, key: issues.key })
        .from(issueRelations)
        .innerJoin(issues, eq(issues.id, issueRelations.relatedIssueId))
        .where(eq(issueRelations.issueId, issue.id));
      for (const row of related) {
        const prefix = relatedIssueEntryName(row.key);
        let relatedRepositories: typeof repositories;
        try {
          relatedRepositories = await context.sourceBrowser.workFileRepositories(row);
        } catch (error) {
          // A related Issue's checkout drift must not block this Issue's own files; its checkouts stay unavailable.
          app.log.warn({ issueKey: issue.key, relatedIssueKey: row.key, err: errorDiagnostic(error) }, "related_issue_read_roots_unavailable");
          continue;
        }
        readRoots[prefix] = issueRoot(context.stateRoot, row.key);
        for (const [name, repository] of relatedRepositories) repositories.set(`${prefix}/${name}`, repository);
      }
      return { readRoots, repositories };
    });
  const relativeWorkPath = (value: unknown, optional = false): string => {
    if (value === undefined && optional) return "";
    if (typeof value !== "string" || value.length > 4096 || (!optional && !value.length)) throw new DomainError("invalid_issue_file_path", "bad_request");
    return value;
  };
  // The query carries a work-file path; keep names out of request logs like the download route.
  app.get<{ Params: { key: string }; Querystring: { path?: string } }>("/api/issues/:key/files", { logLevel: "silent" }, async (request, _reply) => {
    await requireCurrentUser(database, request);
    const issue = await requireIssue(database, request.params.key);
    const relative = relativeWorkPath(request.query.path, true);
    return withSharedCheckout(async () => listIssueWorkFiles(context.stateRoot, issue.key, relative, await fileAccess(issue, request)));
  });
  app.get<{ Params: { key: string }; Querystring: { path: string } }>("/api/issues/:key/files/download", { logLevel: "silent" }, async (request, reply) => {
    await requireCurrentUser(database, request);
    const issue = await requireIssue(database, request.params.key);
    const relative = relativeWorkPath(request.query.path);
    const file = await withSharedCheckout(async () => openIssueWorkFile(context.stateRoot, issue.key, relative, await fileAccess(issue, request)));
    reply.header("Content-Type", "application/octet-stream");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Length", file.size);
    reply.header("Content-Disposition", contentDisposition(file.fileName));
    return reply.send(file.handle.createReadStream({ autoClose: true }));
  });

  // An explicit refresh starts a full filesystem/Git scan; it needs a current user and a minimum interval.
  let lastRefreshAt = Number.NEGATIVE_INFINITY;
  app.get<{ Querystring: { refresh?: string } }>("/api/workspaces/stats", async (request, _reply) => {
    const refresh = request.query.refresh === "true";
    if (refresh) {
      await requireCurrentUser(database, request);
      const now = Date.now();
      if (now - lastRefreshAt < issuePilotConfig.http.workspaceStatisticsRefreshIntervalMs) throw new DomainError("workspace_statistics_refresh_too_frequent", "rate_limited");
      lastRefreshAt = now;
    }
    const { snapshot, ...state } = workspaces.readStats(refresh);
    const stats: WorkspaceStatsState = { ...state, snapshot: snapshot ? { ...snapshot, workspaces: snapshot.workspaces.map(serializeInspection) } : null };
    return stats;
  });

  const transitionTarget = (body: unknown) => {
    const input = record(body);
    return {
      serviceKey: text(input.serviceKey, "service_key", 100),
      workMode: choice(input.workMode, "work_mode", ISSUE_WORK_MODES),
    };
  };

  app.post<{ Params: { key: string } }>("/api/issues/:key/scope-transition/plan", async (request) => {
    const issue = await requireIssue(database, request.params.key);
    const target = transitionTarget(request.body);
    await authorizeWorkMode(database, request, target.workMode);
    return runScopeExclusive(async () => {
      await authorizeWorkMode(database, request, target.workMode);
      const plan: IssueScopeTransitionPlan = await scopeTransitions.plan(issue.id, target);
      return plan;
    });
  });

  app.post<{ Params: { key: string } }>("/api/issues/:key/scope-transition/apply", async (request) => {
    const issue = await requireIssue(database, request.params.key);
    const input = record(request.body);
    const target = transitionTarget(input);
    const expectedIssueUpdatedAt = text(input.expectedIssueUpdatedAt, "expected_issue_updated_at", 100);
    const expectedPlanHash = text(input.expectedPlanHash, "expected_plan_hash", 100);
    if (!/^sha256:[0-9a-f]{64}$/.test(expectedPlanHash) || !Number.isFinite(new Date(expectedIssueUpdatedAt).getTime())) throw new DomainError("invalid_scope_transition_expectation", "bad_request");
    const actorSubject = await authorizeWorkMode(database, request, target.workMode);
    const changed = await runScopeExclusive(async () => {
      await authorizeWorkMode(database, request, target.workMode);
      return scopeTransitions.apply(issue.id, target, { expectedIssueUpdatedAt, expectedPlanHash }, actorSubject, () => authorizeWorkMode(database, request, target.workMode));
    });
    return { issueKey: changed.key };
  });

  app.delete<{ Params: { key: string } }>("/api/issues/:key/workspace", async (request) => {
    await requireCurrentUser(database, request);
    const issue = await requireIssue(database, request.params.key);
    return workspaces.releaseIssue(issue.id, () => requireCurrentUser(database, request));
  });
}
