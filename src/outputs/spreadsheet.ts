import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { utils, write, read } from "@e965/xlsx";
import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { parseExcel, isExcelFile } from "../documents/excel.ts";
import { resolveSecureAttachmentFile } from "../http/attachment-store.ts";
import { outputFileName, type IssueOutputStore } from "./store.ts";

let activeWorkers = 0;

function acquireSpreadsheetWorker(): () => void {
  if (activeWorkers >= issuePilotConfig.limits.spreadsheet.workers) throw new Error("spreadsheet_capacity_exceeded");
  activeWorkers++;
  return () => { activeWorkers--; };
}

export interface SpreadsheetAttachment { id: string; fileName: string; objectKey: string; size: number; sha256: string }
export interface SpreadsheetInput { fileName: string; attachmentIds: string[]; outputFiles?: string[]; data?: unknown; script: string }

export async function generateSpreadsheet(store: IssueOutputStore, attachmentRoot: string, attachments: SpreadsheetAttachment[], input: SpreadsheetInput, signal?: AbortSignal) {
  outputFileName(input.fileName);
  if (!/\.xlsx$/i.test(input.fileName)) throw new Error("spreadsheet_output_xlsx_required");
  const files: Array<{ id?: string; fileName: string; source: "attachment" | "output"; sheets?: ReturnType<typeof parseExcel>; data?: unknown }> = [];
  for (const id of input.attachmentIds) {
    signal?.throwIfAborted();
    const attachment = attachments.find((file) => file.id === id);
    if (!attachment) throw new Error("spreadsheet_attachment_not_authorized");
    if (!isExcelFile(attachment.fileName)) throw new Error("spreadsheet_excel_attachment_required");
    const filePath = await resolveSecureAttachmentFile(attachmentRoot, attachment.objectKey, attachment.size);
    const content = await readFile(filePath);
    if (createHash("sha256").update(content).digest("hex") !== attachment.sha256) throw new Error("attachment_integrity_check_failed");
    files.push({ id: attachment.id, source: "attachment", fileName: attachment.fileName, sheets: parseExcel(content) });
  }
  for (const fileName of input.outputFiles ?? []) {
    signal?.throwIfAborted();
    const content = await store.read(fileName);
    if (isExcelFile(fileName)) files.push({ source: "output", fileName, sheets: parseExcel(content) });
    else if (/\.(csv|tsv)$/i.test(fileName)) {
      const workbook = read(content.toString("utf8"), { type: "string", raw: true, FS: /\.tsv$/i.test(fileName) ? "\t" : "," });
      files.push({ source: "output", fileName, sheets: workbook.SheetNames.map((name) => ({ name, rows: utils.sheet_to_json<string[]>(workbook.Sheets[name]!, { header: 1, raw: false, defval: "" }) })) });
    } else if (/\.(json|jsonl)$/i.test(fileName)) {
      let data: unknown;
      try { data = /\.jsonl$/i.test(fileName) ? content.toString("utf8").split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line)) : JSON.parse(content.toString("utf8")); }
      catch { throw new Error("spreadsheet_output_invalid_json"); }
      files.push({ source: "output", fileName, data });
    } else throw new Error("spreadsheet_output_format_not_supported");
  }
  let inputProvided = false;
  const sandbox = new CodemodeSandbox({
    memoryLimitBytes: issuePilotConfig.limits.spreadsheet.memoryBytes,
    timeoutMs: issuePilotConfig.limits.spreadsheet.executionMs,
    acquireWorker: acquireSpreadsheetWorker,
    tools: [{ name: "input", execute: () => {
      if (inputProvided) throw new Error("spreadsheet_input_already_loaded");
      inputProvided = true;
      return { files, data: input.data ?? null };
    } }],
  });
  let result: unknown;
  try {
    const evaluated = await sandbox.execute(`"use strict"; const {files, data} = await tools.input({}); return (function(files, data) { "use strict";\n${input.script}\n})(files, data);`, signal ? { signal } : {});
    if (!evaluated.ok) {
      if (signal?.aborted) signal.throwIfAborted();
      if (evaluated.error.kind === "timeout") throw new Error("spreadsheet_execution_timeout");
      if (evaluated.error.kind === "sandbox") throw new Error(evaluated.error.message === "spreadsheet_capacity_exceeded" ? "spreadsheet_capacity_exceeded" : "spreadsheet_execution_unavailable");
      // Script errors and console output may contain authorized business rows;
      // expose only a stable code, never the VM's output, message or stack.
      throw new Error(evaluated.error.name === "SyntaxError" ? "spreadsheet_script_syntax_error" : "spreadsheet_script_failed");
    }
    result = evaluated.value;
  } finally { await sandbox.close(); }
  signal?.throwIfAborted();
  if (!result || typeof result !== "object" || !("sheets" in result) || !Array.isArray(result.sheets) || !result.sheets.length) throw new Error("spreadsheet_invalid_result");
  const workbook = utils.book_new();
  const summary: Array<{ name: string; rows: number }> = [];
  for (const sheet of result.sheets) {
    if (!sheet || typeof sheet !== "object" || typeof sheet.name !== "string" || !Array.isArray(sheet.rows) || sheet.rows.some((row: unknown) => !Array.isArray(row) || row.some((cell) => cell !== null && !["string", "number", "boolean"].includes(typeof cell)))) throw new Error("spreadsheet_invalid_result");
    try { utils.book_append_sheet(workbook, utils.aoa_to_sheet(sheet.rows), sheet.name); }
    catch { throw new Error("spreadsheet_invalid_sheet"); }
    summary.push({ name: sheet.name, rows: sheet.rows.length });
  }
  const data = write(workbook, { type: "buffer", bookType: "xlsx", compression: true }) as Buffer;
  signal?.throwIfAborted();
  const output = await store.generate(input.fileName, async (append) => { await append(data); signal?.throwIfAborted(); });
  return { fileName: output.fileName, size: output.size, sheets: summary };
}
