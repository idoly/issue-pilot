import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { utils, write } from "@e965/xlsx";
import { createDocumentReadTool } from "../../src/agent/document-read-tool.ts";
import { parseExcel } from "../../src/documents/excel.ts";

for (const format of ["xlsx", "xls"] as const) {
  test(`reads ${format} worksheets as text with pagination and preserves the original file`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "issue-pilot-excel-"));
    try {
      const workbook = utils.book_new();
      utils.book_append_sheet(workbook, utils.aoa_to_sheet([["姓名", "工号"], ["张三", "00123"], ["<script>alert(1)</script>", "带,逗号"]]), "人员");
      utils.book_append_sheet(workbook, utils.aoa_to_sheet([["日期", "金额"], ["2026-10-16", 123.45]]), "汇总");
      const buffer = write(workbook, { type: "buffer", bookType: format === "xls" ? "biff8" : "xlsx" }) as Buffer;
      const file = path.join(root, `data.${format}`);
      await writeFile(file, buffer, { mode: 0o400 });
      const sheets = parseExcel(buffer);
      assert.deepEqual(sheets.map((sheet) => sheet.name), ["人员", "汇总"]);
      assert.equal(sheets[0]!.rows[1]![1], "00123");
      const tool = createDocumentReadTool(root);
      const result = await tool.execute("read", { path: file, offset: 1, limit: 3 }, undefined, undefined, {} as never);
      const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      assert.match(text, /# Sheet: 人员/);
      assert.match(text, /张三/);
      assert.match(text, /00123/);
      assert.doesNotMatch(text, /# Sheet: 汇总/);
      assert.deepEqual(await readFile(file), Buffer.from(buffer));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("rejects an invalid workbook with a readable error", () => {
  assert.throws(() => parseExcel(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff])), /excel_parse_failed/);
});
