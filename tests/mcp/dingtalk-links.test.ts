import assert from "node:assert/strict";
import { test } from "node:test";
import { dingtalkAttachments, dingtalkIssueRecord } from "../../src/mcp/dingtalk.ts";
const columns = { title: "title", description: "description", number: "number", attachments: "attachments" };
const link = { isLink: true, type: "link", filename: "说明文档", resourceUrl: "https://docs.example.test/document", url: "https://docs.example.test/document" };
const file = { resourceId: "file-id", filename: "image.png", size: 4, url: "https://alidocs2.oss-cn-zhangjiakou.aliyuncs.com/image.png" };

test("link attachments are preserved as description links while files remain downloadable", () => {
  const record = { recordId: "one", cells: { title: "Title", description: "Description", attachments: [link, file, { ...file, resourceId: "second", filename: "second.png" }] } };
  const files = dingtalkAttachments(record, "attachments"); assert.equal(files.length, 2); assert.deepEqual(files[0], { id: "file-id", fileName: "image.png", size: 4, url: file.url });
  const imported = dingtalkIssueRecord(record, columns);
  assert.equal(imported.creatable, true); assert.equal(imported.attachments!.length, 2);
  assert.equal(imported.description, "Description\n\n### 附件链接\n\n- [说明文档](<https://docs.example.test/document>)");
});

test("link-only records keep their evidence without pretending to contain downloadable files", () => {
  const record = { recordId: "one", cells: { title: "Title", attachments: [{ ...link, isLink: undefined }] } };
  assert.deepEqual(dingtalkAttachments(record, "attachments"), []);
  assert.match(dingtalkIssueRecord(record, columns).description, /附件链接/);
});

for (const url of ["javascript:alert(1)", "data:text/html,example", "file:///etc/passwd", "https://user:password@docs.example.test/", "https://docs.example.test/\nmalformed", "not-a-url"]) test(`rejects unsafe linked attachment scheme or credentials: ${url.split(":")[0]}`, () => {
  assert.throws(() => dingtalkIssueRecord({ recordId: "one", cells: { title: "Title", attachments: [{ ...link, url }] } }, columns), /invalid_dingtalk_attachments/);
});

test("linked attachment labels cannot inject Markdown and oversized linked evidence fails explicitly", () => {
  const record = { recordId: "one", cells: { title: "Title", attachments: [{ ...link, filename: "name](/unexpected)[<tag>" }] } };
  const imported = dingtalkIssueRecord(record, columns);
  assert.ok(imported.description.includes("name\\](/unexpected)\\[&lt;tag&gt;"));
  assert.ok(!imported.description.includes("<tag>"));
  const oversized = dingtalkIssueRecord({ recordId: "one", cells: { title: "Title", attachments: [{ ...link, url: "https://docs.example.test/" + "a".repeat(8100) }] } }, columns);
  assert.equal(oversized.creatable, false); assert.match(oversized.reason!, /描述超过/);
});

test("ordinary files still require an ID, exact size and valid file name", () => {
  for (const change of [{ resourceId: undefined }, { size: undefined }, { size: "4" }, { filename: "../file" }, { url: undefined }]) assert.throws(() => dingtalkAttachments({ recordId: "one", cells: { attachments: [{ ...file, ...change }] } }, "attachments"), /invalid_dingtalk_attachments/);
});
