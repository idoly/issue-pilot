import type { FastifyRequest } from "fastify";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { ApiError } from "./input.ts";
import { requireIssue, runIssueExclusive, type ApiRouteContext } from "./route-context.ts";

const notFoundErrors = new Set(["source_repository_not_found", "source_path_not_found", "source_commit_not_found", "source_commit_file_not_found", "source_diff_file_not_found"]);
const conflictErrors = new Set(["source_browser_unavailable", "source_repository_state_invalid", "source_runtime_invalid", "source_read_only", "source_file_changed"]);
const requestErrors = new Set(["invalid_source_path", "invalid_source_query", "invalid_source_revision", "invalid_source_line", "invalid_source_hash", "source_path_not_directory", "source_path_not_file", "source_path_outside_repository"]);
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

type SourceRequest = FastifyRequest<{ Params: { key: string } }>;
type Issue = Awaited<ReturnType<typeof requireIssue>>;

export function registerSourceBrowserRoutes(context: ApiRouteContext): void {
  const { app, database, engine, sourceBrowser } = context;
  const register = (resource: string, operation: (issue: Issue, request: SourceRequest) => Promise<unknown>) => {
    app.get<{ Params: { key: string } }>(`/api/issues/:key/source/${resource}`, { logLevel: "silent" }, async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      const issue = await requireIssue(database, request.params.key);
      return sourceOperation(() => operation(issue, request));
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
  app.put<{ Params: { key: string }; Body: string }>("/api/issues/:key/source/file", {
    logLevel: "silent",
    bodyLimit: issuePilotConfig.limits.sourceBrowser.fileBytes,
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
  register("search", (issue, request) => sourceBrowser.search(issue, repository(request), headerValue(request.headers["x-issue-pilot-query"], true), {
    caseSensitive: booleanHeader(request.headers["x-issue-pilot-case-sensitive"], true),
    wordMatch: booleanHeader(request.headers["x-issue-pilot-word-match"], false),
  }));
  register("blame", (issue, request) => sourceBrowser.blame(issue, repository(request), relativePath(request, true), line(request)));
  register("history", (issue, request) => sourceBrowser.history(issue, repository(request), relativePath(request)));
  register("commit", (issue, request) => sourceBrowser.commit(issue, repository(request), headerValue(request.headers["x-issue-pilot-revision"], true), relativePath(request)));
  register("commit-file", (issue, request) => sourceBrowser.commitFile(issue, repository(request), headerValue(request.headers["x-issue-pilot-revision"], true), relativePath(request, true)));
  register("diff", (issue, request) => sourceBrowser.diff(issue, repository(request), relativePath(request)));
  register("diff-file", (issue, request) => sourceBrowser.diffFile(issue, repository(request), relativePath(request, true)));
}
