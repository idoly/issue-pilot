import type { FastifyRequest } from "fastify";
import { ApiError } from "./input.ts";
import { requireCurrentUser, requireIssue, runIssueExclusive, type ApiRouteContext } from "./route-context.ts";

const notFoundErrors = new Set(["source_repository_not_found", "source_path_not_found", "source_commit_not_found", "source_commit_file_not_found", "source_diff_file_not_found"]);
const conflictErrors = new Set(["source_browser_unavailable", "source_repository_state_invalid", "source_runtime_invalid", "source_git_binding_invalid", "source_read_only", "source_file_changed", "source_path_exists", "source_stage_failed", "source_unstage_failed", "source_discard_failed", "source_commit_failed"]);
const requestErrors = new Set(["invalid_source_path", "invalid_source_query", "invalid_source_history_cursor", "invalid_source_revision", "invalid_source_line", "invalid_source_hash", "invalid_source_commit_message", "invalid_source_commit_author", "source_path_not_directory", "source_path_not_file", "source_path_outside_repository"]);
const contentErrors = new Set(["source_file_binary", "source_commit_too_large", "source_diff_too_large"]);
const unrestrictedBodyLimit = Number.MAX_SAFE_INTEGER;

function headerValue(value: string | string[] | undefined, required = false): string {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || (required && !value)) throw new ApiError(400, "invalid_source_request");
  try { return decodeURIComponent(value); }
  catch { throw new ApiError(400, "invalid_source_request"); }
}

function booleanHeader(value: string | string[] | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const decoded = headerValue(value, true);
  if (decoded === "true") return true;
  if (decoded === "false") return false;
  throw new ApiError(400, "invalid_source_request");
}

async function sourceOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    const message = error instanceof Error ? error.message : "source_browser_failed";
    if (notFoundErrors.has(message)) throw new ApiError(404, message);
    if (conflictErrors.has(message)) throw new ApiError(409, message);
    if (requestErrors.has(message)) throw new ApiError(400, message);
    if (contentErrors.has(message)) throw new ApiError(413, message);
    throw error;
  }
}

type SourceRequest = FastifyRequest<{ Params: { key: string } }>;
type GitRequest = FastifyRequest<{ Params: { key: string }; Body: { paths?: unknown } }>;
type Issue = Awaited<ReturnType<typeof requireIssue>>;

export function registerSourceBrowserRoutes(context: Pick<ApiRouteContext, "app" | "database" | "engine" | "sourceBrowser">): void {
  const { app, database, engine, sourceBrowser } = context;
  const register = (resource: string, operation: (issue: Issue, request: SourceRequest, signal: AbortSignal) => Promise<unknown>) => {
    app.get<{ Params: { key: string } }>(`/api/issues/:key/source/${resource}`, { logLevel: "silent" }, async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const controller = new AbortController();
      const closed = () => { if (!reply.raw.writableEnded) controller.abort(); };
      reply.raw.once("close", closed);
      try {
        const issue = await requireIssue(database, request.params.key);
        return await sourceOperation(() => operation(issue, request, controller.signal));
      } catch (error) {
        if (controller.signal.aborted) { reply.hijack(); return; }
        throw error;
      } finally { reply.raw.off("close", closed); }
    });
  };
  const repository = (request: SourceRequest) => headerValue(request.headers["x-issue-pilot-repository"], true);
  const relativePath = (request: SourceRequest, required = false) => headerValue(request.headers["x-issue-pilot-path"], required);
  const line = (request: SourceRequest) => {
    const value = headerValue(request.headers["x-issue-pilot-line"], true);
    if (!/^[1-9][0-9]*$/.test(value)) throw new ApiError(400, "invalid_source_request");
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new ApiError(400, "invalid_source_request");
    return parsed;
  };

  register("repositories", (issue) => sourceBrowser.repositories(issue));
  register("tree", (issue, request) => sourceBrowser.tree(issue, repository(request), relativePath(request)));
  register("file", (issue, request) => sourceBrowser.file(issue, repository(request), relativePath(request, true)));
  const mutate = <T>(request: FastifyRequest<{ Params: { key: string } }>, operation: (issue: Issue) => Promise<T>) => requireIssue(database, request.params.key)
    .then((issue) => runIssueExclusive(engine, [issue.id], () => sourceOperation(() => operation(issue))));
  app.put<{ Params: { key: string }; Body: string }>("/api/issues/:key/source/file", {
    logLevel: "silent",
    bodyLimit: unrestrictedBodyLimit,
  }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (typeof request.body !== "string") throw new ApiError(400, "invalid_source_request");
    const issue = await requireIssue(database, request.params.key);
    return runIssueExclusive(engine, [issue.id], () => sourceOperation(() => sourceBrowser.writeFile(
      issue,
      repository(request),
      relativePath(request, true),
      request.body,
      headerValue(request.headers["x-issue-pilot-sha256"], true),
    )));
  });
  app.post<{ Params: { key: string }; Body: string }>("/api/issues/:key/source/file", { logLevel: "silent", bodyLimit: unrestrictedBodyLimit }, (request) => {
    if (typeof request.body !== "string") throw new ApiError(400, "invalid_source_request");
    return mutate(request, (issue) => sourceBrowser.createFile(issue, repository(request), relativePath(request, true), request.body));
  });
  app.post<{ Params: { key: string } }>("/api/issues/:key/source/directory", { logLevel: "silent" }, (request) => mutate(request, (issue) => sourceBrowser.createDirectory(issue, repository(request), relativePath(request, true))));
  app.delete<{ Params: { key: string } }>("/api/issues/:key/source/path", { logLevel: "silent" }, (request) => mutate(request, (issue) => sourceBrowser.deletePath(issue, repository(request), relativePath(request, true), booleanHeader(request.headers["x-issue-pilot-recursive"], false))));
  app.post<{ Params: { key: string } }>("/api/issues/:key/source/rename", { logLevel: "silent" }, (request) => mutate(request, (issue) => sourceBrowser.renamePath(issue, repository(request), relativePath(request, true), headerValue(request.headers["x-issue-pilot-destination"], true), booleanHeader(request.headers["x-issue-pilot-overwrite"], false))));
  const gitPaths = (request: GitRequest) => {
    const paths = request.body?.paths;
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) throw new ApiError(400, "invalid_source_request");
    return paths as string[];
  };
  for (const [action, operation] of [
    ["stage", (issue: Issue, request: GitRequest) => sourceBrowser.stage(issue, repository(request), gitPaths(request))],
    ["unstage", (issue: Issue, request: GitRequest) => sourceBrowser.unstage(issue, repository(request), gitPaths(request))],
    ["discard", (issue: Issue, request: GitRequest) => sourceBrowser.discard(issue, repository(request), gitPaths(request))],
  ] as const) app.post<{ Params: { key: string }; Body: { paths?: unknown } }>(`/api/issues/:key/source/${action}`, { logLevel: "silent" }, (request) => mutate(request, (issue) => operation(issue, request)));
  app.post<{ Params: { key: string }; Body: { message?: unknown } }>("/api/issues/:key/source/commit", { logLevel: "silent" }, async (request) => {
    const person = await requireCurrentUser(database, request);
    return mutate(request, (issue) => sourceBrowser.createCommit(issue, repository(request), typeof request.body?.message === "string" ? request.body.message : "", {
      name: person.displayName ?? person.subject,
      email: person.email ?? `${person.subject}@localhost`,
    }));
  });
  register("search", (issue, request, signal) => sourceBrowser.search(issue, repository(request), headerValue(request.headers["x-issue-pilot-query"], true), {
    signal,
    caseSensitive: booleanHeader(request.headers["x-issue-pilot-case-sensitive"], true),
    wordMatch: booleanHeader(request.headers["x-issue-pilot-word-match"], false),
  }));
  register("blame", (issue, request) => sourceBrowser.blame(issue, repository(request), relativePath(request, true), line(request)));
  const historyCursor = (request: SourceRequest) => {
    const revision = headerValue(request.headers["x-issue-pilot-revision"]), offset = headerValue(request.headers["x-issue-pilot-offset"]);
    if (!revision && !offset) return undefined;
    if (!/^[1-9][0-9]*$/.test(offset)) throw new ApiError(400, "invalid_source_history_cursor");
    return { revision, offset: Number(offset) };
  };
  register("history", (issue, request, signal) => sourceBrowser.history(issue, repository(request), relativePath(request), historyCursor(request), signal));
  register("commit", (issue, request) => sourceBrowser.commit(issue, repository(request), headerValue(request.headers["x-issue-pilot-revision"], true), relativePath(request)));
  register("commit-file", (issue, request) => sourceBrowser.commitFile(issue, repository(request), headerValue(request.headers["x-issue-pilot-revision"], true), relativePath(request, true)));
  register("diff", (issue, request) => sourceBrowser.diff(issue, repository(request), relativePath(request), booleanHeader(request.headers["x-issue-pilot-staged"], false)));
  register("diff-file", (issue, request) => sourceBrowser.diffFile(issue, repository(request), relativePath(request, true), booleanHeader(request.headers["x-issue-pilot-staged"], false)));
}
