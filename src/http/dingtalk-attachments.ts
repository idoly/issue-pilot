import { applicationParameters } from "../configuration/parameters.ts";
import { removePendingAttachments, stageAttachment, type PendingAttachment } from "./attachment-store.ts";
import type { DingtalkAttachment } from "../mcp/dingtalk.ts";
import { DingtalkError } from "../mcp/dingtalk.ts";

/** Only download signed URLs from the configured DingTalk attachment storage hosts. Never forward MCP credentials. */
export async function downloadDingtalkAttachments(files: DingtalkAttachment[], signal: AbortSignal, request: typeof fetch = fetch): Promise<PendingAttachment[]> {
  const pending: PendingAttachment[] = [];
  try {
    for (const file of files) {
      signal.throwIfAborted();
      const url = new URL(file.url);
      if (url.protocol !== "https:" || url.username || url.password || url.port || !applicationParameters().dingtalkAttachmentHosts.includes(url.hostname))
        throw new DingtalkError("dingtalk_attachment_host_not_allowed");
      const response = await request(url, { signal, redirect: "error" });
      if (!response.body) throw new DingtalkError("dingtalk_attachment_download_failed");
      // Own the response before filesystem setup; staging can fail before it starts iterating chunks.
      const reader = response.body.getReader();
      async function* chunks() {
        let received = 0;
        while (true) {
          signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) return;
          // Stop at the declared size instead of staging an unbounded replacement object.
          received += value.byteLength;
          if (received > file.size) throw new DingtalkError("dingtalk_attachment_size_changed", 409);
          yield value;
        }
      }
      const failures: unknown[] = [];
      try {
        if (!response.ok) throw new DingtalkError("dingtalk_attachment_download_failed");
        const staged = await stageAttachment(file.fileName, response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream", chunks());
        pending.push(staged);
        signal.throwIfAborted();
        if (staged.size !== file.size) throw new DingtalkError("dingtalk_attachment_size_changed", 409);
      } catch (error) {
        failures.push(error);
      }
      try {
        await reader.cancel();
      } catch (error) {
        // An errored stream rejects cancel with its original read error; that is not a second failure.
        if (!failures.includes(error)) throw new Error("dingtalk_attachment_cleanup_failed", { cause: new AggregateError([...failures, error]) });
      } finally {
        reader.releaseLock();
      }
      if (failures.length) throw failures[0];
    }
    return pending;
  } catch (error) {
    let failure = error;
    if (error instanceof Error && ["attachment_staging_cleanup_failed", "dingtalk_attachment_cleanup_failed"].includes(error.message))
      failure = new Error("dingtalk_attachment_cleanup_failed", { cause: error });
    else if (signal.aborted) failure = signal.reason;
    else if (!(error instanceof DingtalkError)) failure = new DingtalkError("dingtalk_attachment_download_failed");
    try {
      await removePendingAttachments(pending, [failure]);
    } catch (cleanup) {
      throw new Error("dingtalk_attachment_cleanup_failed", { cause: cleanup });
    }
    throw failure;
  }
}
