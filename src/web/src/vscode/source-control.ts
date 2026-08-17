import type { IEditorService } from "@codingame/monaco-vscode-api/services";
import type { editor as MonacoEditor } from "monaco-editor";
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

import { commitSourceChanges, discardSourcePaths, errorMessage, loadSourceBlame, loadSourceCommit, loadSourceCommitFile, loadSourceDiff, loadSourceDiffFile, loadSourceHistory, stageSourcePaths, unstageSourcePaths, type SourceBlame, type SourceCommit, type SourceCommitFile, type SourceCommitFileComparison, type SourceRepository, type SourceWorkspaceFileComparison } from "../data/client";
import { getIssuePilotVscodeApi, sourceControlCommitCommand, sourceControlDiscardCommand, sourceControlOpenChangesCommand, sourceControlOpenFileCommand, sourceControlOpenHeadCommand, sourceControlRefreshCommand, sourceControlStageCommand, sourceControlUnstageCommand, type IssuePilotVscodeApi } from "./extension-api";

const sourceRevisionScheme = "issue-pilot-commit";
const encoder = new TextEncoder();

type RevisionResource = {
  issueKey: string;
  repository: string;
  revision: string;
  path: string;
  side: "before" | "after";
  workspace: boolean;
  staged?: boolean;
};

class SourceRevisionFileSystemProvider implements FileSystemProvider {
  readonly onDidChangeFile: Event<FileChangeEvent[]>;
  private readonly resources = new Map<string, RevisionResource>();
  private readonly comparisons = new Map<string, Promise<SourceCommitFileComparison | SourceWorkspaceFileComparison>>();

  constructor(private readonly vscode: IssuePilotVscodeApi) {
    this.onDidChangeFile = new vscode.EventEmitter<FileChangeEvent[]>().event;
  }

  register(issueKey: string, repository: string, revision: string, file: SourceCommitFile): Pick<SourceControlHistoryItemChange, "originalUri" | "modifiedUri"> {
    return {
      originalUri: file.status === "added" ? undefined : this.resource({ issueKey, repository, revision, path: file.path, side: "before", workspace: false }, file.previousPath ?? file.path),
      modifiedUri: file.status === "deleted" ? undefined : this.resource({ issueKey, repository, revision, path: file.path, side: "after", workspace: false }, file.path),
    };
  }

  registerWorkspace(issueKey: string, repository: string, file: SourceCommitFile, workingTreeUri: Uri, staged: boolean): { originalUri: Uri; modifiedUri: Uri } {
    const request = { issueKey, repository, revision: staged ? "staged" : "working-tree", path: file.path, workspace: true, staged } as const;
    return {
      originalUri: this.resource({ ...request, side: "before" }, file.previousPath ?? file.path),
      modifiedUri: file.status === "deleted" || staged ? this.resource({ ...request, side: "after" }, file.path) : workingTreeUri,
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
      comparison = request.workspace
        ? loadSourceDiffFile(request.issueKey, request.repository, request.path, undefined, request.staged)
        : loadSourceCommitFile(request.issueKey, request.repository, request.revision, request.path);
      this.comparisons.set(key, comparison);
    }
    let result: SourceCommitFileComparison | SourceWorkspaceFileComparison;
    try {
      result = await comparison;
    } catch (error) {
      if (this.comparisons.get(key) === comparison) this.comparisons.delete(key);
      throw new this.vscode.FileSystemError(errorMessage(error));
    }
    const file = request.side === "before" ? result.before : result.after;
    if (!file) {
      if (request.workspace) return encoder.encode("");
      throw this.vscode.FileSystemError.FileNotFound("source_commit_file_not_found");
    }
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
      query: `revision=${request.revision}&side=${request.side}${request.workspace ? "&workspace=true" : ""}${request.staged ? "&staged=true" : ""}`,
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

type SourceControlMenuResource = SourceControlResourceState & { command?: { command: string; arguments?: unknown[] }; issuePilot?: { repository: string; path: string; staged: boolean } };
type SourceControlMenuTarget = SourceControlMenuResource | { resourceStates?: readonly SourceControlMenuResource[] };

type RegisteredSourceControl = {
  repository: SourceRepository;
  sourceControl: SourceControl;
  workingGroup: SourceControlResourceGroup;
  stagedGroup: SourceControlResourceGroup;
  history: SourceControlHistory;
};

function sourceControlResources(vscode: IssuePilotVscodeApi, issueKey: string, repository: SourceRepository, root: Uri, revisionContent: SourceRevisionFileSystemProvider, files: SourceCommitFile[], staged: boolean): SourceControlResourceState[] {
  return files.map((file) => {
    const resourceUri = vscode.Uri.joinPath(root, file.path);
    const comparison = revisionContent.registerWorkspace(issueKey, repository.name, file, resourceUri, staged);
    const displayName = file.path.slice(file.path.lastIndexOf("/") + 1);
    return {
      resourceUri,
      contextValue: `issue-pilot-${staged ? "staged" : "working"}-${file.status}`,
      issuePilot: { repository: repository.name, path: file.path, staged },
      command: {
        command: "vscode.diff",
        title: "打开变更",
        arguments: [comparison.originalUri, comparison.modifiedUri, `${displayName} (${staged ? "Index" : "Working Tree"})`, { preview: false }],
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

function blameAge(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  const units = [
    [365 * 24 * 60 * 60 * 1000, "year"],
    [30 * 24 * 60 * 60 * 1000, "month"],
    [24 * 60 * 60 * 1000, "day"],
    [60 * 60 * 1000, "hour"],
    [60 * 1000, "minute"],
  ] as const;
  const [size, unit] = units.find(([size]) => Math.abs(elapsed) >= size) ?? [1000, "second"] as const;
  return new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" }).format(-Math.trunc(elapsed / size), unit);
}

function registerBlameStatus(vscode: IssuePilotVscodeApi, editorService: IEditorService, issueKey: string, repositories: SourceRepository[], workspacePath: string): void {
  const item = vscode.window.createStatusBarItem("issue-pilot.gitBlameInformation", vscode.StatusBarAlignment.Right, 10_000);
  item.name = "Git Blame Information";
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let hoverDetail: SourceBlame | undefined;
  const attachHoverBridge = () => {
    const element = document.querySelector<HTMLElement>('[id$=".gitBlameInformation"]');
    if (!element || element.dataset.issuePilotHoverBridge) return;
    element.dataset.issuePilotHoverBridge = "true";
    element.addEventListener("mouseenter", () => {
      if (hoverTimer) clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        if (!hoverDetail) return;
        const rect = element.getBoundingClientRect();
        window.parent.postMessage({ kind: "issue-pilot-workbench-blame-hover", issueKey, visible: true, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, detail: hoverDetail }, window.location.origin);
      }, 300);
    });
    element.addEventListener("mouseleave", () => {
      if (hoverTimer) clearTimeout(hoverTimer);
      window.parent.postMessage({ kind: "issue-pilot-workbench-blame-hover", issueKey, visible: false }, window.location.origin);
    });
  };
  const update = async (resource: { scheme: string; path: string; query?: string }, zeroBasedLine: number) => {
    const currentGeneration = ++generation;
    const filePrefix = `${workspacePath}/`;
    const workspaceRevisionPrefix = `/${issueKey}/`;
    const relative = resource.scheme === "file" && resource.path.startsWith(filePrefix)
      ? resource.path.slice(filePrefix.length)
      : resource.scheme === sourceRevisionScheme && resource.path.startsWith(workspaceRevisionPrefix) && (resource.query?.includes("workspace=true") || resource.query?.includes("workspace%3Dtrue"))
        ? resource.path.slice(workspaceRevisionPrefix.length)
        : "";
    if (!relative) {
      hoverDetail = undefined;
      item.hide();
      window.parent.postMessage({ kind: "issue-pilot-workbench-blame-hover", issueKey, visible: false }, window.location.origin);
      return;
    }
    const separator = relative.indexOf("/");
    const repository = separator < 0 ? "" : relative.slice(0, separator);
    const filePath = separator < 0 ? "" : relative.slice(separator + 1);
    if (!filePath || !repositories.some((candidate) => candidate.name === repository)) {
      item.hide();
      return;
    }
    try {
      const blame = await loadSourceBlame(issueKey, repository, filePath, zeroBasedLine + 1);
      if (currentGeneration !== generation) return;
      const author = blame.author.slice(0, 40);
      const subject = blame.subject.slice(0, 80);
      item.text = blame.shortCommit && blame.date
        ? `$(git-commit) ${author} (${blameAge(blame.date)})`
        : `$(git-commit) ${subject}`;
      const tooltip = new vscode.MarkdownString("", true);
      if (blame.date) {
        tooltip.appendMarkdown("$(account) **");
        tooltip.appendText(blame.author);
        tooltip.appendMarkdown(`**, ${blameAge(blame.date)} (${new Date(blame.date).toLocaleString()})\n\n---\n\n`);
      }
      tooltip.appendText(blame.subject);
      tooltip.appendMarkdown("\n\n---\n\n");
      if (blame.commit) tooltip.appendMarkdown(`$(git-commit) \`${blame.commit}\`  \n`);
      tooltip.appendText(`${blame.path}:${blame.line}`);
      item.tooltip = tooltip;
      hoverDetail = blame;
      item.show();
      queueMicrotask(attachHoverBridge);
      setTimeout(attachHoverBridge, 100);
      setTimeout(attachHoverBridge, 500);
    } catch {
      if (currentGeneration === generation) item.hide();
    }
  };
  const schedule = (resource: { scheme: string; path: string; query?: string }, line: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void update(resource, line); }, 120);
  };
  const attached = new WeakSet<object>();
  const attachActiveEditor = () => {
    const control = editorService.activeTextEditorControl;
    if (!control) { item.hide(); return; }
    const editor = ("getModifiedEditor" in control ? control.getModifiedEditor() : control) as MonacoEditor.ICodeEditor;
    if (attached.has(editor)) return;
    attached.add(editor);
    editor.onDidChangeCursorPosition((event) => schedule(editor.getModel()?.uri ?? { scheme: "", path: "" }, event.position.lineNumber - 1));
    editor.onMouseMove((event) => {
      if (event.target.position) schedule(editor.getModel()?.uri ?? { scheme: "", path: "" }, event.target.position.lineNumber - 1);
    });
  };
  editorService.onDidActiveEditorChange(attachActiveEditor);
  attachActiveEditor();
}

export async function registerSourceControls(issueKey: string, repositories: SourceRepository[], workspacePath: string, editorService: IEditorService): Promise<() => Promise<void>> {
  const vscode = await getIssuePilotVscodeApi();
  registerBlameStatus(vscode, editorService, issueKey, repositories, workspacePath);
  const revisionContent = new SourceRevisionFileSystemProvider(vscode);
  vscode.workspace.registerFileSystemProvider(sourceRevisionScheme, revisionContent, { isCaseSensitive: true, isReadonly: true });

  const providers: RegisteredSourceControl[] = repositories.map((repository) => {
    const root = vscode.Uri.file(`${workspacePath}/${repository.name}`);
    const sourceControl = vscode.scm.createSourceControl(`issue-pilot-${repository.name}`, repository.name, root);
    sourceControl.inputBox.visible = repository.access === "write";
    sourceControl.inputBox.placeholder = "Message (press Ctrl+Enter to commit)";
    sourceControl.acceptInputCommand = repository.access === "write" ? { command: sourceControlCommitCommand, title: "Commit", arguments: [repository.name] } : undefined;
    sourceControl.actionButton = repository.access === "write" ? {
      command: { command: sourceControlCommitCommand, title: "Commit", arguments: [repository.name] },
      enabled: true,
    } : undefined;
    const stagedGroup = sourceControl.createResourceGroup("staged", "Staged Changes");
    stagedGroup.contextValue = repository.access === "write" ? "issue-pilot-staged" : "issue-pilot-readonly";
    stagedGroup.hideWhenEmpty = true;
    const workingGroup = sourceControl.createResourceGroup("working-tree", "Changes");
    workingGroup.contextValue = repository.access === "write" ? "issue-pilot-working" : "issue-pilot-readonly";
    workingGroup.hideWhenEmpty = false;
    const history = new SourceControlHistory(vscode, issueKey, repository, root, revisionContent);
    sourceControl.historyProvider = history;
    history.publishCurrentRef();
    return { repository, sourceControl, workingGroup, stagedGroup, history };
  });

  let refreshGeneration = 0;
  const refresh = async () => {
    const generation = ++refreshGeneration;
    await Promise.all(providers.map(async ({ repository, sourceControl, workingGroup, stagedGroup, history }) => {
      try {
        const [working, staged] = await Promise.all([
          loadSourceDiff(issueKey, repository.name),
          loadSourceDiff(issueKey, repository.name, "", undefined, true),
        ]);
        if (generation === refreshGeneration) {
          workingGroup.resourceStates = sourceControlResources(vscode, issueKey, repository, sourceControl.rootUri!, revisionContent, working.files, false);
          stagedGroup.resourceStates = sourceControlResources(vscode, issueKey, repository, sourceControl.rootUri!, revisionContent, staged.files, true);
          sourceControl.count = working.files.length + staged.files.length;
          history.invalidate();
        }
      } catch (error) {
        if (generation === refreshGeneration) console.warn(`source_control_refresh_failed:${repository.name}:${errorMessage(error)}`);
      }
    }));
  };

  vscode.commands.registerCommand(sourceControlRefreshCommand, refresh);
  vscode.commands.registerCommand(sourceControlOpenChangesCommand, (resource: SourceControlMenuResource) => resource.command
    ? vscode.commands.executeCommand(resource.command.command, ...(resource.command.arguments ?? []))
    : undefined);
  const contextUri = (resource: SourceControlMenuResource | Uri | { sourceUri?: Uri }) => {
    if (resource instanceof vscode.Uri) return resource;
    if ("resourceUri" in resource && resource.resourceUri instanceof vscode.Uri) return resource.resourceUri;
    return "sourceUri" in resource && resource.sourceUri instanceof vscode.Uri ? resource.sourceUri : undefined;
  };
  vscode.commands.registerCommand(sourceControlOpenFileCommand, (resource: SourceControlMenuResource | Uri | { sourceUri?: Uri }) => {
    const uri = contextUri(resource);
    return uri ? vscode.window.showTextDocument(uri, { preview: false }) : undefined;
  });
  vscode.commands.registerCommand(sourceControlOpenHeadCommand, (resource: SourceControlMenuResource) => {
    const original = resource.command?.arguments?.[0];
    return original instanceof vscode.Uri ? vscode.window.showTextDocument(original, { preview: false }) : undefined;
  });
  const resourcesFor = (target: SourceControlMenuTarget): SourceControlMenuResource[] => "resourceStates" in target && target.resourceStates ? [...target.resourceStates] : [target as SourceControlMenuResource];
  const mutation = (target: SourceControlMenuTarget) => {
    const resources = resourcesFor(target).filter((resource) => resource.issuePilot);
    const repository = resources[0]?.issuePilot?.repository;
    if (!repository || resources.some((resource) => resource.issuePilot?.repository !== repository)) return undefined;
    return { repository, paths: resources.map((resource) => resource.issuePilot!.path) };
  };
  const mutateResource = async (target: SourceControlMenuTarget, operation: (repository: string, paths: string[]) => Promise<unknown>) => {
    const selected = mutation(target);
    if (!selected) return;
    await operation(selected.repository, selected.paths);
    await refresh();
  };
  vscode.commands.registerCommand(sourceControlStageCommand, (target: SourceControlMenuTarget) => mutateResource(target, (repository, paths) => stageSourcePaths(issueKey, repository, paths)));
  vscode.commands.registerCommand(sourceControlUnstageCommand, (target: SourceControlMenuTarget) => mutateResource(target, (repository, paths) => unstageSourcePaths(issueKey, repository, paths)));
  vscode.commands.registerCommand(sourceControlDiscardCommand, async (target: SourceControlMenuTarget) => {
    const selected = mutation(target);
    if (!selected) return;
    const label = selected.paths.length === 1 ? selected.paths[0] : `${selected.paths.length} files`;
    const confirmation = await vscode.window.showWarningMessage(`Discard changes in ${label}?`, { modal: true }, "Discard Changes");
    if (confirmation !== "Discard Changes") return;
    await discardSourcePaths(issueKey, selected.repository, selected.paths);
    await refresh();
  });
  vscode.commands.registerCommand(sourceControlCommitCommand, async (repositoryName: string) => {
    const provider = providers.find(({ repository }) => repository.name === repositoryName && repository.access === "write");
    const message = provider?.sourceControl.inputBox.value.trim();
    if (!provider || !message) return;
    await commitSourceChanges(issueKey, repositoryName, message);
    provider.sourceControl.inputBox.value = "";
    await refresh();
  });
  window.addEventListener("focus", () => { void refresh(); });
  await refresh();
  return refresh;
}
