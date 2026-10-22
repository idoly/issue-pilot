import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { IssueDetail } from "../data/client";
import { AttachmentPreview } from "./AttachmentPreview";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

for (const action of ["close", "switch"] as const) it(`cancels an attachment request when the preview ${action === "close" ? "closes" : "changes files"}`, async () => {
  const responses: Array<(response: Response) => void> = [];
  const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>(resolve => { responses.push(resolve); }));
  vi.stubGlobal("fetch", fetchMock);
  const original = { id: "old", fileName: "old.txt", mediaType: "text/plain", size: 16, sha256: "a".repeat(64) };
  const [selected, setSelected] = createSignal<IssueDetail["attachments"][number] | null>(original, { ownedWrite: true });
  render(() => <AttachmentPreview issueKey="ISSUE-1" attachment={selected()} onClose={() => setSelected(null)} />);
  try {
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const signal = fetchMock.mock.calls[0]![1]?.signal as AbortSignal | undefined;
    setSelected(action === "close" ? null : { ...original, id: "current", fileName: "current.txt" });
    await waitFor(() => expect(signal?.aborted).toBe(true));
    responses[0]!(new Response("stale attachment text"));
    if (action === "switch") {
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      responses[1]!(new Response("current attachment text"));
      await screen.findByText("current attachment text");
    }
    expect(screen.queryByText("stale attachment text")).toBeNull();
  } finally { for (const resolve of responses) resolve(new Response("fixture cleanup")); }
});

for (const outcome of ["success", "failure"] as const) it(`ignores a previous attachment's clipboard ${outcome}`, async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(url.endsWith("/old") ? "old attachment text" : "current attachment text")));
  const clipboard = await import("../ui/clipboard");
  let finish!: () => void;
  vi.spyOn(clipboard, "copyText").mockImplementationOnce(() => new Promise<void>((resolve, reject) => { finish = outcome === "success" ? resolve : () => reject(new Error("clipboard_write_failed")); }));
  const original = { id: "old", fileName: "old.txt", mediaType: "text/plain", size: 16, sha256: "a".repeat(64) };
  const [selected, setSelected] = createSignal<IssueDetail["attachments"][number]>(original, { ownedWrite: true });
  render(() => <AttachmentPreview issueKey="ISSUE-1" attachment={selected()} onClose={() => {}} />);
  try {
    await screen.findByText("old attachment text");
    fireEvent.click(screen.getByRole("button", { name: "复制文字" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    setSelected({ ...original, id: "current", fileName: "current.txt" });
    await screen.findByText("current attachment text");
    finish(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.getByText("current attachment text")).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制文字" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  } finally { finish?.(); }
});

it("keeps attachment text available after a clipboard failure and allows retry", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("copyable attachment text")));
  const clipboard = await import("../ui/clipboard");
  vi.spyOn(clipboard, "copyText").mockRejectedValueOnce(new Error("clipboard_write_failed")).mockResolvedValueOnce();
  render(() => <AttachmentPreview issueKey="ISSUE-1" attachment={{ id: "text", fileName: "notes.txt", mediaType: "text/plain", size: 16, sha256: "a".repeat(64) }} onClose={() => {}} />);
  await screen.findByText("copyable attachment text");
  fireEvent.click(screen.getByRole("button", { name: "复制文字" }));
  await screen.findByRole("alert");
  expect(screen.getByText("copyable attachment text")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "复制文字" }));
  await screen.findByRole("button", { name: "已复制" });
  expect(screen.queryByRole("alert")).toBeNull();
});

it("retries a failed attachment preview while retaining the download action", async () => {
  const fetchMock = vi.fn().mockRejectedValueOnce(new Error("network_failed")).mockResolvedValueOnce(new Response("Recovered attachment"));
  vi.stubGlobal("fetch", fetchMock);
  render(() => <AttachmentPreview issueKey="ISSUE-1" attachment={{ id: "text", fileName: "notes.txt", mediaType: "text/plain", size: 20, sha256: "a".repeat(64) }} onClose={() => {}} />);
  await screen.findByRole("alert");
  expect(screen.queryByRole("link", { name: "下载文件" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByText("Recovered attachment");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
});

it("offers an Excel attachment download without fetching or parsing its contents", () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const attachment = { id: "workbook", fileName: "input.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 512, sha256: "a".repeat(64), createdAt: "2026-10-02T00:00:00Z" };
  render(() => <AttachmentPreview issueKey="ISSUE-1" attachment={attachment} onClose={() => {}} />);
  expect(screen.getByRole("status").textContent).toContain("此格式不支持内嵌预览");
  expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  expect(screen.queryByRole("link", { name: "下载文件" })).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});
