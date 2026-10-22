import { issuePilotConfig } from "../../issue-pilot.config.ts";
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
      if (url.protocol !== "https:" || url.username || url.password || url.port || !issuePilotConfig.limits.capability.dingtalk.attachmentHosts.includes(url.hostname)) throw new DingtalkError("dingtalk_attachment_host_not_allowed");
      const response = await request(url, { signal, redirect: "error" });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new DingtalkError("dingtalk_attachment_download_failed"); }
      async function* chunks() {
        const reader = response.body!.getReader();
        try {
          while (true) { const { done, value } = await reader.read(); if (done) return; yield value; }
        } finally { await reader.cancel(); reader.releaseLock(); }
      }
      const staged = await stageAttachment(file.fileName, response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream", chunks());
      pending.push(staged);
      if (staged.size !== file.size) throw new DingtalkError("dingtalk_attachment_size_changed", 409);
    }
    return pending;
  } catch (error) {
    await removePendingAttachments(pending);
    if (signal.aborted) throw signal.reason;
    if (error instanceof DingtalkError) throw error;
    throw new DingtalkError("dingtalk_attachment_download_failed");
  }
}
