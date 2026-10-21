import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { issueRoot, issueWorkDirectory } from "./state.ts";

export interface IssueWorkFile {
  name: string;
  path: string;
  kind: "file" | "directory" | "link" | "special";
  size: number;
  updatedAt: string;
}

export async function prepareIssueWorkDirectory(stateRoot: string, issueKey: string): Promise<string> {
  const legacy = path.join(issueRoot(stateRoot, issueKey), "work");
  const oldEntries = await readdir(legacy).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (oldEntries.length) throw new Error("issue_work_directory_migration_required");
  const root = issueWorkDirectory(stateRoot, issueKey);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) throw new Error("invalid_issue_work_directory");
  return root;
}

async function resolveWorkPath(stateRoot: string, issueKey: string, relative: string): Promise<string> {
  if (relative.includes("\0") || relative.includes("\\") || path.isAbsolute(relative) || relative.split("/").some(segment => segment === ".." || segment.toLowerCase() === ".git")) throw new Error("invalid_issue_file_path");
  const root = issueWorkDirectory(stateRoot, issueKey);
  if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) throw new Error("invalid_issue_work_directory");
  const target = await realpath(path.resolve(root, relative || "."));
  const selected = path.relative(root, target);
  if (selected === ".." || selected.startsWith(`..${path.sep}`) || path.isAbsolute(selected) || selected.split(path.sep).some(segment => segment.toLowerCase() === ".git")) throw new Error("invalid_issue_file_path");
  return target;
}

export async function listIssueWorkFiles(stateRoot: string, issueKey: string, relative = ""): Promise<IssueWorkFile[]> {
  const target = await resolveWorkPath(stateRoot, issueKey, relative);
  if (!(await lstat(target)).isDirectory()) throw new Error("issue_file_not_directory");
  const entries = await readdir(target, { withFileTypes: true });
  if (entries.length > issuePilotConfig.limits.sourceBrowser.directoryEntries) throw new Error("issue_file_directory_too_large");
  const files = await Promise.all(entries.filter(entry => entry.name.toLowerCase() !== ".git").map(async entry => {
    const metadata = await lstat(path.join(target, entry.name));
    return {
      name: entry.name,
      path: path.posix.join(relative, entry.name),
      kind: metadata.isSymbolicLink() ? "link" as const : metadata.isDirectory() ? "directory" as const : metadata.isFile() ? "file" as const : "special" as const,
      size: metadata.size,
      updatedAt: metadata.mtime.toISOString(),
    };
  }));
  return files.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
}

export async function openIssueWorkFile(stateRoot: string, issueKey: string, relative: string) {
  const target = await resolveWorkPath(stateRoot, issueKey, relative);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("issue_file_not_regular");
    return { handle, size: metadata.size, fileName: path.basename(target) };
  } catch (error) { await handle.close(); throw error; }
}
