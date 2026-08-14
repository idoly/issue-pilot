import { ApiError } from "./input.ts";
import { requireIssue, type ApiRouteContext } from "./route-context.ts";
import { WorkspaceConversionRefusal, WorkspaceReleaseRefusal } from "../workspace/lifecycle.ts";

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
  const { app, database, workspaces, runScopeExclusive } = context;

  app.get("/api/workspaces/stats", async () => {
    const stats = await workspaces.stats();
    return { ...stats, workspaces: stats.workspaces.map(serializeInspection) };
  });

  app.post<{ Params: { key: string } }>("/api/issues/:key/development", async (request) => {
    const issue = await requireIssue(database, request.params.key);
    try {
      const converted = await runScopeExclusive(() => workspaces.convertIssueToDevelopment(issue.id));
      return { issueKey: converted.key };
    } catch (error) {
      if (error instanceof WorkspaceConversionRefusal) throw new ApiError(409, error.reason);
      throw error;
    }
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
