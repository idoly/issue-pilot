import { and, eq, inArray, isNull } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { applicationParameters } from "../configuration/parameters.ts";
import { loadDingtalkUserSettings } from "../configuration/user-preferences.ts";
import { dingtalkIssueImports, issues, mcpServices, subjects } from "../db/schema.ts";
import { ISSUE_PRIORITIES, ISSUE_WORK_MODES } from "../domain/contracts.ts";
import { connectMcp, type McpConnector, type McpSession } from "../mcp/client.ts";
import { DingtalkError, dingtalkIssueRecord, dingtalkAttachments, parseDingtalkTable, readDingtalkFields, readDingtalkRecord, resolveDingtalkColumns } from "../mcp/dingtalk.ts";
import type { DingtalkImportResponse, DingtalkSourceResponse } from "../mcp/dingtalk-contracts.ts";
import { downloadDingtalkAttachments } from "./dingtalk-attachments.ts";
import { ApiError, choice, record, text } from "./input.ts";
import type { IssueCreationScopeResolver, IssueCreator } from "./issue-routes.ts";
import { authorizeWorkMode, requireCurrentUser, serializePerson, type ApiRouteContext } from "./route-context.ts";

export function registerDingtalkRoutes(context: ApiRouteContext, createIssue: IssueCreator, resolveCreationScope: IssueCreationScopeResolver, connect: McpConnector = connectMcp): void {
  const { app, database, runScopeExclusive, stateRoot } = context;
  const handle =
    <T>(operation: (request: FastifyRequest, signal: AbortSignal) => Promise<T>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const controller = new AbortController(),
        signal = AbortSignal.any([controller.signal, AbortSignal.timeout(applicationParameters().mcpExecutionMs)]);
      const abort = () => controller.abort();
      const close = () => {
        if (!reply.raw.writableEnded) abort();
      };
      request.raw.once("aborted", abort);
      reply.raw.once("close", close);
      try {
        return await operation(request, signal);
      } catch (error) {
        // A cancellation must not hide incomplete cleanup of the response or staged files.
        if (error instanceof Error && ["dingtalk_attachment_cleanup_failed", "dingtalk_connection_close_failed"].includes(error.message)) throw error;
        if (signal.aborted) throw new ApiError(408, "dingtalk_request_cancelled_or_timed_out");
        if (error instanceof DingtalkError) throw new ApiError(error.statusCode, error.message);
        throw error;
      } finally {
        request.raw.removeListener("aborted", abort);
        reply.raw.removeListener("close", close);
      }
    };
  const settings = (request: FastifyRequest) =>
    runScopeExclusive(async () => {
      const user = await requireCurrentUser(database, request),
        preferences = await loadDingtalkUserSettings(database.db, user.subject);
      const name = preferences.source?.mcp ?? "dingtalk";
      const [server] = await database.db
        .select()
        .from(mcpServices)
        .where(and(eq(mcpServices.name, name), eq(mcpServices.enabled, true)))
        .limit(1);
      return { user, preferences, name, server };
    });
  app.get(
    "/api/dingtalk/source",
    handle(async (request): Promise<DingtalkSourceResponse> => {
      const state = await settings(request);
      let url = "";
      if (state.preferences.source?.url)
        try {
          url = parseDingtalkTable(state.preferences.source.url).url;
        } catch (error) {
          if (!(error instanceof DingtalkError)) throw error;
        }
      return {
        user: serializePerson(state.user),
        url,
        ...(state.preferences.source?.environment ? { environment: state.preferences.source.environment } : {}),
        connection: { available: Boolean(state.server), name: state.name },
      };
    }),
  );
  app.post(
    "/api/dingtalk/import",
    handle(async (request, signal): Promise<DingtalkImportResponse> => {
      const input = record(request.body);
      if (Object.keys(input).some((key) => !["url", "serviceKey", "workMode", "priority", "startAgent", "assigneeSubject"].includes(key))) throw new ApiError(400, "invalid_dingtalk_import");
      const table = parseDingtalkTable(text(input.url, "dingtalk_url", 4096)),
        workMode = choice(input.workMode, "work_mode", ISSUE_WORK_MODES),
        priority = choice(input.priority, "priority", ISSUE_PRIORITIES),
        serviceKey = text(input.serviceKey, "service_key", 100);
      await authorizeWorkMode(database, request, workMode);
      if (input.startAgent !== undefined && typeof input.startAgent !== "boolean") throw new ApiError(400, "invalid_start_agent");
      const state = await settings(request);
      const assigneeSubject = input.assigneeSubject === undefined ? state.user.subject : input.assigneeSubject === null ? null : text(input.assigneeSubject, "assignee_subject", 255);
      if (!state.server) throw new ApiError(400, "dingtalk_mcp_not_configured");
      const result = async (status: "existing" | "created", issueKey: string, assigneeSubject: string | null): Promise<DingtalkImportResponse> => {
        const [assignee] = assigneeSubject ? await database.db.select().from(subjects).where(eq(subjects.subject, assigneeSubject)).limit(1) : [];
        return { user: serializePerson(state.user), status, issueKey, ...(assignee ? { assignee: serializePerson(assignee) } : {}) };
      };
      const [existing] = await database.db
        .select({ key: issues.key, assigneeSubject: issues.assigneeSubject })
        .from(dingtalkIssueImports)
        .innerJoin(issues, eq(issues.id, dingtalkIssueImports.issueId))
        .where(and(eq(dingtalkIssueImports.baseId, table.baseId), eq(dingtalkIssueImports.tableId, table.tableId), eq(dingtalkIssueImports.recordId, table.recordId)))
        .limit(1);
      if (existing) return result("existing", existing.key, existing.assigneeSubject);
      let session: McpSession;
      try {
        session = await connect(state.server, signal);
      } catch {
        throw new DingtalkError("dingtalk_connection_failed");
      }
      let outcome: DingtalkImportResponse | undefined;
      let failure: unknown;
      let failed = false;
      try {
        const fields = await readDingtalkFields(session, table),
          columns = resolveDingtalkColumns(fields, state.preferences.fields ?? {});
        if (!columns.title) throw new ApiError(400, "dingtalk_columns_required");
        const row = await readDingtalkRecord(session, table, columns),
          data = dingtalkIssueRecord(row, columns);
        if (!data.creatable) throw new ApiError(400, "dingtalk_record_invalid");
        const manualMatches = await runScopeExclusive(async () => {
          await authorizeWorkMode(database, request, workMode);
          const scope = await resolveCreationScope(workMode, serviceKey);
          // Only hand-created Issues match by title; an Issue imported from another record belongs to that record.
          return database.db
            .select({ key: issues.key, assigneeSubject: issues.assigneeSubject })
            .from(issues)
            .leftJoin(dingtalkIssueImports, eq(dingtalkIssueImports.issueId, issues.id))
            .where(
              and(
                inArray(issues.title, [data.title, data.number].filter(Boolean)),
                eq(issues.serviceId, scope.serviceId),
                eq(issues.environmentId, scope.environment.id),
                isNull(dingtalkIssueImports.issueId),
              ),
            )
            .limit(2);
        });
        if (manualMatches.length > 1) throw new ApiError(409, "dingtalk_manual_match_ambiguous");
        if (manualMatches[0]) outcome = await result("existing", manualMatches[0].key, manualMatches[0].assigneeSubject);
        else {
          signal.throwIfAborted();
          const pending = await downloadDingtalkAttachments(stateRoot, dingtalkAttachments(row, columns.attachments), signal);
          const created = await createIssue(
            { title: data.title, description: `${data.description}\n\n钉钉来源：${table.url}`, priority, workMode, serviceKey, assigneeSubject, ccSubjects: [] },
            request,
            pending,
            { dingtalk: { baseId: table.baseId, tableId: table.tableId, recordId: table.recordId, sourceUrl: table.url }, startAgent: input.startAgent === true, signal },
          );
          outcome = await result(created.created ? "created" : "existing", created.issue.id, created.issue.assigneeSubject ?? assigneeSubject);
        }
      } catch (error) {
        failed = true;
        failure = error;
      }
      try {
        await session.close();
      } catch (closeError) {
        // MCP errors can contain connection secrets; keep the original cause in the failure chain only.
        app.log.warn("dingtalk_connection_close_failed");
        if (failed) throw new Error("dingtalk_connection_close_failed", { cause: new AggregateError([failure, closeError], "dingtalk_connection_close_failed") });
        return { ...outcome!, connectionCleanup: "failed" };
      }
      if (failed) throw failure;
      return outcome!;
    }),
  );
}
