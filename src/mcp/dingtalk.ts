import { issuePilotConfig } from "../../issue-pilot.config.ts";
import type { McpSession } from "./client.ts";
import { DINGTALK_COLUMNS, type DingtalkTable, type DingtalkField, type DingtalkColumns, type DingtalkRecord, type DingtalkIssueRecord } from "./dingtalk-contracts.ts";

const limits = issuePilotConfig.limits.capability.dingtalk;
export class DingtalkError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 502) { super(message); this.statusCode = statusCode; }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DingtalkError("invalid_dingtalk_response");
  return value as Record<string, unknown>;
}
function dingtalkId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(value)) throw new DingtalkError("invalid_dingtalk_id", 400);
  return value;
}
export function parseDingtalkTable(value: string): DingtalkTable {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["alidocs.dingtalk.com", "docs.dingtalk.com"].includes(url.hostname) || url.username || url.password || url.port || url.pathname !== "/notable/record") throw new Error();
    const baseId = dingtalkId(url.searchParams.get("dentryUuid")), tableId = dingtalkId(url.searchParams.get("sheetId")), recordId = dingtalkId(url.searchParams.get("rowId"));
    const canonical = new URL("https://alidocs.dingtalk.com/notable/record");
    canonical.searchParams.set("dentryUuid", baseId); canonical.searchParams.set("rowId", recordId); canonical.searchParams.set("sheetId", tableId);
    return { baseId, tableId, recordId, url: canonical.toString() };
  } catch { throw new DingtalkError("invalid_dingtalk_record_url", 400); }
}
async function read(session: McpSession, name: "get_tables" | "query_records", input: Record<string, unknown>) {
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
  title: ["序号", "工单标题", "标题", "任务名称", "任务", "名称"], description: ["工单描述", "任务描述", "问题描述", "描述", "详情"],
 number: ["序号", "工单编号", "编号"], attachments: ["附件"],
};
export function resolveDingtalkColumns(fields: DingtalkField[], requested: Partial<DingtalkColumns>): DingtalkColumns {
  return Object.fromEntries(DINGTALK_COLUMNS.map(key => {
    let id = requested[key];
    if (id !== undefined && id !== "") {
      const matches = fields.filter(field => field.id === id || field.name === id);
      if (matches.length !== 1) throw new DingtalkError("dingtalk_fields_changed", 409);
      id = matches[0]!.id;
    }
    if (id === undefined) {
      for (const name of suggested[key]) {
        const matching = fields.filter(field => field.name === name);
        if (matching.length === 1) { id = matching[0]!.id; break; }
      }
    }
    return [key, id ?? ""];
  })) as DingtalkColumns;
}
export async function readDingtalkRecord(session: McpSession, table: DingtalkTable, columns: DingtalkColumns): Promise<DingtalkRecord> {
  const data = await read(session, "query_records", { baseId: table.baseId, tableId: table.tableId, fieldIds: [...new Set(Object.values(columns).filter(Boolean))], recordIds: [table.recordId] });
  if (!Array.isArray(data.records) || data.records.length > 1 || data.nextCursor) throw new DingtalkError("invalid_dingtalk_response");
  if (!data.records.length) throw new DingtalkError("dingtalk_record_not_found", 404);
  const row = object(data.records[0]);
  if (row.recordId !== table.recordId) throw new DingtalkError("invalid_dingtalk_response");
  return { recordId: table.recordId, cells: object(row.cells) };
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
function dingtalkCellTexts(record: DingtalkRecord, field: string | undefined): string[] { return field ? cellTexts(record.cells[field]).map(value => value.trim()).filter(Boolean) : []; }
export interface DingtalkAttachment { id: string; fileName: string; size: number; url: string }
interface DingtalkAttachmentLink { fileName: string; url: string }
function decodeDingtalkAttachments(record: DingtalkRecord, field: string | undefined): { files: DingtalkAttachment[]; links: DingtalkAttachmentLink[] } {
  const value = field ? record.cells[field] : undefined;
  const files: DingtalkAttachment[] = [], links: DingtalkAttachmentLink[] = [];
  if (value === null || value === undefined) return { files, links };
  if (!Array.isArray(value)) throw new DingtalkError("invalid_dingtalk_attachments");
  for (const item of value) {
    const file = object(item);
    if (file.isLink === true || file.type === "link") {
      if (typeof file.filename !== "string" || !file.filename.trim() || /[\u0000-\u001f\u007f]/.test(file.filename) || typeof file.url !== "string" || /[\u0000-\u001f\u007f]/.test(file.url)) throw new DingtalkError("invalid_dingtalk_attachments");
      let url: URL;
      try { url = new URL(file.url); } catch { throw new DingtalkError("invalid_dingtalk_attachments"); }
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new DingtalkError("invalid_dingtalk_attachments");
      links.push({ fileName: file.filename.trim(), url: url.href.replaceAll("<", "%3C").replaceAll(">", "%3E") });
      continue;
    }
    if (typeof file.resourceId !== "string" || typeof file.filename !== "string" || !file.filename.trim() || /[/\\\u0000-\u001f\u007f]/.test(file.filename) || [".", ".."].includes(file.filename) || !Number.isSafeInteger(file.size) || Number(file.size) < 0 || typeof file.url !== "string") throw new DingtalkError("invalid_dingtalk_attachments");
    files.push({ id: file.resourceId, fileName: file.filename, size: Number(file.size), url: file.url });
  }
  return { files, links };
}
export function dingtalkAttachments(record: DingtalkRecord, field: string | undefined): DingtalkAttachment[] {
  return decodeDingtalkAttachments(record, field).files;
}

export function dingtalkIssueRecord(record: DingtalkRecord, columns: DingtalkColumns): DingtalkIssueRecord {
  const value = (key: keyof DingtalkColumns) => dingtalkCellTexts(record, columns[key]).join("\n");
  const number = value("number"), title = value("title");
  const decoded = decodeDingtalkAttachments(record, columns.attachments);
  const linkLines = decoded.links.map(link => {
    const label = link.fileName.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/[\\[\]]/g, "\\$&");
    return `- [${label}](<${link.url}>)`;
  });
  const description = [value("description"), ...(linkLines.length ? [`### 附件链接\n\n${linkLines.join("\n")}`] : [])].filter(Boolean).join("\n\n");
  const reason = !title ? "记录标题为空" : title.length > 300 ? "标题超过 300 字符" : description.length > limits.descriptionCharacters ? "描述超过导入上限，请调整描述字段" : undefined;
  const attachments = decoded.files.map(({ id, fileName, size }) => ({ id, fileName, size }));
  return { recordId: record.recordId, ...(attachments.length ? { attachments } : {}), title: title.slice(0, 300), description: description.slice(0, limits.descriptionCharacters), number: number.slice(0, limits.labelCharacters), creatable: !reason, ...(reason ? { reason } : {}) };
}
