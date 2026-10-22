import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesDingtalkUser, parseDingtalkTable } from "../../src/mcp/dingtalk.ts";

test("DingTalk links use the table from direct or iframe parameters and ignore view settings", () => {
  const expected = { baseId: "base", tableId: "table", url: "https://alidocs.dingtalk.com/i/nodes/base?entrance=data&sheetId=table" };
  for (const query of [
    "entrance=data&sheetId=table&token=fixture-secret",
    "iframeQuery=entrance%3Ddata%26sheetId%3Dtable%26token%3Dfixture-secret",
    "sheetId=table&viewId=view",
    "iframeQuery=entrance%3Ddata%26sheetId%3Dtable%26viewId%3Dview",
    "sheetId=table&viewId=..%2Fview",
  ]) assert.deepEqual(parseDingtalkTable(`https://alidocs.dingtalk.com/i/nodes/base?${query}`), expected);
  assert.deepEqual(parseDingtalkTable("https://docs.dingtalk.com/i/nodes/base?iframeQuery=sheetId%3Dtable"), expected);
});

test("DingTalk record links retain exact row selection and omit view or share credentials", () => {
  assert.deepEqual(parseDingtalkTable("https://alidocs.dingtalk.com/notable/record?dentryUuid=base&rowId=row&sheetId=table&viewId=view&token=fixture-private"), { baseId: "base", tableId: "table", recordId: "row", url: "https://alidocs.dingtalk.com/notable/record?dentryUuid=base&rowId=row&sheetId=table" });
  for (const query of ["dentryUuid=base&sheetId=table", "rowId=row&sheetId=table", "dentryUuid=base&sheetId=table&rowId=..%2Frow"]) assert.throws(() => parseDingtalkTable(`https://alidocs.dingtalk.com/notable/record?${query}`), /invalid_dingtalk_table_url/);
});

test("embedded query parameters cannot bypass table link validation", () => {
  for (const url of [
    "https://alidocs.dingtalk.com/i/nodes/base?iframeQuery=entrance%3Ddata%26viewId%3Dview",
    "https://alidocs.dingtalk.com/i/nodes/base?iframeQuery=sheetId%3D..%252Ftable",
    "https://alidocs.dingtalk.com/i/nodes/base?sheetId=&iframeQuery=sheetId%3Dtable",
    "https://alidocs.dingtalk.com/i/nodes/base?iframeQuery=entrance%3Ddocument%26sheetId%3Dtable",
    "https://other.example.test/i/nodes/base?iframeQuery=sheetId%3Dtable",
    "http://alidocs.dingtalk.com/i/nodes/base?iframeQuery=sheetId%3Dtable",
    "https://user:password@alidocs.dingtalk.com/i/nodes/base?iframeQuery=sheetId%3Dtable",
  ]) assert.throws(() => parseDingtalkTable(url), /^Error: invalid_dingtalk_table_url$/);
});

test("current user matching accepts decorated names and excludes longer names", () => {
  const row = (value: unknown) => ({ recordId: "record", cells: { owner: value } });
  assert.equal(matchesDingtalkUser(row({ value: ["Alice（开发）", "Bob"] }), "owner", "Alice"), true);
  assert.equal(matchesDingtalkUser(row({ value: ["负责人：严欣（开发）"] }), "owner", "严欣"), true);
  assert.equal(matchesDingtalkUser(row("严欣然"), "owner", "严欣"), false);
  assert.equal(matchesDingtalkUser(row("AliceExtra"), "owner", "Alice"), false);
  assert.equal(matchesDingtalkUser(row("Bob"), "owner", "Alice"), false);
  assert.equal(matchesDingtalkUser(row("Alice"), "owner", ""), false);
});
