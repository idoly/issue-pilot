import { listIssueWorkFiles, openIssueWorkFile } from "../workspace/working-files.ts";
import { ISSUE_WORK_MODES } from "../domain/contracts.ts";
import { WorkspaceConversionRefusal, WorkspaceReleaseRefusal, WorkspaceScopeMigrationRefusal } from "../workspace/lifecycle.ts";
import { ScopeTransitionRefusal } from "../workspace/scope-transition.ts";
import { ApiError, choice, record, text } from "./input.ts";
import { authorizeWorkMode, requireIssue, type ApiRouteContext } from "./route-context.ts";

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

  const relativeWorkPath = (value: unknown, optional = false): string => {
    if (value === undefined && optional) return "";
    if (typeof value !== "string" || value.length > 4096 || (!optional && !value.length)) throw new ApiError(400, "invalid_issue_file_path");
    return value;
  };
  const workFileError = (error: unknown): never => {
    const code = error instanceof Error ? error.message : "";
    if (["invalid_issue_file_path", "invalid_issue_work_directory", "issue_file_not_directory", "issue_file_not_regular"].includes(code)) throw new ApiError(400, code);
    if (code === "issue_file_directory_too_large") throw new ApiError(413, code);
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") throw new ApiError(404, "issue_file_not_found");
    throw error;
  };
  app.get<{ Params: { key: string }; Querystring: { path?: string } }>("/api/issues/:key/files", async (request, reply) => {
    const issue = await requireIssue(database, request.params.key);
    const relative = relativeWorkPath(request.query.path, true);
    reply.header("Cache-Control", "private, no-store");
    try { return await listIssueWorkFiles(context.stateRoot, issue.key, relative); }
    catch (error) {
      if (!relative && error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
      return workFileError(error);
    }
  });
  app.get<{ Params: { key: string }; Querystring: { path: string } }>("/api/issues/:key/files/download", { logLevel: "silent" }, async (request, reply) => {
    const issue = await requireIssue(database, request.params.key);
    const relative = relativeWorkPath(request.query.path);
    try {
      const file = await openIssueWorkFile(context.stateRoot, issue.key, relative);
      reply.header("Cache-Control", "private, no-store");
      reply.header("Content-Type", "application/octet-stream");
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Content-Length", file.size);
      reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
      return reply.send(file.handle.createReadStream({ autoClose: true }));
    } catch (error) { return workFileError(error); }
  });

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
    await authorizeWorkMode(database, request, target.workMode);
    try { return await runScopeExclusive(async () => { await authorizeWorkMode(database, request, target.workMode); return scopeTransitions.plan(issue.id, target); }); }
    catch (error) { transitionError(error); }
  });

  app.post<{ Params: { key: string } }>("/api/issues/:key/scope-transition/apply", async (request) => {
    const issue = await requireIssue(database, request.params.key);
    const input = record(request.body);
    const target = transitionTarget(input);
    const expectedIssueUpdatedAt = text(input.expectedIssueUpdatedAt, "expected_issue_updated_at", 100);
    const expectedPlanHash = text(input.expectedPlanHash, "expected_plan_hash", 100);
    if (!/^sha256:[0-9a-f]{64}$/.test(expectedPlanHash) || !Number.isFinite(new Date(expectedIssueUpdatedAt).getTime())) throw new ApiError(400, "invalid_scope_transition_expectation");
    const actorSubject = await authorizeWorkMode(database, request, target.workMode);
    try {
      const changed = await runScopeExclusive(async () => { await authorizeWorkMode(database, request, target.workMode); return scopeTransitions.apply(issue.id, target, { expectedIssueUpdatedAt, expectedPlanHash }, actorSubject); });
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
