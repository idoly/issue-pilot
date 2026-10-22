import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { loadDingtalkUserSettings, FileConfigurationError } from "../configuration/file-configuration.ts";
import { dingtalkConnection } from "../configuration/mcp.ts";
import { dingtalkIssueImports, issues, mcpServices } from "../db/schema.ts";
import { ISSUE_PRIORITIES, ISSUE_WORK_MODES } from "../domain/contracts.ts";
import { connectMcp, type McpConnector, type McpSession } from "../mcp/client.ts";
import { DingtalkError, dingtalkCellTexts, dingtalkId, dingtalkPreviewRecord, dingtalkAttachments, matchesDingtalkPerson, pendingDingtalkStatus, resolveDingtalkPerson, parseDingtalkTable, readDingtalkFields, readDingtalkRecords, resolveDingtalkColumns } from "../mcp/dingtalk.ts";
import { DINGTALK_COLUMNS, type DingtalkColumns, type DingtalkPreviewRecord, type DingtalkRecord, type DingtalkSourceResponse, type DingtalkPreviewResponse, type DingtalkImportResponse } from "../mcp/dingtalk-contracts.ts";
import { downloadDingtalkAttachments } from "./dingtalk-attachments.ts";
import type { DingtalkPerson } from "../mcp/dingtalk.ts";
import { errorDiagnostic } from "./error-diagnostic.ts";
import { ApiError, choice, record, text } from "./input.ts";
import type { IssueCreator } from "./issue-routes.ts";
import { authorizeWorkMode, requireCurrentUser, serializePerson, type ApiRouteContext } from "./route-context.ts";

const limits = issuePilotConfig.limits.capability.dingtalk;
interface DingtalkQuery {
  table: ReturnType<typeof parseDingtalkTable>; fields: Awaited<ReturnType<typeof readDingtalkFields>>; columns: DingtalkColumns;
  signature: string; assignee: string; person: DingtalkPerson | undefined; pendingStatus: string;
}
export function registerDingtalkRoutes(context: ApiRouteContext, createIssue: IssueCreator, connect: McpConnector = connectMcp): void {
  const { app, database, runScopeExclusive } = context, key = randomBytes(32);
  const sign = (kind: string, value: unknown) => createHmac("sha256", key).update(kind + ":" + JSON.stringify(value)).digest("hex");
  const equal = (left: unknown, right: string) => typeof left === "string" && /^[a-f0-9]{64}$/.test(left) && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
  const handle = <T>(operation: (request: FastifyRequest, signal: AbortSignal) => Promise<T>) => async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "private, no-store"); reply.header("Pragma", "no-cache");
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(issuePilotConfig.limits.capability.mcp.executionMs)]);
    const abort = () => controller.abort();
    const close = () => { if (!reply.raw.writableEnded) abort(); };
    request.raw.once("aborted", abort); reply.raw.once("close", close);
    try {
      const result = await operation(request, signal);
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > issuePilotConfig.limits.capability.resultBytes) throw new DingtalkError("dingtalk_result_too_large");
      return result;
    }
    catch (error) {
      if (signal.aborted) throw new ApiError(408, "dingtalk_request_cancelled_or_timed_out");
      if (error instanceof DingtalkError) throw new ApiError(error.statusCode, error.message);
      if (error instanceof FileConfigurationError) throw new ApiError(400, "dingtalk_configuration_invalid");
      throw error;
    } finally { request.raw.removeListener("aborted", abort); reply.raw.removeListener("close", close); }
  };
  const settings = (request: FastifyRequest) => runScopeExclusive(async () => {
    const user = await requireCurrentUser(database, request), personal = await loadDingtalkUserSettings(context.stateRoot, user.subject);
    const name = personal.source?.mcp ?? "dingtalk";
    const [server] = await database.db.select().from(mcpServices).where(and(eq(mcpServices.name, name), eq(mcpServices.enabled, true))).limit(1);
    return { user, personal, name, server };
  });
  const withSession = async <T>(request: FastifyRequest, signal: AbortSignal, input: Record<string, unknown>, operation: (state: Awaited<ReturnType<typeof settings>>, session: McpSession, query: DingtalkQuery) => Promise<T>) => {
    const state = await settings(request);
    if (!state.server) throw new ApiError(400, "dingtalk_mcp_not_configured");
    const configuration = dingtalkConnection(state.server, state.personal), table = parseDingtalkTable(text(input.url, "dingtalk_url", 4096));
    let session: McpSession | undefined;
    try {
      try { session = await connect(configuration, signal); } catch { throw new DingtalkError("dingtalk_connection_failed"); }
      const fields = await readDingtalkFields(session, table);
      const requested = input.columns === undefined ? {} : record(input.columns);
      if (Object.keys(requested).some(key => !DINGTALK_COLUMNS.includes(key as keyof DingtalkColumns))) throw new ApiError(400, "invalid_dingtalk_columns");
      for (const value of Object.values(requested)) if (typeof value !== "string" || value.length > 255) throw new ApiError(400, "invalid_dingtalk_columns");
      const columns = resolveDingtalkColumns(fields, requested), assignee = state.personal.source?.assignee ?? state.user.displayName ?? state.user.subject;
      const person = fields.find(field => field.id === columns.assignee)?.type === "user" ? await resolveDingtalkPerson(session, assignee) : undefined;
      const pendingStatus = pendingDingtalkStatus(fields, columns);
      const query: DingtalkQuery = { table, fields, columns, assignee, person, pendingStatus, signature: sign("query", { table, columns, assignee, person, pendingStatus, subject: state.user.subject, configuration }) };
      const result = await operation(state, session, query);
      signal.throwIfAborted(); await requireCurrentUser(database, request);
      return result;
    } finally {
      if (session) try { await session.close(); } catch { app.log.warn("dingtalk_connection_close_failed"); }
    }
  };
  const mappings = async (table: ReturnType<typeof parseDingtalkTable>, ids: string[], previews: Array<Pick<DingtalkPreviewRecord, "recordId" | "title" | "number">> = []) => {
    if (!ids.length) return new Map<string, string>();
    const rows = await database.db.select({ recordId: dingtalkIssueImports.recordId, key: issues.key }).from(dingtalkIssueImports).innerJoin(issues, eq(issues.id, dingtalkIssueImports.issueId)).where(and(eq(dingtalkIssueImports.baseId, table.baseId), eq(dingtalkIssueImports.tableId, table.tableId), inArray(dingtalkIssueImports.recordId, ids)));
    const existing = new Map(rows.map(row => [row.recordId, row.key]));
    const titles = [...new Set(previews.flatMap(row => [row.title, row.number].filter(Boolean)))];
    if (titles.length) {
      const matches = await database.db.select({ key: issues.key, title: issues.title }).from(issues).where(inArray(issues.title, titles));
      const byTitle = new Map(matches.map(row => [row.title, row.key]));
      for (const row of previews) {
        const key = byTitle.get(row.title) ?? (row.number ? byTitle.get(row.number) : undefined);
        if (key && !existing.has(row.recordId)) existing.set(row.recordId, key);
      }
    }
    return existing;
  };
  app.get("/api/dingtalk/source", handle(async (request): Promise<DingtalkSourceResponse> => {
    const state = await settings(request);
    return { user: serializePerson(state.user), url: state.personal.source ? parseDingtalkTable(state.personal.source.url).url : "", assignee: state.personal.source?.assignee ?? state.user.displayName ?? state.user.subject, ...(state.personal.source?.environment ? { environment: state.personal.source.environment } : {}), connection: { available: Boolean(state.server), kind: state.personal.personal ? "personal" : "shared", name: state.name } };
  }));
  app.post("/api/dingtalk/preview", handle(async (request, signal) => {
    const input = record(request.body);
    return withSession(request, signal, input, async (state, session, query): Promise<DingtalkPreviewResponse> => {
      const { table, fields, columns, signature, assignee, person, pendingStatus } = query;
      if (!columns.title || !columns.assignee || !columns.status) return { user: serializePerson(state.user), fields, columns, records: [], cursor: "", scanned: 0, statusOptions: [], needsMapping: true };
      let cursor = "";
      if (input.cursor) {
        try {
          const token = record(JSON.parse(Buffer.from(text(input.cursor, "dingtalk_cursor", limits.cursorCharacters), "base64url").toString("utf8")));
          if (typeof token.cursor !== "string" || token.cursor.length > limits.cursorCharacters || !equal(token.signature, sign("cursor", { signature, cursor: token.cursor }))) throw new Error();
          cursor = token.cursor;
        } catch { throw new DingtalkError("dingtalk_snapshot_changed", 409); }
      }
      if (table.recordId && input.cursor) throw new ApiError(400, "invalid_dingtalk_cursor");
      signal.throwIfAborted();
      const page = await readDingtalkRecords(session, table, columns, table.recordId ? { recordIds: [table.recordId] } : { ...(cursor ? { cursor } : {}), limit: limits.previewRecords, status: { fieldId: columns.status, value: pendingStatus } });
      if (table.recordId && (page.cursor || page.records.some(row => row.recordId !== table.recordId))) throw new DingtalkError("invalid_dingtalk_response");
      const statuses = new Set<string>();
      const records: DingtalkPreviewRecord[] = page.records.filter(row => matchesDingtalkPerson(row, columns.assignee, assignee, person) && dingtalkCellTexts(row, columns.status).includes(pendingStatus)).map(row => {
        for (const value of dingtalkCellTexts(row, columns.status)) if (value.length <= limits.labelCharacters && statuses.size < 100) statuses.add(value);
        const preview = dingtalkPreviewRecord(row, columns);
        if (!preview.assignee && person) preview.assignee = assignee;
        return { ...preview, token: sign("record", { signature, record: preview }) };
      });
      cursor = page.cursor;
      const scanned = page.records.length;
      const imported = await mappings(table, records.map(row => row.recordId), records);
      const remaining = records.filter(row => !imported.has(row.recordId));
      return { user: serializePerson(state.user), fields, columns, records: remaining, skippedImported: records.length - remaining.length, cursor: cursor ? Buffer.from(JSON.stringify({ cursor, signature: sign("cursor", { signature, cursor }) })).toString("base64url") : "", scanned, statusOptions: [...statuses], needsMapping: false };
    });
  }));
  app.post("/api/dingtalk/import", handle(async (request, signal) => {
    const input = record(request.body), workMode = choice(input.workMode, "work_mode", ISSUE_WORK_MODES), priority = choice(input.priority, "priority", ISSUE_PRIORITIES), serviceKey = text(input.serviceKey, "service_key", 100);
    await authorizeWorkMode(database, request, workMode);
    if (input.startAgent !== undefined && typeof input.startAgent !== "boolean") throw new ApiError(400, "invalid_start_agent");
    if (!Array.isArray(input.records) || !input.records.length || input.records.length > limits.importRecords) throw new ApiError(400, "invalid_dingtalk_records");
    const selected = input.records.map(value => { const row = record(value); if (typeof row.token !== "string" || !/^[a-f0-9]{64}$/.test(row.token)) throw new ApiError(400, "invalid_dingtalk_record_token"); return { recordId: dingtalkId(row.recordId), token: row.token }; });
    if (new Set(selected.map(row => row.recordId)).size !== selected.length) throw new ApiError(400, "duplicate_dingtalk_records");
    return withSession(request, signal, input, async (state, session, query): Promise<DingtalkImportResponse> => {
      const { table, columns, signature, assignee, person, pendingStatus } = query;
      if (!columns.title || !columns.assignee || !columns.status) throw new ApiError(400, "dingtalk_columns_required");
      const imported = await mappings(table, selected.map(row => row.recordId)), missing = selected.filter(row => !imported.has(row.recordId));
      const fresh = missing.length ? (await readDingtalkRecords(session, table, columns, { recordIds: missing.map(row => row.recordId) })).records : [];
      if (fresh.some(row => !missing.some(selected => selected.recordId === row.recordId))) throw new DingtalkError("invalid_dingtalk_response");
      const freshPreviews = fresh.map(row => dingtalkPreviewRecord(row, columns));
      for (const [id, key] of await mappings(table, fresh.map(row => row.recordId), freshPreviews)) imported.set(id, key);
      const byId = new Map<string, DingtalkRecord>(fresh.map(row => [row.recordId, row]));
      const results: Array<{ recordId: string; status: "created" | "existing" | "stale" | "failed"; issueKey?: string; error?: string }> = [];
      for (const selectedRow of selected) {
        signal.throwIfAborted();
        if (imported.has(selectedRow.recordId)) { results.push({ recordId: selectedRow.recordId, status: "existing", issueKey: imported.get(selectedRow.recordId)! }); continue; }
        const row = byId.get(selectedRow.recordId), preview = row && dingtalkPreviewRecord(row, columns);
        if (preview && !preview.assignee && person) preview.assignee = assignee;
        if (!row || !preview?.creatable || !matchesDingtalkPerson(row, columns.assignee, assignee, person) || !dingtalkCellTexts(row, columns.status).includes(pendingStatus) || !equal(selectedRow.token, sign("record", { signature, record: preview }))) { results.push({ recordId: selectedRow.recordId, status: "stale", error: "记录已变化，请重新读取后选择" }); continue; }
        try {
          const pending = await downloadDingtalkAttachments(dingtalkAttachments(row, columns.attachments), signal);
          const result = await createIssue({ title: preview.title, description: `${preview.description}\n\n钉钉来源：${table.recordId ? table.url : `${table.url}&recordId=${encodeURIComponent(row.recordId)}`}`, priority, workMode, serviceKey, assigneeSubject: state.user.subject, ccSubjects: [] }, request, pending, { dingtalk: { baseId: table.baseId, tableId: table.tableId, recordId: row.recordId, sourceUrl: table.url }, startAgent: input.startAgent === true, signal });
          results.push({ recordId: row.recordId, status: result.created ? "created" : "existing", issueKey: result.issue.id });
        } catch (error) {
          if (signal.aborted) throw error;
          if (!(error instanceof ApiError)) app.log.error({ err: errorDiagnostic(error) }, "dingtalk_issue_creation_failed");
          results.push({ recordId: row.recordId, status: "failed", error: error instanceof ApiError || error instanceof DingtalkError ? error.message : "issue_creation_failed" });
        }
      }
      return { user: serializePerson(state.user), results };
    });
  }));
}
