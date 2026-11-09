import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { IssueDetail, IssueWorkFile } from "../data/client";
const state = vi.hoisted(() => ({ list: vi.fn(), user: () => ({ subject: "alice", role: "developer" }), read: vi.fn(), original: vi.fn() }));
vi.mock("../data/client", async (original) => ({
  ...(await original<typeof import("../data/client")>()),
  listIssueWorkFiles: state.list,
  fetchIssueWorkFile: state.read,
  fetchAttachment: state.original,
}));
vi.mock("./ApplicationResources", () => ({ useApplicationResources: () => ({ currentUser: () => state.user() }) }));
import { IssueFiles } from "./IssueFiles";
const issue = { id: "ISSUE-20261021-001", updatedAt: "2026-10-21T00:00:00Z", repositories: [{ name: "repository" }], attachments: [] } as unknown as IssueDetail;
const file = (name: string, kind: IssueWorkFile["kind"] = "file"): IssueWorkFile => ({ name, path: name, kind, size: 1, updatedAt: issue.updatedAt });
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  state.user = () => ({ subject: "alice", role: "developer" });
});
it("lists working files and repository folders and provides real downloads", async () => {
  state.list.mockResolvedValueOnce([file("checkpoint.json"), file("uuid-image.png"), file("folder", "directory"), file("repository", "directory"), file("escape", "link")]);
  state.list.mockResolvedValueOnce([{ ...file("source.java"), path: "repository/source.java" }]);
  render(() => <IssueFiles issue={issue} />);
  const link = await screen.findByRole("link", { name: "下载工作文件 checkpoint.json" });
  expect(state.read).not.toHaveBeenCalled();
  expect(link.getAttribute("href")).toBe(`/api/issues/${issue.id}/files/download?path=checkpoint.json`);
  expect(screen.getByRole("heading", { name: "工作目录" })).toBeTruthy();
  expect(document.querySelector(".issue-directory-list small")).toBeNull();
  const folder = screen.getByRole("button", { name: "打开目录 folder" }).closest(".issue-attachment-row")!;
  const repository = screen.getByRole("button", { name: "打开目录 repository" }).closest(".issue-attachment-row")!;
  const normal = link.closest(".issue-attachment-row")!;
  const icons = [folder, repository, normal].map((row) => row.querySelector("svg.ui-icon"));
  expect(icons.every(Boolean)).toBe(true);
  expect(new Set(icons.map((icon) => icon!.innerHTML)).size).toBe(3);
  expect(screen.queryByRole("link", { name: "下载工作文件 escape" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "打开目录 repository" }));
  await screen.findByText("source.java");
  expect(state.list.mock.calls[1]?.slice(0, 2)).toEqual([issue.id, "repository"]);
});
it("previews supported working files only after a click and keeps binary files download-only", async () => {
  state.list.mockResolvedValue([file("note.txt"), file("report.xlsx")]);
  state.read.mockImplementation(async () => new Response("working preview").blob());
  render(() => <IssueFiles issue={issue} />);
  const preview = await screen.findByRole("button", { name: "预览工作文件 note.txt" });
  expect(state.read).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "预览工作文件 report.xlsx" })).toBeNull();
  fireEvent.click(preview);
  await screen.findByText("working preview");
  expect(state.read).toHaveBeenCalledWith(issue.id, "note.txt", expect.any(AbortSignal));
  expect(screen.getByRole("dialog", { name: "note.txt" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "下载文件" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("keeps managed metadata private and previews original attachments through the attachment endpoint", async () => {
  const stored = ".attachment-original.txt",
    detailed = { ...issue, attachments: [{ id: "original", fileName: "input.txt", storedFileName: stored, mediaType: "text/plain", size: 8, sha256: "" }] } as IssueDetail;
  state.list.mockResolvedValue([
    { ...file(stored), managed: true },
    { ...file(".session-private.jsonl"), managed: true },
  ]);
  state.original.mockResolvedValue(new Response("original preview").blob());
  render(() => <IssueFiles issue={detailed} />);
  const preview = await screen.findByRole("button", { name: "预览工作文件 input.txt" });
  expect(state.original).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "预览工作文件 .session-private.jsonl" })).toBeNull();
  expect(screen.queryByRole("link", { name: "下载工作文件 .session-private.jsonl" })).toBeNull();
  expect(screen.getByRole("link", { name: "下载工作文件 input.txt" }).getAttribute("href")).toBe(`/api/issues/${issue.id}/attachments/original`);
  fireEvent.click(preview);
  await screen.findByText("original preview");
  expect(state.original).toHaveBeenCalledWith(issue.id, "original", expect.any(AbortSignal));
  expect(state.read).not.toHaveBeenCalled();
});

it("cancels old identity reads and ignores their late results", async () => {
  let finishOld!: (rows: IssueWorkFile[]) => void;
  const [user, setUser] = createSignal({ subject: "alice", role: "developer" }, { ownedWrite: true });
  state.user = user;
  state.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOld = resolve;
      }),
  );
  state.list.mockResolvedValueOnce([file("bob.txt")]);
  render(() => <IssueFiles issue={issue} />);
  await waitFor(() => expect(state.list).toHaveBeenCalledOnce());
  const oldSignal = state.list.mock.calls[0]![2] as AbortSignal;
  setUser({ subject: "bob", role: "developer" });
  await screen.findByText("bob.txt");
  expect(oldSignal.aborted).toBe(true);
  finishOld([file("alice.txt")]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText("alice.txt")).toBeNull();
  expect(screen.getByText("bob.txt")).toBeTruthy();
});

it("keeps the open directory and preview when the Issue object is replaced with identical content", async () => {
  state.list
    .mockResolvedValueOnce([file("folder", "directory")])
    .mockResolvedValueOnce([{ ...file("note.txt"), path: "folder/note.txt" }])
    .mockResolvedValue([]);
  state.read.mockImplementation(async () => new Response("preview text").blob());
  const [current, setCurrent] = createSignal(issue);
  render(() => <IssueFiles issue={current()} />);
  fireEvent.click(await screen.findByRole("button", { name: "打开目录 folder" }));
  fireEvent.click(await screen.findByRole("button", { name: "预览工作文件 note.txt" }));
  await screen.findByRole("dialog", { name: "note.txt" });
  const calls = state.list.mock.calls.length;
  // Issue refreshes (workspace tools, agent events) replace the object with identical content.
  setCurrent({ ...issue });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(state.list).toHaveBeenCalledTimes(calls);
  expect(screen.getByRole("dialog", { name: "note.txt" })).toBeTruthy();
  expect(screen.getAllByText("note.txt").length).toBeGreaterThan(0);
  // A real change still reloads the root list.
  setCurrent({ ...issue, updatedAt: "2026-10-22T00:00:00Z" });
  await waitFor(() => expect(state.list).toHaveBeenCalledTimes(calls + 1));
});

it("reloads working files when a workspace tool changes repositories without changing Issue metadata", async () => {
  state.list.mockResolvedValueOnce([file("original", "directory")]).mockResolvedValueOnce([file("original", "directory"), file("added", "directory")]);
  const [current, setCurrent] = createSignal(issue);
  render(() => <IssueFiles issue={current()} />);
  await screen.findByRole("button", { name: "打开目录 original" });
  setCurrent({ ...issue, repositories: [...issue.repositories, { name: "added", url: "https://example.test/added.git", baseBranch: "main", workingBranch: null }] });
  await screen.findByRole("button", { name: "打开目录 added" });
  expect(state.list).toHaveBeenCalledTimes(2);
});

it("does not abort an in-flight listing when the Issue object is replaced with identical content", async () => {
  let finish!: (rows: IssueWorkFile[]) => void;
  let signal: AbortSignal | undefined;
  state.list.mockImplementationOnce(
    (_key: string, _directory: string, provided: AbortSignal) =>
      new Promise<IssueWorkFile[]>((resolve) => {
        signal = provided;
        finish = resolve;
      }),
  );
  const [current, setCurrent] = createSignal(issue);
  render(() => <IssueFiles issue={current()} />);
  await waitFor(() => expect(state.list).toHaveBeenCalledTimes(1));
  // A workspace tool event refreshes the Issue while the listing is still loading.
  setCurrent({ ...issue });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(signal?.aborted).toBe(false);
  finish([file("late.txt")]);
  expect(await screen.findByText("late.txt")).toBeTruthy();
  expect(screen.queryByText("正在读取文件…")).toBeNull();
});
