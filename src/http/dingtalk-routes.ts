import { and, eq, inArray } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { loadDingtalkUserSettings, FileConfigurationError } from "../configuration/file-configuration.ts";
import { dingtalkIssueImports, issues, mcpServices } from "../db/schema.ts";
import { ISSUE_PRIORITIES, ISSUE_WORK_MODES } from "../domain/contracts.ts";
import { connectMcp, type McpConnector, type McpSession } from "../mcp/client.ts";
import { DingtalkError, dingtalkIssueRecord, dingtalkAttachments, parseDingtalkTable, readDingtalkFields, readDingtalkRecord, resolveDingtalkColumns } from "../mcp/dingtalk.ts";
import type { DingtalkImportResponse, DingtalkSourceResponse } from "../mcp/dingtalk-contracts.ts";
import { downloadDingtalkAttachments } from "./dingtalk-attachments.ts";
import { ApiError, choice, record, text } from "./input.ts";
import type { IssueCreator } from "./issue-routes.ts";
import { authorizeWorkMode, requireCurrentUser, serializePerson, type ApiRouteContext } from "./route-context.ts";

export function registerDingtalkRoutes(context: ApiRouteContext, createIssue: IssueCreator, connect: McpConnector = connectMcp): void {
  const { app, database, runScopeExclusive } = context;
  const handle = <T>(operation: (request: FastifyRequest, signal: AbortSignal) => Promise<T>) => async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "private, no-store"); reply.header("Pragma", "no-cache");
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(issuePilotConfig.limits.capability.mcp.executionMs)]);
    const abort = () => controller.abort();
    const close = () => { if (!reply.raw.writableEnded) abort(); };
    request.raw.once("aborted", abort); reply.raw.once("close", close);
    try { return await operation(request, signal); }
    catch (error) {
      if (signal.aborted) throw new ApiError(408, "dingtalk_request_cancelled_or_timed_out");
      if (error instanceof DingtalkError) throw new ApiError(error.statusCode, error.message);
      if (error instanceof FileConfigurationError) throw new ApiError(400, "dingtalk_configuration_invalid");
      throw error;
    } finally { request.raw.removeListener("aborted", abort); reply.raw.removeListener("close", close); }
  };
  const settings = (request: FastifyRequest) => runScopeExclusive(async () => {
    const user = await requireCurrentUser(database, request), preferences = await loadDingtalkUserSettings(context.stateRoot, user.subject);
    const name = preferences.source?.mcp ?? "dingtalk";
    const [server] = await database.db.select().from(mcpServices).where(and(eq(mcpServices.name, name), eq(mcpServices.enabled, true))).limit(1);
    return { user, preferences, name, server };
  });
  app.get("/api/dingtalk/source", handle(async (request): Promise<DingtalkSourceResponse> => {
    const state = await settings(request);
    let url = "";
    if (state.preferences.source?.url) try { url = parseDingtalkTable(state.preferences.source.url).url; } catch (error) { if (!(error instanceof DingtalkError)) throw error; }
    return { user: serializePerson(state.user), url, ...(state.preferences.source?.environment ? { environment: state.preferences.source.environment } : {}), connection: { available: Boolean(state.server), name: state.name } };
  }));
  app.post("/api/dingtalk/import", handle(async (request, signal): Promise<DingtalkImportResponse> => {
    const input = record(request.body);
    if (Object.keys(input).some(key => !["url", "serviceKey", "workMode", "priority", "startAgent"].includes(key))) throw new ApiError(400, "invalid_dingtalk_import");
    const table = parseDingtalkTable(text(input.url, "dingtalk_url", 4096)), workMode = choice(input.workMode, "work_mode", ISSUE_WORK_MODES), priority = choice(input.priority, "priority", ISSUE_PRIORITIES), serviceKey = text(input.serviceKey, "service_key", 100);
    await authorizeWorkMode(database, request, workMode);
    if (input.startAgent !== undefined && typeof input.startAgent !== "boolean") throw new ApiError(400, "invalid_start_agent");
    const state = await settings(request);
    if (!state.server) throw new ApiError(400, "dingtalk_mcp_not_configured");
    const result = (status: "existing" | "created", issueKey: string): DingtalkImportResponse => ({ user: serializePerson(state.user), status, issueKey });
    const [existing] = await database.db.select({ key: issues.key }).from(dingtalkIssueImports).innerJoin(issues, eq(issues.id, dingtalkIssueImports.issueId)).where(and(eq(dingtalkIssueImports.baseId, table.baseId), eq(dingtalkIssueImports.tableId, table.tableId), eq(dingtalkIssueImports.recordId, table.recordId))).limit(1);
    if (existing) return result("existing", existing.key);
    let session: McpSession | undefined;
    try {
      try { session = await connect(state.server, signal); } catch { throw new DingtalkError("dingtalk_connection_failed"); }
      const fields = await readDingtalkFields(session, table), columns = resolveDingtalkColumns(fields, state.preferences.fields ?? {});
      if (!columns.title) throw new ApiError(400, "dingtalk_columns_required");
      const row = await readDingtalkRecord(session, table, columns), data = dingtalkIssueRecord(row, columns);
      const [manual] = await database.db.select({ key: issues.key }).from(issues).where(inArray(issues.title, [data.title, data.number].filter(Boolean))).limit(1);
      if (manual) return result("existing", manual.key);

      if (!data.creatable) throw new ApiError(400, "dingtalk_record_invalid");
      signal.throwIfAborted();
      const pending = await downloadDingtalkAttachments(dingtalkAttachments(row, columns.attachments), signal);
      const created = await createIssue({ title: data.title, description: `${data.description}\n\n钉钉来源：${table.url}`, priority, workMode, serviceKey, assigneeSubject: state.user.subject, ccSubjects: [] }, request, pending, { dingtalk: { baseId: table.baseId, tableId: table.tableId, recordId: table.recordId, sourceUrl: table.url }, startAgent: input.startAgent === true, signal });
      return result(created.created ? "created" : "existing", created.issue.id);
    } finally { if (session) try { await session.close(); } catch { app.log.warn("dingtalk_connection_close_failed"); } }
  }));
}
