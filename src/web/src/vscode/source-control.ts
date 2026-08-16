import type {
  Disposable,
  Event,
  EventEmitter,
  FileChangeEvent,
  FileStat,
  FileSystemProvider,
  SourceControl,
  SourceControlHistoryItem,
  SourceControlHistoryItemChange,
  SourceControlHistoryItemRef,
  SourceControlHistoryItemRefsChangeEvent,
  SourceControlHistoryOptions,
  SourceControlHistoryProvider,
  SourceControlResourceGroup,
  SourceControlResourceState,
  Uri,
} from "vscode";

import { errorMessage, loadSourceCommit, loadSourceCommitFile, loadSourceDiff, loadSourceHistory, type SourceCommit, type SourceCommitFile, type SourceCommitFileComparison, type SourceRepository } from "../data/client";
import { getIssuePilotVscodeApi, sourceControlRefreshCommand, type IssuePilotVscodeApi } from "./extension-api";

const sourceRevisionScheme = "issue-pilot-commit";
const encoder = new TextEncoder();

type RevisionResource = {
  issueKey: string;
  repository: string;
  revision: string;
  path: string;
  side: "before" | "after";
};

class SourceRevisionFileSystemProvider implements FileSystemProvider {
  readonly onDidChangeFile: Event<FileChangeEvent[]>;
  private readonly resources = new Map<string, RevisionResource>();
  private readonly comparisons = new Map<string, Promise<SourceCommitFileComparison>>();

  constructor(private readonly vscode: IssuePilotVscodeApi) {
    this.onDidChangeFile = new vscode.EventEmitter<FileChangeEvent[]>().event;
  }

  register(issueKey: string, repository: string, revision: string, file: SourceCommitFile): Pick<SourceControlHistoryItemChange, "originalUri" | "modifiedUri"> {
    return {
      originalUri: file.status === "added" ? undefined : this.resource({ issueKey, repository, revision, path: file.path, side: "before" }, file.previousPath ?? file.path),
      modifiedUri: file.status === "deleted" ? undefined : this.resource({ issueKey, repository, revision, path: file.path, side: "after" }, file.path),
    };
  }

  watch(): Disposable {
    return new this.vscode.Disposable(() => undefined);
  }

  stat(resource: Uri): FileStat {
    if (!this.resources.has(resource.toString())) throw this.vscode.FileSystemError.FileNotFound("source_commit_file_not_found");
    return { type: this.vscode.FileType.File, ctime: 0, mtime: 0, size: 0, permissions: this.vscode.FilePermission.Readonly };
  }

  async readFile(resource: Uri): Promise<Uint8Array> {
    const request = this.resources.get(resource.toString());
    if (!request) throw this.vscode.FileSystemError.FileNotFound("source_commit_file_not_found");
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
      throw new this.vscode.FileSystemError(errorMessage(error));
    }
    const file = request.side === "before" ? result.before : result.after;
    if (!file) throw this.vscode.FileSystemError.FileNotFound("source_commit_file_not_found");
    return encoder.encode(file.content);
  }

  readDirectory(): never {
    throw this.vscode.FileSystemError.FileNotADirectory("source_path_not_directory");
  }

  writeFile(): never {
    throw this.vscode.FileSystemError.NoPermissions("source_read_only");
  }

  createDirectory(): never {
    throw this.vscode.FileSystemError.NoPermissions("source_read_only");
  }

  delete(): never {
    throw this.vscode.FileSystemError.NoPermissions("source_read_only");
  }

  rename(): never {
    throw this.vscode.FileSystemError.NoPermissions("source_read_only");
  }

  private resource(request: RevisionResource, displayPath: string): Uri {
    const resource = this.vscode.Uri.from({
      scheme: sourceRevisionScheme,
      authority: "issue-pilot",
      path: `/${request.issueKey}/${request.repository}/${displayPath}`,
      query: `revision=${request.revision}&side=${request.side}`,
    });
    this.resources.set(resource.toString(), request);
    return resource;
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

class SourceControlHistory implements SourceControlHistoryProvider {
  readonly currentHistoryItemRef: SourceControlHistoryItemRef;
  readonly currentHistoryItemRemoteRef = undefined;
  readonly currentHistoryItemBaseRef = undefined;
  readonly onDidChangeCurrentHistoryItemRefs: Event<void>;
  readonly onDidChangeHistoryItemRefs: Event<SourceControlHistoryItemRefsChangeEvent>;
  private readonly currentRefsEmitter: EventEmitter<void>;
  private readonly refsEmitter: EventEmitter<SourceControlHistoryItemRefsChangeEvent>;
  private commits: SourceCommit[] | undefined;

  constructor(
    private readonly vscode: IssuePilotVscodeApi,
    private readonly issueKey: string,
    private readonly repository: SourceRepository,
    private readonly rootUri: Uri,
    private readonly revisionContent: SourceRevisionFileSystemProvider,
  ) {
    this.currentHistoryItemRef = {
      id: repository.branch,
      name: repository.branch,
      category: "branches",
      description: "当前分支",
      icon: new vscode.ThemeIcon("git-branch"),
    };
    this.currentRefsEmitter = new vscode.EventEmitter<void>();
    this.refsEmitter = new vscode.EventEmitter<SourceControlHistoryItemRefsChangeEvent>();
    this.onDidChangeCurrentHistoryItemRefs = this.currentRefsEmitter.event;
    this.onDidChangeHistoryItemRefs = this.refsEmitter.event;
  }

  publishCurrentRef(): void {
    this.currentRefsEmitter.fire();
  }

  invalidate(): void {
    this.commits = undefined;
    this.refsEmitter.fire({ added: [], removed: [], modified: [this.currentHistoryItemRef], silent: false });
  }

  provideHistoryItemRefs(historyItemRefs?: string[]): SourceControlHistoryItemRef[] {
    return !historyItemRefs?.length || historyItemRefs.includes(this.currentHistoryItemRef.id) || historyItemRefs.includes(this.currentHistoryItemRef.name)
      ? [this.currentHistoryItemRef]
      : [];
  }

  async provideHistoryItems(options: SourceControlHistoryOptions): Promise<SourceControlHistoryItem[]> {
    const commits = await this.loadCommits();
    const filter = options.filterText?.trim().toLocaleLowerCase();
    const filtered = filter ? commits.filter((commit) => [commit.hash, commit.shortHash, commit.author, commit.subject].some((value) => value.toLocaleLowerCase().includes(filter))) : commits;
    const skip = Math.max(0, options.skip ?? 0);
    const limit = typeof options.limit === "number" ? Math.max(0, options.limit) : filtered.length;
    return filtered.slice(skip, skip + limit).map((commit, index) => this.historyItem(commit, skip + index === 0));
  }

  async provideHistoryItemChanges(historyItemId: string): Promise<SourceControlHistoryItemChange[]> {
    const response = await loadSourceCommit(this.issueKey, this.repository.name, historyItemId);
    return response.files.map((file) => ({
      uri: this.vscode.Uri.joinPath(this.rootUri, file.path),
      ...this.revisionContent.register(this.issueKey, this.repository.name, historyItemId, file),
    }));
  }

  async resolveHistoryItem(historyItemId: string): Promise<SourceControlHistoryItem | undefined> {
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

  private historyItem(commit: SourceCommit, current: boolean): SourceControlHistoryItem {
    return {
      id: commit.hash,
      parentIds: commit.parents,
      subject: commit.subject,
      message: commit.subject,
      displayId: commit.shortHash,
      author: commit.author,
      timestamp: new Date(commit.date).getTime(),
      references: current ? [{ ...this.currentHistoryItemRef, revision: commit.hash }] : undefined,
    };
  }
}

type RegisteredSourceControl = {
  repository: SourceRepository;
  sourceControl: SourceControl;
  group: SourceControlResourceGroup;
  history: SourceControlHistory;
};

function sourceControlResources(vscode: IssuePilotVscodeApi, root: Uri, files: SourceCommitFile[]): SourceControlResourceState[] {
  return files.map((file) => {
    const resourceUri = vscode.Uri.joinPath(root, file.path);
    return {
      resourceUri,
      contextValue: `issue-pilot-${file.status}`,
      command: file.status === "deleted" ? undefined : {
        command: "vscode.open",
        title: "打开文件",
        arguments: [resourceUri, { preview: false }],
      },
      decorations: {
        iconPath: new vscode.ThemeIcon(statusIcon(file)),
        tooltip: `${statusLabel(file)}${file.previousPath ? `: ${file.previousPath} -> ${file.path}` : `: ${file.path}`}`,
        strikeThrough: file.status === "deleted",
        faded: file.status === "deleted",
      },
    };
  });
}

export async function registerSourceControls(issueKey: string, repositories: SourceRepository[], workspacePath: string): Promise<void> {
  const vscode = await getIssuePilotVscodeApi();
  const revisionContent = new SourceRevisionFileSystemProvider(vscode);
  vscode.workspace.registerFileSystemProvider(sourceRevisionScheme, revisionContent, { isCaseSensitive: true, isReadonly: true });

  const providers: RegisteredSourceControl[] = repositories.map((repository) => {
    const root = vscode.Uri.file(`${workspacePath}/${repository.name}`);
    const sourceControl = vscode.scm.createSourceControl(`issue-pilot-${repository.name}`, repository.name, root);
    sourceControl.inputBox.visible = false;
    const group = sourceControl.createResourceGroup("working-tree", "工作区变更");
    group.contextValue = "issue-pilot-readonly";
    group.hideWhenEmpty = false;
    const history = new SourceControlHistory(vscode, issueKey, repository, root, revisionContent);
    sourceControl.historyProvider = history;
    history.publishCurrentRef();
    return { repository, sourceControl, group, history };
  });

  let refreshGeneration = 0;
  const refresh = async () => {
    const generation = ++refreshGeneration;
    await Promise.all(providers.map(async ({ repository, sourceControl, group, history }) => {
      try {
        const response = await loadSourceDiff(issueKey, repository.name);
        if (generation === refreshGeneration) {
          group.resourceStates = sourceControlResources(vscode, sourceControl.rootUri!, response.files);
          sourceControl.count = response.files.length;
          history.invalidate();
        }
      } catch (error) {
        if (generation === refreshGeneration) console.warn(`source_control_refresh_failed:${repository.name}:${errorMessage(error)}`);
      }
    }));
  };

  vscode.commands.registerCommand(sourceControlRefreshCommand, refresh);
  window.addEventListener("focus", () => { void refresh(); });
  await refresh();
}
