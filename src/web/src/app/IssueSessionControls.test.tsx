import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IssueDetail } from "../data/client";
const state = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), user: () => ({ subject: "dev", role: "developer" }) }));
vi.mock("../data/client", async original => ({ ...await original<typeof import("../data/client")>(), listIssueSessions: state.list, readIssueSession: state.read }));
vi.mock("./ApplicationResources", () => ({ useApplicationResources: () => ({ currentUser: () => state.user() }) }));
import { IssueSessionControls } from "./IssueSessionControls";
const issue = { id: "ISSUE-20261030-001", status: "open", workspace: { status: "ready" }, attachments: [] } as unknown as IssueDetail;
const sessions = [{ sessionId: "current", createdAt: "2026-10-30T00:00:00Z", current: true }, { sessionId: "old", createdAt: "2026-10-29T00:00:00Z", current: false }];
beforeEach(() => { vi.resetAllMocks(); state.user = () => ({ subject: "dev", role: "developer" }); state.list.mockResolvedValue(sessions); state.read.mockResolvedValue({ events: [], nextOffset: null }); });
afterEach(() => cleanup());
const open = () => { render(() => <IssueSessionControls issue={issue} disabled={false} />); fireEvent.click(screen.getByRole("button", { name: "查看历史" })); };

it("opens history separately without reset controls", async () => {
  open();
  const dialog = await screen.findByRole("dialog", { name: "历史会话" });
  expect(within(dialog).queryByRole("button", { name: /重置/ })).toBeNull();
});
it("automatically reads the first archived session and renders its conversation", async () => {
  state.read.mockResolvedValue({ events: [{ id: "message", issueId: issue.id, createdAt: "2026-10-29T00:00:00Z", event: { type: "issue_user", message: "历史消息内容" } }], nextOffset: null });
  open();
  expect(await screen.findByText("历史消息内容")).toBeTruthy();
  expect(state.read).toHaveBeenCalledExactlyOnceWith(issue.id, "old", 0, expect.any(AbortSignal));
  expect(screen.getByRole("region", { name: "历史对话" })).toBeTruthy();
});
it("shows an empty state without a dark transcript when only the current session exists", async () => {
  state.list.mockResolvedValue([sessions[0]]); open();
  expect(await screen.findByText("暂无历史会话")).toBeTruthy();
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByRole("region", { name: "历史对话" })).toBeNull();
  expect(state.read).not.toHaveBeenCalled();
});
it("shows loading and empty conversation states without an empty transcript", async () => {
  let finish!: (page: { events: []; nextOffset: null }) => void;
  state.read.mockImplementation(() => new Promise(resolve => { finish = resolve; })); open();
  await waitFor(() => expect(state.read).toHaveBeenCalledOnce());
  expect(screen.getByRole("status").textContent).toBe("正在加载历史会话…");
  expect(screen.queryByRole("region", { name: "历史对话" })).toBeNull();
  finish({ events: [], nextOffset: null });
  expect(await screen.findByText("该会话暂无可显示的对话")).toBeTruthy();
});
it("keeps read errors inside the dialog and permits retry", async () => {
  state.read.mockRejectedValueOnce(new Error("读取失败")); open();
  const dialog = await screen.findByRole("dialog", { name: "历史会话" });
  expect((await within(dialog).findByRole("alert")).textContent).toBe("读取失败");
  fireEvent.click(within(dialog).getByRole("button", { name: "查看对话" }));
  expect(await within(dialog).findByText("该会话暂无可显示的对话")).toBeTruthy();
  expect(state.read).toHaveBeenCalledTimes(2);
});
it("aborts a pending history read on close and ignores its late result", async () => {
  let finish!: (page: { events: []; nextOffset: number }) => void;
  state.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })); open();
  await waitFor(() => expect(state.read).toHaveBeenCalledOnce());
  const signal = state.read.mock.calls[0]![3] as AbortSignal;
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(signal.aborted).toBe(true);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  finish({ events: [], nextOffset: 50 });
  fireEvent.click(screen.getByRole("button", { name: "查看历史" }));
  expect(await screen.findByText("该会话暂无可显示的对话")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
});
