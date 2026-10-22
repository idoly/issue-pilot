import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { issueOutputRoot, issueWorkDirectory } from "../workspace/state.ts";
import { workFileName } from "../workspace/work-file-store.ts";

/** Legacy download compatibility only. New producers write directly to the Issue working directory. */
export { IssueWorkFileStore as IssueOutputStore, workFileName as outputFileName } from "../workspace/work-file-store.ts";
export interface IssueOutput { fileName: string; size: number; updatedAt: string }
export const legacyOutputLinksFile = ".legacy-output-links.json";
export async function legacyOutputLinks(stateRoot: string, issueKey: string): Promise<Record<string, string>> {
  const root = issueWorkDirectory(stateRoot, issueKey), file = path.join(root, legacyOutputLinksFile);
  const metadata = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!metadata) return {};
  if (!metadata.isFile() || metadata.mode & 0o077) throw new Error("insecure_legacy_output_links");
  const data = JSON.parse(await readFile(file, "utf8"));
  if (data.version !== 1 || !data.files || typeof data.files !== "object" || Array.isArray(data.files)) throw new Error("invalid_legacy_output_links");
  for (const [name, target] of Object.entries(data.files)) { workFileName(name); if (typeof target !== "string") throw new Error("invalid_legacy_output_links"); workFileName(target); }
  return data.files;
}
export async function resolveIssueOutput(stateRoot: string, issueKey: string, fileName: string): Promise<string> {
  const selected = workFileName(fileName), links = await legacyOutputLinks(stateRoot, issueKey);
  const target = Object.hasOwn(links, selected) ? path.join(issueWorkDirectory(stateRoot, issueKey), links[selected]!) : path.join(issueOutputRoot(stateRoot, issueKey), selected);
  if (!(await lstat(target)).isFile() || await realpath(target) !== target) throw new Error("insecure_issue_output_file");
  return target;
}
export async function openLegacyIssueOutput(stateRoot: string, issueKey: string, fileName: string) {
  const target = await resolveIssueOutput(stateRoot, issueKey, fileName);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const info = await handle.stat(); if (!info.isFile()) throw new Error("insecure_issue_output_file"); return { handle, size: info.size }; }
  catch (error) { await handle.close(); throw error; }
}
export async function listIssueOutputs(stateRoot: string, issueKey: string): Promise<IssueOutput[]> {
  const links = await legacyOutputLinks(stateRoot, issueKey);
  const legacy = issueOutputRoot(stateRoot, issueKey);
  const metadata = await lstat(legacy).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (metadata && !metadata.isDirectory()) throw new Error("insecure_issue_output_root");
  const names = new Set([...Object.keys(links), ...(metadata ? await readdir(legacy) : [])]);
  const files = await Promise.all([...names].map(async name => {
    const file = await resolveIssueOutput(stateRoot, issueKey, name), info = await lstat(file);
    return { fileName: name, size: info.size, updatedAt: info.mtime.toISOString() };
  }));
  return files.sort((a, b) => a.fileName.localeCompare(b.fileName));
}
