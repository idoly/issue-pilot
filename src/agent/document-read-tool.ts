import { access, readFile } from "node:fs/promises";
import { createReadToolDefinition, detectSupportedImageMimeTypeFromFile } from "@earendil-works/pi-coding-agent";
import { excelText, isExcelFile, parseExcel } from "../documents/excel.ts";

export function createDocumentReadTool(workspaceRoot: string) {
  return createReadToolDefinition(workspaceRoot, {
    operations: {
      access,
      detectImageMimeType: detectSupportedImageMimeTypeFromFile,
      readFile: async (filePath) => {
        const content = await readFile(filePath);
        return isExcelFile(filePath) ? Buffer.from(excelText(parseExcel(content)), "utf8") : content;
      },
    },
  });
}
