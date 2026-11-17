import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RequestError, type IssueDetail } from "../data/client";
const state = vi.hoisted(() => ({
  update: vi.fn<typeof import("../data/client").updateIssue>(),
  read: vi.fn<typeof import("../data/client").getIssue>(),
  user: () => ({ subject: "developer", role: "developer" }),
}));
vi.mock("../data/client", async (original) => ({
  ...(await original<typeof import("../data/client")>()),
  updateIssue: state.update,
  getIssue: state.read,
}));
vi.mock("./ApplicationResources", () => ({
  useApplicationResources: () => ({ currentUser: () => state.user(), people: () => [], peopleError: () => "", catalog: () => ({ environments: [], services: [] }) }),
}));
import { IssueWorkspace } from "./IssueWorkspace";
import { settle } from "../test-settle";
import { createIssueList } from "./issue-list";

/** The related-Issue picker reads the shared list; it stays idle until the editor refreshes it. */
function Workspace(props: Omit<Parameters<typeof IssueWorkspace>[0], "issueList">) {
  const issueList = createIssueList(() => false);
  return <IssueWorkspace {...props} issueList={issueList} />;
}
const issue: IssueDetail = {
  workspaceStatus: "ready",
  agentRunning: false,
  resolvedAt: null,
  editVersion: "a".repeat(64),
  id: "ISSUE-20261018-001",
  title: "Synthetic scope",
  description: "",
  priority: "p2",
  type: "smart_analysis",
  status: "pending",
  assignee: null,
  assigneeSubject: null,
  reporterSubject: "reporter",
  ccSubjects: [],
  service: { key: "orders", name: "Orders" },
  environmentKey: "prod",
  revision: "ISSUE-20261018-001:1",
  createdAt: "2026-10-18T00:00:00Z",
  updatedAt: "2026-10-18T00:00:00Z",
  repositories: [],
  workingDirectory: "/fixture/workspaces/issue",
  workspace: { status: "ready", sourceAvailable: false, runtimeReady: true, retryable: false },
  attachments: [],
  collaboratingServices: [],
  relatedIssues: [],
  scopeTransitions: [],
  ccRecipients: [],
};
beforeEach(() => {
  state.update.mockResolvedValue(issue);
  state.read.mockResolvedValue(issue);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  state.user = () => ({ subject: "developer", role: "developer" });
});
async function open(onUpdated = async () => {}) {
  render(() => <Workspace issue={issue} onOpenSource={() => {}} onUpdated={onUpdated} onCreatedFollowUp={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "编辑工单" }));
  return screen.findByRole("dialog", { name: "编辑工单" });
}
it("saves edits and resets from the footer without confirmation", async () => {
  const updated = vi.fn<NonNullable<Parameters<typeof IssueWorkspace>[0]["onUpdated"]>>(async () => {}),
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

it("keeps the editor version across background refresh and preserves a conflicted draft until explicit reload", async () => {
  const latest = { ...issue, title: "Another editor's title", editVersion: "b".repeat(64) };
  const [current, setCurrent] = createSignal(issue, { ownedWrite: true });
  state.update.mockRejectedValueOnce(new Error("issue_edit_conflict"));
  state.read.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(latest);
  render(() => <Workspace issue={current()} onOpenSource={() => {}} onUpdated={async () => {}} onCreatedFollowUp={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "编辑工单" }));
  const dialog = await screen.findByRole("dialog", { name: "编辑工单" });
  fireEvent.input(within(dialog).getByLabelText("编辑工单标题"), { target: { value: "My draft" } });
  const file = new File(["draft evidence"], "draft.txt", { type: "text/plain" });
  await fireEvent.change(within(dialog).getByLabelText("编辑工单选择附件"), { target: { files: [file] } });
  setCurrent(latest);
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("工单已被修改");
  expect(state.update.mock.calls[0]?.[1]).toMatchObject({ title: "My draft", expectedEditVersion: issue.editVersion });
  expect(within(dialog).getByLabelText("编辑工单标题")).toHaveProperty("value", "My draft");
  expect(within(dialog).getByText("draft.txt")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "重新载入（放弃草稿）" }));
  await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toContain("读取失败"));
  expect(within(dialog).getByText("draft.txt")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "重新载入（放弃草稿）" }));
  await waitFor(() => expect(within(dialog).getByLabelText("编辑工单标题")).toHaveProperty("value", latest.title));
  expect(within(dialog).queryByText("draft.txt")).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(state.update).toHaveBeenCalledTimes(2));
  expect(state.update.mock.calls[1]?.[1]).toMatchObject({ title: latest.title, expectedEditVersion: latest.editVersion });
  expect(state.update.mock.calls[1]?.[3]).toEqual([]);
});
it("preserves uploads and allows the unchanged edit to retry after atomic reset failure", async () => {
  state.update.mockRejectedValueOnce(new Error("reset_failed"));
  const updated = vi.fn<NonNullable<Parameters<typeof IssueWorkspace>[0]["onUpdated"]>>(async () => {}),
    dialog = await open(updated);
  const file = new File(["content"], "evidence.txt", { type: "text/plain" });
  await fireEvent.change(within(dialog).getByLabelText("编辑工单选择附件"), { target: { files: [file] } });
  fireEvent.click(within(dialog).getByRole("button", { name: "重置" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("reset_failed");
  expect(within(dialog).getByText("evidence.txt")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "重置" }));
  await waitFor(() => expect(updated).toHaveBeenCalledOnce());
  expect(state.update).toHaveBeenCalledTimes(2);
  expect(state.update.mock.calls[1]).toEqual(state.update.mock.calls[0]);
});

it("saves normally without reading or resetting the session", async () => {
  const updated = vi.fn<NonNullable<Parameters<typeof IssueWorkspace>[0]["onUpdated"]>>(async () => {}),
    dialog = await open(updated);
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(updated).toHaveBeenCalledOnce());
  expect(state.update.mock.calls[0]!.at(-1)).toBe(false);
});
it("disables editing while an Agent round is queued or running and keeps history reachable", () => {
  render(() => <Workspace issue={{ ...issue, agentRunning: true }} onOpenSource={() => {}} onUpdated={async () => {}} onCreatedFollowUp={() => {}} />);
  expect(screen.getByRole("button", { name: "编辑工单" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "查看历史" })).toHaveProperty("disabled", false);
});
it("keeps session history reachable after resolution without the edit dialog", () => {
  render(() => <Workspace issue={{ ...issue, status: "resolved", resolvedAt: "2026-10-19T00:00:00Z" }} onOpenSource={() => {}} onUpdated={async () => {}} onCreatedFollowUp={() => {}} />);
  expect(screen.queryByRole("button", { name: "编辑工单" })).toBeNull();
  expect(screen.getByRole("button", { name: "查看历史" })).toHaveProperty("disabled", false);
});
it("disables reset when work starts while the editor is open", async () => {
  const [current, setCurrent] = createSignal(issue);
  render(() => <Workspace issue={current()} onOpenSource={() => {}} onUpdated={async () => {}} onCreatedFollowUp={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "编辑工单" }));
  const dialog = await screen.findByRole("dialog", { name: "编辑工单" });
  setCurrent({ ...issue, agentRunning: true });
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "重置" })).toHaveProperty("disabled", true));
  expect(within(dialog).getByRole("button", { name: "保存" })).toHaveProperty("disabled", false);
});
it("explains a save refused by queued work without suggesting a reset", async () => {
  state.update.mockRejectedValueOnce(new Error("issue_already_running"));
  const dialog = await open();
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  const alert = await within(dialog).findByRole("alert");
  expect(alert.textContent).toBe("工单正在处理，请等待处理结束后再保存。");
  expect(alert.textContent).not.toContain("重置");
});
it("disables reset for non-developers", async () => {
  state.user = () => ({ subject: "viewer", role: "product" });
  const dialog = await open();
  expect(within(dialog).getByRole("button", { name: "重置" })).toHaveProperty("disabled", true);
  expect(within(dialog).getByRole("button", { name: "保存" })).toHaveProperty("disabled", false);
});
it("reports a completed reset separately from a failed page refresh", async () => {
  const updated = vi.fn<NonNullable<Parameters<typeof IssueWorkspace>[0]["onUpdated"]>>(async () => {}).mockRejectedValueOnce(new Error("网络错误")),
    dialog = await open(updated);
  fireEvent.click(within(dialog).getByRole("button", { name: "重置" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("工单已保存并重置，但刷新失败");
  expect(updated).toHaveBeenCalledOnce();
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑工单" })).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "编辑工单" }));
  const reopened = await screen.findByRole("dialog", { name: "编辑工单" });
  expect(within(reopened).queryByRole("button", { name: "保存" })).toBeNull();
  fireEvent.click(within(reopened).getByRole("button", { name: "重新读取" }));
  await waitFor(() => expect(updated).toHaveBeenCalledTimes(2));
  expect(state.update).toHaveBeenCalledOnce();
});
for (const change of ["identity", "issue"] as const)
  for (const failure of ["committed cleanup", "refresh"] as const)
    it(`preserves the new attachment draft when an old ${failure} fails after changing ${change}`, async () => {
      let rejectPending!: (error: Error) => void;
      const pending = new Promise<never>((_, reject) => {
        rejectPending = reject;
      });
      const updated = vi.fn<NonNullable<Parameters<typeof IssueWorkspace>[0]["onUpdated"]>>(async () => {});
      if (failure === "committed cleanup") state.update.mockImplementationOnce(() => pending);
      else updated.mockImplementationOnce(() => pending);
      const attachment = { id: "existing", fileName: "existing.txt", mediaType: "text/plain", size: 3, sha256: "a".repeat(64) };
      const [currentIssue, setIssue] = createSignal({ ...issue, attachments: [attachment] }, { ownedWrite: true });
      const [user, setUser] = createSignal({ subject: "developer", role: "developer" }, { ownedWrite: true });
      state.user = user;
      render(() => <Workspace issue={currentIssue()} onOpenSource={() => {}} onUpdated={updated} onCreatedFollowUp={() => {}} />);
      try {
        fireEvent.click(screen.getByRole("button", { name: "编辑工单" }));
        const oldDialog = await screen.findByRole("dialog", { name: "编辑工单" });
        fireEvent.click(within(oldDialog).getByRole("button", { name: "重置" }));
        await waitFor(() => expect(state.update).toHaveBeenCalledOnce());
        await waitFor(() => expect(updated).toHaveBeenCalledTimes(failure === "refresh" ? 1 : 0));

        if (change === "identity") setUser({ subject: "other-developer", role: "developer" });
        else setIssue({ ...currentIssue(), id: "ISSUE-20261018-002" });
        await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑工单" })).toBeNull());
        fireEvent.click(screen.getByRole("button", { name: "编辑工单" }));
        const currentDialog = await screen.findByRole("dialog", { name: "编辑工单" });
        const file = new File(["new content"], "new-evidence.txt", { type: "text/plain" });
        await fireEvent.change(within(currentDialog).getByLabelText("编辑工单选择附件"), { target: { files: [file] } });
        fireEvent.click(within(currentDialog).getByRole("button", { name: "移除existing.txt" }));
        await waitFor(() => expect(within(currentDialog).queryByRole("button", { name: "移除existing.txt" })).toBeNull());

        rejectPending(failure === "committed cleanup" ? new RequestError("attachment_finalize_failed", "committed") : new Error("old_refresh_failed"));
        await settle();
        expect(within(currentDialog).getByText("new-evidence.txt")).toBeTruthy();
        expect(within(currentDialog).queryByRole("button", { name: "移除existing.txt" })).toBeNull();
        expect(within(currentDialog).queryByRole("alert")).toBeNull();
        fireEvent.click(within(currentDialog).getByRole("button", { name: "保存" }));
        await waitFor(() => expect(state.update).toHaveBeenCalledTimes(2));
        expect(state.update.mock.calls[1]).toEqual([currentIssue().id, expect.anything(), [attachment.id], [file], false]);
      } finally {
        rejectPending(new Error("test_cleanup"));
        await pending.catch(() => undefined);
      }
    });
it("does not reset after the workspace unmounts while saving", async () => {
  let finish!: () => void;
  state.update.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(issue);
      }),
  );
  const updated = vi.fn<NonNullable<Parameters<typeof IssueWorkspace>[0]["onUpdated"]>>(async () => {});
  const view = render(() => <Workspace issue={issue} onOpenSource={() => {}} onUpdated={updated} onCreatedFollowUp={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "编辑工单" }));
  const dialog = await screen.findByRole("dialog", { name: "编辑工单" });
  fireEvent.click(within(dialog).getByRole("button", { name: "重置" }));
  await waitFor(() => expect(state.update).toHaveBeenCalledOnce());
  view.unmount();
  finish();
  await settle();
  expect(updated).not.toHaveBeenCalled();
});
it("surfaces the server refusal when there is no current session", async () => {
  state.update.mockRejectedValueOnce(new Error("agent_session_not_found"));
  const dialog = await open();
  fireEvent.click(within(dialog).getByRole("button", { name: "重置" }));
  expect((await within(dialog).findByRole("alert")).textContent).toBe("暂无可重置的会话。");
});
