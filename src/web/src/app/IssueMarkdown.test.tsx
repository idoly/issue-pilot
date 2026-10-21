import { describe, expect, it } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { IssueMarkdown, resolveIssueFileLink } from "./IssueMarkdown";
import type { IssueDetail } from "../data/client";

const issue = {
  id: "ISSUE-20261021-001", workingDirectory: "/state/workspaces/issue-20261021-001",
  outputs: [{ fileName: "库存 #1.xlsx", size: 10, updatedAt: "2026-10-21T00:00:00Z" }],
  attachments: [{ id: "image-id", fileName: "图片.png", workingFileName: "uuid-图片.png" }],
} as IssueDetail;

describe("Issue file links", () => {
  it("turns published filesystem, relative and sandbox links into encoded download URLs", () => {
    const expected = `/api/issues/${issue.id}/outputs/${encodeURIComponent("库存 #1.xlsx")}`;
    for (const href of ["库存 #1.xlsx", "./outputs/库存 #1.xlsx", "sandbox:/mnt/data/库存%20%231.xlsx", "file:///state/issues/issue-20261021-001/outputs/库存%20%231.xlsx"]) expect(resolveIssueFileLink(href, issue)).toBe(expected);
    expect(resolveIssueFileLink("attachments/uuid-图片.png", issue)).toBe(`/api/issues/${issue.id}/attachments/image-id`);
    expect(resolveIssueFileLink("/state/workspaces/issue-20261021-001/checkpoint.json", issue)).toBe(`/api/issues/${issue.id}/files/download?path=checkpoint.json`);
  });
  it("does not guess unpublished results or map other Issues and traversal paths", () => {
    for (const href of ["sandbox:/mnt/data/missing.xlsx", "file:///etc/passwd", "/state/issues/issue-20261021-002/outputs/库存 #1.xlsx", "../库存 #1.xlsx", "%2e%2e/secret", "work/.git/config", "javascript:alert(1)"]) expect(resolveIssueFileLink(href, issue)).toBeNull();
    expect(resolveIssueFileLink("https://example.com/report", issue)).toBeUndefined();
  });
  it("keeps Markdown sanitization and isolates file resolution between Issue contexts", async () => {
    const [selected, setSelected] = createSignal(issue, { ownedWrite: true });
    const view = render(() => <IssueMarkdown issue={selected()} source={'[下载](sandbox:/mnt/data/库存%20%231.xlsx) <img src="x" onerror="alert(1)">'} />);
    const link = view.container.querySelector("a");
    expect(link?.getAttribute("href")).toBe(`/api/issues/${issue.id}/outputs/${encodeURIComponent("库存 #1.xlsx")}`);
    expect(link?.hasAttribute("download")).toBe(true);
    expect(view.container.querySelector("img")?.hasAttribute("onerror")).toBe(false);
    setSelected({ ...issue, id: "ISSUE-20261021-002", outputs: [] });
    await waitFor(() => expect(view.container.querySelector("a")).toBeNull());
    expect(view.container.textContent).toContain("下载");
  });
});
