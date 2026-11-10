import type { FastifyReply, FastifyRequest } from "fastify";
import { WorkersAiError } from "../search/cloudflare.ts";
import type { IssueSearchSettings } from "../search/contracts.ts";
import { IssueSearchIndex, IssueSearchIndexRequired } from "../search/issue-index.ts";
import { ApiError, record, text } from "./input.ts";
import { loadIssueSearchSettings, projectIssueSearchSettings, updateIssueSearchSettings } from "./issue-search-configuration.ts";
import { requireAdmin, requireCurrentUser, type ApiRouteContext } from "./route-context.ts";

const configurationPath = "/api/config/issue-search";

export function registerIssueSearchRoutes(context: Pick<ApiRouteContext, "app" | "database" | "stateRoot" | "runScopeExclusive">, fetchEmbeddings: typeof fetch = fetch) {
  const { app, database, stateRoot, runScopeExclusive } = context;
  const index = new IssueSearchIndex(database.db, stateRoot, fetchEmbeddings);
  const active = new Set<AbortController>();
  let refreshing = false;
  let closing = false;
  const cancelActive = () => {
    for (const request of active) request.abort();
  };
  app.addHook("preClose", async () => {
    closing = true;
    cancelActive();
  });

  const settings = () => loadIssueSearchSettings(database.db);
  app.get(configurationPath, { logLevel: "silent" }, async (request) => {
    await requireAdmin(database, request);
    return projectIssueSearchSettings(await settings());
  });
  app.put(configurationPath, { logLevel: "silent" }, (request) =>
    runScopeExclusive(async () => {
      await requireAdmin(database, request);
      const result = await updateIssueSearchSettings(database.db, request.body);
      if (result.changed) cancelActive();
      return projectIssueSearchSettings(result.settings);
    }),
  );

  const run = async <T>(request: FastifyRequest, reply: FastifyReply, refresh: boolean, operation: (state: IssueSearchSettings, signal: AbortSignal, verify: () => Promise<void>) => Promise<T>) => {
    const authorize = () => (refresh ? requireAdmin(database, request) : requireCurrentUser(database, request));
    await authorize();
    const state = await settings();
    if (!state.enabled) throw new ApiError(503, "issue_search_disabled");
    if (!state.accountId || !state.apiToken) throw new ApiError(503, "issue_search_credentials_required");
    if (closing || active.size >= 4 || (refresh && refreshing)) throw new ApiError(409, "issue_search_busy");
    const controller = new AbortController();
    const abort = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    active.add(controller);
    if (refresh) refreshing = true;
    reply.raw.once("close", abort);
    const verify = async () => {
      controller.signal.throwIfAborted();
      await authorize();
      if ((await settings()).revision !== state.revision) throw new ApiError(409, "configuration_changed");
      controller.signal.throwIfAborted();
    };
    try {
      const result = await operation(state, controller.signal, verify);
      await verify();
      return result;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof IssueSearchIndexRequired) throw new ApiError(409, error.message);
      if (error instanceof WorkersAiError) throw new ApiError(error.message.endsWith("rate_limited") ? 429 : 502, error.message);
      if (controller.signal.aborted && error === controller.signal.reason) throw new ApiError(408, "issue_search_cancelled");
      throw error;
    } finally {
      reply.raw.removeListener("close", abort);
      active.delete(controller);
      if (refresh) refreshing = false;
    }
  };
  app.post("/api/issue-search", { bodyLimit: 4096 }, (request, reply) => {
    const input = record(request.body);
    if (Object.keys(input).some((key) => key !== "query")) throw new ApiError(400, "invalid_issue_search_request");
    const query = text(input.query, "issue_search_query", 500);
    return run(request, reply, false, (state, signal, verify) => index.search(state, query, signal, verify));
  });
  app.post("/api/issue-search/refresh", { bodyLimit: 4096 }, (request, reply) => {
    const input = record(request.body);
    if (Object.keys(input).some((key) => key !== "after") || (input.after !== undefined && (typeof input.after !== "string" || !/^[0-9a-f-]{36}$/i.test(input.after))))
      throw new ApiError(400, "invalid_issue_search_cursor");
    const after = input.after as string | undefined;
    return run(request, reply, true, (state, signal, verify) => index.refresh(state, after, signal, verify));
  });
  return cancelActive;
}
