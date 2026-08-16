import { Event } from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import {
  FilePermission,
  FileSystemProviderCapabilities,
  FileSystemProviderError,
  FileSystemProviderErrorCode,
  FileType,
  type IFileDeleteOptions,
  type IFileOverwriteOptions,
  type IFileSystemProviderWithFileReadWriteCapability,
  type IFileWriteOptions,
  type IStat,
  type IWatchOptions,
} from "@codingame/monaco-vscode-files-service-override";
import type { Uri } from "monaco-editor";

import { errorMessage, loadSourceFile, loadSourceTree, type SourceRepository, type SourceTreeEntry } from "../data/client";

const encoder = new TextEncoder();
const directoryStat: IStat = { type: FileType.Directory, ctime: 0, mtime: 0, size: 0, permissions: FilePermission.Readonly };

function providerError(message: string, code: FileSystemProviderErrorCode): FileSystemProviderError {
  return FileSystemProviderError.create(message, code);
}

function sourceError(error: unknown): FileSystemProviderError {
  const message = errorMessage(error);
  if (message === "source_path_not_found" || message === "source_repository_not_found") return providerError(message, FileSystemProviderErrorCode.FileNotFound);
  if (message === "source_path_not_directory") return providerError(message, FileSystemProviderErrorCode.FileNotADirectory);
  if (message === "source_path_not_file") return providerError(message, FileSystemProviderErrorCode.FileIsADirectory);
  if (message === "source_file_too_large") return providerError(message, FileSystemProviderErrorCode.FileTooLarge);
  if (message === "source_browser_unavailable" || message === "source_runtime_invalid") return providerError(message, FileSystemProviderErrorCode.Unavailable);
  return providerError(message, FileSystemProviderErrorCode.Unknown);
}

export class SourceFileSystemProvider implements IFileSystemProviderWithFileReadWriteCapability {
  readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive | FileSystemProviderCapabilities.Readonly;
  readonly onDidChangeCapabilities = Event.None;
  readonly onDidChangeFile: typeof Event.None = Event.None;
  readonly readOnlyMessage = { value: "Issue Pilot代码工作台为只读" };

  private readonly repositoryByName: Map<string, SourceRepository>;
  private readonly directoryRequests = new Map<string, Promise<SourceTreeEntry[]>>();
  private readonly workspaceBytes: Uint8Array;
  readonly workspacePath: string;
  readonly workspaceUriPath: string;

  constructor(readonly issueKey: string, repositories: SourceRepository[]) {
    this.repositoryByName = new Map(repositories.map((repository) => [repository.name, repository]));
    this.workspaceUriPath = `/issue-pilot/${issueKey}.code-workspace`;
    this.workspacePath = `/issue-pilot/${issueKey}`;
    this.workspaceBytes = encoder.encode(JSON.stringify({
      folders: repositories.map((repository) => ({ name: repository.name, path: `${this.workspacePath}/${repository.name}` })),
    }));
  }

  watch(_resource: Uri, _options: IWatchOptions) {
    return { dispose() {} };
  }

  async stat(resource: Uri): Promise<IStat> {
    if (resource.path === this.workspaceUriPath) return { type: FileType.File, ctime: 0, mtime: 0, size: this.workspaceBytes.byteLength, permissions: FilePermission.Readonly };
    if (resource.path === "/issue-pilot" || resource.path === this.workspacePath) return directoryStat;
    const parsed = this.parseRepositoryPath(resource);
    if (!parsed.relativePath) return directoryStat;
    const separator = parsed.relativePath.lastIndexOf("/");
    const parent = separator < 0 ? "" : parsed.relativePath.slice(0, separator);
    const name = separator < 0 ? parsed.relativePath : parsed.relativePath.slice(separator + 1);
    const entry = (await this.directory(parsed.repository, parent)).find((candidate) => candidate.name === name);
    if (!entry) throw providerError("source_path_not_found", FileSystemProviderErrorCode.FileNotFound);
    return this.entryStat(entry);
  }

  async readdir(resource: Uri): Promise<[string, FileType][]> {
    if (resource.path === "/issue-pilot") return [[`${this.issueKey}.code-workspace`, FileType.File], [this.issueKey, FileType.Directory]];
    if (resource.path === this.workspacePath) return [...this.repositoryByName.keys()].map((name) => [name, FileType.Directory]);
    const parsed = this.parseRepositoryPath(resource);
    return (await this.directory(parsed.repository, parsed.relativePath)).map((entry) => [entry.name, this.entryType(entry)]);
  }

  async readFile(resource: Uri): Promise<Uint8Array> {
    if (resource.path === this.workspaceUriPath) return this.workspaceBytes;
    const parsed = this.parseRepositoryPath(resource);
    if (!parsed.relativePath) throw providerError("source_path_not_file", FileSystemProviderErrorCode.FileIsADirectory);
    try {
      const separator = parsed.relativePath.lastIndexOf("/");
      const parent = separator < 0 ? "" : parsed.relativePath.slice(0, separator);
      const name = separator < 0 ? parsed.relativePath : parsed.relativePath.slice(separator + 1);
      const entry = (await this.directory(parsed.repository, parent)).find((candidate) => candidate.name === name);
      if (!entry) throw providerError("source_path_not_found", FileSystemProviderErrorCode.FileNotFound);
      if (entry.type === "directory") throw providerError("source_path_not_file", FileSystemProviderErrorCode.FileIsADirectory);
      return encoder.encode((await loadSourceFile(this.issueKey, parsed.repository, parsed.relativePath)).content);
    } catch (error) {
      throw error instanceof FileSystemProviderError ? error : sourceError(error);
    }
  }

  writeFile(_resource: Uri, _content: Uint8Array, _options: IFileWriteOptions): Promise<void> {
    return Promise.reject(providerError("source_read_only", FileSystemProviderErrorCode.FileWriteLocked));
  }

  mkdir(_resource: Uri): Promise<void> {
    return Promise.reject(providerError("source_read_only", FileSystemProviderErrorCode.FileWriteLocked));
  }

  delete(_resource: Uri, _options: IFileDeleteOptions): Promise<void> {
    return Promise.reject(providerError("source_read_only", FileSystemProviderErrorCode.FileWriteLocked));
  }

  rename(_from: Uri, _to: Uri, _options: IFileOverwriteOptions): Promise<void> {
    return Promise.reject(providerError("source_read_only", FileSystemProviderErrorCode.FileWriteLocked));
  }

  private parseRepositoryPath(resource: Uri): { repository: string; relativePath: string } {
    const prefix = `${this.workspacePath}/`;
    if (!resource.path.startsWith(prefix)) throw providerError("source_path_not_found", FileSystemProviderErrorCode.FileNotFound);
    const relative = resource.path.slice(prefix.length);
    const separator = relative.indexOf("/");
    const repository = separator < 0 ? relative : relative.slice(0, separator);
    const relativePath = separator < 0 ? "" : relative.slice(separator + 1);
    if (!this.repositoryByName.has(repository)) throw providerError("source_repository_not_found", FileSystemProviderErrorCode.FileNotFound);
    return { repository, relativePath };
  }

  private async directory(repository: string, relativePath: string): Promise<SourceTreeEntry[]> {
    const key = `${repository}\0${relativePath}`;
    const existing = this.directoryRequests.get(key);
    if (existing) return existing;
    const request = (async () => {
      try {
        const result = await loadSourceTree(this.issueKey, repository, relativePath);
        if (result.truncated) throw providerError("source_tree_too_large", FileSystemProviderErrorCode.Unavailable);
        return result.entries;
      } catch (error) {
        if (error instanceof FileSystemProviderError) throw error;
        throw sourceError(error);
      }
    })();
    this.directoryRequests.set(key, request);
    try {
      return await request;
    } finally {
      if (this.directoryRequests.get(key) === request) this.directoryRequests.delete(key);
    }
  }

  private entryType(entry: SourceTreeEntry): FileType {
    if (entry.type === "directory") return FileType.Directory;
    if (entry.type === "file") return FileType.File;
    if (entry.type === "symlink") return FileType.SymbolicLink;
    return FileType.Unknown;
  }

  private entryStat(entry: SourceTreeEntry): IStat {
    return { type: this.entryType(entry), ctime: 0, mtime: 0, size: entry.size ?? 0, permissions: FilePermission.Readonly };
  }
}
