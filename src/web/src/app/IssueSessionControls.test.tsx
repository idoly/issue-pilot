import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IssueDetail } from "../data/client";
const state = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), reset: vi.fn(), user: () => ({ subject: "dev", role: "developer" }) }));
vi.mock("../data/client", async original => ({ ...await original<typeof import("../data/client")>(), listIssueSessions: state.list, readIssueSession: state.read, resetIssueSession: state.reset }));
vi.mock("./ApplicationResources", () => ({ useApplicationResources: () => ({ currentUser: () => state.user() }) }));
import { IssueSessionControls } from "./IssueSessionControls";
const issue = { id: "ISSUE-20261030-001", status: "open", workspace: { status: "ready" }, attachments: [] } as unknown as IssueDetail;
const sessions = [{ sessionId: "current", createdAt: "2026-10-30T00:00:00Z", current: true }, { sessionId: "old", createdAt: "2026-10-29T00:00:00Z", current: false }];
beforeEach(() => { vi.resetAllMocks(); state.user = () => ({ subject: "dev", role: "developer" }); state.list.mockResolvedValue(sessions); state.reset.mockResolvedValue({ sessionId: "new" }); vi.spyOn(window, "confirm").mockReturnValue(true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("resets directly from the editor after one confirmation", async () => {
  const updated = vi.fn(async () => {}); render(() => <IssueSessionControls issue={issue} disabled={false} onReset={updated} />);
  fireEvent.click(screen.getByRole("button", { name: "重置会话" }));
  await waitFor(() => expect(updated).toHaveBeenCalledOnce());
  expect(state.reset).toHaveBeenCalledExactlyOnceWith(issue.id, "current");
});

it("cancelling the confirmation leaves the session unchanged", async () => {
  vi.mocked(window.confirm).mockReturnValue(false); render(() => <IssueSessionControls issue={issue} disabled={false} onReset={async () => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "重置会话" })); await waitFor(() => expect(state.list).toHaveBeenCalledOnce());
  expect(state.reset).not.toHaveBeenCalled();
});

it("opens history separately without putting reset inside the history dialog", async () => {
  render(() => <IssueSessionControls issue={issue} disabled={false} onReset={async () => {}} />); fireEvent.click(screen.getByRole("button", { name: "查看历史" }));
  const dialog = await screen.findByRole("dialog", { name: "历史会话" }); expect(within(dialog).queryByRole("button", { name: "重置会话" })).toBeNull(); expect(screen.queryByRole("dialog", { name: "工单会话" })).toBeNull();
});

it("keeps a stale-session failure visible", async () => {
  state.reset.mockRejectedValue(new Error("agent_session_changed")); render(() => <IssueSessionControls issue={issue} disabled={false} onReset={async () => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "重置会话" })); await waitFor(() => expect(state.list).toHaveBeenCalledOnce()); fireEvent.click(screen.getByRole("button", { name: "重置会话" }));
  expect((await screen.findByRole("alert")).textContent).toBe("会话已更新，请重新打开编辑工单。"); expect(state.reset).toHaveBeenCalledOnce();
});

it("disables reset during active work", () => { render(() => <IssueSessionControls issue={issue} disabled onReset={async () => {}} />); expect(screen.getByRole("button", { name: "重置会话" })).toHaveProperty("disabled", true); });
