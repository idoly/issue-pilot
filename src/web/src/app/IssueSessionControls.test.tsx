import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
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
it("resets only after confirmation, using the displayed session identity", async () => {
  const updated = vi.fn(async () => {});
  render(() => <IssueSessionControls issue={issue} disabled={false} onReset={updated} />);
  fireEvent.click(screen.getByRole("button", { name: "重置会话" }));
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "重置会话" })).toHaveProperty("disabled", false));
  vi.mocked(window.confirm).mockReturnValueOnce(false);
  fireEvent.click(within(dialog).getByRole("button", { name: "重置会话" })); expect(state.reset).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "重置会话" }));
  await waitFor(() => expect(updated).toHaveBeenCalledOnce());
  expect(state.reset).toHaveBeenCalledExactlyOnceWith(issue.id, "current");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
it("keeps a stale-session failure visible without resetting again", async () => {
  state.reset.mockRejectedValue(new Error("agent_session_changed"));
  render(() => <IssueSessionControls issue={issue} disabled={false} onReset={async () => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "重置会话" })); const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "重置会话" })).toHaveProperty("disabled", false));
  fireEvent.click(within(dialog).getByRole("button", { name: "重置会话" }));
  expect((await within(dialog).findByRole("alert")).textContent).toBe("agent_session_changed"); expect(state.reset).toHaveBeenCalledOnce();
});
it("ignores a late history response after identity changes", async () => {
  const [user, setUser] = createSignal({ subject: "dev", role: "developer" }, { ownedWrite: true }); state.user = user;
  let resolve!: (value: typeof sessions) => void; state.list.mockImplementationOnce(() => new Promise(finish => { resolve = finish; }));
  render(() => <IssueSessionControls issue={issue} disabled={false} onReset={async () => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "重置会话" })); await screen.findByRole("dialog");
  setUser({ subject: "other", role: "developer" }); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  resolve(sessions); await Promise.resolve(); expect(state.reset).not.toHaveBeenCalled();
});
it("disables session actions during active work", () => {
  render(() => <IssueSessionControls issue={issue} disabled onReset={async () => {}} />);
  expect(screen.getByRole("button", { name: "重置会话" })).toHaveProperty("disabled", true);
});
