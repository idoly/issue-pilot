import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { issuePilotConfig } from "../../../../issue-pilot.config.ts";
import { fetchOutput, type IssueDetail } from "../data/client";
import { OutputPreview } from "./OutputPreview";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const output = { fileName: "report.md", size: 100, updatedAt: "2026-10-02T00:00:00Z" };

describe("output preview", () => {
  it("renders Markdown safely and keeps the full-file download link", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('# Results\n<script>alert(1)</script>\nDone')));
    const view = render(() => <OutputPreview issueKey="ISSUE-1" output={output} onClose={() => {}} />);
    expect(await screen.findByRole("heading", { name: "Results" })).toBeTruthy();
    expect(view.baseElement.querySelector(".output-markdown-preview script")).toBeNull();
    expect(screen.getByRole("link", { name: "下载文件" }).getAttribute("href")).toBe("/api/issues/ISSUE-1/outputs/report.md");
  });

  it("cancels a closed preview and ignores a response that arrives after closing", async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const [selected, setSelected] = createSignal<IssueDetail["outputs"][number] | null>(output, { ownedWrite: true });
    render(() => <OutputPreview issueKey="ISSUE-1" output={selected()} onClose={() => setSelected(null)} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const signal = fetchMock.mock.calls[0]![1].signal as AbortSignal;
    setSelected(null);
    await waitFor(() => expect(signal.aborted).toBe(true));
    finish(new Response("late content"));
    await Promise.resolve();
    expect(screen.queryByText("late content")).toBeNull();
  });

  it("offers an Excel download without fetching or parsing the workbook", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(() => <OutputPreview issueKey="ISSUE-1" output={{ ...output, fileName: "report.xlsx" }} onClose={() => {}} />);
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "此格式暂不支持预览，请下载查看");
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
    expect(screen.getByRole("link", { name: "下载文件" }).getAttribute("href")).toBe("/api/issues/ISSUE-1/outputs/report.xlsx");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses oversized files without requesting their contents", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(() => <OutputPreview issueKey="ISSUE-1" output={{ ...output, size: issuePilotConfig.web.outputPreviewBytes + 1 }} onClose={() => {}} />);
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "文件过大，请下载查看完整内容");
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a failed download and keeps one close action in the footer", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("network_failed")).mockResolvedValueOnce(new Response("Recovered output"));
    vi.stubGlobal("fetch", fetchMock);
    const close = vi.fn();
    render(() => <OutputPreview issueKey="ISSUE-1" output={{ ...output, fileName: "report.txt" }} onClose={close} />);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText("Recovered output");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("previews text larger than the previous 2 MiB limit", async () => {
    const content = "a".repeat(3 * 1024 * 1024);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(content)));
    await expect(fetchOutput("ISSUE-1", "report.txt")).resolves.toBe(content);
  });

  it("rejects a streamed file that grows beyond the preview limit", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array(issuePilotConfig.web.outputPreviewBytes + 1))));
    await expect(fetchOutput("ISSUE-1", "report.txt")).rejects.toThrow("文件过大");
  });
});
