import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IssueDetail } from "../data/client";
const state = vi.hoisted(() => ({ update: vi.fn(), user: () => ({ subject: "developer", role: "developer" }) }));
vi.mock("../data/client", async (original) => ({
  ...(await original<typeof import("../data/client")>()),
  updateIssue: state.update,
}));
vi.mock("./ApplicationResources", () => ({
  useApplicationResources: () => ({ currentUser: () => state.user(), people: () => [], peopleError: () => "", catalog: () => ({ environments: [], services: [] }) }),
}));
import { IssueWorkspace } from "./IssueWorkspace";
const issue: IssueDetail = {
  id: "ISSUE-20261018-001",
  title: "Synthetic scope",
  description: "",
  priority: "p2",
  type: "smart_analysis",
  status: "pending",
  assignee: null,
  assigneeSubject: null,
  service: { key: "orders", name: "Orders" },
  environmentKey: "prod",
  updatedAt: "2026-10-18T00:00:00Z",
  repositories: [],
  workspace: { status: "ready", sourceAvailable: false },
  attachments: [],
  comments: [],
};
beforeEach(() => {
  state.update.mockResolvedValue(issue);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  state.user = () => ({ subject: "developer", role: "developer" });
});
async function open(onUpdated = async () => {}, agentRunning = false) {
  render(() => <IssueWorkspace issue={{ ...issue, agentRunning }} onOpenSource={() => {}} onUpdated={onUpdated} onCreatedFollowUp={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "编辑工单" }));
  return screen.findByRole("dialog", { name: "编辑工单" });
}
it("saves edits and resets from the footer without confirmation", async () => {
  const updated = vi.fn(async () => {}),
    confirm = vi.spyOn(window, "confirm");
  const dialog = await open(updated);
  await fireEvent.input(within(dialog).getByLabelText("编辑工单标题"), { target: { value: "修改后的标题" } });
  const reset = within(dialog).getByRole("button", { name: "重置" });
  expect(reset.closest("footer")).toBe(within(dialog).getByRole("button", { name: "保存" }).closest("footer"));
  expect(within(dialog).getByText(/重置会保存当前修改并创建新会话/)).toBeTruthy();
  fireEvent.click(reset);
  await waitFor(() => expect(updated).toHaveBeenCalledOnce());
  expect(state.update).toHaveBeenCalledWith(issue.id, expect.objectContaining({ title: "修改后的标题" }), [], [], true);
  expect(confirm).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑工单" })).toBeNull());
});
it("preserves drafts and does not reset when saving fails", async () => {
  state.update.mockRejectedValue(new Error("保存失败"));
  const dialog = await open();
  fireEvent.input(within(dialog).getByLabelText("编辑工单标题"), { target: { value: "保留草稿" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "重置" }));
  expect((await within(dialog).findByRole("alert")).textContent).toBe("保存失败");
  expect(within(dialog).getByLabelText("编辑工单标题")).toHaveProperty("value", "保留草稿");
});
it("reports partial success and retries without uploading saved attachments twice", async () => {
  state.update.mockRejectedValueOnce(new Error("issue_saved_session_reset_failed"));
  const updated = vi.fn(async () => {}),
    dialog = await open(updated);
  const file = new File(["content"], "evidence.txt", { type: "text/plain" });
  await fireEvent.change(within(dialog).getByLabelText("编辑工单选择附件"), { target: { files: [file] } });
  fireEvent.click(within(dialog).getByRole("button", { name: "重置" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("工单已保存，但会话重置失败");
  expect(state.update.mock.calls[0]![3]).toEqual([file]);
  // The server committed the edits, so the retry must not upload the same file again.
  fireEvent.click(within(dialog).getByRole("button", { name: "重置" }));
  await waitFor(() => expect(updated).toHaveBeenCalledOnce());
  expect(state.update.mock.calls[1]![3]).toEqual([]);
});
it("saves normally without reading or resetting the session", async () => {
  const updated = vi.fn(async () => {}),
    dialog = await open(updated);
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(updated).toHaveBeenCalledOnce());
  expect(state.update.mock.calls[0]!.at(-1)).toBe(false);
});
for (const busy of [true, false])
  it(`disables reset for ${busy ? "active work" : "non-developers"}`, async () => {
    if (!busy) state.user = () => ({ subject: "viewer", role: "product" });
    const dialog = await open(async () => {}, busy);
    expect(within(dialog).getByRole("button", { name: "重置" })).toHaveProperty("disabled", true);
    expect(within(dialog).getByRole("button", { name: "保存" })).toHaveProperty("disabled", false);
  });
it("reports a completed reset separately from a failed page refresh", async () => {
  const updated = vi.fn(async () => {
      throw new Error("刷新失败");
    }),
    dialog = await open(updated);
  fireEvent.click(within(dialog).getByRole("button", { name: "重置" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("工单已保存并重置，但刷新失败");
  expect(updated).toHaveBeenCalledOnce();
});
it("does not reset after the workspace unmounts while saving", async () => {
  let finish!: () => void;
  state.update.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(issue);
      }),
  );
  const updated = vi.fn(async () => {});
  const view = render(() => <IssueWorkspace issue={issue} onOpenSource={() => {}} onUpdated={updated} onCreatedFollowUp={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "编辑工单" }));
  const dialog = await screen.findByRole("dialog", { name: "编辑工单" });
  fireEvent.click(within(dialog).getByRole("button", { name: "重置" }));
  await waitFor(() => expect(state.update).toHaveBeenCalledOnce());
  view.unmount();
  finish();
  await Promise.resolve();
  expect(updated).not.toHaveBeenCalled();
});
it("surfaces the server refusal when there is no current session", async () => {
  state.update.mockRejectedValueOnce(new Error("agent_session_not_found"));
  const dialog = await open();
  fireEvent.click(within(dialog).getByRole("button", { name: "重置" }));
  expect((await within(dialog).findByRole("alert")).textContent).toBe("暂无可重置的会话。");
});
