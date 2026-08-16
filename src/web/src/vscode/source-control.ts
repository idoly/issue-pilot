import { Emitter, Event } from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import { observableValue } from "@codingame/monaco-vscode-api/vscode/vs/base/common/observableInternal/observables/observableValue";
import { ResourceTree } from "@codingame/monaco-vscode-api/vscode/vs/base/common/resourceTree";
import { ThemeIcon } from "@codingame/monaco-vscode-api/vscode/vs/base/common/themables";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import type { ITextModel } from "@codingame/monaco-vscode-api/vscode/vs/editor/common/model";
import { MenuId, MenuRegistry } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { CommandsRegistry } from "@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands";
import type { IEditorService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service";
import { IEditorService as EditorService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service";
import type { ISCMHistoryItem, ISCMHistoryItemChange, ISCMHistoryItemRef, ISCMHistoryItemRefsChangeEvent, ISCMHistoryOptions, ISCMHistoryProvider } from "@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/scm/common/history";
import type { ISCMProvider, ISCMResource, ISCMResourceGroup } from "@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/scm/common/scm";
import { ISCMService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/scm/common/scm.service";
import { getService } from "@codingame/monaco-vscode-api";
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
import * as monaco from "monaco-editor";

import { errorMessage, loadSourceCommit, loadSourceCommitFile, loadSourceDiff, loadSourceHistory, type SourceCommit, type SourceCommitFile, type SourceCommitFileComparison, type SourceRepository } from "../data/client";

const refreshCommand = "issue-pilot.sourceControl.refresh";
export const sourceRevisionScheme = "issue-pilot-commit";
const encoder = new TextEncoder();

type RevisionResource = {
  issueKey: string;
  repository: string;
  revision: string;
  path: string;
  side: "before" | "after";
};

export class SourceRevisionFileSystemProvider implements IFileSystemProviderWithFileReadWriteCapability {
  readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive | FileSystemProviderCapabilities.Readonly;
  readonly onDidChangeCapabilities = Event.None;
  readonly onDidChangeFile: typeof Event.None = Event.None;
  readonly readOnlyMessage = { value: "Git提交内容为只读" };
  private readonly resources = new Map<string, RevisionResource>();
  private readonly comparisons = new Map<string, Promise<SourceCommitFileComparison>>();

  register(issueKey: string, repository: string, revision: string, file: SourceCommitFile): Pick<ISCMHistoryItemChange, "originalUri" | "modifiedUri"> {
    return {
      originalUri: file.status === "added" ? undefined : this.resource({ issueKey, repository, revision, path: file.path, side: "before" }, file.previousPath ?? file.path),
      modifiedUri: file.status === "deleted" ? undefined : this.resource({ issueKey, repository, revision, path: file.path, side: "after" }, file.path),
    };
  }

  watch(_resource: URI, _options: IWatchOptions) {
    return { dispose() {} };
  }

  async stat(resource: URI): Promise<IStat> {
    if (!this.resources.has(resource.toString())) throw this.providerError("source_commit_file_not_found", FileSystemProviderErrorCode.FileNotFound);
    return { type: FileType.File, ctime: 0, mtime: 0, size: 0, permissions: FilePermission.Readonly };
  }

  async readFile(resource: URI): Promise<Uint8Array> {
    const request = this.resources.get(resource.toString());
    if (!request) throw this.providerError("source_commit_file_not_found", FileSystemProviderErrorCode.FileNotFound);
    const key = `${request.issueKey}\0${request.repository}\0${request.revision}\0${request.path}`;
    let comparison = this.comparisons.get(key);
    if (!comparison) {
      comparison = loadSourceCommitFile(request.issueKey, request.repository, request.revision, request.path);
      this.comparisons.set(key, comparison);
    }
    let result: SourceCommitFileComparison;
    try {
      result = await comparison;
    } catch (error) {
      if (this.comparisons.get(key) === comparison) this.comparisons.delete(key);
      throw this.providerError(errorMessage(error), FileSystemProviderErrorCode.Unknown);
    }
    const file = request.side === "before" ? result.before : result.after;
    if (!file) throw this.providerError("source_commit_file_not_found", FileSystemProviderErrorCode.FileNotFound);
    return encoder.encode(file.content);
  }

  readdir(_resource: URI): Promise<[string, FileType][]> {
    return Promise.reject(this.providerError("source_path_not_directory", FileSystemProviderErrorCode.FileNotADirectory));
  }

  writeFile(_resource: URI, _content: Uint8Array, _options: IFileWriteOptions): Promise<void> {
    return Promise.reject(this.providerError("source_read_only", FileSystemProviderErrorCode.FileWriteLocked));
  }

  mkdir(_resource: URI): Promise<void> {
    return Promise.reject(this.providerError("source_read_only", FileSystemProviderErrorCode.FileWriteLocked));
  }

  delete(_resource: URI, _options: IFileDeleteOptions): Promise<void> {
    return Promise.reject(this.providerError("source_read_only", FileSystemProviderErrorCode.FileWriteLocked));
  }

  rename(_from: URI, _to: URI, _options: IFileOverwriteOptions): Promise<void> {
    return Promise.reject(this.providerError("source_read_only", FileSystemProviderErrorCode.FileWriteLocked));
  }

  private resource(request: RevisionResource, displayPath: string): URI {
    const resource = URI.from({
      scheme: sourceRevisionScheme,
      authority: "issue-pilot",
      path: `/${request.issueKey}/${request.repository}/${displayPath}`,
      query: `revision=${request.revision}&side=${request.side}`,
    });
    this.resources.set(resource.toString(), request);
    return resource;
  }

  private providerError(message: string, code: FileSystemProviderErrorCode): FileSystemProviderError {
    return FileSystemProviderError.create(message, code);
  }
}

function statusLabel(file: SourceCommitFile): string {
  if (file.status === "added") return "新增";
  if (file.status === "deleted") return "删除";
  if (file.status === "renamed") return "重命名";
  if (file.status === "copied") return "复制";
  return "修改";
}

function statusIcon(file: SourceCommitFile): string {
  if (file.status === "added") return "diff-added";
  if (file.status === "deleted") return "diff-removed";
  if (file.status === "renamed") return "diff-renamed";
  return "diff-modified";
}

class SourceControlResource implements ISCMResource {
  readonly contextValue: string;
  readonly decorations: ISCMResource["decorations"];
  readonly command = undefined;
  readonly multiDiffEditorOriginalUri = undefined;
  readonly multiDiffEditorModifiedUri = undefined;

  constructor(readonly resourceGroup: ISCMResourceGroup, readonly sourceUri: URI, private readonly file: SourceCommitFile, private readonly editorService: IEditorService) {
    this.contextValue = `issue-pilot-${file.status}`;
    this.decorations = {
      icon: ThemeIcon.fromId(statusIcon(file)),
      tooltip: `${statusLabel(file)}${file.previousPath ? `: ${file.previousPath} -> ${file.path}` : `: ${file.path}`}`,
      strikeThrough: file.status === "deleted",
      faded: file.status === "deleted",
    };
  }

  async open(preserveFocus: boolean): Promise<void> {
    if (this.file.status === "deleted") return;
    await this.editorService.openEditor({ resource: this.sourceUri, options: { preserveFocus, pinned: true } });
  }
}

class SourceControlGroup implements ISCMResourceGroup {
  readonly id = "working-tree";
  readonly label = "工作区变更";
  readonly contextValue = "issue-pilot-readonly";
  readonly hideWhenEmpty = false;
  readonly multiDiffEditorEnableViewChanges = false;
  readonly onDidChange = Event.None;
  private readonly resourcesEmitter = new Emitter<void>();
  readonly onDidChangeResources = this.resourcesEmitter.event;
  readonly resourceTree: ResourceTree<ISCMResource, ISCMResourceGroup>;
  private currentResources: ISCMResource[] = [];

  constructor(readonly provider: ISCMProvider, root: URI, private readonly editorService: IEditorService, private readonly notifyProvider: () => void) {
    this.resourceTree = new ResourceTree(this, root);
  }

  get resources(): readonly ISCMResource[] {
    return this.currentResources;
  }

  replace(files: SourceCommitFile[], root: URI): void {
    this.currentResources = files.map((file) => new SourceControlResource(this, URI.joinPath(root, file.path), file, this.editorService));
    this.resourceTree.clear();
    for (const resource of this.currentResources) this.resourceTree.add(resource.sourceUri, resource);
    this.resourcesEmitter.fire();
    this.notifyProvider();
  }

  dispose(): void {
    this.resourcesEmitter.dispose();
  }
}

class SourceControlHistoryProvider implements ISCMHistoryProvider {
  readonly currentRef: ISCMHistoryItemRef;
  readonly historyItemRef;
  readonly historyItemRemoteRef = observableValue<ISCMHistoryItemRef | undefined>(this, undefined);
  readonly historyItemBaseRef = observableValue<ISCMHistoryItemRef | undefined>(this, undefined);
  readonly historyItemRefChanges = observableValue<ISCMHistoryItemRefsChangeEvent>(this, { added: [], removed: [], modified: [], silent: true });
  private commits: SourceCommit[] | undefined;

  constructor(private readonly issueKey: string, private readonly repository: SourceRepository, private readonly rootUri: URI, private readonly revisionContent: SourceRevisionFileSystemProvider) {
    this.currentRef = { id: repository.branch, name: repository.branch, category: "branches", description: "当前分支", icon: ThemeIcon.fromId("git-branch") };
    this.historyItemRef = observableValue<ISCMHistoryItemRef | undefined>(this, this.currentRef);
  }

  invalidate(): void {
    this.commits = undefined;
    this.historyItemRefChanges.set({ added: [], removed: [], modified: [this.currentRef], silent: false }, undefined, undefined);
  }

  async provideHistoryItemRefs(historyItemRefs?: string[]): Promise<ISCMHistoryItemRef[]> {
    return !historyItemRefs?.length || historyItemRefs.includes(this.currentRef.id) || historyItemRefs.includes(this.currentRef.name) ? [this.currentRef] : [];
  }

  async provideHistoryItems(options: ISCMHistoryOptions): Promise<ISCMHistoryItem[]> {
    const commits = await this.loadCommits();
    const filter = options.filterText?.trim().toLocaleLowerCase();
    const filtered = filter ? commits.filter((commit) => [commit.hash, commit.shortHash, commit.author, commit.subject].some((value) => value.toLocaleLowerCase().includes(filter))) : commits;
    const skip = Math.max(0, options.skip ?? 0);
    const limit = typeof options.limit === "number" ? Math.max(0, options.limit) : filtered.length;
    return filtered.slice(skip, skip + limit).map((commit, index) => this.historyItem(commit, skip + index === 0));
  }

  async provideHistoryItemChanges(historyItemId: string): Promise<ISCMHistoryItemChange[]> {
    const response = await loadSourceCommit(this.issueKey, this.repository.name, historyItemId);
    return response.files.map((file) => ({
      uri: URI.joinPath(this.rootUri, file.path),
      ...this.revisionContent.register(this.issueKey, this.repository.name, historyItemId, file),
    }));
  }

  async resolveHistoryItem(historyItemId: string): Promise<ISCMHistoryItem | undefined> {
    const commits = await this.loadCommits();
    const index = commits.findIndex((commit) => commit.hash === historyItemId);
    return index < 0 ? undefined : this.historyItem(commits[index]!, index === 0);
  }

  async resolveHistoryItemChatContext(): Promise<undefined> { return undefined; }
  async resolveHistoryItemChangeRangeChatContext(): Promise<undefined> { return undefined; }
  async resolveHistoryItemRefsCommonAncestor(): Promise<undefined> { return undefined; }

  private async loadCommits(): Promise<SourceCommit[]> {
    if (!this.commits) this.commits = (await loadSourceHistory(this.issueKey, this.repository.name)).commits;
    return this.commits;
  }

  private historyItem(commit: SourceCommit, current: boolean): ISCMHistoryItem {
    return {
      id: commit.hash,
      parentIds: commit.parents,
      subject: commit.subject,
      message: commit.subject,
      displayId: commit.shortHash,
      author: commit.author,
      timestamp: new Date(commit.date).getTime(),
      references: current ? [{ ...this.currentRef, revision: commit.hash }] : undefined,
    };
  }
}

class SourceControlProvider implements ISCMProvider {
  readonly providerId = "issue-pilot";
  readonly label: string;
  readonly name: string;
  readonly groups: readonly ISCMResourceGroup[];
  readonly onDidChangeResourceGroups = Event.None;
  private readonly resourcesEmitter = new Emitter<void>();
  readonly onDidChangeResources = this.resourcesEmitter.event;
  readonly contextValue = observableValue<string | undefined>(this, "issue-pilot-readonly");
  readonly count = observableValue<number | undefined>(this, 0);
  readonly commitTemplate = observableValue(this, "");
  readonly artifactProvider = observableValue(this, undefined);
  readonly historyProvider;
  readonly actionButton = observableValue(this, undefined);
  readonly statusBarCommands = observableValue(this, undefined);
  readonly inputBoxTextModel: ITextModel;
  readonly group: SourceControlGroup;

  constructor(readonly id: string, readonly rootUri: URI, issueKey: string, repository: SourceRepository, editorService: IEditorService, revisionContent: SourceRevisionFileSystemProvider) {
    this.label = id;
    this.name = id;
    this.historyProvider = observableValue<ISCMHistoryProvider | undefined>(this, new SourceControlHistoryProvider(issueKey, repository, rootUri, revisionContent));
    this.inputBoxTextModel = monaco.editor.createModel("", "plaintext", monaco.Uri.parse(`inmemory://issue-pilot-scm/${encodeURIComponent(id)}`)) as ITextModel;
    this.group = new SourceControlGroup(this, rootUri, editorService, () => this.resourcesEmitter.fire());
    this.groups = [this.group];
  }

  replace(files: SourceCommitFile[]): void {
    this.group.replace(files, this.rootUri);
    this.count.set(files.length, undefined, undefined);
  }

  refreshHistory(): void {
    (this.historyProvider.get() as SourceControlHistoryProvider | undefined)?.invalidate();
  }

  async getOriginalResource(_uri: URI): Promise<URI | null> {
    return null;
  }

  dispose(): void {
    this.group.dispose();
    this.resourcesEmitter.dispose();
    this.inputBoxTextModel.dispose();
  }
}

export async function registerSourceControls(issueKey: string, repositories: SourceRepository[], workspacePath: string, revisionContent: SourceRevisionFileSystemProvider): Promise<void> {
  const [scmService, editorService] = await Promise.all([getService(ISCMService), getService(EditorService)]);
  const providers = repositories.map((repository) => {
    const provider = new SourceControlProvider(repository.name, URI.file(`${workspacePath}/${repository.name}`), issueKey, repository, editorService, revisionContent);
    const registered = scmService.registerSCMProvider(provider);
    registered.input.visible = false;
    return { repository, provider };
  });

  let refreshGeneration = 0;
  const refresh = async () => {
    const generation = ++refreshGeneration;
    await Promise.all(providers.map(async ({ repository, provider }) => {
      try {
        const response = await loadSourceDiff(issueKey, repository.name);
        if (generation === refreshGeneration) {
          provider.replace(response.files);
          provider.refreshHistory();
        }
      } catch (error) {
        if (generation === refreshGeneration) console.warn(`source_control_refresh_failed:${repository.name}:${errorMessage(error)}`);
      }
    }));
  };

  CommandsRegistry.registerCommand(refreshCommand, refresh);
  MenuRegistry.appendMenuItem(MenuId.SCMTitle, {
    command: { id: refreshCommand, title: "刷新只读变更", icon: ThemeIcon.fromId("refresh") },
    group: "navigation",
  });
  window.addEventListener("focus", () => { void refresh(); });
  await refresh();
}
