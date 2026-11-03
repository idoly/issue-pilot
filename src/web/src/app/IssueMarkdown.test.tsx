import { describe, expect, it } from "vitest";
import { render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { IssueMarkdown, resolveIssueFileLink } from "./IssueMarkdown";

const issue = {
  id: "ISSUE-20261021-001",
  workingDirectory: "/state/workspaces/issue-20261021-001",
  attachments: [{ id: "image-id", fileName: "图片.png", storedFileName: ".attachment-uuid-图片.png" }],
} satisfies Parameters<typeof resolveIssueFileLink>[1];

describe("Issue file links", () => {
  it("normalizes file links to current working files", () => {
    const expected = `/api/issues/${issue.id}/files/download?path=${encodeURIComponent("库存 #1.xlsx")}`;
    for (const href of ["./库存 #1.xlsx", "sandbox:/mnt/data/库存%20%231.xlsx", "file:///state/workspaces/issue-20261021-001/库存%20%231.xlsx"])
      expect(resolveIssueFileLink(href, issue)).toBe(expected);
    for (const href of ["库存 #1.xlsx", "/state/workspaces/issue-20261021-001/库存 #1.xlsx"])
      expect(resolveIssueFileLink(href, issue)).toBe(`/api/issues/${issue.id}/files/download?path=${encodeURIComponent("库存 #1.xlsx")}`);
    expect(resolveIssueFileLink(".attachment-uuid-图片.png", issue)).toBe(`/api/issues/${issue.id}/attachments/image-id`);
    expect(resolveIssueFileLink("uuid-图片.png", issue)).toBe(`/api/issues/${issue.id}/files/download?path=${encodeURIComponent("uuid-图片.png")}`);
    expect(resolveIssueFileLink("图片.png", issue)).toBe(`/api/issues/${issue.id}/attachments/image-id`);
    for (const directory of ["outputs", "work", "attachments"]) {
      const selected = `${directory}/库存 #1.xlsx`;
      expect(resolveIssueFileLink(`./${selected}`, issue)).toBe(`/api/issues/${issue.id}/files/download?path=${encodeURIComponent(selected)}`);
    }
    expect(resolveIssueFileLink("attachments/.attachment-uuid-图片.png", issue)).toBe(`/api/issues/${issue.id}/files/download?path=${encodeURIComponent("attachments/.attachment-uuid-图片.png")}`);
    expect(resolveIssueFileLink("file:///state/issues/issue-20261021-001/outputs/库存%20%231.xlsx", issue)).toBeNull();
    expect(resolveIssueFileLink("/state/workspaces/issue-20261021-001/checkpoint.json", issue)).toBe(`/api/issues/${issue.id}/files/download?path=checkpoint.json`);
  });
  it("blocks unrelated Issues and unsafe paths", () => {
    for (const href of ["file:///etc/passwd", "/state/issues/issue-20261021-002/outputs/库存 #1.xlsx", "../库存 #1.xlsx", "%2e%2e/secret", "work/.git/config", "javascript:alert(1)"])
      expect(resolveIssueFileLink(href, issue)).toBeNull();
    expect(resolveIssueFileLink("https://example.com/report", issue)).toBeUndefined();
  });
  it("resolves current paths only for explicitly related Issues and refuses retired layouts", () => {
    const owner = "ISSUE-20260901-002",
      name = "customer-state-sync-java8-tests.log";
    const current = { ...issue, id: "ISSUE-20261023-003", relatedIssues: [{ id: owner }] } satisfies Parameters<typeof resolveIssueFileLink>[1];
    const selected = `/state/workspaces/${owner.toLowerCase()}/${name}`;
    const expected = `/api/issues/${current.id}/files/download?path=${encodeURIComponent(`.related-${owner.toLowerCase()}/${name}`)}`;
    for (const href of [selected, `file://${selected}`, `${window.location.origin}${selected}?issue=${current.id}`]) expect(resolveIssueFileLink(href, current)).toBe(expected);
    expect(resolveIssueFileLink(`/state/issues/${owner.toLowerCase()}/work/${name}`, current)).toBeNull();
    expect(resolveIssueFileLink(selected, { ...current, relatedIssues: [] })).toBeNull();
    expect(resolveIssueFileLink(`${window.location.origin}${selected}/../secret`, current)).toBeNull();
    expect(resolveIssueFileLink(`https://external.example${selected}`, current)).toBeUndefined();
    expect(resolveIssueFileLink(`/?issue=${owner}`, current)).toBeUndefined();
  });
  it("rewrites raw HTML file links as well as Markdown links before sanitizing", () => {
    const file = `file:///state/workspaces/${issue.id.toLowerCase()}/diagnostics.log`;
    const view = render(() => <IssueMarkdown issue={issue} source={`[Markdown log](${file}) <a href="${file}" onmouseover="alert(1)">HTML log</a> <a href="/etc/passwd">unavailable</a>`} />);
    const links = view.container.querySelectorAll("a");
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.getAttribute("href")).toBe(`/api/issues/${issue.id}/files/download?path=diagnostics.log`);
      expect(link.hasAttribute("download")).toBe(true);
      expect(link.hasAttribute("onmouseover")).toBe(false);
    }
    expect(view.container.textContent).toContain("unavailable");
  });
  it("keeps Markdown sanitization and isolates file resolution between Issue contexts", async () => {
    const [selected, setSelected] = createSignal(issue, { ownedWrite: true });
    const view = render(() => <IssueMarkdown issue={selected()} source={'[下载](sandbox:/mnt/data/库存%20%231.xlsx) <img src="x" onerror="alert(1)">'} />);
    const link = view.container.querySelector("a");
    expect(link?.getAttribute("href")).toBe(`/api/issues/${issue.id}/files/download?path=${encodeURIComponent("库存 #1.xlsx")}`);
    expect(link?.hasAttribute("download")).toBe(true);
    expect(view.container.querySelector("img")?.hasAttribute("onerror")).toBe(false);
    setSelected({ ...issue, id: "ISSUE-20261021-002" });
    await waitFor(() => expect(view.container.querySelector("a")?.getAttribute("href")).toBe(`/api/issues/ISSUE-20261021-002/files/download?path=${encodeURIComponent("库存 #1.xlsx")}`));
    expect(view.container.textContent).toContain("下载");
  });
});
