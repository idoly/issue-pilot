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

import { createSourceDirectory, createSourceFile, deleteSourcePath, errorMessage, loadSourceFile, loadSourceTree, renameSourcePath, saveSourceFile, type SourceRepository, type SourceTreeEntry } from "../data/client";

const encoder = new TextEncoder();
const noEvent = () => ({ dispose() {} });
const directoryStat = (readOnly: boolean): IStat => ({ type: FileType.Directory, ctime: 0, mtime: 0, size: 0, ...(readOnly ? { permissions: FilePermission.Readonly } : {}) });

function providerError(message: string, code: FileSystemProviderErrorCode): FileSystemProviderError {
  return FileSystemProviderError.create(message, code);
}

function sourceError(error: unknown): FileSystemProviderError {
  const message = errorMessage(error);
  if (message === "source_path_not_found" || message === "source_repository_not_found") return providerError(message, FileSystemProviderErrorCode.FileNotFound);
  if (message === "source_path_not_directory") return providerError(message, FileSystemProviderErrorCode.FileNotADirectory);
  if (message === "source_path_not_file") return providerError(message, FileSystemProviderErrorCode.FileIsADirectory);
  if (message === "source_file_too_large") return providerError(message, FileSystemProviderErrorCode.FileTooLarge);
  if (message === "source_read_only" || message === "source_file_changed") return providerError(message, FileSystemProviderErrorCode.FileWriteLocked);
  if (message === "source_browser_unavailable" || message === "source_runtime_invalid") return providerError(message, FileSystemProviderErrorCode.Unavailable);
  return providerError(message, FileSystemProviderErrorCode.Unknown);
}

export class SourceFileSystemProvider implements IFileSystemProviderWithFileReadWriteCapability {
  readonly capabilities: FileSystemProviderCapabilities;
  readonly onDidChangeCapabilities = noEvent;
  readonly onDidChangeFile = noEvent;
  readonly readOnlyMessage = { value: "测试和正式环境代码工作台为只读" };

  private readonly repositoryByName: Map<string, SourceRepository>;
  private readonly directoryRequests = new Map<string, Promise<SourceTreeEntry[]>>();
  private readonly fileHashes = new Map<string, string>();
  private onWrite: () => void = () => undefined;
  private readonly workspaceBytes: Uint8Array;
  readonly workspacePath: string;
  readonly workspaceUriPath: string;

  constructor(readonly issueKey: string, repositories: SourceRepository[]) {
    this.repositoryByName = new Map(repositories.map((repository) => [repository.name, repository]));
    this.capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive
      | (repositories.some((repository) => repository.access === "write") ? 0 : FileSystemProviderCapabilities.Readonly);
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
    if (resource.path === "/issue-pilot") return directoryStat(true);
    if (resource.path === this.workspacePath) return directoryStat(![...this.repositoryByName.values()].some((repository) => repository.access === "write"));
    const parsed = this.parseRepositoryPath(resource);
    if (!parsed.relativePath) return directoryStat(this.repositoryByName.get(parsed.repository)?.access !== "write");
    const separator = parsed.relativePath.lastIndexOf("/");
    const parent = separator < 0 ? "" : parsed.relativePath.slice(0, separator);
    const name = separator < 0 ? parsed.relativePath : parsed.relativePath.slice(separator + 1);
    const entry = (await this.directory(parsed.repository, parent)).find((candidate) => candidate.name === name);
    if (!entry) throw providerError("source_path_not_found", FileSystemProviderErrorCode.FileNotFound);
    return this.entryStat(entry, parsed.repository);
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
      const file = await loadSourceFile(this.issueKey, parsed.repository, parsed.relativePath);
      this.fileHashes.set(resource.path, file.sha256);
      return encoder.encode(file.content);
    } catch (error) {
      throw error instanceof FileSystemProviderError ? error : sourceError(error);
    }
  }

  async writeFile(resource: Uri, content: Uint8Array, options: IFileWriteOptions): Promise<void> {
    const parsed = this.parseRepositoryPath(resource);
    if (this.repositoryByName.get(parsed.repository)?.access !== "write") throw providerError("source_read_only", FileSystemProviderErrorCode.FileWriteLocked);
    const expectedSha256 = this.fileHashes.get(resource.path);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(content); }
    catch { throw providerError("source_file_binary", FileSystemProviderErrorCode.FileWriteLocked); }
    try {
      const file = expectedSha256
        ? await saveSourceFile(this.issueKey, parsed.repository, parsed.relativePath, text, expectedSha256)
        : options.create
          ? await createSourceFile(this.issueKey, parsed.repository, parsed.relativePath, text)
          : (() => { throw providerError("source_file_not_loaded", FileSystemProviderErrorCode.FileWriteLocked); })();
      this.fileHashes.set(resource.path, file.sha256);
      this.onWrite();
    } catch (error) {
      throw sourceError(error);
    }
  }

  setOnWrite(listener: () => void): void {
    this.onWrite = listener;
  }

  async mkdir(resource: Uri): Promise<void> {
    const parsed = this.writablePath(resource);
    try { await createSourceDirectory(this.issueKey, parsed.repository, parsed.relativePath); this.onWrite(); }
    catch (error) { throw sourceError(error); }
  }

  async delete(resource: Uri, options: IFileDeleteOptions): Promise<void> {
    const parsed = this.writablePath(resource);
    try { await deleteSourcePath(this.issueKey, parsed.repository, parsed.relativePath, options.recursive); this.fileHashes.delete(resource.path); this.onWrite(); }
    catch (error) { throw sourceError(error); }
  }

  async rename(from: Uri, to: Uri, options: IFileOverwriteOptions): Promise<void> {
    const source = this.writablePath(from);
    const destination = this.writablePath(to);
    if (source.repository !== destination.repository) throw providerError("source_path_outside_repository", FileSystemProviderErrorCode.NoPermissions);
    try { await renameSourcePath(this.issueKey, source.repository, source.relativePath, destination.relativePath, options.overwrite); this.fileHashes.delete(from.path); this.onWrite(); }
    catch (error) { throw sourceError(error); }
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

  private writablePath(resource: Uri): { repository: string; relativePath: string } {
    const parsed = this.parseRepositoryPath(resource);
    if (!parsed.relativePath || this.repositoryByName.get(parsed.repository)?.access !== "write") throw providerError("source_read_only", FileSystemProviderErrorCode.FileWriteLocked);
    return parsed;
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

  private entryStat(entry: SourceTreeEntry, repository: string): IStat {
    const readOnly = this.repositoryByName.get(repository)?.access !== "write";
    return { type: this.entryType(entry), ctime: 0, mtime: 0, size: entry.size ?? 0, ...(readOnly ? { permissions: FilePermission.Readonly } : {}) };
  }
}
