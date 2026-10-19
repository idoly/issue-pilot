import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { monacoTestState } from "../test-monaco";
import CodeBrowser from "./CodeBrowser";
import { createSignal } from "solid-js";
import { issuePilotConfig } from "../../../../issue-pilot.config.ts";
import { copyText } from "../ui/clipboard";
vi.mock("../ui/clipboard", () => ({ copyText: vi.fn() }));

const api = vi.hoisted(() => ({
  loadSourceRepositories: vi.fn(), loadSourceTree: vi.fn(), loadSourceFile: vi.fn(), saveSourceFile: vi.fn(), searchSource: vi.fn(),
  loadSourceDiff: vi.fn(), loadSourceDiffFile: vi.fn(), stageSourcePaths: vi.fn(), unstageSourcePaths: vi.fn(), discardSourcePaths: vi.fn(), commitSourceChanges: vi.fn(),
  loadSourceHistory: vi.fn(), loadSourceCommit: vi.fn(), loadSourceCommitFile: vi.fn(), loadSourceBlame: vi.fn(),
  createSourceFile: vi.fn(), createSourceDirectory: vi.fn(), deleteSourcePath: vi.fn(), renameSourcePath: vi.fn(),
}));
vi.mock("../data/client", async original => ({ ...await original<typeof import("../data/client")>(), ...api }));
const revision = "c".repeat(40);
const changedFile = { path: "a.txt", previousPath: null, status: "modified" };
const file = (path: string, content = `${path} content`) => ({ path, content, size: content.length, sha256: "a".repeat(64) });
const mount = (development = false) => render(() => <CodeBrowser issueKey="ISSUE-20261017-001" development={development} agentOpen detailsOpen onClose={() => {}} onToggleAgent={() => {}} onToggleDetails={() => {}} />);
const clickReady = async (name: string | RegExp) => {
  await waitFor(() => expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name }));
};
const open = async (name = "a.txt") => { fireEvent.click(await screen.findByRole("button", { name: new RegExp(name.replaceAll(".", "\\.")) })); return await screen.findByLabelText(`代码内容 ${name}`) as HTMLTextAreaElement; };

describe("native code browser", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.loadSourceRepositories.mockResolvedValue([{ name: "app", url: "https://example.test/app.git", branch: "main", access: "write" }]);
    api.loadSourceTree.mockResolvedValue({ path: "", entries: ["a.txt", "b.txt"].map(name => ({ name, path: name, type: "file", size: 12 })), truncated: false });
    api.loadSourceFile.mockImplementation(async (_key: string, _repo: string, path: string) => file(path));
    api.saveSourceFile.mockImplementation(async (_key: string, _repo: string, path: string, content: string) => ({ ...file(path, content), sha256: "b".repeat(64) }));
    api.searchSource.mockResolvedValue({ matches: [{ path: "b.txt", line: 1, column: 1, preview: "needle" }], truncated: false });
    api.loadSourceDiff.mockResolvedValue({ files: [], truncated: false });
    api.loadSourceDiffFile.mockResolvedValue({ file: changedFile, before: { content: "before" }, after: { content: "after" } });
    api.loadSourceHistory.mockResolvedValue({ commits: [{ hash: revision, shortHash: "cccccccc", parents: [], author: "Fixture", date: "2026-10-17T00:00:00Z", subject: "Saved change" }], truncated: false });
    api.loadSourceCommit.mockResolvedValue({ files: [changedFile], truncated: false });
    api.loadSourceCommitFile.mockResolvedValue({ file: changedFile, before: { content: "old revision" }, after: { content: "new revision" } });
    api.loadSourceBlame.mockResolvedValue({ path: "a.txt", line: 1, commit: revision, shortCommit: "cccccccc", author: "Fixture", date: "2026-10-17T00:00:00Z", subject: "Saved change" });
    api.createSourceFile.mockImplementation(async (_key: string, _repo: string, path: string) => file(path, ""));
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("opens text, saves with the read hash, and keeps a conflicting draft", async () => {
    mount(); const editor = await open();
    await fireEvent.input(editor, { target: { value: "edited" } });
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    await waitFor(() => expect(api.saveSourceFile).toHaveBeenCalledWith("ISSUE-20261017-001", "app", "a.txt", "edited", "a".repeat(64)));
    await waitFor(() => expect(screen.queryByText(/未保存/)).toBeNull());
    api.saveSourceFile.mockRejectedValueOnce(new Error("source_file_changed"));
    await fireEvent.input(editor, { target: { value: "keep my draft" } });
    fireEvent.click(screen.getByRole("button", { name: "保存文件" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("草稿已保留"));
    expect(editor.value).toBe("keep my draft");
  });

  it("autosaves without losing typing or the next hash when Issue content refreshes during a save", async () => {
    vi.useFakeTimers();
    let finish!: (value: ReturnType<typeof file>) => void;
    api.saveSourceFile.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const [contentVersion, setContentVersion] = createSignal("first", { ownedWrite: true });
    render(() => <CodeBrowser issueKey="ISSUE-20261017-001" contentVersion={contentVersion()} development={false} agentOpen detailsOpen onClose={() => {}} onToggleAgent={() => {}} onToggleDetails={() => {}} />);
    await vi.advanceTimersByTimeAsync(0);
    fireEvent.click(screen.getByRole("button", { name: "a.txt" })); await vi.advanceTimersByTimeAsync(0);
    const editor = screen.getByLabelText("代码内容 a.txt") as HTMLTextAreaElement;
    await fireEvent.input(editor, { target: { value: "first draft" } });
    await vi.advanceTimersByTimeAsync(issuePilotConfig.web.sourceAutoSaveDebounceMs);
    expect(api.saveSourceFile).toHaveBeenCalledTimes(1); expect(editor.readOnly).toBe(false);
    await fireEvent.input(editor, { target: { value: "newer draft" } }); setContentVersion("Agent updated");
    finish({ ...file("a.txt", "first draft"), sha256: "b".repeat(64) }); await vi.advanceTimersByTimeAsync(0);
    expect(editor.value).toBe("newer draft");
    await vi.advanceTimersByTimeAsync(issuePilotConfig.web.sourceAutoSaveDebounceMs);
    expect(api.saveSourceFile).toHaveBeenLastCalledWith("ISSUE-20261017-001", "app", "a.txt", "newer draft", "b".repeat(64));
    expect(screen.getByLabelText("文件保存状态").textContent).toBe("已保存");
  });

  it("stops automatic retries after a conflict and keeps subsequent typing", async () => {
    vi.useFakeTimers(); api.saveSourceFile.mockRejectedValue(new Error("source_file_changed"));
    mount(); await vi.advanceTimersByTimeAsync(0);
    fireEvent.click(screen.getByRole("button", { name: "a.txt" })); await vi.advanceTimersByTimeAsync(0);
    const editor = screen.getByLabelText("代码内容 a.txt") as HTMLTextAreaElement;
    await fireEvent.input(editor, { target: { value: "keep draft" } }); await vi.advanceTimersByTimeAsync(issuePilotConfig.web.sourceAutoSaveDebounceMs);
    await fireEvent.input(editor, { target: { value: "keep newer draft" } }); await vi.advanceTimersByTimeAsync(5_000);
    expect(api.saveSourceFile).toHaveBeenCalledTimes(1); expect(editor.value).toBe("keep newer draft");
    expect(screen.getByLabelText("文件保存状态").textContent).toContain("草稿已保留");
  });

  it("refreshes external changes and keeps Changes visible when Graph history fails", async () => {
    vi.useFakeTimers(); vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    let modified = false;
    api.loadSourceHistory.mockRejectedValue(new Error("source_history_failed"));
    api.loadSourceDiff.mockImplementation(async (_key: string, _repo: string, _path: string, _signal: AbortSignal, staged = false) => ({ files: modified && !staged ? [changedFile] : [], truncated: false }));
    mount(true); await vi.advanceTimersByTimeAsync(0);
    modified = true; await vi.advanceTimersByTimeAsync(issuePilotConfig.web.sourceRefreshMs);
    expect(screen.getByRole("button", { name: "查看差异 a.txt" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "历史" })); await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText("CHANGES")).toBeTruthy();
    expect(screen.getByRole("button", { name: "查看差异 a.txt" })).toBeTruthy();
  });

  it("preserves existing CRLF line endings when saving", async () => {
    api.loadSourceFile.mockResolvedValueOnce(file("a.txt", "first\r\nsecond\r\n"));
    mount(); const editor = await open();
    await fireEvent.input(editor, { target: { value: "first\nchanged\n" } });
    await clickReady("保存文件");
    await waitFor(() => expect(api.saveSourceFile).toHaveBeenCalledWith("ISSUE-20261017-001", "app", "a.txt", "first\r\nchanged\r\n", "a".repeat(64)));
  });

  it("keeps unsaved text when switching files is declined", async () => {
    mount(); const editor = await open();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    await fireEvent.input(editor, { target: { value: "unsaved" } });
    fireEvent.click(screen.getByRole("button", { name: /b\.txt/ }));
    expect(editor.value).toBe("unsaved");
    expect(api.loadSourceFile).toHaveBeenCalledTimes(1);
  });

  it("keeps read-only repositories uneditable and does not send mutations", async () => {
    api.loadSourceRepositories.mockResolvedValue([{ name: "app", url: "https://example.test/app.git", branch: "main", access: "read" }]);
    mount(); const editor = await open();
    expect(editor.readOnly).toBe(true);
    fireEvent.click(screen.getByLabelText("文件操作"));
    expect((screen.getByRole("button", { name: "新建文件" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    expect(api.saveSourceFile).not.toHaveBeenCalled();
  });

  it("searches through the Source API and opens the selected result", async () => {
    mount(); await screen.findByRole("button", { name: /a\.txt/ });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await fireEvent.input(await screen.findByLabelText("代码搜索文字"), { target: { value: "needle" } });
    fireEvent.submit(screen.getByLabelText("代码搜索文字").closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "打开搜索结果 app/b.txt:1" }));
    expect(await screen.findByLabelText("代码内容 b.txt")).toHaveProperty("value", "b.txt content");
    expect(api.searchSource).toHaveBeenCalledWith("ISSUE-20261017-001", "app", "needle", { caseSensitive: false, wordMatch: false }, expect.any(AbortSignal));
  });

  it("keeps a broad AI search bounded and reveals more results without rerunning it", async () => {
    api.searchSource.mockResolvedValue({ matches: Array.from({ length: 10_000 }, (_, index) => ({ path: "many.txt", line: index + 1, column: 1, preview: "AI detail main" })), truncated: false });
    mount(); await screen.findByRole("button", { name: /a\.txt/ });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await fireEvent.input(await screen.findByLabelText("代码搜索文字"), { target: { value: "AI" } });
    fireEvent.submit(screen.getByLabelText("代码搜索文字").closest("form")!);
    const more = await screen.findByRole("button", { name: /显示更多结果/ });
    expect(document.querySelectorAll(".source-search-match")).toHaveLength(issuePilotConfig.web.sourceSearchPageMatches);
    expect(screen.getByText("结果达到上限，请缩小搜索范围。")).toBeTruthy();
    fireEvent.click(more);
    await waitFor(() => expect(document.querySelectorAll(".source-search-match")).toHaveLength(issuePilotConfig.web.sourceSearchPageMatches * 2));
    expect(api.searchSource).toHaveBeenCalledTimes(1);
  });

  it("cancels an obsolete search and ignores its late results", async () => {
    let finish!: (value: unknown) => void;
    api.searchSource.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    mount(); await screen.findByRole("button", { name: /a\.txt/ });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    const input = await screen.findByLabelText("代码搜索文字");
    await fireEvent.input(input, { target: { value: "AI" } }); fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(api.searchSource).toHaveBeenCalledTimes(1));
    const signal = api.searchSource.mock.calls[0]![4] as AbortSignal;
    await fireEvent.input(input, { target: { value: "needle" } }); fireEvent.submit(input.closest("form")!);
    expect(await screen.findByRole("button", { name: "打开搜索结果 app/b.txt:1" })).toBeTruthy();
    expect(signal.aborted).toBe(true);
    finish({ matches: [{ path: "stale.txt", line: 1, column: 1, preview: "AI" }], truncated: false }); await Promise.resolve(); await Promise.resolve();
    expect(screen.queryByRole("button", { name: /打开搜索结果.*stale/ })).toBeNull();
  });

  it("opens search results as a read-only editor document", async () => {
    mount(); await screen.findByRole("button", { name: /a\.txt/ });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await fireEvent.input(await screen.findByLabelText("代码搜索文字"), { target: { value: "needle" } });
    fireEvent.submit(screen.getByLabelText("代码搜索文字").closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "Open in editor" }));
    const editor = await screen.findByLabelText("代码内容 搜索结果 needle") as HTMLTextAreaElement;
    expect(editor.readOnly).toBe(true);
    expect(editor.value).toBe("app/b.txt\n  1: needle");
    fireEvent.keyDown(editor, { key: "s", ctrlKey: true });
    expect(api.saveSourceFile).not.toHaveBeenCalled();
  });

  it("saves a selected search replacement through the current file hash", async () => {
    api.loadSourceFile.mockImplementation(async (_key: string, _repo: string, path: string) => file(path, "needle tail"));
    mount(); await screen.findByRole("button", { name: /a\.txt/ });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await fireEvent.input(await screen.findByLabelText("代码搜索文字"), { target: { value: "needle" } });
    fireEvent.submit(screen.getByLabelText("代码搜索文字").closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "打开搜索结果 app/b.txt:1" }));
    await screen.findByLabelText("代码内容 b.txt");
    await clickReady("替换为空 app/b.txt:1");
    await waitFor(() => expect(api.saveSourceFile).toHaveBeenCalledWith("ISSUE-20261017-001", "app", "b.txt", " tail", "a".repeat(64)));
    expect(screen.getByLabelText("代码内容 b.txt")).toHaveProperty("value", " tail");
  });

  it("rejects a stale search replacement while preserving the current file", async () => {
    mount(); await screen.findByRole("button", { name: /a\.txt/ });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await fireEvent.input(await screen.findByLabelText("代码搜索文字"), { target: { value: "needle" } });
    fireEvent.submit(screen.getByLabelText("代码搜索文字").closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "打开搜索结果 app/b.txt:1" }));
    await screen.findByLabelText("代码内容 b.txt");
    await clickReady("替换为空 app/b.txt:1");
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "匹配内容已变化，请重新搜索。");
    expect(screen.getByLabelText("代码内容 b.txt")).toHaveProperty("value", "b.txt content");
    expect(api.saveSourceFile).not.toHaveBeenCalled();
  });

  it("shows changes and delegates staging, unstaging and committing", async () => {
    let staged = false;
    api.loadSourceDiff.mockImplementation(async (_key: string, _repo: string, _path: string, _signal: AbortSignal, index = false) => ({ files: index === staged ? [changedFile] : [], truncated: false }));
    api.stageSourcePaths.mockImplementation(async () => { staged = true; });
    api.unstageSourcePaths.mockImplementation(async () => { staged = false; });
    mount(true);
    await waitFor(() => expect(api.loadSourceDiff).toHaveBeenCalledTimes(2));
    await clickReady("暂存");
    await waitFor(() => expect(api.stageSourcePaths).toHaveBeenCalledWith("ISSUE-20261017-001", "app", ["a.txt"]));
    await clickReady("取消暂存");
    await waitFor(() => expect(api.unstageSourcePaths).toHaveBeenCalledWith("ISSUE-20261017-001", "app", ["a.txt"]));
    await screen.findByRole("button", { name: "暂存" });
    await clickReady("查看差异 a.txt");
    expect(await screen.findByText("before")).toBeTruthy();
    expect(screen.getByText("after")).toBeTruthy();
    expect(screen.getByRole("region", { name: "代码差异" }).querySelector('[data-side="original"]')?.textContent).toBe("before");
    expect(monacoTestState.diffs.at(-1)?.container.dataset.split).toBe("false");
    await clickReady("并排");
    await waitFor(() => expect(monacoTestState.diffs.at(-1)?.container.dataset.split).toBe("true"));
    await clickReady("行内");
    await waitFor(() => expect(monacoTestState.diffs.at(-1)?.container.dataset.split).toBe("false"));
    expect(screen.getByText("before")).toBeTruthy();
    await clickReady("暂存");
    await screen.findByRole("button", { name: "取消暂存" });
    await waitFor(() => expect((screen.getByLabelText("提交说明") as HTMLInputElement).disabled).toBe(false));
    await fireEvent.input(screen.getByLabelText("提交说明"), { target: { value: "update text" } });
    await clickReady("提交暂存的变更");
    await waitFor(() => expect(api.commitSourceChanges).toHaveBeenCalledWith("ISSUE-20261017-001", "app", "update text"));
  });

  it("keeps unchanged lines visible in a full-file comparison", async () => {
    const unchanged = Array.from({ length: 20 }, (_, index) => `unchanged line ${index + 1}`).join("\n");
    api.loadSourceDiff.mockImplementation(async (_key: string, _repo: string, _path: string, _signal: AbortSignal, staged = false) => ({ files: staged ? [] : [changedFile], truncated: false }));
    api.loadSourceDiffFile.mockResolvedValue({ file: changedFile, before: { content: unchanged + "\nold ending\n" }, after: { content: unchanged + "\nnew ending\n" } });
    mount(true); await clickReady("查看差异 a.txt");
    await waitFor(() => expect(monacoTestState.models.at(-1)?.getValue()).toBe(unchanged + "\nnew ending\n"));
    expect(monacoTestState.models.at(-2)?.getValue()).toBe(unchanged + "\nold ending\n");
  });

  it("requires a message before committing staged changes", async () => {
    api.loadSourceDiff.mockImplementation(async (_key: string, _repo: string, _path: string, _signal: AbortSignal, staged = false) => ({ files: staged ? [changedFile] : [], truncated: false }));
    mount(true);
    await clickReady("提交暂存的变更");
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "请填写提交说明");
    expect(api.commitSourceChanges).not.toHaveBeenCalled();
  });

  it("compares index and worktree versions separately and includes both rename paths", async () => {
    const renamed = { status: "renamed", path: "new.txt", previousPath: "old.txt" };
    api.loadSourceDiff.mockResolvedValue({ files: [renamed], truncated: false });
    api.loadSourceDiffFile.mockImplementation(async (_key: string, _repository: string, _path: string, _signal: AbortSignal, staged: boolean) => ({
      file: renamed, before: { content: staged ? "committed" : "indexed" }, after: { content: staged ? "indexed" : "working" },
    }));
    mount(true);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "查看差异 new.txt" })).toHaveLength(2));
    const groups = document.querySelectorAll(".source-change-group");
    await waitFor(() => expect((within(groups[0] as HTMLElement).getByRole("button", { name: "查看差异 new.txt" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(groups[0] as HTMLElement).getByRole("button", { name: "查看差异 new.txt" }));
    expect(await screen.findByText("committed")).toBeTruthy();
    expect(screen.getByText("indexed")).toBeTruthy();
    fireEvent.click(within(groups[1] as HTMLElement).getByRole("button", { name: "查看差异 new.txt" }));
    expect(await screen.findByText("working")).toBeTruthy();
    expect(screen.getByText("indexed")).toBeTruthy();
    expect(screen.queryByText("committed")).toBeNull();
    await clickReady("全部暂存");
    await waitFor(() => expect(api.stageSourcePaths).toHaveBeenCalledWith("ISSUE-20261017-001", "app", ["old.txt", "new.txt"]));
    await clickReady("全部取消暂存");
    await waitFor(() => expect(api.unstageSourcePaths).toHaveBeenCalledWith("ISSUE-20261017-001", "app", ["old.txt", "new.txt"]));
  });

  it("loads older history from its cursor while keeping expanded commits", async () => {
    const cursor = { revision, offset: 1 };
    api.loadSourceHistory.mockResolvedValueOnce({ commits: [{ hash: revision, shortHash: "cccccccc", parents: ["d".repeat(40)], author: "Fixture", date: "2026-10-17T00:00:00Z", subject: "Saved change" }], truncated: true, nextCursor: cursor });
    api.loadSourceHistory.mockResolvedValue({ commits: [{ hash: "d".repeat(40), shortHash: "dddddddd", parents: [], author: "Fixture", date: "2026-10-16T00:00:00Z", subject: "Earlier change" }], truncated: false, nextCursor: null });
    mount(true); await clickReady(/Saved change/);
    await screen.findByRole("button", { name: "提交文件 a.txt" });
    await clickReady("加载更早提交");
    expect(await screen.findByRole("button", { name: /Earlier change/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "提交文件 a.txt" })).toBeTruthy();
    expect(api.loadSourceHistory).toHaveBeenLastCalledWith("ISSUE-20261017-001", "app", "", expect.any(AbortSignal), cursor);
    expect(screen.queryByRole("button", { name: "加载更早提交" })).toBeNull();
  });

  it("ignores older history arriving after the selected repository changes", async () => {
    let finish!: (value: unknown) => void;
    api.loadSourceRepositories.mockResolvedValue(["app", "other"].map(name => ({ name, url: `https://example.test/${name}.git`, branch: "main", access: "write" })));
    api.loadSourceHistory.mockResolvedValueOnce({ commits: [{ hash: revision, shortHash: "cccccccc", parents: [], author: "Fixture", date: "2026-10-17T00:00:00Z", subject: "App change" }], truncated: true, nextCursor: { revision, offset: 1 } });
    api.loadSourceHistory.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    api.loadSourceHistory.mockResolvedValue({ commits: [{ hash: "d".repeat(40), shortHash: "dddddddd", parents: [], author: "Fixture", date: "2026-10-17T00:00:00Z", subject: "Other repository" }], truncated: false, nextCursor: null });
    mount(true); await clickReady("加载更早提交");
    await waitFor(() => expect(api.loadSourceHistory).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "仓库 other" }));
    expect(await screen.findByRole("button", { name: /Other repository/ })).toBeTruthy();
    finish({ commits: [{ hash: "e".repeat(40), subject: "Stale history" }], truncated: false, nextCursor: null }); await Promise.resolve(); await Promise.resolve();
    expect(screen.queryByRole("button", { name: /Stale history/ })).toBeNull();
    expect((api.loadSourceHistory.mock.calls[1]![3] as AbortSignal).aborted).toBe(true);
  });

  it("expands the Graph file list and opens the clicked file in the central area", async () => {
    mount(true); await clickReady(/Saved change/);
    expect(api.loadSourceCommitFile).not.toHaveBeenCalled();
    await clickReady("提交文件 a.txt");
    expect(await screen.findByText("old revision")).toBeTruthy();
    expect(screen.getByText("new revision")).toBeTruthy();
    expect(screen.getByRole("region", { name: "代码差异" })).toBeTruthy();
    expect(api.loadSourceCommitFile).toHaveBeenCalledWith("ISSUE-20261017-001", "app", revision, "a.txt", expect.any(AbortSignal));
  });

  it("lists all Graph files under their commit and loads only the selected comparison", async () => {
    api.loadSourceCommit.mockResolvedValue({ files: [changedFile, { path: "new.txt", previousPath: "old.txt", status: "renamed" }, { path: "gone.txt", previousPath: null, status: "deleted" }], truncated: false });
    api.loadSourceCommitFile.mockImplementation(async (_key: string, _repo: string, _revision: string, path: string) => ({ file: { ...changedFile, path }, before: { content: `before ${path}` }, after: { content: `after ${path}` } }));
    mount(true); await clickReady(/Saved change/);
    const files = await screen.findByRole("group", { name: "Saved change 涉及的文件" });
    for (const path of ["a.txt", "new.txt", "gone.txt"]) expect(within(files).getByRole("button", { name: `提交文件 ${path}` })).toBeTruthy();
    expect(within(files).getByRole("button", { name: "提交文件 new.txt" }).getAttribute("title")).toContain("old.txt → new.txt");
    expect(within(files).getByRole("button", { name: "打开文件 gone.txt" })).toHaveProperty("disabled", true);
    expect(api.loadSourceCommitFile).not.toHaveBeenCalled();
    await clickReady("提交文件 new.txt");
    expect(await screen.findByText("before new.txt")).toBeTruthy();
    expect(screen.getAllByRole("region", { name: "代码差异" })).toHaveLength(1);
    await clickReady(/Saved change/);
    await waitFor(() => expect(screen.queryByRole("group", { name: "Saved change 涉及的文件" })).toBeNull());
    expect(screen.getByText("before new.txt")).toBeTruthy();
  });

  it("keeps files nested under each of several expanded Graph commits", async () => {
    api.loadSourceHistory.mockResolvedValue({ commits: [
      { hash: revision, shortHash: "cccccccc", parents: ["d".repeat(40)], author: "Fixture", date: "2026-10-17T00:00:00Z", subject: "Newest" },
      { hash: "d".repeat(40), shortHash: "dddddddd", parents: [], author: "Fixture", date: "2026-10-16T00:00:00Z", subject: "Older" },
    ], truncated: false });
    api.loadSourceCommit.mockImplementation(async (_key: string, _repository: string, hash: string) => ({ files: [{ ...changedFile, path: hash === revision ? "new.txt" : "old.txt" }], truncated: false }));
    mount(true); await clickReady(/Newest/); await clickReady(/Older/);
    expect(await screen.findByRole("button", { name: "提交文件 old.txt" })).toBeTruthy();
    const groups = document.querySelectorAll(".source-history-commit");
    expect(groups).toHaveLength(2);
    expect(within(groups[0] as HTMLElement).getByRole("button", { name: "提交文件 new.txt" })).toBeTruthy();
    expect(within(groups[1] as HTMLElement).getByRole("button", { name: "提交文件 old.txt" })).toBeTruthy();
  });

  it("shows an empty Graph commit without replacing the central editor", async () => {
    api.loadSourceCommit.mockResolvedValue({ files: [], truncated: false });
    mount(true); await clickReady(/Saved change/);
    expect(await screen.findByRole("group", { name: "Saved change 涉及的文件" })).toHaveProperty("textContent", "");
    expect(screen.queryByRole("region", { name: "代码差异" })).toBeNull();
    expect(api.loadSourceCommitFile).not.toHaveBeenCalled();
  });

  it("reads line information, history and a commit comparison", async () => {
    mount(); await open();
    await waitFor(() => expect(screen.getByLabelText("当前行归属").textContent).toContain("Fixture"));
    fireEvent.click(screen.getByRole("button", { name: "变更" }));
    await clickReady("历史");
    fireEvent.click(await screen.findByRole("button", { name: /Saved change/ }));
    fireEvent.click(await screen.findByRole("button", { name: "提交文件 a.txt" }));
    expect(await screen.findByText("old revision")).toBeTruthy();
    expect(screen.getByText("new revision")).toBeTruthy();
    expect(api.loadSourceCommitFile).toHaveBeenCalledWith("ISSUE-20261017-001", "app", revision, "a.txt", expect.any(AbortSignal));
  });

  it("updates the permanent status bar from the clicked line and ignores stale blame", async () => {
    let finish!: (value: unknown) => void;
    api.loadSourceFile.mockResolvedValue(file("a.txt", "first\nsecond\nthird\n"));
    api.loadSourceBlame.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    api.loadSourceBlame.mockResolvedValue({ path: "a.txt", line: 2, commit: revision, shortCommit: "cccccccc", author: "Second author", date: "2026-10-17T00:00:00Z", subject: "Second line" });
    mount(); const editor = await open();
    await waitFor(() => expect(api.loadSourceBlame).toHaveBeenCalledTimes(1));
    editor.setSelectionRange(6, 6); fireEvent.click(editor);
    await waitFor(() => expect(screen.getByLabelText("当前行归属").textContent).toContain("Second author"));
    expect(api.loadSourceBlame).toHaveBeenLastCalledWith("ISSUE-20261017-001", "app", "a.txt", 2, expect.any(AbortSignal));
    expect(api.loadSourceBlame.mock.calls[0]![4].aborted).toBe(true);
    finish({ path: "a.txt", line: 1, author: "Stale author" }); await Promise.resolve(); await Promise.resolve();
    expect(screen.getByLabelText("当前行归属").textContent).toContain("Second author");
    expect(screen.getByText("Ln 2, Col 1")).toBeTruthy();
  });

  it("keeps Graph hover details selectable and copies the complete commit hash", async () => {
    mount(true); const row = await screen.findByRole("button", { name: /Saved change/ });
    fireEvent.mouseEnter(row);
    const hover = await screen.findByRole("tooltip", { name: "提交信息" });
    expect(hover.textContent).toContain(revision);
    expect(hover.textContent).toContain("Fixture");
    fireEvent.click(within(hover).getByRole("button", { name: "复制提交号" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(revision));
    expect(await within(hover).findByText("已复制")).toBeTruthy();
  });

  for (const outcome of ["success", "failure"] as const) it(`ignores clipboard ${outcome} from a different commit hover`, async () => {
    const secondHash = "d".repeat(40);
    api.loadSourceHistory.mockResolvedValue({ commits: [
      { hash: revision, shortHash: "cccccccc", parents: [secondHash], author: "Fixture", date: "2026-10-17T00:00:00Z", subject: "First commit" },
      { hash: secondHash, shortHash: "dddddddd", parents: [], author: "Fixture", date: "2026-10-16T00:00:00Z", subject: "Second commit" },
    ], truncated: false });
    let finish!: () => void;
    vi.mocked(copyText).mockImplementationOnce(() => new Promise<void>((resolve, reject) => { finish = outcome === "success" ? resolve : () => reject(new Error("clipboard_failed")); }));
    mount(true);
    try {
      fireEvent.mouseEnter(await screen.findByRole("button", { name: /First commit, Fixture/ }));
      fireEvent.click(within(await screen.findByRole("tooltip", { name: "提交信息" })).getByRole("button", { name: "复制提交号" }));
      await waitFor(() => expect(finish).toBeTypeOf("function"));
      fireEvent.mouseEnter(screen.getByRole("button", { name: /Second commit, Fixture/ }));
      const current = await waitFor(() => { const tooltip = screen.getByRole("tooltip", { name: "提交信息" }); expect(tooltip.textContent).toContain(secondHash); return tooltip; });
      finish(); await new Promise(resolve => setTimeout(resolve, 0));
      expect(current.textContent).not.toContain("已复制"); expect(current.textContent).not.toContain("复制失败");
    } finally { finish?.(); }
  });

  it("searches every repository and reveals the selected Unicode match", async () => {
    api.loadSourceRepositories.mockResolvedValue(["app", "other"].map(name => ({ name, url: `https://example.test/${name}.git`, branch: "main", access: "write" })));
    api.searchSource.mockImplementation(async (_key: string, repository: string) => ({ matches: repository === "other" ? [{ path: "result.txt", line: 2, column: 4, preview: "订单 needle" }] : [], truncated: false }));
    api.loadSourceFile.mockImplementation(async (_key: string, _repo: string, path: string) => file(path, "first\n订单 needle\nlast"));
    mount(); await screen.findByRole("button", { name: "仓库 other" });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await fireEvent.input(await screen.findByLabelText("代码搜索文字"), { target: { value: "needle" } });
    fireEvent.submit(screen.getByLabelText("代码搜索文字").closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: "打开搜索结果 other/result.txt:2" }));
    const editor = await screen.findByLabelText("代码内容 result.txt") as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value.slice(editor.selectionStart, editor.selectionEnd)).toBe("needle"));
    expect(api.searchSource.mock.calls.map(call => call[1])).toEqual(["app", "other"]);
    expect(api.loadSourceFile).toHaveBeenLastCalledWith("ISSUE-20261017-001", "other", "result.txt", expect.any(AbortSignal));
    expect(screen.getByText("Ln 2, Col 10")).toBeTruthy();
  });

  it("opens independent roots and single-child chains, preserving expansion after a save", async () => {
    api.loadSourceRepositories.mockResolvedValue(["app", "other"].map(name => ({ name, url: `https://example.test/${name}.git`, branch: "main", access: "write" })));
    api.loadSourceTree.mockImplementation(async (_key: string, repository: string, path: string) => ({ path, truncated: false, entries: repository === "other" ? [{ path: "readme.md", name: "readme.md", type: "file" }] : path === "" ? [{ path: "src", name: "src", type: "directory" }] : path === "src" ? [{ path: "src/main", name: "main", type: "directory" }] : path === "src/main" ? [{ path: "src/main/code", name: "code", type: "directory" }] : [{ path: "src/main/code/value.ts", name: "value.ts", type: "file" }] }));
    mount();
    expect((await screen.findByRole("button", { name: "仓库 app" })).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "仓库 other" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(await screen.findByRole("button", { name: "src" }));
    fireEvent.click(await screen.findByRole("button", { name: "value.ts" }));
    const editor = await screen.findByLabelText("代码内容 src/main/code/value.ts") as HTMLTextAreaElement;
    await fireEvent.input(editor, { target: { value: "edited" } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "仓库 other" }));
    expect(editor.value).toBe("edited"); expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "仓库 app" }).getAttribute("aria-expanded")).toBe("true");
    const reads = api.loadSourceTree.mock.calls.length;
    await clickReady("保存文件");
    await waitFor(() => expect(api.loadSourceTree.mock.calls.length).toBeGreaterThan(reads));
    await waitFor(() => expect(screen.getByRole("button", { name: "value.ts" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "main" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "code" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("ignores a file response superseded by a later selection", async () => {
    let finish!: (value: ReturnType<typeof file>) => void;
    api.loadSourceFile.mockImplementation((_key: string, _repo: string, path: string) => path === "a.txt" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(file(path)));
    mount(); fireEvent.click(await screen.findByRole("button", { name: /a\.txt/ }));
    await waitFor(() => expect(api.loadSourceFile).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /b\.txt/ }));
    expect(await screen.findByLabelText("代码内容 b.txt")).toHaveProperty("value", "b.txt content");
    finish(file("a.txt")); await Promise.resolve();
    expect(screen.getByLabelText("代码内容 b.txt")).toHaveProperty("value", "b.txt content");
  });

  it("opens a file using the displayed keyboard shortcut", async () => {
    mount(); await screen.findByRole("button", { name: /a\.txt/ });
    fireEvent.keyDown(window, { key: "p", ctrlKey: true });
    const input = await screen.findByLabelText("转到文件路径");
    await fireEvent.input(input, { target: { value: "b.txt" } });
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    expect(await screen.findByLabelText("代码内容 b.txt")).toHaveProperty("value", "b.txt content");
  });

  it("creates, renames and deletes paths through the existing API", async () => {
    mount(); await screen.findByRole("button", { name: /a\.txt/ });
    fireEvent.click(screen.getByLabelText("文件操作"));
    fireEvent.click(screen.getByRole("button", { name: "新建文件" }));
    await fireEvent.input(await screen.findByLabelText("文件操作路径"), { target: { value: "new.txt" } });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    await waitFor(() => expect(api.createSourceFile).toHaveBeenCalledWith("ISSUE-20261017-001", "app", "new.txt", ""));
    expect(await screen.findByLabelText("代码内容 new.txt")).toHaveProperty("value", "");
    fireEvent.click(screen.getByLabelText("文件操作"));
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    await fireEvent.input(await screen.findByLabelText("文件操作路径"), { target: { value: "renamed.txt" } });
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    await waitFor(() => expect(api.renameSourcePath).toHaveBeenCalledWith("ISSUE-20261017-001", "app", "new.txt", "renamed.txt", false));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await open();
    fireEvent.click(screen.getByLabelText("文件操作"));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    const dialog = await screen.findByRole("dialog", { name: "删除路径" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(api.deleteSourcePath).toHaveBeenCalledWith("ISSUE-20261017-001", "app", "a.txt", false));
  });
});
