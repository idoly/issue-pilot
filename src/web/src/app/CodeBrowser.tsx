import "./code-browser.css";
import { createEffect, createMemo, createSignal, For, lazy, onCleanup, Show, untrack } from "solid-js";
import { Button, Input, Modal } from "../ui";
import { Code2, File, GitBranch, PanelBottom, PanelRight, Search, X, Plus, Pencil, Trash2 } from "../ui/icons";
import { issuePilotConfig } from "../../../../issue-pilot.config.ts";
import { sourceLanguageName } from "./source-language";
import { Codicon, EditorFileIcon } from "./EditorIcons";
import { Portal } from "@solidjs/web";
import { copyText } from "../ui/clipboard";
import { relativeTime } from "./model";
import watermark from "./editor-watermark.svg";
import { HistoryGraph, historyGraph } from "./HistoryGraph";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { commitSourceChanges, createSourceDirectory, createSourceFile, deleteSourcePath, discardSourcePaths, errorMessage, loadSourceBlame, loadSourceCommit, loadSourceCommitFile, loadSourceDiff, loadSourceDiffFile, loadSourceFile, loadSourceHistory, loadSourceRepositories, loadSourceTree, renameSourcePath, saveSourceFile, searchSource, stageSourcePaths, unstageSourcePaths, type SourceBlame, type SourceCommit, type SourceCommitFile, type SourceFile, type SourceHistoryCursor, type SourceRepository, type SourceSearchMatch, type SourceTreeEntry } from "../data/client";

const SourceText = lazy(async () => ({ default: (await import("./SourceText")).SourceText }));
const SourceDiff = lazy(async () => ({ default: (await import("./SourceDiff")).SourceDiff }));

function SourceStatusIcon(props: { status: SourceCommitFile["status"]; untracked: boolean }) {
  const letter = () => props.untracked ? "U" : ({ added: "A", modified: "M", deleted: "D", renamed: "R", copied: "C" })[props.status];
  return <span class="source-git-letter" aria-hidden="true">{letter()}</span>;
}

function Directory(props: { issueKey: string; repository: string; path: string; version: number; selected: string; recursive?: boolean; onSelect: (entry: SourceTreeEntry) => void }) {
  const [entries, setEntries] = createSignal<SourceTreeEntry[]>([], { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  let controller: AbortController | undefined;
  createEffect(() => ({ issueKey: props.issueKey, repository: props.repository, path: props.path, version: props.version }), value => {
    controller?.abort(); const request = new AbortController(); controller = request;
    setLoading(true); setError("");
    void loadSourceTree(value.issueKey, value.repository, value.path, request.signal).then(tree => {
      if (request.signal.aborted) return;
      setEntries(tree.entries);
      if (tree.truncated) setError("目录条目超过上限，请进入子目录查看");
    }).catch(cause => { if (!request.signal.aborted) setError(errorMessage(cause)); }).finally(() => { if (!request.signal.aborted) setLoading(false); });
  });
  onCleanup(() => controller?.abort());
  return <ul class="source-tree" aria-label={props.path || "仓库文件"}>
    <Show when={loading()}><li class="muted">加载中…</li></Show>
    <Show when={error()}><li role="alert">{error()}</li></Show>
    <For each={entries()} keyed={entry => entry.path}>{entry => {
      const [override, setOverride] = createSignal<boolean | undefined>(undefined, { ownedWrite: true });
      const [recursive, setRecursive] = createSignal(false, { ownedWrite: true });
      const expanded = () => override() ?? (props.recursive || props.path !== "" && entries().length === 1 && entry().type === "directory");
      return <li><button type="button" class={props.selected === entry().path ? "selected" : ""} title={entry().path} disabled={entry().type !== "file" && entry().type !== "directory"} aria-expanded={entry().type === "directory" ? expanded() ? "true" : "false" : undefined} onClick={event => { props.onSelect(entry()); if (entry().type === "directory") { const next = !expanded(); setOverride(next); setRecursive(next && event.altKey); } }}><span class="source-tree-arrow">{entry().type === "directory" ? expanded() ? <Codicon name="chevron-down" /> : <Codicon name="chevron-right" /> : null}</span><EditorFileIcon path={entry().path} directory={entry().type === "directory"} expanded={expanded()} /><span>{entry().name}</span></button>
        <Show when={entry().type === "directory" && expanded()}><Directory {...props} path={entry().path} recursive={recursive() || props.recursive} /></Show>
      </li>;
    }}</For>
  </ul>;
}

export type SourcePanel = "navigation" | "details" | "agent";
type SearchMatch = SourceSearchMatch & { repository: string };
type View = "files" | "search" | "changes";
type PathAction = { kind: "file" | "directory" | "rename" | "delete"; repository: string; path: string; directory: boolean };
type Comparison = { title: string; path: string; staged: boolean; revision?: string; canOpen: boolean; before: string; after: string };
const normalizedText = (value: string) => value.replace(/\r\n/g, "\n");
const changeLabel: Record<SourceCommitFile["status"], string> = { added: "新增", modified: "修改", deleted: "删除", renamed: "重命名", copied: "复制" };
const changedPaths = (files: SourceCommitFile[]) => [...new Set(files.flatMap(file => file.previousPath ? [file.previousPath, file.path] : [file.path]))];
async function loadChanges(key: string, repository: string, signal: AbortSignal) {
  const [working, staged] = await Promise.all([loadSourceDiff(key, repository, "", signal), loadSourceDiff(key, repository, "", signal, true)]);
  return { rows: [...staged.files.map(file => ({ file, staged: true })), ...working.files.map(file => ({ file, staged: false }))], truncated: working.truncated || staged.truncated };
}

function EditorEmpty(props: { onCommands: () => void; onFile: () => void; onSearch: () => void }) {
  const shortcuts = [{ label: "Show All Commands", keys: ["Ctrl", "Shift", "P"], run: props.onCommands }, { label: "Go to File", keys: ["Ctrl", "P"], run: props.onFile }, { label: "Find in Files", keys: ["Ctrl", "Shift", "F"], run: props.onSearch }];
  return <div class="source-empty"><div class="source-watermark"><img src={watermark} alt="" aria-hidden="true" draggable={false} /><div class="source-shortcuts"><For each={shortcuts}>{shortcut => <dl><dt><button onClick={shortcut.run}>{shortcut.label}</button></dt><dd><For each={shortcut.keys}>{(key, index) => <><Show when={index() > 0}><span>+</span></Show><kbd>{key}</kbd></>}</For></dd></dl>}</For></div></div></div>;
}

export default function CodeBrowser(props: { issueKey: string; repositoryVersion?: string; contentVersion?: string; development: boolean; agentOpen: boolean; detailsOpen: boolean; onClose: () => void; onToggleAgent: () => void; onToggleDetails: () => void; onDirtyChange?: (dirty: boolean) => void; onResize?: (panel: SourcePanel, size: number) => void }) {
  const [repositories, setRepositories] = createSignal<SourceRepository[]>([], { ownedWrite: true });
  const [repository, setRepository] = createSignal("", { ownedWrite: true });
  const [view, setView] = createSignal<View>(untrack(() => props.development) ? "changes" : "files", { ownedWrite: true });
  const [selected, setSelected] = createSignal<{ repository: string; path: string; directory: boolean }>({ repository: "", path: "", directory: true }, { ownedWrite: true });
  const pathWritable = () => repositories().find(row => row.name === (selected().repository || repository()))?.access === "write";
  const [searchDocument, setSearchDocument] = createSignal<{ term: string; content: string } | null>(null, { ownedWrite: true });
  const [searchSelection, setSearchSelection] = createSignal("", { ownedWrite: true });
  const [file, setFile] = createSignal<SourceFile | null>(null, { ownedWrite: true });
  const [draft, setDraft] = createSignal("", { ownedWrite: true });
  const [comparison, setComparison] = createSignal<Comparison | null>(null, { ownedWrite: true });
  const [blame, setBlame] = createSignal<SourceBlame | null>(null, { ownedWrite: true });
  const [blameStatus, setBlameStatus] = createSignal("行信息", { ownedWrite: true });
  const [error, setError] = createSignal("", { ownedWrite: true });
  const [loading, setLoading] = createSignal(true, { ownedWrite: true });
  const [fileLoading, setFileLoading] = createSignal(false, { ownedWrite: true });
  const [mutating, setMutating] = createSignal(false, { ownedWrite: true });
  const [saving, setSaving] = createSignal(false, { ownedWrite: true });
  const [saveBlocked, setSaveBlocked] = createSignal(false, { ownedWrite: true });
  const busy = () => mutating() || saving();
  const [panelLoading, setPanelLoading] = createSignal(false, { ownedWrite: true });
  const [version, setVersion] = createSignal(0, { ownedWrite: true });
  const [query, setQuery] = createSignal("", { ownedWrite: true });
  const [caseSensitive, setCaseSensitive] = createSignal(false, { ownedWrite: true });
  const [matches, setMatches] = createSignal<SearchMatch[]>([], { ownedWrite: true });
  const [wholeWord, setWholeWord] = createSignal(false, { ownedWrite: true });
  const [searching, setSearching] = createSignal(false, { ownedWrite: true });
  const [searched, setSearched] = createSignal(false, { ownedWrite: true });
  const [visibleSearchLimit, setVisibleSearchLimit] = createSignal<number>(issuePilotConfig.web.sourceSearchPageMatches, { ownedWrite: true });
  const [searchTruncated, setSearchTruncated] = createSignal(false, { ownedWrite: true });
  const [searchTerm, setSearchTerm] = createSignal("", { ownedWrite: true });
  const [reveal, setReveal] = createSignal({ line: 1, column: 1, length: 0 }, { ownedWrite: true });
  const searchFiles = createMemo(() => {
    const files = new Map<string, { repository: string; path: string; matches: SearchMatch[] }>();
    for (const match of matches()) {
      const key = `${match.repository}\0${match.path}`;
      if (!files.has(key)) files.set(key, { repository: match.repository, path: match.path, matches: [] });
      files.get(key)!.matches.push(match);
    }
    return [...files.values()].sort((left, right) => left.repository.localeCompare(right.repository) || left.path.localeCompare(right.path));
  });
  const visibleSearchFiles = createMemo(() => {
    let remaining = visibleSearchLimit();
    return searchFiles().flatMap(file => {
      if (!remaining) return [];
      const visible = file.matches.slice(0, remaining); remaining -= visible.length;
      return [{ ...file, matches: visible, total: file.matches.length }];
    });
  });
  const [changes, setChanges] = createSignal<Array<{ file: SourceCommitFile; staged: boolean }>>([], { ownedWrite: true });
  const changeGroups = createMemo(() => [
    { staged: true, title: "暂存区", files: changes().filter(row => row.staged).map(row => row.file).sort((a, b) => a.path.localeCompare(b.path)) },
    { staged: false, title: "工作区", files: changes().filter(row => !row.staged).map(row => row.file).sort((a, b) => a.path.localeCompare(b.path)) },
  ].filter(group => !group.staged || group.files.length > 0));
  const [commits, setCommits] = createSignal<SourceCommit[]>([], { ownedWrite: true });
  const [historyCursor, setHistoryCursor] = createSignal<SourceHistoryCursor | null>(null, { ownedWrite: true });
  const [historyLoading, setHistoryLoading] = createSignal(false, { ownedWrite: true });
  const graphs = createMemo(() => historyGraph(commits()));
  const [commitHover, setCommitHover] = createSignal<{ commit: SourceCommit; left: number; top: number } | null>(null, { ownedWrite: true });
  const [copyStatus, setCopyStatus] = createSignal("", { ownedWrite: true });
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelHoverHide = () => clearTimeout(hoverTimer);
  const hideCommitHover = () => { cancelHoverHide(); hoverTimer = setTimeout(() => setCommitHover(null), 200); };
  const showCommitHover = (commit: SourceCommit, element: HTMLElement) => {
    cancelHoverHide(); setCopyStatus("");
    const rect = element.getBoundingClientRect(), width = Math.min(440, window.innerWidth - 16);
    setCommitHover({ commit, left: Math.max(8, Math.min(rect.right + 8, window.innerWidth - width - 8)), top: Math.max(8, Math.min(rect.top, window.innerHeight - 240)) });
  };
  const copyCommit = async (commit: SourceCommit, detail: boolean) => {
    try { await copyText(detail ? `${commit.hash}\n${commit.author}\n${new Date(commit.date).toLocaleString()}\n\n${commit.subject}` : commit.hash); setCopyStatus("已复制"); }
    catch { setCopyStatus("复制失败，请选择文字后按 Ctrl+C"); }
  };
  onCleanup(cancelHoverHide);
  const [commitFiles, setCommitFiles] = createSignal<Record<string, SourceCommitFile[]>>({}, { ownedWrite: true });
  const [historySelection, setHistorySelection] = createSignal("", { ownedWrite: true });
  const [message, setMessage] = createSignal("", { ownedWrite: true });
  const [cursor, setCursor] = createSignal({ line: 1, column: 1 }, { ownedWrite: true });
  const [picker, setPicker] = createSignal<"commands" | "file" | null>(null, { ownedWrite: true });
  const [pickerPath, setPickerPath] = createSignal("", { ownedWrite: true });
  const [action, setAction] = createSignal<PathAction | null>(null, { ownedWrite: true });
  const [pathDraft, setPathDraft] = createSignal("", { ownedWrite: true });
  const currentRepository = createMemo(() => repositories().find(row => row.name === repository()));
  const writable = () => currentRepository()?.access === "write";
  const dirty = () => Boolean(file() && normalizedText(file()!.content) !== draft());
  createEffect(dirty, value => { props.onDirtyChange?.(value); });
  const mayLeave = () => !dirty() || window.confirm("文件有未保存修改，是否放弃这些修改？");
  let scope = 0, fileRequest = 0, loadedIssue = "";
  let savingRequest: { owner: number; sequence: number } | undefined;
  let changesController: AbortController | undefined;
  const [changesError, setChangesError] = createSignal("", { ownedWrite: true });
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let repositoryController: AbortController | undefined, fileController: AbortController | undefined, panelController: AbortController | undefined, searchController: AbortController | undefined, historyController: AbortController | undefined;
  let comparisonToolbar!: HTMLDivElement;
  let rootElement: HTMLElement | undefined;
  let fileActions: HTMLDetailsElement | undefined;
  const panelRange = (panel: SourcePanel) => {
    const root = rootElement?.getBoundingClientRect();
    if (!root) return { current: 0, minimum: 0, maximum: 0 };
    const navigation = rootElement?.querySelector(".source-navigation")?.getBoundingClientRect().width ?? 300;
    const details = rootElement?.querySelector(".source-details-caption")?.getBoundingClientRect().width ?? 0;
    if (panel === "navigation") return { current: navigation, minimum: 120, maximum: Math.max(120, root.width - details - 220) };
    if (panel === "details") return { current: details, minimum: 240, maximum: Math.max(240, root.width - navigation - 220) };
    const top = rootElement?.querySelector(".source-agent-caption")?.getBoundingClientRect().top ?? root.bottom - 22;
    return { current: root.bottom - 22 - top, minimum: 120, maximum: Math.max(120, root.height - 216) };
  };
  const resetFile = () => { fileRequest++; fileController?.abort(); savingRequest = undefined; setSaving(false); setSaveBlocked(false); setSearchDocument(null); setFile(null); setDraft(""); setComparison(null); setBlame(null); setSelected({ repository: "", path: "", directory: true }); setFileLoading(false); };
  const report = (cause: unknown) => setError(errorMessage(cause) === "source_file_changed" ? "文件已被其他操作修改；你的草稿已保留，请重新读取后合并。" : errorMessage(cause));

  const loadPanel = async (nextView = view(), name = repository()) => {
    historyController?.abort(); setHistoryLoading(false);
    panelController?.abort(); const request = new AbortController(); panelController = request;
    const owner = scope, key = props.issueKey;
    if (!name || nextView === "files" || nextView === "search") { setPanelLoading(false); return; }
    setError(""); setPanelLoading(true);
    try {
      const [status, history] = await Promise.allSettled([loadChanges(key, name, request.signal), loadSourceHistory(key, name, "", request.signal)]);
      if (owner !== scope || request.signal.aborted) return;
      if (status.status === "fulfilled") { setChanges(status.value.rows); setChangesError(status.value.truncated ? "变更条目超过上限，请缩小范围" : ""); } else setChangesError(errorMessage(status.reason));
      if (history.status === "fulfilled") {
        if (commits()[0]?.hash !== history.value.commits[0]?.hash || commits().length <= history.value.commits.length) {
          setCommits(history.value.commits); setHistoryCursor(history.value.nextCursor ?? null);
        }
      } else report(history.reason);
    } catch (cause) { if (owner === scope && !request.signal.aborted) report(cause); }
    finally { if (owner === scope && !request.signal.aborted) setPanelLoading(false); }
  };
  const loadMoreHistory = async () => {
    const cursor = historyCursor();
    if (!cursor || historyLoading() || panelLoading() || view() !== "changes") return;
    const request = new AbortController(); historyController = request;
    const owner = scope, name = repository(); setHistoryLoading(true); setError("");
    try {
      const page = await loadSourceHistory(props.issueKey, name, "", request.signal, cursor);
      if (owner !== scope || request.signal.aborted) return;
      const existing = new Set(commits().map(commit => commit.hash));
      const added = page.commits.filter(commit => !existing.has(commit.hash));
      if (!added.length && page.truncated) throw new Error("历史列表已变化，请刷新后重试。");
      setCommits(value => [...value, ...added]); setHistoryCursor(page.nextCursor);
    } catch (cause) { if (owner === scope && !request.signal.aborted) report(cause); }
    finally { if (owner === scope && !request.signal.aborted) setHistoryLoading(false); }
  };
  createEffect(() => ({ issueKey: props.issueKey, version: props.repositoryVersion }), value => {
    repositoryController?.abort(); fileController?.abort(); panelController?.abort(); searchController?.abort(); historyController?.abort(); setHistoryLoading(false); setSearching(false); setCommitHover(null);
    const request = new AbortController(); repositoryController = request;
    const owner = ++scope;
    savingRequest = undefined; setSaving(false);
    setLoading(true); setMutating(false); setFileLoading(false); setError("");
    if (loadedIssue !== value.issueKey) { resetFile(); setRepository(""); setMatches([]); setChanges([]); setCommits([]); setHistoryCursor(null); setCommitFiles({}); setHistorySelection(""); loadedIssue = value.issueKey; }
    void loadSourceRepositories(value.issueKey, request.signal).then(rows => {
      if (owner !== scope || request.signal.aborted) return;
      const retained = rows.find(row => row.name === repository() && row.url === currentRepository()?.url);
      setRepositories(rows);
      const name = retained?.name ?? rows[0]?.name ?? "";
      if (!retained) {
        if (dirty()) { setRepository(""); setError("当前仓库已变化，未保存内容仍在编辑区，请先复制或另存。"); return; }
        resetFile(); setRepository(name);
      }
      setVersion(value => value + 1); void loadPanel(view(), name);
    }).catch(cause => { if (!request.signal.aborted) report(cause); }).finally(() => { if (owner === scope) setLoading(false); });
  });
  onCleanup(() => { scope++; repositoryController?.abort(); fileController?.abort(); panelController?.abort(); searchController?.abort(); historyController?.abort(); });
  const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty()) { event.preventDefault(); event.returnValue = ""; } };
  window.addEventListener("beforeunload", beforeUnload);
  onCleanup(() => window.removeEventListener("beforeunload", beforeUnload));

  const refreshChanges = async () => {
    if (view() !== "changes" || !repository() || mutating() || panelLoading() || document.hidden || changesController) return;
    const request = new AbortController(); changesController = request;
    const owner = scope, name = repository();
    try {
      const result = await loadChanges(props.issueKey, name, request.signal);
      if (owner !== scope || request.signal.aborted) return;
      const current = changes();
      if (current.length !== result.rows.length || result.rows.some((row, index) => row.staged !== current[index]!.staged || row.file.path !== current[index]!.file.path || row.file.previousPath !== current[index]!.file.previousPath || row.file.status !== current[index]!.file.status)) setChanges(result.rows);
      setChangesError(result.truncated ? "变更条目超过上限，请缩小范围" : "");
    } catch (cause) { if (owner === scope && !request.signal.aborted) setChangesError(errorMessage(cause)); }
    finally { if (changesController === request) changesController = undefined; }
  };
  createEffect(() => ({ issueKey: props.issueKey, repository: repository(), view: view() }), value => {
    changesController?.abort(); changesController = undefined;
    if (value.view !== "changes" || !value.repository) return;
    const refresh = () => { void refreshChanges(); };
    const timer = setInterval(refresh, issuePilotConfig.web.sourceRefreshMs);
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(timer); changesController?.abort(); changesController = undefined; window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  });
  createEffect(() => props.contentVersion, () => { setVersion(value => value + 1); untrack(() => { void refreshChanges(); }); });
  const selectRepository = (name: string) => {
    scope++; resetFile(); setMutating(false); setRepository(name); setChanges([]); setCommits([]); setHistoryCursor(null); setHistoryLoading(false); historyController?.abort(); setCommitFiles({}); setHistorySelection(""); setCommitHover(null); setError("");
    panelController?.abort(); searchController?.abort(); setSearching(false); setPanelLoading(false);
  };
  const loadFile = async (path: string, target: { repository?: string; line?: number; column?: number; length?: number } = {}) => {
    const name = target.repository ?? repository();
    if (!name) return;
    if (name !== repository()) selectRepository(name);
    fileController?.abort(); const request = new AbortController(); fileController = request;
    const owner = scope, sequence = ++fileRequest;
    setFileLoading(true); setError(""); setComparison(null); setSearchDocument(null); setBlame(null); setSelected({ repository: name, path, directory: false });
    try {
      const loaded = await loadSourceFile(props.issueKey, name, path, request.signal);
      if (owner !== scope || sequence !== fileRequest || request.signal.aborted) return;
      setFile(loaded); setDraft(normalizedText(loaded.content)); setSaveBlocked(false);
      setCursor({ line: target.line ?? 1, column: target.column ?? 1 });
      setReveal({ line: target.line ?? 1, column: target.column ?? 1, length: target.length ?? 0 });
      return loaded;
    } catch (cause) { if (owner === scope && sequence === fileRequest && !request.signal.aborted) report(cause); }
    finally { if (owner === scope && sequence === fileRequest) setFileLoading(false); }
  };
  const openFile = (...args: Parameters<typeof loadFile>) => {
    if (busy() || !mayLeave()) return;
    return loadFile(...args);
  };
  async function mutate<T>(operation: () => Promise<T>, after?: (value: T) => void | Promise<void>, targetRepository = repository()) {
    if (busy() || repositories().find(row => row.name === targetRepository)?.access !== "write") return;
    const owner = scope; setMutating(true); setError("");
    try {
      const value = await operation();
      if (owner !== scope) return;
      setVersion(value => value + 1);
      await loadPanel();
      if (owner === scope) await after?.(value);
    } catch (cause) { if (owner === scope) report(cause); }
    finally { if (owner === scope) setMutating(false); }
  }
  const save = async () => {
    const current = file();
    if (!current || !dirty() || !writable() || mutating() || fileLoading() || savingRequest?.owner === scope && savingRequest.sequence === fileRequest) return;
    const task = { owner: scope, sequence: fileRequest }, content = draft(), name = repository();
    savingRequest = task; setSaving(true); setSaveBlocked(false); setError("");
    try {
      const saved = await saveSourceFile(props.issueKey, name, current.path, current.content.includes("\r\n") ? content.replace(/\n/g, "\r\n") : content, current.sha256);
      if (task.owner !== scope || task.sequence !== fileRequest) return;
      setFile(saved); setVersion(value => value + 1);
    } catch (cause) { if (task.owner === scope && task.sequence === fileRequest) { setSaveBlocked(true); report(cause); } }
    finally { if (savingRequest === task) { savingRequest = undefined; if (task.owner === scope && task.sequence === fileRequest) { setSaving(false); void refreshChanges(); } } }
  };
  createEffect(() => ({ draft: draft(), file: file(), writable: writable(), saving: saving(), mutating: mutating(), blocked: saveBlocked(), loading: fileLoading() }), value => {
    if (!value.file || !value.writable || value.saving || value.mutating || value.blocked || value.loading || value.draft === normalizedText(value.file.content)) return;
    const timer = setTimeout(() => { void save(); }, issuePilotConfig.web.sourceAutoSaveDebounceMs);
    return () => clearTimeout(timer);
  });
  const switchRepository = (name: string) => {
    if (name === repository() || !mayLeave() || busy()) return;
    selectRepository(name); void loadPanel(view(), name);
  };
  const search = async (term = query().trim()) => {
    clearTimeout(searchTimer);
    searchController?.abort();
    if (!term || !repositories().length) { setMatches([]); setSearched(false); setSearching(false); return; }
    const request = new AbortController(); searchController = request;
    const owner = scope, key = props.issueKey, targets = repositories();
    setError(""); setSearching(true); setSearched(true); setSearchTerm(term); setMatches([]); setSearchTruncated(false); setVisibleSearchLimit(issuePilotConfig.web.sourceSearchPageMatches);
    try {
      const found: SearchMatch[] = []; let failures = 0, truncated = false;
      const limit = issuePilotConfig.limits.sourceBrowser.searchMatches, concurrency = issuePilotConfig.web.sourceSearchConcurrency;
      for (let offset = 0; offset < targets.length; offset += concurrency) {
        const batch = targets.slice(offset, offset + concurrency);
        const results = await Promise.allSettled(batch.map(row => searchSource(key, row.name, term, { caseSensitive: caseSensitive(), wordMatch: wholeWord() }, request.signal)));
        if (owner !== scope || request.signal.aborted) return;
        results.forEach((result, index) => {
          if (result.status === "fulfilled") {
            const room = limit - found.length;
            found.push(...result.value.matches.slice(0, room).map(match => ({ ...match, repository: batch[index]!.name })));
            truncated ||= result.value.truncated || result.value.matches.length > room;
          } else failures++;
        });
        setMatches([...found]);
        if (found.length === limit && offset + concurrency < targets.length) { truncated = true; break; }
      }
      setSearchTruncated(truncated);
      if (failures) setError(`${failures} 个仓库搜索失败。`);
    } catch (cause) { if (owner === scope && !request.signal.aborted) report(cause); }
    finally { if (owner === scope && !request.signal.aborted) setSearching(false); }
  };
  const removeSearchMatch = (match: SearchMatch) => setMatches(value => value.filter(row => row !== match));
  const replaceSearchMatch = async (match: SearchMatch) => {
    if (busy() || !mayLeave() || repositories().find(row => row.name === match.repository)?.access !== "write") return;
    const loaded = await loadFile(match.path, { repository: match.repository, line: match.line, column: match.column });
    if (!loaded || file() !== loaded) return;
    const content = normalizedText(loaded.content), lines = content.split("\n");
    const offset = lines.slice(0, match.line - 1).reduce((sum, line) => sum + line.length + 1, 0) + match.column - 1;
    const selected = content.slice(offset, offset + searchTerm().length);
    if (caseSensitive() ? selected !== searchTerm() : selected.toLocaleLowerCase() !== searchTerm().toLocaleLowerCase()) { setError("匹配内容已变化，请重新搜索。"); return; }
    setDraft(content.slice(0, offset) + content.slice(offset + selected.length));
  };
  createEffect(() => ({ view: view(), query: query(), caseSensitive: caseSensitive(), wholeWord: wholeWord(), version: version(), repositories: repositories().map(row => row.name).join("|") }), value => {
    searchController?.abort(); setSearching(false);
    if (value.view !== "search") return;
    setMatches([]); setSearched(false); setSearchTruncated(false); setVisibleSearchLimit(issuePilotConfig.web.sourceSearchPageMatches);
    searchTimer = setTimeout(() => { void search(value.query.trim()); }, issuePilotConfig.web.sourceSearchDebounceMs);
    return () => clearTimeout(searchTimer);
  });
  createEffect(() => view(), value => {
    cancelHoverHide(); setCommitHover(null);
    if (value === "search") queueMicrotask(() => { if (rootElement?.isConnected && view() === "search") rootElement.querySelector<HTMLInputElement>('[aria-label="代码搜索文字"]')?.focus(); });
  });
  const compare = async (path: string, staged: boolean, revision?: string) => {
    panelController?.abort(); const request = new AbortController(); panelController = request;
    const owner = scope; setError(""); setPanelLoading(true);
    try {
      const result = revision ? await loadSourceCommitFile(props.issueKey, repository(), revision, path, request.signal) : await loadSourceDiffFile(props.issueKey, repository(), path, request.signal, staged);
      if (owner === scope && !request.signal.aborted) {
        setSearchDocument(null);
        const beforeRevision = result.before && "revision" in result.before ? result.before.revision.slice(0, 8) : commits().find(commit => commit.hash === revision)?.parents[0]?.slice(0, 8) ?? "";
        setComparison({ title: revision ? `${basename(result.file.previousPath ?? path)} (${beforeRevision}) ↔ ${basename(path)} (${revision.slice(0, 8)})` : `${basename(path)} (${staged ? "Index" : "Working Tree"})`, path, staged, ...(revision ? { revision } : {}), canOpen: Boolean(result.after), before: result.before?.content ?? "", after: result.after?.content ?? "" });
      }
    } catch (cause) { if (owner === scope && !request.signal.aborted) report(cause); }
    finally { if (owner === scope && !request.signal.aborted) setPanelLoading(false); }
  };
  const changeStage = (files: SourceCommitFile[], staged: boolean) => {
    if (dirty()) return;
    const paths = changedPaths(files), current = comparison();
    void mutate(() => staged ? unstageSourcePaths(props.issueKey, repository(), paths) : stageSourcePaths(props.issueKey, repository(), paths), async () => {
      if (current && comparison() === current && !current.revision && view() === "changes" && files.some(file => file.path === current.path)) await compare(current.path, !staged);
    });
  };
  const discardChange = (changed: SourceCommitFile) => {
    if (busy() || dirty() || !window.confirm(`放弃 ${changed.path} 的 Git 修改？`)) return;
    const active = file(), name = repository();
    void mutate(() => discardSourcePaths(props.issueKey, name, changedPaths([changed])), async () => {
      if (!active || !changedPaths([changed]).includes(active.path)) return;
      if (changed.status === "added" || changed.status === "renamed" && active.path === changed.path) resetFile();
      else await loadFile(active.path, { repository: name });
    });
  };
  const historyFiles = async (revision: string, openFirst = false) => {
    setHistorySelection(revision);
    if (!openFirst && commitFiles()[revision]) { setCommitFiles(value => { const next = { ...value }; delete next[revision]; return next; }); return; }
    panelController?.abort(); const request = new AbortController(); panelController = request;
    const owner = scope; setPanelLoading(true); setError("");
    try {
      const result = commitFiles()[revision] ? { files: commitFiles()[revision]!, truncated: false } : await loadSourceCommit(props.issueKey, repository(), revision, "", request.signal);
      if (owner !== scope || request.signal.aborted) return;
      setCommitFiles(value => ({ ...value, [revision]: result.files }));
      if (result.truncated) setError("提交文件超过上限");
      if (openFirst) { const first = result.files[0]; if (first) { setHistorySelection(`${revision}/${first.path}`); await compare(first.path, false, revision); } }
    } catch (cause) { if (owner === scope && !request.signal.aborted) report(cause); }
    finally { if (owner === scope && !request.signal.aborted) setPanelLoading(false); }
  };
  createEffect(() => ({ issueKey: props.issueKey, repository: repository(), file: file(), line: cursor().line, loading: fileLoading(), dirty: dirty(), comparison: comparison() }), value => {
    setBlame(null);
    if (!value.file || value.loading || value.comparison) { setBlameStatus("行信息"); return; }
    if (value.dirty) { setBlameStatus("未保存的更改"); return; }
    setBlameStatus("加载行信息…");
    const request = new AbortController();
    const timer = setTimeout(() => {
      void loadSourceBlame(value.issueKey, value.repository, value.file!.path, value.line, request.signal).then(result => {
        if (!request.signal.aborted) setBlame(result);
      }).catch(() => { if (!request.signal.aborted) setBlameStatus("暂无行信息"); });
    }, issuePilotConfig.web.sourceBlameDebounceMs);
    return () => { clearTimeout(timer); request.abort(); };
  });
  const blameLabel = () => {
    const value = blame();
    return value ? value.commit ? `${value.author} · ${relativeTime(value.date!)} · ${value.subject}` : value.subject : blameStatus();
  };
  const showBlameHover = (element: HTMLElement) => {
    const value = blame();
    if (value?.commit && value.date) showCommitHover({ hash: value.commit, shortHash: value.shortCommit!, parents: [], author: value.author, date: value.date, subject: value.subject }, element);
  };
  const openAction = (kind: PathAction["kind"]) => {
    if (fileActions) fileActions.open = false;
    const target = selected(); setError(""); setAction({ kind, ...target, repository: target.repository || repository() });
    setPathDraft(kind === "rename" ? target.path : target.directory && target.path ? `${target.path}/` : "");
  };
  const applyPathAction = () => {
    const current = action(); if (!current) return;
    const key = props.issueKey, name = current.repository, destination = pathDraft().trim();
    const active = file(), affectsFile = name === repository() && active && (active.path === current.path || current.directory && active.path.startsWith(`${current.path}/`));
    if ((current.kind === "file" || affectsFile) && !mayLeave()) return;
    void mutate(async () => {
      if (current.kind === "file") return createSourceFile(key, name, destination, "");
      if (current.kind === "directory") await createSourceDirectory(key, name, destination);
      if (current.kind === "rename") await renameSourcePath(key, name, current.path, destination, false);
      if (current.kind === "delete") await deleteSourcePath(key, name, current.path, current.directory);
    }, async created => {
      setAction(null);
      if (created) { if (name !== repository()) selectRepository(name); setFile(created); setDraft(normalizedText(created.content)); setComparison(null); setSelected({ repository: name, path: created.path, directory: false }); setReveal({ line: 1, column: 1, length: 0 }); }
      else if (affectsFile && current.kind === "rename") await loadFile(destination + active.path.slice(current.path.length), { repository: name });
      else if (affectsFile && current.kind === "delete") resetFile();
    }, name);
  };
  const views = [{ value: "files" as const, label: "文件", title: "Explorer", icon: File }, { value: "search" as const, label: "搜索", title: "Search", icon: Search }, { value: "changes" as const, label: "变更", title: "Source Control", icon: GitBranch }];
  const activePath = () => searchDocument() ? `Search: ${searchDocument()!.term}` : comparison() ? comparison()!.path : file()?.path ?? "";
  const basename = (path: string) => path.split("/").at(-1) ?? path;
  const directoryName = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const closeFile = () => { if (searchDocument()) setSearchDocument(null); else if (comparison()) { panelController?.abort(); setPanelLoading(false); setComparison(null); } else if (mayLeave()) resetFile(); };
  const openSearchEditor = () => {
    if (busy() || !mayLeave()) return;
    const content = searchFiles().map(file => `${file.repository}/${file.path}\n${file.matches.map(match => `  ${match.line}: ${match.preview}`).join("\n")}`).join("\n\n");
    resetFile(); setSearchDocument({ term: searchTerm(), content });
  };
  const commit = (event?: Event) => {
    event?.preventDefault();
    if (busy() || dirty() || panelLoading() || !changes().some(row => row.staged)) return;
    if (!message().trim()) { setError("请填写提交说明"); return; }
    void mutate(() => commitSourceChanges(props.issueKey, repository(), message()), () => { setMessage(""); if (!comparison()?.revision) setComparison(null); });
  };
  const openPicker = (value: "commands" | "file") => { setPickerPath(activePath()); setPicker(value); };
  const keyboard = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || !(event.ctrlKey || event.metaKey) || action()) return;
    if (event.key.toLowerCase() === "p") { event.preventDefault(); openPicker(event.shiftKey ? "commands" : "file"); }
    if (event.shiftKey && event.key.toLowerCase() === "f") { event.preventDefault(); setView("search"); void loadPanel("search"); }
  };
  window.addEventListener("keydown", keyboard);
  onCleanup(() => window.removeEventListener("keydown", keyboard));
  const actionTitle = () => ({ file: "新建文件", directory: "新建目录", rename: "重命名", delete: "删除路径" })[action()?.kind ?? "file"];

  return <section ref={rootElement} class="source-browser" aria-label={`${props.issueKey} 代码浏览器`}>
    <header class="source-browser-header">
      <div class="source-browser-title"><Code2 size={16} /><strong>代码</strong><small>{props.issueKey}</small></div>
      <div class="source-view-switcher" role="toolbar" aria-label="代码视图"><For each={views}>{item => <Button type="text" shape="circle" icon={<item.icon size={16} />} aria-label={item.label} title={item.title} aria-pressed={view() === item.value ? "true" : "false"} onClick={() => { setView(item.value); void loadPanel(item.value); }} />}</For></div>
      <Button type="text" shape="circle" icon={<PanelBottom size={16} />} aria-label="Agent面板" aria-pressed={props.agentOpen ? "true" : "false"} onClick={props.onToggleAgent} />
      <Button type="text" shape="circle" icon={<PanelRight size={16} />} aria-label="工单详情" aria-pressed={props.detailsOpen ? "true" : "false"} onClick={props.onToggleDetails} />
      <Button type="text" shape="circle" icon={<X size={16} />} aria-label="关闭代码浏览器" onClick={() => { if (mayLeave()) props.onClose(); }} />
    </header>
    <Show when={error() && !action()}><div class="source-error" role="alert">{error()}</div></Show>
    <Show when={loading() || panelLoading()}><div class="source-loading" role="status">代码加载中…</div></Show>
    <div class="source-body">
      <nav class={`source-navigation source-nav-${view()}`} aria-label="代码导航">
        <div class="source-navigation-title"><span>{view() === "files" ? `${props.issueKey} (WORKSPACE)` : view() === "search" ? "SEARCH" : "SOURCE CONTROL"}</span><Button type="text" icon={<Codicon name="refresh" size={14} />} aria-label="刷新代码" title="Refresh" onClick={() => { setVersion(value => value + 1); void loadPanel(); }} /></div>
        <Show when={view() === "changes"}><div class="source-section-title"><Codicon name="chevron-down" size={14} /><span>REPOSITORIES</span></div><div class="source-repository-list"><For each={repositories()}>{row => <button type="button" class={row.name === repository() ? "selected" : ""} aria-label={`仓库 ${row.name}`} disabled={busy()} onClick={() => switchRepository(row.name)}><Codicon name="vm-outline" />{row.name}</button>}</For></div></Show>
        <Show when={view() === "files"}>
          <details ref={fileActions} class="source-path-actions"><summary aria-label="文件操作" title="File actions">…</summary><div><Button size="small" icon={<Plus size={13} />} disabled={!pathWritable() || busy()} onClick={() => openAction("file")}>新建文件</Button><Button size="small" disabled={!pathWritable() || busy()} onClick={() => openAction("directory")}>新建目录</Button><Button size="small" icon={<Pencil size={13} />} disabled={!pathWritable() || busy() || !selected().path} onClick={() => openAction("rename")}>重命名</Button><Button size="small" icon={<Trash2 size={13} />} danger disabled={!pathWritable() || busy() || !selected().path} onClick={() => openAction("delete")}>删除</Button></div></details>
          <For each={repositories()} keyed={row => row.name}>{row => {
            const [expanded, setExpanded] = createSignal(true, { ownedWrite: true });
            const [recursive, setRecursive] = createSignal(false, { ownedWrite: true });
            return <section class="source-repository-tree"><button class="source-repository-root" aria-label={`仓库 ${row().name}`} aria-expanded={expanded() ? "true" : "false"} onClick={event => { const next = !expanded(); setExpanded(next); setRecursive(next && event.altKey); setSelected({ repository: row().name, path: "", directory: true }); }}>{expanded() ? <Codicon name="chevron-down" /> : <Codicon name="chevron-right" />}<EditorFileIcon path={row().name} directory root expanded={expanded()} /> {row().name}</button><Show when={expanded()}><Directory issueKey={props.issueKey} repository={row().name} path="" version={version()} selected={selected().repository === row().name ? selected().path : ""} recursive={recursive()} onSelect={entry => { if (busy()) return; if (entry.type === "directory") setSelected({ repository: row().name, path: entry.path, directory: true }); else void openFile(entry.path, { repository: row().name }); }} /></Show></section>;
          }}</For>
        </Show>
        <Show when={view() === "search"}>
          <form class="source-search-form" onSubmit={event => { event.preventDefault(); void search(); }}>
            <div class="source-search-input"><Input aria-label="代码搜索文字" placeholder="Search" value={query()} onInput={event => setQuery(event.currentTarget.value)} /><div class="source-search-options"><Button type="text" icon={<Codicon name="case-sensitive" />} aria-label="区分大小写" title="Match Case" aria-pressed={caseSensitive() ? "true" : "false"} onClick={() => setCaseSensitive(value => !value)} /><Button type="text" icon={<Codicon name="whole-word" />} aria-label="匹配全字" title="Match Whole Word" aria-pressed={wholeWord() ? "true" : "false"} onClick={() => setWholeWord(value => !value)} /></div></div>
          </form>
          <Show when={searching()}><div class="source-search-summary" role="status">搜索中…</div></Show>
          <Show when={!searching() && searched()}><div class="source-search-summary" role="status"><Show when={matches().length} fallback="没有搜索结果">{matches().length} results in {searchFiles().length} files - <button onClick={openSearchEditor}>Open in editor</button></Show></div></Show>
          <Show when={searchTruncated()}><div class="source-search-limit" role="status">结果达到上限，请缩小搜索范围。</div></Show>
          <div class="source-search-results"><For each={repositories().filter(row => visibleSearchFiles().some(file => file.repository === row.name)).sort((left, right) => left.name.localeCompare(right.name))}>{row => {
            const [expanded, setExpanded] = createSignal(true, { ownedWrite: true });
            return <details class="source-search-repository" open onToggle={event => { setExpanded(event.currentTarget.open); }}>
            <summary class="source-search-repository-title"><Codicon name="chevron-down" /><EditorFileIcon path={row.name} directory root expanded={expanded()} /><span>{row.name}</span><span class="source-search-count">{matches().filter(match => match.repository === row.name).length}</span></summary>
            <For each={visibleSearchFiles().filter(file => file.repository === row.name)} keyed={file => file.path}>{file => <details class="source-search-file" open>
              <summary class="source-search-file-title"><Codicon name="chevron-down" /><EditorFileIcon path={file().path} /><span class="source-file-label"><span>{basename(file().path)}</span><small>{file().repository}{directoryName(file().path) ? ` • ${directoryName(file().path)}` : ""}</small></span><span class="source-search-count">{file().total}</span></summary>
              <For each={file().matches}>{match => <div class={`source-search-match${searchSelection() === `${match.repository}/${match.path}:${match.line}` ? " selected" : ""}`}><button class="source-search-match-select" aria-label={`打开搜索结果 ${match.repository}/${match.path}:${match.line}`} onClick={() => { setSearchSelection(`${match.repository}/${match.path}:${match.line}`); void openFile(match.path, { repository: match.repository, line: match.line, column: match.column, length: searchTerm().length }); }}><code>{match.preview.slice(0, match.column - 1)}<mark>{match.preview.slice(match.column - 1, match.column - 1 + searchTerm().length)}</mark>{match.preview.slice(match.column - 1 + searchTerm().length)}</code></button><div class="source-search-match-actions"><Button type="text" icon={<Codicon name="replace" />} aria-label={`替换为空 ${match.repository}/${match.path}:${match.line}`} title="Replace" disabled={busy() || repositories().find(row => row.name === match.repository)?.access !== "write"} onClick={() => { void replaceSearchMatch(match); }} /><Button type="text" icon={<Codicon name="close" />} aria-label={`移除搜索结果 ${match.repository}/${match.path}:${match.line}`} title="Dismiss" onClick={() => removeSearchMatch(match)} /></div></div>}</For>
            </details>}</For>
          </details>;
          }}</For><Show when={matches().length > visibleSearchLimit()}><Button class="source-search-more" onClick={() => setVisibleSearchLimit(value => value + issuePilotConfig.web.sourceSearchPageMatches)}>显示更多结果（{matches().length - visibleSearchLimit()}）</Button></Show></div>
        </Show>
        <Show when={view() === "changes"}>
          <section class="source-git-pane"><div class="source-section-title"><Codicon name="chevron-down" size={14} /><span>CHANGES</span></div>
          <Show when={writable()}><form class="source-commit-form" onSubmit={commit}><Input aria-label="提交说明" placeholder="Message (press Ctrl+Enter to commit)" value={message()} disabled={busy()} onInput={event => setMessage(event.currentTarget.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") commit(event); }} /><Button htmlType="submit" size="small" type="primary" aria-label="提交暂存的变更" disabled={busy() || dirty() || panelLoading() || !changes().some(row => row.staged)}>Commit</Button></form></Show>
          <Show when={changesError()}><div class="source-git-error" role="alert">{changesError()}</div></Show><For each={changeGroups()}>{group => {
            const staged = group.staged;
            return <section class="source-change-group"><header><Codicon name="chevron-down" size={14} /><h3 aria-label={group.title}>{staged ? "Staged Changes" : "Changes"}</h3><span class="source-change-count">{group.files.length}</span><Show when={writable()}><Button type="text" class="source-group-action" aria-label={staged ? "全部取消暂存" : "全部暂存"} title={staged ? "Unstage All Changes" : "Stage All Changes"} disabled={busy() || dirty() || panelLoading() || !group.files.length} onClick={() => changeStage(group.files, staged)}>{staged ? "−" : "+"}</Button></Show></header><For each={group.files}>{file => <div class={`source-change${comparison()?.path === file.path && !comparison()?.revision && comparison()?.staged === staged ? " selected" : ""}`}><button aria-label={`查看差异 ${file.path}`} title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path} disabled={busy() || panelLoading()} onClick={() => { void compare(file.path, staged); }}><EditorFileIcon path={file.path} /><span class="source-change-name">{basename(file.path)}</span><span class="source-change-directory">{directoryName(file.path)}</span></button><div class="source-change-actions"><Show when={writable()}><Button type="text" aria-label={staged ? "取消暂存" : "暂存"} title={staged ? "Unstage Changes" : "Stage Changes"} disabled={busy() || dirty() || panelLoading()} onClick={() => changeStage([file], staged)}>{staged ? "−" : "+"}</Button><Show when={!staged}><Button type="text" aria-label="放弃" title="Discard Changes" disabled={busy() || dirty() || panelLoading()} onClick={() => discardChange(file)}>↶</Button></Show></Show><span class={`source-change-status ${file.status}`} title={!staged && file.status === "added" ? "未跟踪" : changeLabel[file.status]}><SourceStatusIcon status={file.status} untracked={!staged && file.status === "added"} /></span></div></div>}</For></section>;
          }}</For></section>
        </Show>
        <Show when={view() === "changes"}><section class="source-history" aria-label="提交历史"><div class="source-section-title"><Codicon name="chevron-down" /><button aria-label="历史" title="Commit History" onClick={() => { void loadPanel("changes"); }}>GRAPH</button><span class="source-history-auto"><Codicon name="git-branch" size={16} /> Auto</span><Button type="text" icon={<Codicon name="target" />} aria-label="定位最新提交" onClick={() => rootElement?.querySelector(".source-history-row")?.scrollIntoView({ block: "nearest" })} /><Button type="text" icon={<Codicon name="refresh" />} aria-label="刷新历史" onClick={() => { void loadPanel(); }} /></div><div class="source-history-tree"><For each={commits()} fallback={<p class="muted">没有提交记录</p>}>{(commit, index) => <div class={`source-history-commit${historySelection().startsWith(commit.hash) ? " active" : ""}`}><div class={`source-history-row${historySelection() === commit.hash ? " selected" : ""}`}><button class="source-history-select" aria-label={`${commit.subject}, ${commit.author}`} aria-expanded={commitFiles()[commit.hash] ? "true" : "false"} onMouseEnter={event => showCommitHover(commit, event.currentTarget)} onMouseLeave={hideCommitHover} onClick={() => { void historyFiles(commit.hash); }}><HistoryGraph value={graphs().get(commit.hash)!} expanded={Boolean(commitFiles()[commit.hash])} /><span class="source-history-label"><span>{commit.subject}</span><small>{commit.author}</small></span><Show when={index() === 0}><span class="source-branch-label"><Codicon name="git-branch" size={12} /><span>{currentRepository()?.branch}</span></span></Show></button><Button class="source-history-action" type="text" icon={<Codicon name="diff-multiple" />} aria-label={`打开提交变更 ${commit.shortHash}`} title="Open Changes" onClick={() => { void historyFiles(commit.hash, true); }} /></div><Show when={commitFiles()[commit.hash]}>{files => <div class="source-history-files" role="group" aria-label={`${commit.subject} 涉及的文件`}><For each={files()}>{row => <div class={`source-history-file${historySelection() === `${commit.hash}/${row.path}` ? " selected" : ""}`} style={{ "padding-left": `${graphs().get(commit.hash)!.fileWidth}px`, "--history-indent": `${graphs().get(commit.hash)!.fileWidth}px` }}><button aria-label={`提交文件 ${row.path}`} title={`${changeLabel[row.status]}: ${row.previousPath ? `${row.previousPath} → ` : ""}${row.path}`} onClick={() => { setHistorySelection(`${commit.hash}/${row.path}`); void compare(row.path, false, commit.hash); }}><HistoryGraph value={graphs().get(commit.hash)!} files /><EditorFileIcon path={row.path} /><span class="source-file-label"><span>{basename(row.path)}</span><small>{repository()}{directoryName(row.path) ? ` • ${directoryName(row.path)}` : ""}</small></span></button><Button class="source-history-action" type="text" icon={<Codicon name="go-to-file" />} aria-label={`打开文件 ${row.path}`} title="Open File" disabled={row.status === "deleted"} onClick={() => { void openFile(row.path); }} /></div>}</For></div>}</Show></div>}</For><Show when={historyCursor()}><Button class="source-history-more" loading={historyLoading()} disabled={historyLoading() || panelLoading()} onClick={() => { void loadMoreHistory(); }}>加载更早提交</Button></Show></div></section></Show>
      </nav>
      <div class="source-editor">
        <Show when={activePath()}><div class="source-editor-tabs"><div class="source-editor-tab"><EditorFileIcon path={activePath()} /><strong class={comparison()?.revision ? "source-revision-title" : ""}>{comparison()?.title ?? basename(activePath())}{dirty() && !comparison() ? " · 未保存" : ""}</strong><Show when={comparison()?.revision}><Codicon name="lock-small" size={12} /></Show><Button type="text" icon={<X size={14} />} aria-label={comparison() ? "关闭差异" : "关闭文件"} onClick={closeFile} /></div></div></Show>
        <div class="source-editor-meta" style={{ display: activePath() ? undefined : "none" }}>
          <div class="source-breadcrumb" title={`${props.issueKey}/${repository()}/${activePath()}`}><Show when={comparison()?.revision} fallback={<EditorFileIcon path={repository()} directory root expanded />}><span>{props.issueKey}</span><Codicon name="chevron-right" size={14} /></Show><span>{repository()}</span><For each={activePath().split("/")}>{(part, index) => <><Codicon name="chevron-right" size={14} /><Show when={index() === activePath().split("/").length - 1}><EditorFileIcon path={activePath()} /></Show><span>{part}</span></>}</For></div>
          <div class="source-comparison-tools" ref={comparisonToolbar} />
          <div class="source-file-tools"><Show when={file() && !comparison()}><Button size="small" type="text" disabled={busy() || fileLoading()} onClick={() => { void openFile(file()!.path); }}>重新读取</Button><span class="source-save-status" aria-label="文件保存状态">{saving() ? "保存中…" : dirty() ? saveBlocked() ? "保存失败 · 草稿已保留" : "等待自动保存" : "已保存"}</span><Button size="small" type="text" disabled={!writable() || !dirty() || busy() || fileLoading()} onClick={save}>保存文件</Button></Show></div>
        </div>
        <Show when={comparison()}>{value => <SourceDiff value={value()} toolbar={comparisonToolbar} disabled={busy() || panelLoading() || !value().canOpen} onOpen={() => { void openFile(value().path); }} />}</Show>
        <Show when={searchDocument()}>{document => <SourceText path={`搜索结果 ${document().term}`} value={document().content} readonly onInput={() => {}} onSave={() => {}} onPosition={(line, column) => { setCursor({ line, column }); }} />}</Show>
        <Show when={!comparison() && !searchDocument()}>
          <Show when={fileLoading()}><div role="status">文件加载中…</div></Show>
          <Show when={file()} fallback={<EditorEmpty onCommands={() => openPicker("commands")} onFile={() => openPicker("file")} onSearch={() => { setView("search"); void loadPanel("search"); }} />}><SourceText path={file()!.path} value={draft()} reveal={reveal()} readonly={!writable() || mutating() || fileLoading()} onInput={setDraft} onSave={save} onPosition={(line, column) => { setCursor({ line, column }); }} /></Show>
        </Show>
      </div>
      <Show when={props.agentOpen}><div class="source-agent-caption"><span>AGENT</span><Button type="text" icon={<X size={14} />} aria-label="关闭 Agent 面板" onClick={props.onToggleAgent} /></div></Show>
    </div>
    <Show when={props.detailsOpen}><div class="source-details-caption"><span>工单详情</span><Button type="text" icon={<X size={14} />} aria-label="关闭工单详情" onClick={props.onToggleDetails} /></div></Show>
    <footer class="source-statusbar"><div class="source-status-left"><Codicon name="vm-outline" size={14} /><span>{repository()}</span><span class="source-status-blame" aria-label="当前行归属" onMouseEnter={event => showBlameHover(event.currentTarget)} onMouseLeave={hideCommitHover}><Show when={file() && !comparison()}>{blameLabel()}</Show></span></div><div><Show when={activePath()}><Show when={file() && !comparison()}><span>Ln {cursor().line}, Col {cursor().column}</span></Show><span>Spaces: 2</span><span>UTF-8</span><span>{file()?.content.includes("\r\n") ? "CRLF" : "LF"}</span><span>{sourceLanguageName(activePath())}</span><Show when={!writable()}><span>只读</span></Show></Show></div></footer>
    <Show when={commitHover()}>{hover => <Portal><div class="source-commit-hover" role="tooltip" aria-label="提交信息" style={{ left: `${hover().left}px`, top: `${hover().top}px` }} onMouseEnter={cancelHoverHide} onMouseLeave={hideCommitHover} onKeyDown={event => { if (event.key === "Escape") setCommitHover(null); }}><header><Codicon name="account" /><strong>{hover().commit.author}</strong><time>{new Date(hover().commit.date).toLocaleString()}</time></header><p>{hover().commit.subject}</p><div class="source-commit-hash"><Codicon name="git-commit" /><code>{hover().commit.hash}</code></div><footer><Button size="small" onFocus={cancelHoverHide} onBlur={hideCommitHover} onClick={() => { void copyCommit(hover().commit, false); }}>复制提交号</Button><Button size="small" onFocus={cancelHoverHide} onBlur={hideCommitHover} onClick={() => { void copyCommit(hover().commit, true); }}>复制提交信息</Button><span role="status">{copyStatus()}</span></footer></div></Portal>}</Show>
    <PanelResizeHandle name="调整左侧宽度" class="source-resize-navigation" orientation="vertical" range={() => panelRange("navigation")} onResize={size => props.onResize?.("navigation", size)} />
    <Show when={props.detailsOpen}><PanelResizeHandle name="调整右侧宽度" class="source-resize-details" orientation="vertical" reverse range={() => panelRange("details")} onResize={size => props.onResize?.("details", size)} /></Show>
    <Show when={props.agentOpen}><PanelResizeHandle name="调整下方面板高度" class="source-resize-agent" orientation="horizontal" reverse range={() => panelRange("agent")} onResize={size => props.onResize?.("agent", size)} /></Show>
    <Modal open={picker() !== null} title={picker() === "file" ? "转到文件" : "命令"} okText={picker() === "file" ? "打开" : "关闭"} okButtonProps={{ disabled: picker() === "file" && !pickerPath().trim() }} onCancel={() => setPicker(null)} onOk={() => { const path = pickerPath().trim(), value = picker(); setPicker(null); if (value === "file" && path) void openFile(path); }}><Show when={picker() === "file"} fallback={<div class="source-command-list"><For each={views}>{item => <Button onClick={() => { setPicker(null); setView(item.value); void loadPanel(item.value); }}>{item.title}</Button>}</For><Button onClick={() => { setPicker(null); setView("changes"); void loadPanel("changes"); }}>Commit History</Button></div>}><Input aria-label="转到文件路径" value={pickerPath()} onInput={event => setPickerPath(event.currentTarget.value)} placeholder="相对仓库路径，如 src/main.ts" /></Show></Modal>
    <Modal open={action() !== null} title={actionTitle()} okText={action()?.kind === "delete" ? "删除" : "确定"} confirmLoading={busy()} okButtonProps={{ danger: action()?.kind === "delete", disabled: action()?.kind !== "delete" && !pathDraft().trim() }} onCancel={() => setAction(null)} onOk={applyPathAction}><Show when={error()}><div class="workspace-error" role="alert">{error()}</div></Show><Show when={action()?.kind === "delete"} fallback={<label>相对仓库路径<Input aria-label="文件操作路径" value={pathDraft()} onInput={event => setPathDraft(event.currentTarget.value)} /></label>}><p>删除 {action()?.path}{action()?.directory ? " 及其内容" : ""}？</p></Show></Modal>
  </section>;
}
