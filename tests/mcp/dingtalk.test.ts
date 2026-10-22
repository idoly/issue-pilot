import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDingtalkTable } from "../../src/mcp/dingtalk.ts";

test("DingTalk table links accept direct and iframeQuery sheet IDs and discard share credentials", () => {
  const expected = { baseId: "base", tableId: "table", url: "https://alidocs.dingtalk.com/i/nodes/base?entrance=data&sheetId=table" };
  for (const url of [
    "https://alidocs.dingtalk.com/i/nodes/base?entrance=data&sheetId=table&viewId=view&token=fixture-secret",
    "https://alidocs.dingtalk.com/i/nodes/base?iframeQuery=entrance%3Ddata%26sheetId%3Dtable%26viewId%3Dview%26token%3Dfixture-secret",
    "https://docs.dingtalk.com/i/nodes/base?iframeQuery=sheetId%3Dtable",
  ]) assert.deepEqual(parseDingtalkTable(url), expected);
  assert.deepEqual(parseDingtalkTable("https://alidocs.dingtalk.com/i/nodes/base?sheetId=table&iframeQuery=sheetId%3Dother"), expected);
});

test("embedded query parameters cannot bypass table link validation", () => {
  for (const url of [
    "https://alidocs.dingtalk.com/i/nodes/base?iframeQuery=entrance%3Ddata%26viewId%3Dview",
    "https://alidocs.dingtalk.com/i/nodes/base?iframeQuery=sheetId%3D..%252Ftable",
    "https://alidocs.dingtalk.com/i/nodes/base?sheetId=&iframeQuery=sheetId%3Dtable",
    "https://other.example.test/i/nodes/base?iframeQuery=sheetId%3Dtable",
    "http://alidocs.dingtalk.com/i/nodes/base?iframeQuery=sheetId%3Dtable",
    "https://user:password@alidocs.dingtalk.com/i/nodes/base?iframeQuery=sheetId%3Dtable",
  ]) assert.throws(() => parseDingtalkTable(url), /^Error: invalid_dingtalk_table_url$/);
});
