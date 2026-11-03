import { attachmentUrl, issueWorkFileUrl, type IssueDetail } from "../data/client";
import { Markdown } from "../ui/Markdown";

type IssueFileContext = Pick<IssueDetail, "id" | "workingDirectory"> & {
  attachments: Array<Pick<IssueDetail["attachments"][number], "id" | "fileName" | "storedFileName">>;
  relatedIssues?: Array<Pick<NonNullable<IssueDetail["relatedIssues"]>[number], "id">>;
};

export function resolveIssueFileLink(href: string, issue: IssueFileContext): string | null | undefined {
  if (href.startsWith("/api/") || href.startsWith("/?") || href === "/" || /^(?:mailto:|tel:|#)/i.test(href)) return undefined;
  if (/^(?:https?:|\/\/)/i.test(href)) {
    try {
      const url = new URL(href, window.location.href);
      const rawPath = href.replace(/^(?:https?:)?\/\/[^/?#]+/i, "").split(/[?#]/, 1)[0]!;
      if (url.origin !== window.location.origin || !/\/(?:issues|workspaces)\/issue-\d{8}-\d{3,}\//i.test(decodeURIComponent(rawPath))) return undefined;
      // Keep the raw path so URL normalization cannot hide traversal. Retired issues/ URLs
      // are recognized above only to reject their old layout below, never to convert it.
      href = rawPath;
    } catch {
      return null;
    }
  }
  let selected: string;
  try {
    selected = decodeURIComponent(href);
  } catch {
    return null;
  }
  if (selected.includes("\\") || selected.includes("\0") || selected.split("/").some((part) => part === ".." || part.toLowerCase() === ".git")) return null;
  selected = selected.replace(/^file:\/\//i, "");
  let relatedKey: string | undefined;
  let kind: "work" | "name" = "name";
  if (selected.startsWith("sandbox:/mnt/data/")) selected = selected.slice("sandbox:/mnt/data/".length);
  else if (/^[a-z][a-z0-9+.-]*:/i.test(selected)) return null;
  else if (issue.workingDirectory && selected.startsWith(`${issue.workingDirectory}/`)) {
    selected = selected.slice(issue.workingDirectory.length + 1);
    kind = "work";
  } else if (selected.startsWith("/") || selected.startsWith("~/")) {
    const match = /\/workspaces\/(issue-\d{8}-\d{3,})\/(.*)$/i.exec(selected);
    if (!match) return null;
    const owner = match[1]!.toUpperCase();
    if (owner !== issue.id) {
      if (!issue.relatedIssues?.some((related) => related.id === owner)) return null;
      relatedKey = owner;
    }
    selected = match[2]!;
    kind = "work";
  } else selected = selected.replace(/^\.\//, "");
  if (!selected) return null;
  if (relatedKey) return kind === "work" ? issueWorkFileUrl(issue.id, `.related-${relatedKey.toLowerCase()}/${selected}`) : null;
  const originals = issue.attachments.filter((file) => file.storedFileName === selected || (kind !== "work" && file.fileName === selected));
  if (originals.length === 1) return attachmentUrl(issue.id, originals[0]!.id);
  return issueWorkFileUrl(issue.id, selected);
}

export function IssueMarkdown(props: { source: string; issue: IssueFileContext }) {
  return <Markdown source={props.source} resolveLink={(href) => resolveIssueFileLink(href, props.issue)} />;
}
