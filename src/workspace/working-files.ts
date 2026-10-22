import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { legacyIssueRoot, issueWorkDirectory } from "./state.ts";

export interface IssueWorkFile {
  name: string;
  path: string;
  kind: "file" | "directory" | "link" | "special";
  size: number;
  updatedAt: string;
  managed?: boolean;
}
export interface WorkFileAccess { readRoots?: Record<string, string> }
export function isManagedIssueFile(relative: string): boolean {
  const segments = relative.split(path.sep), first = segments[0] ?? "";
  const name = /^\.related-issue-[0-9]{8}-[0-9]{3,}$/.test(first) ? segments[1] ?? "" : first;
  return name.startsWith(".session-") || name.startsWith(".runtime-") || name.startsWith(".attachment-") || name === ".issue-runtime.json" || name === ".legacy-output-links.json" || /^\.related-issue-[0-9]{8}-[0-9]{3,}\.jsonl?$/.test(name);
}
function inside(root: string, selected: string): boolean { const relative = path.relative(root, selected); return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }

export async function prepareIssueWorkDirectory(stateRoot: string, issueKey: string): Promise<string> {
  const legacy = legacyIssueRoot(stateRoot, issueKey);
  const oldEntries = await readdir(legacy).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (oldEntries.length) throw new Error("issue_layout_migration_required");
  const root = issueWorkDirectory(stateRoot, issueKey);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) throw new Error("invalid_issue_work_directory");
  return root;
}

async function resolveWorkPath(stateRoot: string, issueKey: string, relative: string, access: WorkFileAccess): Promise<string> {
  if (relative.includes("\0") || relative.includes("\\") || path.isAbsolute(relative) || relative.split("/").some(segment => segment === ".." || segment.toLowerCase() === ".git")) throw new Error("invalid_issue_file_path");
  const root = issueWorkDirectory(stateRoot, issueKey);
  if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) throw new Error("invalid_issue_work_directory");
  const target = await realpath(path.resolve(root, relative || "."));
  const selected = path.relative(root, target);
  const allowed = inside(root, target) || Object.entries(access.readRoots ?? {}).some(([prefix, allowedRoot]) => (relative === prefix || relative.startsWith(prefix + "/")) && inside(allowedRoot, target));
  if (!allowed || selected.split(path.sep).some(segment => segment.toLowerCase() === ".git")) throw new Error("invalid_issue_file_path");
  return target;
}

export async function listIssueWorkFiles(stateRoot: string, issueKey: string, relative = "", access: WorkFileAccess = {}): Promise<IssueWorkFile[]> {
  const target = await resolveWorkPath(stateRoot, issueKey, relative, access);
  if (!(await lstat(target)).isDirectory()) throw new Error("issue_file_not_directory");
  const entries = await readdir(target, { withFileTypes: true });
  if (entries.length > issuePilotConfig.limits.sourceBrowser.directoryEntries) throw new Error("issue_file_directory_too_large");
  const files = await Promise.all(entries.filter(entry => entry.name.toLowerCase() !== ".git").map(async entry => {
    const metadata = await lstat(path.join(target, entry.name));
    const selected = path.posix.join(relative, entry.name);
    const permittedDirectory = metadata.isSymbolicLink() && access.readRoots?.[selected] && await realpath(path.join(target, entry.name)) === access.readRoots[selected] && (await stat(access.readRoots[selected]!)).isDirectory();
    return {
      name: entry.name,
      path: selected,
      ...(isManagedIssueFile(selected) ? { managed: true } : {}),
      kind: permittedDirectory ? "directory" as const : metadata.isSymbolicLink() ? "link" as const : metadata.isDirectory() ? "directory" as const : metadata.isFile() ? "file" as const : "special" as const,
      size: metadata.size,
      updatedAt: metadata.mtime.toISOString(),
    };
  }));
  return files.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
}

export async function openIssueWorkFile(stateRoot: string, issueKey: string, relative: string, access: WorkFileAccess = {}) {
  const target = await resolveWorkPath(stateRoot, issueKey, relative, access);
  const issueRoots = [issueWorkDirectory(stateRoot, issueKey), ...Object.entries(access.readRoots ?? {}).filter(([prefix]) => /^\.related-issue-[0-9]{8}-[0-9]{3,}$/.test(prefix)).map(([, root]) => root)];
  if (isManagedIssueFile(relative) || issueRoots.some(root => inside(root, target) && isManagedIssueFile(path.relative(root, target)))) throw new Error("managed_issue_file_private");
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("issue_file_not_regular");
    return { handle, size: metadata.size, fileName: path.basename(target) };
  } catch (error) { await handle.close(); throw error; }
}
