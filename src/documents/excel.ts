import { read, utils } from "@e965/xlsx";

export interface ExcelSheet { name: string; rows: string[][] }
export const isExcelFile = (fileName: string): boolean => /\.(xlsx|xls)$/i.test(fileName);

export function parseExcel(content: Uint8Array): ExcelSheet[] {
  try {
    const workbook = read(Uint8Array.from(content), { type: "array", cellFormula: false, cellHTML: false, cellText: true });
    if (!workbook.SheetNames.length) throw new Error("empty_workbook");
    return workbook.SheetNames.map((name) => ({
      name,
      rows: utils.sheet_to_json<string[]>(workbook.Sheets[name]!, { header: 1, raw: false, defval: "", blankrows: true }).map((row) => row.map((cell) => String(cell ?? ""))),
    }));
  } catch { throw new Error("excel_parse_failed: 无法解析 Excel，请确认文件有效且未加密"); }
}

export function excelText(sheets: ExcelSheet[]): string {
  return sheets.map((sheet) => [
    `# Sheet: ${sheet.name}`,
    ...sheet.rows.map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(",")),
  ].join("\n")).join("\n\n");
}
