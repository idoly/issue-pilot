import { render, screen } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { AttachmentPreview } from "./AttachmentPreview";

it("offers an Excel attachment download without fetching or parsing its contents", () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const attachment = { id: "workbook", fileName: "input.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 512, sha256: "a".repeat(64), createdAt: "2026-10-02T00:00:00Z" };
  render(() => <AttachmentPreview issueKey="ISSUE-1" attachment={attachment} onClose={() => {}} />);
  expect(screen.getByText("此格式不支持内嵌预览")).toBeTruthy();
  expect(screen.getByRole("link", { name: "下载附件" }).getAttribute("href")).toBe("/api/issues/ISSUE-1/attachments/workbook");
  expect(fetchMock).not.toHaveBeenCalled();
});
