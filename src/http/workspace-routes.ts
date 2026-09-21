import { ISSUE_WORK_MODES } from "../domain/contracts.ts";
import { WorkspaceConversionRefusal, WorkspaceReleaseRefusal, WorkspaceScopeMigrationRefusal } from "../workspace/lifecycle.ts";
import { ScopeTransitionRefusal } from "../workspace/scope-transition.ts";
import { ApiError, choice, record, text } from "./input.ts";
import { ensureCurrentSubject, requireIssue, type ApiRouteContext } from "./route-context.ts";

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

  app.get("/api/workspaces/stats", async () => {
    const stats = await workspaces.stats();
    return { ...stats, workspaces: stats.workspaces.map(serializeInspection) };
  });

  const transitionTarget = (body: unknown) => {
    const input = record(body);
    return {
      serviceKey: text(input.serviceKey, "service_key", 100),
      workMode: choice(input.workMode, "work_mode", ISSUE_WORK_MODES),
    };
  };
  const transitionError = (error: unknown): never => {
    if (error instanceof ScopeTransitionRefusal || error instanceof WorkspaceConversionRefusal || error instanceof WorkspaceScopeMigrationRefusal) throw new ApiError(409, error.reason);
    if (error instanceof Error && error.message === "issue_already_running") throw new ApiError(409, error.message);
    throw error;
  };

  app.get<{ Params: { key: string } }>("/api/issues/:key/scope-transitions", async (request, reply) => {
    const issue = await requireIssue(database, request.params.key);
    reply.header("Cache-Control", "private, no-store");
    return scopeTransitions.history(issue.id);
  });

  app.post<{ Params: { key: string } }>("/api/issues/:key/scope-transition/plan", async (request) => {
    const issue = await requireIssue(database, request.params.key);
    const target = transitionTarget(request.body);
    try { return await runScopeExclusive(() => scopeTransitions.plan(issue.id, target)); }
    catch (error) { transitionError(error); }
  });

  app.post<{ Params: { key: string } }>("/api/issues/:key/scope-transition/apply", async (request) => {
    const issue = await requireIssue(database, request.params.key);
    const input = record(request.body);
    const target = transitionTarget(input);
    const expectedIssueUpdatedAt = text(input.expectedIssueUpdatedAt, "expected_issue_updated_at", 100);
    const expectedPlanHash = text(input.expectedPlanHash, "expected_plan_hash", 100);
    if (!/^sha256:[0-9a-f]{64}$/.test(expectedPlanHash) || !Number.isFinite(new Date(expectedIssueUpdatedAt).getTime())) throw new ApiError(400, "invalid_scope_transition_expectation");
    const actorSubject = await ensureCurrentSubject(database, request);
    try {
      const changed = await runScopeExclusive(() => scopeTransitions.apply(issue.id, target, { expectedIssueUpdatedAt, expectedPlanHash }, actorSubject));
      return { issueKey: changed.key };
    } catch (error) { transitionError(error); }
  });

  app.delete<{ Params: { key: string } }>("/api/issues/:key/workspace", async (request) => {
    const issue = await requireIssue(database, request.params.key);
    try {
      return await workspaces.releaseIssue(issue.id);
    } catch (error) {
      if (error instanceof WorkspaceReleaseRefusal) throw new ApiError(409, error.reason);
      throw error;
    }
  });
}
