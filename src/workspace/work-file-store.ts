import { randomUUID } from "node:crypto";
import { link, lstat, open, readdir, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { issuePilotConfig } from "../../issue-pilot.config.ts";
import { KeyedSerialQueue } from "../serial.ts";
import { issueWorkDirectory } from "./state.ts";
import { isManagedIssueFile, openIssueWorkFile, prepareIssueWorkDirectory } from "./working-files.ts";

export interface IssueWorkOutput {
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
    return issueWorkDirectory(this.stateRoot, this.issueKey);
  }

  downloadPath(fileName: string): string {
    return `/api/issues/${encodeURIComponent(this.issueKey.toUpperCase())}/files/download?path=${encodeURIComponent(workFileName(fileName))}`;
  }

  async list(): Promise<IssueWorkOutput[]> {
    await prepareIssueWorkDirectory(this.stateRoot, this.issueKey);
    const entries = await readdir(this.directory, { withFileTypes: true });
    const files = await Promise.all(entries
      .filter(entry => entry.isFile() && entry.name !== ".git" && !isManagedIssueFile(entry.name) && !entry.name.startsWith(".work-file-"))
      .map(async entry => {
        const metadata = await lstat(path.join(this.directory, entry.name));
        if (!metadata.isFile()) throw new Error("invalid_work_file");
        return { fileName: entry.name, size: metadata.size, updatedAt: metadata.mtime.toISOString() };
      }));
    return files.sort((a, b) => a.fileName.localeCompare(b.fileName));
  }

  async read(fileName: string): Promise<Buffer> {
    workFileName(fileName);
    const file = await openIssueWorkFile(this.stateRoot, this.issueKey, fileName);
    try {
      return await file.handle.readFile();
    } finally {
      await file.handle.close();
    }
  }

  write(fileName: string, content: string): Promise<IssueWorkOutput> {
    return this.generate(fileName, async append => { await append(content); });
  }

  async generate<T>(
    fileName: string,
    producer: (append: (content: string | Uint8Array) => Promise<void>) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<IssueWorkOutput & { result: T }> {
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
