import assert from "node:assert/strict";
import { test } from "node:test";
import fs, { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { downloadDingtalkAttachments } from "../../src/http/dingtalk-attachments.ts";
import { removePendingAttachments } from "../../src/http/attachment-store.ts";
import { errorChain, errorDiagnostic } from "../../src/diagnostics.ts";

const file = { id: "file", fileName: "evidence.txt", size: 4, url: "https://alidocs2.oss-cn-zhangjiakou.aliyuncs.com/file?signature=fixture-private" };

for (const operation of ["mkdtemp", "open"] as const) {
  test(`cancels the download when staging ${operation} fails before reading the body`, async (context) => {
    let cancellations = 0;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancellations++;
      },
    });
    context.mock.method(fs, operation, async () => {
      throw Object.assign(new Error("fixture_staging_failed"), { code: "ENOSPC" });
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        downloadDingtalkAttachments([file], new AbortController().signal, async () => new Response(stream)),
        /dingtalk_attachment_download_failed/,
      );
      assert.equal(cancellations, 1);
      assert.equal(stream.locked, false);
    } finally {
      context.mock.restoreAll();
      syncBuiltinESMExports();
      if (!cancellations) await stream.cancel();
    }
  });
}

test("preserves staging and response cleanup failures even when the import is cancelled", async (context) => {
  const controller = new AbortController();
  const staging = Object.assign(new Error("fixture-private-staging-details"), { code: "ENOSPC" });
  const cleanup = new Error("fixture-private-response-details");
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      throw cleanup;
    },
  });
  context.mock.method(fs, "mkdtemp", async () => {
    controller.abort();
    throw staging;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      downloadDingtalkAttachments([file], controller.signal, async () => new Response(stream)),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "dingtalk_attachment_cleanup_failed");
        assert.ok(errorChain(error).includes(staging));
        assert.ok(errorChain(error).includes(cleanup));
        assert.doesNotMatch(String(errorDiagnostic(error)), /fixture-private/);
        return true;
      },
    );
    assert.equal(stream.locked, false);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await stream.cancel().catch(() => undefined);
  }
});

test("reports response cleanup failure after an unsuccessful HTTP status", async () => {
  const cleanup = new Error("fixture-private-response-cleanup");
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      throw cleanup;
    },
  });
  await assert.rejects(
    downloadDingtalkAttachments([file], new AbortController().signal, async () => new Response(stream, { status: 503 })),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "dingtalk_attachment_cleanup_failed");
      assert.ok(errorChain(error).includes(cleanup));
      assert.ok(errorChain(error).some((cause) => cause instanceof Error && cause.message === "dingtalk_attachment_download_failed"));
      return true;
    },
  );
  assert.equal(stream.locked, false);
});
test("downloads attachment bytes to private staging and validates size", async () => {
  const pending = await downloadDingtalkAttachments([file], new AbortController().signal, async (_url, init) => {
    assert.equal(init?.redirect, "error");
    assert.equal(init?.headers, undefined);
    return new Response("data", { headers: { "content-type": "text/plain; charset=utf-8" } });
  });
  try {
    assert.equal(pending[0]!.size, 4);
    assert.equal(pending[0]!.mediaType, "text/plain");
    assert.equal((await stat(pending[0]!.temporaryPath)).mode & 0o777, 0o600);
    assert.equal(await readFile(pending[0]!.temporaryPath, "utf8"), "data");
  } finally {
    await removePendingAttachments(pending);
  }
});
test("rejects untrusted download targets before network access", async () => {
  for (const url of [
    "http://alidocs2.oss-cn-zhangjiakou.aliyuncs.com/file",
    "https://127.0.0.1/file",
    "https://alidocs2.oss-cn-zhangjiakou.aliyuncs.com.evil.test/file",
    "https://user:pass@alidocs2.oss-cn-zhangjiakou.aliyuncs.com/file",
  ]) {
    await assert.rejects(
      downloadDingtalkAttachments([{ ...file, url }], new AbortController().signal, async () => {
        assert.fail("must not fetch");
      }),
      /dingtalk_attachment_host_not_allowed/,
    );
  }
});
test("releases the response reader when the download stream fails", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("fixture-private-download-details"));
    },
  });
  await assert.rejects(
    downloadDingtalkAttachments([file], new AbortController().signal, async () => new Response(stream)),
    { message: "dingtalk_attachment_download_failed" },
  );
  assert.equal(stream.locked, false);
});

test("rejects cancellation after a response arrives and removes completed staging", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled after response");
  const stagingRoot = await mkdtemp(path.join(tmpdir(), "issue-pilot-download-cancel-"));
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = stagingRoot;
  try {
    await assert.rejects(
      downloadDingtalkAttachments([file], controller.signal, async () => {
        queueMicrotask(() => {
          controller.abort(reason);
        });
        return new Response("data");
      }),
      (error) => error === reason,
    );
    assert.deepEqual(await readdir(stagingRoot), []);
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    await rm(stagingRoot, { recursive: true, force: true });
  }
});

test("rejects truncated attachments and preserves cancellation", async () => {
  await assert.rejects(
    downloadDingtalkAttachments([file], new AbortController().signal, async () => new Response("x")),
    /dingtalk_attachment_size_changed/,
  );
  const controller = new AbortController(),
    reason = new Error("cancelled by caller");
  controller.abort(reason);
  await assert.rejects(
    downloadDingtalkAttachments([file], controller.signal, async () => {
      assert.fail("must not fetch");
    }),
    (error) => error === reason,
  );
});
test("stops reading a download as soon as it exceeds the declared size and leaves no staging files", async () => {
  const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("issue-pilot-attachment-")));
  let pulled = 0;
  // An endless replacement object: without a cap, staging would grow until the import deadline.
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(1024));
    },
  });
  await assert.rejects(
    downloadDingtalkAttachments([file], new AbortController().signal, async () => new Response(stream)),
    /dingtalk_attachment_size_changed/,
  );
  assert.ok(pulled < 5, `pulled ${pulled} chunks`);
  const after = (await readdir(tmpdir())).filter((name) => name.startsWith("issue-pilot-attachment-") && !before.has(name));
  assert.deepEqual(after, []);
});
