import { eq } from "drizzle-orm";
import { create as contentDisposition } from "content-disposition";
import { issueRelations, issues } from "../db/schema.ts";
import { withSharedCheckout } from "../workspace/git.ts";
import { issueRoot } from "../workspace/state.ts";
import { listIssueWorkFiles, openIssueWorkFile } from "../workspace/work-files.ts";
import { ISSUE_WORK_MODES } from "../domain/contracts.ts";
import { WorkspaceConversionRefusal, WorkspaceReleaseRefusal, WorkspaceScopeMigrationRefusal } from "../workspace/lifecycle.ts";
import { ScopeTransitionRefusal } from "../workspace/scope-transition.ts";
import { errorDiagnostic } from "../diagnostics.ts";
import { ApiError, choice, record, text } from "./input.ts";
import { authorizeWorkMode, requireCurrentUser, requireIssue, throwRefusal, type ApiRouteContext } from "./route-context.ts";

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

  const fileAccess = (issue: { id: string; key: string }) =>
    runScopeExclusive(async () => {
      // Assemble paths here; the file reader verifies the root and any selected repository.
      const repositories = await context.sourceBrowser.workFileRepositories(issue);
      const readRoots: Record<string, string> = {};
      const related = await database.db
        .select({ id: issues.id, key: issues.key })
        .from(issueRelations)
        .innerJoin(issues, eq(issues.id, issueRelations.relatedIssueId))
        .where(eq(issueRelations.issueId, issue.id));
      for (const row of related) {
        const prefix = `.related-${row.key.toLowerCase()}`;
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
    if (typeof value !== "string" || value.length > 4096 || (!optional && !value.length)) throw new ApiError(400, "invalid_issue_file_path");
    return value;
  };
  const workFileError = (error: unknown): never => {
    const code = error instanceof Error ? error.message : "";
    if (["invalid_issue_file_path", "issue_file_not_directory", "issue_file_not_regular", "managed_issue_file_private"].includes(code)) throw new ApiError(400, code);
    if (["source_git_binding_invalid", "source_runtime_invalid"].includes(code)) throw new ApiError(409, code);
    if (code === "source_path_not_found") throw new ApiError(404, "issue_file_not_found");
    if (code === "issue_file_directory_too_large") throw new ApiError(413, code);
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") throw new ApiError(404, "issue_file_not_found");
      if (error.code === "ELOOP") throw new ApiError(400, "invalid_issue_file_path");
    }
    throw error;
  };
  // The query carries a work-file path; keep names out of request logs like the download route.
  app.get<{ Params: { key: string }; Querystring: { path?: string } }>("/api/issues/:key/files", { logLevel: "silent" }, async (request, _reply) => {
    const issue = await requireIssue(database, request.params.key);
    const relative = relativeWorkPath(request.query.path, true);
    try {
      return await withSharedCheckout(async () => listIssueWorkFiles(context.stateRoot, issue.key, relative, await fileAccess(issue)));
    } catch (error) {
      return workFileError(error);
    }
  });
  app.get<{ Params: { key: string }; Querystring: { path: string } }>("/api/issues/:key/files/download", { logLevel: "silent" }, async (request, reply) => {
    const issue = await requireIssue(database, request.params.key);
    const relative = relativeWorkPath(request.query.path);
    try {
      const file = await withSharedCheckout(async () => openIssueWorkFile(context.stateRoot, issue.key, relative, await fileAccess(issue)));
      reply.header("Content-Type", "application/octet-stream");
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Content-Length", file.size);
      reply.header("Content-Disposition", contentDisposition(file.fileName));
      return reply.send(file.handle.createReadStream({ autoClose: true }));
    } catch (error) {
      return workFileError(error);
    }
  });

  app.get<{ Querystring: { refresh?: string } }>("/api/workspaces/stats", async (request, _reply) => {
    const { snapshot, ...state } = workspaces.readStats(request.query.refresh === "true");
    return { ...state, snapshot: snapshot ? { ...snapshot, workspaces: snapshot.workspaces.map(serializeInspection) } : null };
  });

  const transitionTarget = (body: unknown) => {
    const input = record(body);
    return {
      serviceKey: text(input.serviceKey, "service_key", 100),
      workMode: choice(input.workMode, "work_mode", ISSUE_WORK_MODES),
    };
  };
  const transitionError = (error: unknown): never => {
    if (error instanceof ScopeTransitionRefusal || error instanceof WorkspaceConversionRefusal || error instanceof WorkspaceScopeMigrationRefusal) throwRefusal(error);
    if (error instanceof Error && error.message === "issue_already_running") throw new ApiError(409, error.message);
    throw error;
  };

  app.post<{ Params: { key: string } }>("/api/issues/:key/scope-transition/plan", async (request) => {
    const issue = await requireIssue(database, request.params.key);
    const target = transitionTarget(request.body);
    await authorizeWorkMode(database, request, target.workMode);
    try {
      return await runScopeExclusive(async () => {
        await authorizeWorkMode(database, request, target.workMode);
        return scopeTransitions.plan(issue.id, target);
      });
    } catch (error) {
      transitionError(error);
    }
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
      const changed = await runScopeExclusive(async () => {
        await authorizeWorkMode(database, request, target.workMode);
        return scopeTransitions.apply(issue.id, target, { expectedIssueUpdatedAt, expectedPlanHash }, actorSubject, () => authorizeWorkMode(database, request, target.workMode));
      });
      return { issueKey: changed.key };
    } catch (error) {
      transitionError(error);
    }
  });

  app.delete<{ Params: { key: string } }>("/api/issues/:key/workspace", async (request) => {
    await requireCurrentUser(database, request);
    const issue = await requireIssue(database, request.params.key);
    try {
      return await workspaces.releaseIssue(issue.id, () => requireCurrentUser(database, request));
    } catch (error) {
      if (error instanceof WorkspaceReleaseRefusal) throwRefusal(error);
      throw error;
    }
  });
}
