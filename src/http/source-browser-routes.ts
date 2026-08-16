import { ApiError } from "./input.ts";
import { requireIssue, type ApiRouteContext } from "./route-context.ts";

const notFoundErrors = new Set(["source_repository_not_found", "source_path_not_found", "source_commit_not_found", "source_commit_file_not_found", "source_diff_file_not_found"]);
const conflictErrors = new Set(["source_browser_unavailable", "source_repository_state_invalid", "source_runtime_invalid"]);
const requestErrors = new Set(["invalid_source_path", "invalid_source_query", "invalid_source_revision", "source_path_not_directory", "source_path_not_file", "source_path_outside_repository"]);
const contentErrors = new Set(["source_file_too_large", "source_file_binary", "source_commit_too_large", "source_diff_too_large"]);

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

export function registerSourceBrowserRoutes(context: ApiRouteContext): void {
  const { app, database, sourceBrowser } = context;

  app.get<{ Params: { key: string } }>("/api/issues/:key/source/repositories", { logLevel: "silent" }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const issue = await requireIssue(database, request.params.key);
    return sourceOperation(() => sourceBrowser.repositories(issue));
  });

  app.get<{ Params: { key: string } }>("/api/issues/:key/source/tree", { logLevel: "silent" }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const issue = await requireIssue(database, request.params.key);
    return sourceOperation(() => sourceBrowser.tree(issue, headerValue(request.headers["x-issue-pilot-repository"], true), headerValue(request.headers["x-issue-pilot-path"])));
  });

  app.get<{ Params: { key: string } }>("/api/issues/:key/source/file", { logLevel: "silent" }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const issue = await requireIssue(database, request.params.key);
    return sourceOperation(() => sourceBrowser.file(issue, headerValue(request.headers["x-issue-pilot-repository"], true), headerValue(request.headers["x-issue-pilot-path"], true)));
  });

  app.get<{ Params: { key: string } }>("/api/issues/:key/source/search", { logLevel: "silent" }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const issue = await requireIssue(database, request.params.key);
    return sourceOperation(() => sourceBrowser.search(issue, headerValue(request.headers["x-issue-pilot-repository"], true), headerValue(request.headers["x-issue-pilot-query"], true), {
      caseSensitive: booleanHeader(request.headers["x-issue-pilot-case-sensitive"], true),
      wordMatch: booleanHeader(request.headers["x-issue-pilot-word-match"], false),
    }));
  });

  app.get<{ Params: { key: string } }>("/api/issues/:key/source/history", { logLevel: "silent" }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const issue = await requireIssue(database, request.params.key);
    return sourceOperation(() => sourceBrowser.history(issue, headerValue(request.headers["x-issue-pilot-repository"], true), headerValue(request.headers["x-issue-pilot-path"])));
  });

  app.get<{ Params: { key: string } }>("/api/issues/:key/source/commit", { logLevel: "silent" }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const issue = await requireIssue(database, request.params.key);
    return sourceOperation(() => sourceBrowser.commit(issue, headerValue(request.headers["x-issue-pilot-repository"], true), headerValue(request.headers["x-issue-pilot-revision"], true), headerValue(request.headers["x-issue-pilot-path"])));
  });

  app.get<{ Params: { key: string } }>("/api/issues/:key/source/commit-file", { logLevel: "silent" }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const issue = await requireIssue(database, request.params.key);
    return sourceOperation(() => sourceBrowser.commitFile(issue, headerValue(request.headers["x-issue-pilot-repository"], true), headerValue(request.headers["x-issue-pilot-revision"], true), headerValue(request.headers["x-issue-pilot-path"], true)));
  });

  app.get<{ Params: { key: string } }>("/api/issues/:key/source/diff", { logLevel: "silent" }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const issue = await requireIssue(database, request.params.key);
    return sourceOperation(() => sourceBrowser.diff(issue, headerValue(request.headers["x-issue-pilot-repository"], true), headerValue(request.headers["x-issue-pilot-path"])));
  });

  app.get<{ Params: { key: string } }>("/api/issues/:key/source/diff-file", { logLevel: "silent" }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const issue = await requireIssue(database, request.params.key);
    return sourceOperation(() => sourceBrowser.diffFile(issue, headerValue(request.headers["x-issue-pilot-repository"], true), headerValue(request.headers["x-issue-pilot-path"], true)));
  });
}
