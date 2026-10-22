import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDingtalkTable, resolveDingtalkColumns } from "../../src/mcp/dingtalk.ts";

test("single-record links retain row selection and omit views and credentials", () => {
  assert.deepEqual(parseDingtalkTable("https://alidocs.dingtalk.com/notable/record?dentryUuid=base&rowId=row&sheetId=table&viewId=view&token=private"), { baseId: "base", tableId: "table", recordId: "row", url: "https://alidocs.dingtalk.com/notable/record?dentryUuid=base&rowId=row&sheetId=table" });
});
test("record import rejects table links, missing IDs and other origins", () => {
  for (const url of ["https://alidocs.dingtalk.com/i/nodes/base?sheetId=table", "https://alidocs.dingtalk.com/notable/record?dentryUuid=base&sheetId=table", "https://other.example.test/notable/record?dentryUuid=base&sheetId=table&rowId=row", "https://alidocs.dingtalk.com/notable/record?dentryUuid=base&sheetId=table&rowId=..%2Frow", "http://alidocs.dingtalk.com/notable/record?dentryUuid=base&sheetId=table&rowId=row"]) assert.throws(() => parseDingtalkTable(url), /invalid_dingtalk_record_url/);
});
test("file field mappings resolve exact names or IDs and reject ambiguity", () => {
  const fields = [{ id: "title", name: "工单标题", type: "text" }, { id: "custom", name: "另一个标题", type: "text" }];
  assert.equal(resolveDingtalkColumns(fields, { title: "另一个标题" }).title, "custom");
  assert.equal(resolveDingtalkColumns(fields, { title: "custom" }).title, "custom");
  assert.equal(resolveDingtalkColumns(fields, { attachments: "" }).attachments, "");
  assert.throws(() => resolveDingtalkColumns(fields, { title: "missing" }), /dingtalk_fields_changed/);
  assert.throws(() => resolveDingtalkColumns([...fields, { id: "duplicate", name: "另一个标题", type: "text" }], { title: "另一个标题" }), /dingtalk_fields_changed/);
});
