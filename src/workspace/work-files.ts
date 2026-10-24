import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { KeyedSerialQueue } from "../serial.ts";
import { legacyIssueRoot, issueRoot } from "./state.ts";

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
  return name === ".issue-git" || name.startsWith(".session-") || name.startsWith(".runtime-") || name.startsWith(".attachment-") || name === ".issue-runtime.json" || name === ".legacy-output-links.json" || /^\.related-issue-[0-9]{8}-[0-9]{3,}\.jsonl?$/.test(name);
}
function inside(root: string, selected: string): boolean { const relative = path.relative(root, selected); return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }

export async function prepareIssueWorkDirectory(stateRoot: string, issueKey: string): Promise<string> {
  const legacy = legacyIssueRoot(stateRoot, issueKey);
  const oldEntries = await readdir(legacy).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (oldEntries.length) throw new Error("issue_layout_migration_required");
  const root = issueRoot(stateRoot, issueKey);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) throw new Error("invalid_issue_work_directory");
  return root;
}

async function resolveWorkPath(stateRoot: string, issueKey: string, relative: string, access: WorkFileAccess): Promise<string> {
  if (relative.includes("\0") || relative.includes("\\") || path.isAbsolute(relative) || relative.split("/").some(segment => segment === ".." || segment.toLowerCase() === ".git")) throw new Error("invalid_issue_file_path");
  const root = issueRoot(stateRoot, issueKey);
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
  const issueRoots = [issueRoot(stateRoot, issueKey), ...Object.entries(access.readRoots ?? {}).filter(([prefix]) => /^\.related-issue-[0-9]{8}-[0-9]{3,}$/.test(prefix)).map(([, root]) => root)];
  if (isManagedIssueFile(relative) || issueRoots.some(root => inside(root, target) && isManagedIssueFile(path.relative(root, target)))) throw new Error("managed_issue_file_private");
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("issue_file_not_regular");
    return { handle, size: metadata.size, fileName: path.basename(target) };
  } catch (error) { await handle.close(); throw error; }
}

export interface WorkFileMetadata {
  fileName: string;
  size: number;
  updatedAt: string;
}

// A destination can have several store instances, but only one active producer.
const writes = new KeyedSerialQueue();

export function workFileName(value: string): string {
  if (!value || /[/\\\0]/.test(value) || value === "." || value === ".." || value.toLowerCase() === ".git" || isManagedIssueFile(value) || Buffer.byteLength(value) > issuePilotConfig.limits.filesystemNameBytes) {
    throw new Error("invalid_work_file_name");
  }
  return value;
}

async function cleanupWorkFile(handle: FileHandle, temporary: string, primary: unknown[]): Promise<void> {
  const failures: unknown[] = [];
  try {
    await handle.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await unlink(temporary);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) failures.push(error);
  }
  if (failures.length) throw new AggregateError([...primary, ...failures], "work_file_cleanup_failed");
}

/** Publish unique SDK files only after their complete contents have been written. */
export function generatedWorkFileSaver(root: string, prefix: "codemode" | "mcp") {
  return async (data: string | Uint8Array, extension: string): Promise<string> => {
    if (!/^\.[a-z0-9]{1,8}$/i.test(extension)) throw new Error("invalid_work_file_extension");
    if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) throw new Error("invalid_issue_work_directory");
    const id = randomUUID();
    const target = path.join(root, `${prefix}-${id}${extension}`);
    const temporary = path.join(root, `.work-file-${id}.tmp`);
    // A failed exclusive open does not transfer ownership of the existing path.
    const handle = await open(temporary, "wx", 0o600);
    const failures: unknown[] = [];
    try {
      await handle.writeFile(data);
      await handle.close();
      await link(temporary, target);
      return target;
    } catch (error) {
      failures.push(error);
      throw error;
    } finally {
      await cleanupWorkFile(handle, temporary, failures);
    }
  };
}

export class IssueWorkFileStore {
  private readonly stateRoot: string;
  private readonly issueKey: string;

  constructor(stateRoot: string, issueKey: string) {
    this.stateRoot = stateRoot;
    this.issueKey = issueKey;
  }

  get directory(): string {
    return issueRoot(this.stateRoot, this.issueKey);
  }

  downloadPath(fileName: string): string {
    return `/api/issues/${encodeURIComponent(this.issueKey.toUpperCase())}/files/download?path=${encodeURIComponent(workFileName(fileName))}`;
  }

  async generate<T>(
    fileName: string,
    producer: (append: (content: string | Uint8Array) => Promise<void>) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<WorkFileMetadata & { result: T }> {
    const selected = workFileName(fileName);
    const target = path.join(this.directory, selected);
    return writes.run(target, async () => {
      signal?.throwIfAborted();
      await prepareIssueWorkDirectory(this.stateRoot, this.issueKey);
      const temporary = path.join(this.directory, `.work-file-${randomUUID()}.tmp`);
      const present = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (present && !present.isFile()) throw new Error("invalid_work_file");
      const handle = await open(temporary, "wx", 0o600);
      const failures: unknown[] = [];
      try {
        signal?.throwIfAborted();
        const result = await producer(async content => { await handle.writeFile(content); });
        const metadata = await handle.stat();
        await handle.close();
        signal?.throwIfAborted();
        await rename(temporary, target);
        return { fileName: selected, size: metadata.size, updatedAt: metadata.mtime.toISOString(), result };
      } catch (error) {
        failures.push(error);
        throw error;
      } finally {
        await cleanupWorkFile(handle, temporary, failures);
      }
    });
  }
}
