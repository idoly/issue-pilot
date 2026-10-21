import { attachmentUrl, issueWorkFileUrl, outputUrl, type IssueDetail } from "../data/client";
import { Markdown } from "../ui/Markdown";

export function resolveIssueFileLink(href: string, issue: Pick<IssueDetail, "id" | "outputs" | "attachments" | "workingDirectory">): string | null | undefined {
  if (/^(?:https?:|mailto:|tel:|\/\/|#)/i.test(href) || href.startsWith("/api/")) return undefined;
  let selected: string;
  try { selected = decodeURIComponent(href); } catch { return null; }
  if (selected.includes("\\") || selected.includes("\0") || selected.split("/").some(part => part === ".." || part.toLowerCase() === ".git")) return null;
  selected = selected.replace(/^file:\/\//i, "");
  let kind: "output" | "attachment" | "work" | "name" | "sandbox" = "name";
  if (selected.startsWith("sandbox:/mnt/data/")) { selected = selected.slice("sandbox:/mnt/data/".length); kind = "sandbox"; }
  else if (/^[a-z][a-z0-9+.-]*:/i.test(selected)) return null;
  else if (issue.workingDirectory && selected.startsWith(`${issue.workingDirectory}/`)) {
    selected = selected.slice(issue.workingDirectory.length + 1); kind = "work";
  } else if (selected.startsWith("/") || selected.startsWith("~/")) {
    const prefix = `/issues/${issue.id.toLowerCase()}/`;
    const offset = selected.indexOf(prefix);
    if (offset < 0) return null;
    selected = selected.slice(offset + prefix.length);
    if (selected.startsWith("outputs/")) { kind = "output"; selected = selected.slice(8); }
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
  if (kind !== "attachment") {
    const output = issue.outputs.find(file => file.fileName === selected);
    if (output) return outputUrl(issue.id, output.fileName);
  }
  if (kind !== "output") {
    const matches = issue.attachments.filter(file => file.fileName === selected || file.workingFileName === selected);
    if (matches.length === 1) return attachmentUrl(issue.id, matches[0]!.id);
  }
  if (kind === "work" || kind === "name") return issueWorkFileUrl(issue.id, selected);
  return null;
}

export function IssueMarkdown(props: { source: string; issue: IssueDetail }) {
  return <Markdown source={props.source} resolveLink={href => resolveIssueFileLink(href, props.issue)} />;
}
