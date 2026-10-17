import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import { KeyedSerialQueue } from "../serial.ts";
import { issueOutputRoot } from "../workspace/state.ts";

const outputNamePattern = /^[^/\\\0]{1,255}$/;

export interface IssueOutput {
  fileName: string;
  size: number;
  updatedAt: string;
}

export function outputFileName(value: string): string {
  if (!outputNamePattern.test(value) || value === "." || value === ".." || value !== path.basename(value)) throw new Error("invalid_output_file_name");
  return value;
}

async function secureOutputRoot(stateRoot: string, issueKey: string): Promise<string> {
  const root = issueOutputRoot(stateRoot, issueKey);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0) throw new Error("insecure_issue_output_root");
  return root;
}

async function outputMetadata(root: string, fileName: string): Promise<IssueOutput> {
  const target = path.join(root, outputFileName(fileName));
  const metadata = await lstat(target);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || path.dirname(target) !== root) throw new Error("insecure_issue_output_file");
  return { fileName, size: metadata.size, updatedAt: metadata.mtime.toISOString() };
}

export async function listIssueOutputs(stateRoot: string, issueKey: string): Promise<IssueOutput[]> {
  const root = issueOutputRoot(stateRoot, issueKey);
  const rootMetadata = await lstat(root).catch((error) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!rootMetadata) return [];
  if (!rootMetadata.isDirectory() || (rootMetadata.mode & 0o077) !== 0) throw new Error("insecure_issue_output_root");
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile() || !outputNamePattern.test(entry.name))) throw new Error("insecure_issue_output_file");
  const outputs = await Promise.all(entries.map((entry) => outputMetadata(root, entry.name)));
  return outputs.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.fileName.localeCompare(right.fileName));
}

export async function resolveIssueOutput(stateRoot: string, issueKey: string, fileName: string): Promise<string> {
  const root = issueOutputRoot(stateRoot, issueKey);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || (rootMetadata.mode & 0o077) !== 0) throw new Error("insecure_issue_output_root");
  await outputMetadata(root, fileName);
  return path.join(root, fileName);
}

export type OutputAppender = (content: string | Uint8Array) => Promise<void>;

export class IssueOutputStore {
  private readonly queue = new KeyedSerialQueue();
  private readonly stateRoot: string;
  private readonly issueKey: string;

  constructor(stateRoot: string, issueKey: string) {
    this.stateRoot = stateRoot;
    this.issueKey = issueKey;
  }

  get directory(): string {
    return issueOutputRoot(this.stateRoot, this.issueKey);
  }

  list(): Promise<IssueOutput[]> {
    return listIssueOutputs(this.stateRoot, this.issueKey);
  }

  async read(fileName: string): Promise<Buffer> {
    return readFile(await resolveIssueOutput(this.stateRoot, this.issueKey, fileName));
  }

  write(fileName: string, content: string): Promise<IssueOutput> {
    return this.generate(fileName, async (append) => { await append(content); });
  }

  async generate<T>(fileName: string, producer: (append: OutputAppender) => Promise<T>): Promise<IssueOutput & { result: T }> {
    const selected = outputFileName(fileName);
    return this.queue.run(selected, async () => {
      const root = await secureOutputRoot(this.stateRoot, this.issueKey);
      const target = path.join(root, selected);
      const temporary = path.join(path.dirname(root), `.output-${randomUUID()}.tmp`);
      let handle;
      try {
        await lstat(target).then((metadata) => {
          if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new Error("insecure_issue_output_file");
        }, (error) => {
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
          throw error;
        });
        handle = await open(temporary, "wx", 0o600);
        const append: OutputAppender = async (content) => { await handle!.writeFile(content); };
        const result = await producer(append);
        await handle.close();
        handle = undefined;
        await rename(temporary, target);
        return { ...await outputMetadata(root, selected), result };
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  }
}
