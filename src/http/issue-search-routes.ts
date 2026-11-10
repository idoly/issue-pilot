import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { applicationSettings } from "../db/schema.ts";
import { WorkersAiError } from "../search/cloudflare.ts";
import type { IssueSearchConfiguration, IssueSearchSettings } from "../search/contracts.ts";
import { IssueSearchIndex, IssueSearchIndexRequired } from "../search/issue-index.ts";
import { ApiError, checkRevision, record, text } from "./input.ts";
import { requireAdmin, requireCurrentUser, type ApiRouteContext } from "./route-context.ts";

const defaultSettings: IssueSearchSettings = { revision: 0, enabled: false, accountId: "", apiToken: "" };
const configurationPath = "/api/config/issue-search";
const project = ({ apiToken, ...state }: IssueSearchSettings): IssueSearchConfiguration => ({ ...state, tokenConfigured: Boolean(apiToken) });

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

  const settings = async () => {
    const [row] = await database.db.select({ search: applicationSettings.issueSearch }).from(applicationSettings).where(eq(applicationSettings.id, 1)).limit(1);
    return row?.search ?? defaultSettings;
  };
  app.get(configurationPath, { logLevel: "silent" }, async (request) => {
    await requireAdmin(database, request);
    return project(await settings());
  });
  app.put(configurationPath, { logLevel: "silent" }, async (request) => {
    await requireAdmin(database, request);
    const input = record(request.body);
    if (
      Object.keys(input).some((key) => !["expectedRevision", "enabled", "accountId", "apiToken"].includes(key)) ||
      typeof input.enabled !== "boolean" ||
      typeof input.accountId !== "string" ||
      input.expectedRevision === undefined
    )
      throw new ApiError(400, "invalid_issue_search_configuration");
    const enabled = input.enabled;
    const accountId = input.accountId.trim().toLowerCase();
    if (accountId && !/^[0-9a-f]{32}$/.test(accountId)) throw new ApiError(400, "invalid_issue_search_account_id");
    const token = input.apiToken === undefined || input.apiToken === null ? input.apiToken : text(input.apiToken, "issue_search_token", 1024);
    if (typeof token === "string" && !/^[!-~]+$/.test(token)) throw new ApiError(400, "invalid_issue_search_token");
    return runScopeExclusive(async () => {
      await requireAdmin(database, request);
      const current = await settings();
      checkRevision(input.expectedRevision, current.revision);
      if (token === undefined && accountId !== current.accountId && current.apiToken) throw new ApiError(400, "issue_search_account_token_required");
      const apiToken = token === undefined && accountId === current.accountId ? current.apiToken : (token ?? "");
      if ((enabled && (!accountId || !apiToken)) || (apiToken && !accountId)) throw new ApiError(400, "issue_search_credentials_required");
      if (enabled === current.enabled && accountId === current.accountId && apiToken === current.apiToken) return project(current);
      const search = { enabled, accountId, apiToken, revision: current.revision + 1 };
      await database.db
        .insert(applicationSettings)
        .values({ id: 1, issueSearch: search })
        .onConflictDoUpdate({ target: applicationSettings.id, set: { issueSearch: search } });
      cancelActive();
      return project(search);
    });
  });

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
}
