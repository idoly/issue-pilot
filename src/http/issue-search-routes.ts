import { DomainError } from "../domain/errors.ts";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { IssueSearchSettings } from "../search/contracts.ts";
import { IssueSearchIndex } from "../search/issue-index.ts";
import { closedRecord, text } from "../domain/input.ts";
import { loadIssueSearchSettings } from "../search/settings.ts";
import { requireAdmin, requireCurrentUser, type ApiRouteContext } from "./route-context.ts";

export function registerIssueSearchRoutes(context: Pick<ApiRouteContext, "app" | "database" | "stateRoot">, fetchEmbeddings: typeof fetch = fetch) {
  const { app, database, stateRoot } = context;
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
  const run = async <T>(request: FastifyRequest, reply: FastifyReply, refresh: boolean, operation: (state: IssueSearchSettings, signal: AbortSignal, verify: () => Promise<void>) => Promise<T>) => {
    const authorize = () => (refresh ? requireAdmin(database, request) : requireCurrentUser(database, request));
    await authorize();
    const state = await settings();
    // A socket that closed before listener registration must not start a provider request.
    if (request.raw.aborted || reply.raw.destroyed) throw new DomainError("issue_search_cancelled", "timeout");
    if (!state.enabled) throw new DomainError("issue_search_disabled", "unavailable");
    if (!state.accountId || !state.apiToken) throw new DomainError("issue_search_credentials_required", "unavailable");
    if (closing || active.size >= 4 || (refresh && refreshing)) throw new DomainError("issue_search_busy", "conflict");
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
      if ((await settings()).revision !== state.revision) throw new DomainError("configuration_changed", "conflict");
      controller.signal.throwIfAborted();
    };
    try {
      const result = await operation(state, controller.signal, verify);
      await verify();
      return result;
    } catch (error) {
      if (controller.signal.aborted && error === controller.signal.reason) throw new DomainError("issue_search_cancelled", "timeout");
      throw error;
    } finally {
      reply.raw.removeListener("close", abort);
      active.delete(controller);
      if (refresh) refreshing = false;
    }
  };
  app.post("/api/issue-search", { bodyLimit: 4096 }, (request, reply) => {
    const input = closedRecord(request.body, ["query"], "invalid_issue_search_request");
    const query = text(input.query, "issue_search_query", 500);
    return run(request, reply, false, (state, signal, verify) => index.search(state, query, signal, verify));
  });
  app.post("/api/issue-search/refresh", { bodyLimit: 4096 }, (request, reply) => {
    const input = closedRecord(request.body, ["after"], "invalid_issue_search_cursor");
    if (input.after !== undefined && (typeof input.after !== "string" || !/^[0-9a-f-]{36}$/i.test(input.after))) throw new DomainError("invalid_issue_search_cursor", "bad_request");
    const after = input.after as string | undefined;
    return run(request, reply, true, (state, signal, verify) => index.refresh(state, after, signal, verify));
  });
  return cancelActive;
}
