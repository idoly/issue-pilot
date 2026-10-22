import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, stat } from "node:fs/promises";
import { downloadDingtalkAttachments } from "../../src/http/dingtalk-attachments.ts";
import { removePendingAttachments } from "../../src/http/attachment-store.ts";

const file = { id: "file", fileName: "evidence.txt", size: 4, url: "https://alidocs2.oss-cn-zhangjiakou.aliyuncs.com/file?signature=fixture-private" };
test("downloads attachment bytes to private staging and validates size", async () => {
  const pending = await downloadDingtalkAttachments([file], new AbortController().signal, async (_url, init) => {
    assert.equal(init?.redirect, "error"); assert.equal(init?.headers, undefined);
    return new Response("data", { headers: { "content-type": "text/plain; charset=utf-8" } });
  });
  try { assert.equal(pending[0]!.size, 4); assert.equal(pending[0]!.mediaType, "text/plain"); assert.equal((await stat(pending[0]!.temporaryPath)).mode & 0o777, 0o600); assert.equal(await readFile(pending[0]!.temporaryPath, "utf8"), "data"); }
  finally { await removePendingAttachments(pending); }
});
test("rejects untrusted download targets before network access", async () => {
  for (const url of ["http://alidocs2.oss-cn-zhangjiakou.aliyuncs.com/file", "https://127.0.0.1/file", "https://alidocs2.oss-cn-zhangjiakou.aliyuncs.com.evil.test/file", "https://user:pass@alidocs2.oss-cn-zhangjiakou.aliyuncs.com/file"]) {
    await assert.rejects(downloadDingtalkAttachments([{ ...file, url }], new AbortController().signal, async () => { assert.fail("must not fetch"); }), /dingtalk_attachment_host_not_allowed/);
  }
});
test("rejects truncated attachments and preserves cancellation", async () => {
  await assert.rejects(downloadDingtalkAttachments([file], new AbortController().signal, async () => new Response("x")), /dingtalk_attachment_size_changed/);
  const controller = new AbortController(), reason = new Error("cancelled by caller"); controller.abort(reason);
  await assert.rejects(downloadDingtalkAttachments([file], controller.signal, async () => { assert.fail("must not fetch"); }), error => error === reason);
});
