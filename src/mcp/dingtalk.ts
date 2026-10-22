import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { McpSession } from "./client.ts";
import { DINGTALK_COLUMNS, type DingtalkTable, type DingtalkView, type DingtalkField, type DingtalkColumns, type DingtalkRecord, type DingtalkPreviewRecord } from "./dingtalk-contracts.ts";

const limits = issuePilotConfig.limits.capability.dingtalk;
export class DingtalkError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 502) { super(message); this.statusCode = statusCode; }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DingtalkError("invalid_dingtalk_response");
  return value as Record<string, unknown>;
}
export function dingtalkId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(value)) throw new DingtalkError("invalid_dingtalk_id", 400);
  return value;
}
export function parseDingtalkTable(value: string): DingtalkTable {
  try {
    const url = new URL(value);
    const match = /^\/i\/nodes\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
    if (url.protocol !== "https:" || !["alidocs.dingtalk.com", "docs.dingtalk.com"].includes(url.hostname) || url.username || url.password || url.port || !match) throw new Error();
    const embedded = new URLSearchParams(url.searchParams.get("iframeQuery") ?? "");
    const entrance = url.searchParams.get("entrance") ?? embedded.get("entrance");
    if (entrance !== null && entrance !== "data") throw new Error();
    const baseId = dingtalkId(match[1]), tableId = dingtalkId(url.searchParams.get("sheetId") ?? embedded.get("sheetId"));
    const rawViewId = url.searchParams.get("viewId") ?? embedded.get("viewId");
    const viewId = rawViewId === null ? undefined : dingtalkId(rawViewId);
    // Keep routing information only; share-link credentials never enter an Issue.
    const canonical = new URL(`https://alidocs.dingtalk.com/i/nodes/${baseId}`);
    canonical.searchParams.set("entrance", "data"); canonical.searchParams.set("sheetId", tableId);
    if (viewId) canonical.searchParams.set("viewId", viewId);
    return { baseId, tableId, ...(viewId ? { viewId } : {}), url: canonical.toString() };
  } catch { throw new DingtalkError("invalid_dingtalk_table_url", 400); }
}
async function read(session: McpSession, name: "get_tables" | "get_views" | "query_records", input: Record<string, unknown>) {
  if (!session.call) throw new DingtalkError("dingtalk_read_not_supported");
  let result: Record<string, unknown>;
  try { result = object(await session.call(name, input)); }
  catch (error) { if (error instanceof DingtalkError) throw error; throw new DingtalkError("dingtalk_read_failed"); }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > issuePilotConfig.limits.capability.resultBytes) throw new DingtalkError("dingtalk_result_too_large");
  let payload: Record<string, unknown>;
  if (result.structuredContent) payload = object(result.structuredContent);
  else {
    const text = Array.isArray(result.content) ? result.content.filter(part => part?.type === "text").map(part => part.text).join("\n") : "";
    try { payload = object(JSON.parse(text)); } catch { throw new DingtalkError("invalid_dingtalk_response"); }
  }
  if (result.isError || payload.status !== "success") {
    const error = payload.error && typeof payload.error === "object" ? object(payload.error) : {};
    if (["INVALID_CURSOR", "CURSOR_SNAPSHOT_CHANGED", "CURSOR_SNAPSHOT_UNAVAILABLE", "NON_RESUMABLE_ERROR_CURSOR", "CURSOR_OFFSET_LIMIT"].includes(String(error.code))) throw new DingtalkError("dingtalk_snapshot_changed", 409);
    throw new DingtalkError("dingtalk_read_failed");
  }
  return object(payload.data);
}
export async function readDingtalkFields(session: McpSession, source: DingtalkTable): Promise<DingtalkField[]> {
  const data = await read(session, "get_tables", { baseId: source.baseId, tableIds: [source.tableId] });
  if (!Array.isArray(data.tables)) throw new DingtalkError("invalid_dingtalk_response");
  const table = data.tables.map(object).find(table => table.tableId === source.tableId);
  if (!table || !Array.isArray(table.fields) || table.fields.length > limits.tableFields) throw new DingtalkError("dingtalk_table_not_found");
  const fields = table.fields.map(value => {
    const field = object(value);
    if (typeof field.fieldName !== "string" || !field.fieldName.trim() || field.fieldName.length > limits.labelCharacters || typeof field.type !== "string" || field.type.length > 100) throw new DingtalkError("invalid_dingtalk_response");
    return { id: dingtalkId(field.fieldId), name: field.fieldName, type: field.type };
  });
  if (new Set(fields.map(field => field.id)).size !== fields.length) throw new DingtalkError("invalid_dingtalk_response");
  return fields;
}
const suggested: Record<keyof DingtalkColumns, string[]> = {
  title: ["工单标题", "标题", "任务名称", "任务", "名称"], description: ["工单描述", "任务描述", "问题描述", "描述", "详情"],
  assignee: ["处理人", "负责人", "参与人", "执行人", "当前处理人"], status: ["状态", "任务状态", "研发任务状态", "工单状态"],
  module: ["对应模块", "模块", "项目"], number: ["序号", "工单编号", "编号"],
};
export function resolveDingtalkColumns(fields: DingtalkField[], requested: Partial<DingtalkColumns>): DingtalkColumns {
  return Object.fromEntries(DINGTALK_COLUMNS.map(key => {
    let id = requested[key];
    if (id !== undefined && id !== "" && !fields.some(field => field.id === id)) throw new DingtalkError("dingtalk_fields_changed", 409);
    if (id === undefined) {
      for (const name of suggested[key]) {
        const matching = fields.filter(field => field.name === name);
        if (matching.length === 1) { id = matching[0]!.id; break; }
      }
    }
    return [key, id ?? ""];
  })) as DingtalkColumns;
}
export async function readDingtalkView(session: McpSession, table: DingtalkTable): Promise<DingtalkView | undefined> {
  if (!table.viewId) return undefined;
  const data = await read(session, "get_views", { baseId: table.baseId, tableId: table.tableId, viewIds: [table.viewId] });
  if (!Array.isArray(data.views)) throw new DingtalkError("invalid_dingtalk_response");
  const view = data.views.map(object).find(view => view.viewId === table.viewId);
  if (!view || view.tableId !== undefined && view.tableId !== table.tableId || view.baseId !== undefined && view.baseId !== table.baseId) throw new DingtalkError("dingtalk_view_not_found", 404);
  if (typeof view.viewName !== "string" || view.viewName.length > limits.labelCharacters) throw new DingtalkError("invalid_dingtalk_response");
  const filter = view.filter === null || view.filter === undefined ? undefined : object(view.filter);
  if (filter && Object.keys(filter).length && (!Array.isArray(filter.operands) || !["and", "or"].includes(String(filter.operator).toLowerCase()))) throw new DingtalkError("dingtalk_view_filter_not_supported");
  if (view.sort !== null && view.sort !== undefined && !Array.isArray(view.sort)) throw new DingtalkError("invalid_dingtalk_response");
  const sort = Array.isArray(view.sort) ? view.sort.map(object) : undefined;
  // Forward the view's own query, including $ME, to DingTalk without guessing a different user or filter.
  return { id: table.viewId, name: view.viewName, ...(filter && Array.isArray(filter.operands) && filter.operands.length ? { filters: filter } : {}), ...(sort?.length ? { sort } : {}) };
}
export async function readDingtalkRecords(session: McpSession, table: DingtalkTable, columns: DingtalkColumns, options: { cursor?: string; limit?: number; recordIds?: string[]; filters?: Record<string, unknown>; sort?: Array<Record<string, unknown>> }) {
  const data = await read(session, "query_records", { baseId: table.baseId, tableId: table.tableId, fieldIds: [...new Set(Object.values(columns).filter(Boolean))], ...options });
  if (!Array.isArray(data.records) || data.records.length > 100) throw new DingtalkError("invalid_dingtalk_response");
  const records: DingtalkRecord[] = data.records.map(value => { const row = object(value); return { recordId: dingtalkId(row.recordId), cells: object(row.cells) }; });
  if (new Set(records.map(row => row.recordId)).size !== records.length) throw new DingtalkError("invalid_dingtalk_response");
  const cursor = data.nextCursor ?? "";
  if (typeof cursor !== "string" || cursor.length > limits.cursorCharacters || cursor.startsWith("error-v1:") || cursor === "NON_RESUMABLE_ERROR_CURSOR" || cursor && cursor === options.cursor) throw new DingtalkError("dingtalk_snapshot_changed", 409);
  return { records, cursor };
}
/** Decode display values only, never arbitrary object properties or attachment URLs. */
function cellTexts(value: unknown, depth = 0): string[] {
  if (depth > 8 || value === null || value === undefined) return [];
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(value => cellTexts(value, depth + 1));
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    for (const key of ["text", "displayName", "name", "label", "value", "values", "content"]) if (input[key] !== undefined) return cellTexts(input[key], depth + 1);
  }
  return [];
}
export function dingtalkCellTexts(record: DingtalkRecord, field: string): string[] { return field ? cellTexts(record.cells[field]).map(value => value.trim()).filter(Boolean) : []; }
export function dingtalkPreviewRecord(record: DingtalkRecord, columns: DingtalkColumns): Omit<DingtalkPreviewRecord, "token"> {
  const value = (key: keyof DingtalkColumns) => dingtalkCellTexts(record, columns[key]).join("\n");
  const number = value("number"), originalTitle = value("title"), description = value("description");
  const title = number && !originalTitle.includes(number) ? `${number} ${originalTitle}` : originalTitle;
  const reason = !originalTitle ? "记录标题为空" : title.length > 300 ? "标题超过 300 字符" : description.length > limits.descriptionCharacters ? "描述超过导入上限，请调整描述字段" : undefined;
  const label = (key: keyof DingtalkColumns) => value(key).slice(0, limits.labelCharacters);
  return { recordId: record.recordId, title: title.slice(0, 300), description: description.slice(0, limits.descriptionCharacters), assignee: label("assignee"), status: label("status"), module: label("module"), number: number.slice(0, limits.labelCharacters), creatable: !reason, ...(reason ? { reason } : {}) };
}
