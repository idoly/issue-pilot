import { attachmentUrl, issueWorkFileUrl, outputUrl, type IssueDetail } from "../data/client";
import { Markdown } from "../ui/Markdown";

export function resolveIssueFileLink(href: string, issue: Pick<IssueDetail, "id" | "outputs" | "attachments" | "workingDirectory" | "relatedIssues">): string | null | undefined {
  if (href.startsWith("/api/") || href.startsWith("/?") || href === "/" || /^(?:mailto:|tel:|#)/i.test(href)) return undefined;
  if (/^(?:https?:|\/\/)/i.test(href)) {
    try {
      const url = new URL(href, window.location.href);
      const rawPath = href.replace(/^(?:https?:)?\/\/[^/?#]+/i, "").split(/[?#]/, 1)[0]!;
      if (url.origin !== window.location.origin || !/\/(?:issues|workspaces)\/issue-\d{8}-\d{3,}\//i.test(decodeURIComponent(rawPath))) return undefined;
      // Keep the original path so traversal is rejected before URL normalization can hide it.
      href = rawPath;
    } catch { return null; }
  }
  let selected: string;
  try { selected = decodeURIComponent(href); } catch { return null; }
  if (selected.includes("\\") || selected.includes("\0") || selected.split("/").some(part => part === ".." || part.toLowerCase() === ".git")) return null;
  selected = selected.replace(/^file:\/\//i, "");
  let relatedKey: string | undefined;
  let kind: "output" | "attachment" | "work" | "name" | "sandbox" = "name";
  if (selected.startsWith("sandbox:/mnt/data/")) { selected = selected.slice("sandbox:/mnt/data/".length); kind = "sandbox"; }
  else if (/^[a-z][a-z0-9+.-]*:/i.test(selected)) return null;
  else if (issue.workingDirectory && selected.startsWith(`${issue.workingDirectory}/`)) {
    selected = selected.slice(issue.workingDirectory.length + 1); kind = "work";
  } else if (selected.startsWith("/") || selected.startsWith("~/")) {
    const match = /\/(issues|workspaces)\/(issue-\d{8}-\d{3,})\/(.*)$/i.exec(selected);
    if (!match) return null;
    const owner = match[2]!.toUpperCase();
    if (owner !== issue.id) {
      if (!issue.relatedIssues?.some(related => related.id === owner)) return null;
      relatedKey = owner;
    }
    selected = match[3]!;
    if (match[1]!.toLowerCase() === "workspaces") kind = "work";
    else if (selected.startsWith("outputs/")) { kind = "output"; selected = selected.slice(8); }
    else if (selected.startsWith("attachments/")) { kind = "attachment"; selected = selected.slice(12); }
    else if (selected.startsWith("work/")) { kind = "work"; selected = selected.slice(5); }
    else return null;
  } else {
    selected = selected.replace(/^\.\//, "");
    if (selected.startsWith("outputs/")) { kind = "output"; selected = selected.slice(8); }
    else if (selected.startsWith("attachments/")) { kind = "attachment"; selected = selected.slice(12); }
    else if (selected.startsWith("work/")) { kind = "work"; selected = selected.slice(5); }
  }
  if (!selected) return null;
  if (relatedKey) return kind === "work" ? issueWorkFileUrl(issue.id, `.related-${relatedKey.toLowerCase()}/${selected}`) : null;
  if (kind === "work" || kind === "name") {
    const original = issue.attachments.filter(file => file.storedFileName === selected || kind === "name" && file.fileName === selected && file.workingFileName !== selected);
    if (original.length === 1) return attachmentUrl(issue.id, original[0]!.id);
    return issueWorkFileUrl(issue.id, selected);
  }
  if (kind !== "attachment") {
    const output = issue.outputs.find(file => file.fileName === selected);
    if (output) return outputUrl(issue.id, output.fileName);
  }
  if (kind !== "output") {
    const matches = issue.attachments.filter(file => file.fileName === selected || file.workingFileName === selected);
    if (matches.length === 1) return attachmentUrl(issue.id, matches[0]!.id);
  }
  return null;
}

export function IssueMarkdown(props: { source: string; issue: IssueDetail }) {
  return <Markdown source={props.source} resolveLink={href => resolveIssueFileLink(href, props.issue)} />;
}
