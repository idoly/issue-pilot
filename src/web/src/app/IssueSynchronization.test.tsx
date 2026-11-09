import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IssueDetail, IssueExecutionItem } from "../data/client";
import { EventSourceMock } from "../test-setup";

const api = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn() }));
vi.mock("../data/client", async (original) => ({
  ...(await original<typeof import("../data/client")>()),
  listIssues: api.list,
  getIssue: api.detail,
  listIssuePins: async () => [],
  loadUsers: async () => [{ subject: "alice", name: "Alice", email: "alice@example.test", role: "developer" }],
  loadCurrentUser: async () => ({ subject: "alice", name: "Alice", email: "alice@example.test", role: "developer" }),
  loadCatalog: async () => ({ environments: [{ key: "prod", name: "正式" }], services: [{ key: "orders", name: "Orders", deployments: [{ environmentKey: "prod" }] }] }),
}));
import { App } from "./App";
import { setCurrentUserSubject } from "../data/client";

let current: IssueDetail;
const summary = (): IssueExecutionItem => {
  const { workspace, ...detail } = current;
  return { ...detail, workspaceStatus: workspace.status, agentRunning: current.agentRunning === true, resolvedAt: null };
};
beforeEach(() => {
  current = {
    id: "ISSUE-20261109-001",
    title: "Sync fixture",
    description: "",
    priority: "p2",
    type: "smart_analysis",
    status: "pending",
    assignee: "Alice",
    assigneeSubject: "alice",
    service: { key: "orders", name: "Orders" },
    environmentKey: "prod",
    updatedAt: "2026-11-09T00:00:00.000Z",
    agentRunning: false,
    workspace: { status: "ready", sourceAvailable: false },
    repositories: [],
    attachments: [],
    comments: [],
  };
  api.list.mockImplementation(async () => [summary()]);
  api.detail.mockImplementation(async () => structuredClone(current));
  EventSourceMock.instances.length = 0;
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
  setCurrentUserSubject(null);
});
async function open() {
  render(() => <App initialView="issues" />);
  await screen.findByRole("heading", { name: current.title });
  const stream = EventSourceMock.instances.at(-1)!;
  stream.emit("snapshot_ready", { runState: current.agentRunning ? "running" : "idle", running: current.agentRunning, issueStatus: current.status });
  return stream;
}

it("finishes cleanup in both the conversation and details even when the business status stays pending", async () => {
  current.agentRunning = true;
  const stream = await open();
  expect(screen.getByTitle("中断当前处理并取消后续排队，保留未发送草稿")).toBeTruthy();
  stream.emit("message", { id: "complete", event: { type: "issue_status", status: "complete" } });
  await waitFor(() => expect(api.detail).toHaveBeenCalledTimes(2));
  expect(screen.getByTitle("中断当前处理并取消后续排队，保留未发送草稿")).toBeTruthy();
  current.agentRunning = false;
  stream.emit("message", { id: "idle", event: { type: "issue_run_state", state: "idle" } });
  await waitFor(() => expect(api.detail).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(screen.queryByText(/Esc 中断/)).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "编辑工单" }));
  expect(await screen.findByRole("button", { name: "重置" })).toHaveProperty("disabled", false);
});

it("updates queue metadata after an Agent refresh without requiring a status change", async () => {
  const stream = await open();
  current.title = "Renamed during execution";
  stream.emit("message", { id: "workspace", event: { type: "tool_execution_end", toolCallId: "workspace", toolName: "workspace", result: { content: [] }, isError: false } });
  await screen.findByRole("heading", { name: current.title });
  expect(await within(screen.getByLabelText("工单队列")).findByText(current.title)).toBeTruthy();
});

it("reloads the same selected Issue when returning from another page", async () => {
  await open();
  fireEvent.click(screen.getByRole("radio", { name: "首页" }));
  await screen.findByRole("heading", { name: "运营总览" });
  current.description = "Changed while the workspace was closed";
  fireEvent.click(screen.getByRole("radio", { name: "工单" }));
  await screen.findByText(current.description);
});

it("polls other Issues and updates the selected details while retaining unsent conversation text", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  await open();
  fireEvent.input(screen.getByLabelText("发送给 Agent"), { target: { value: "keep this draft" } });
  const other = { ...summary(), id: "ISSUE-20261109-002", title: "Another updated Issue", status: "open" as const };
  current.description = "External detail change";
  current.updatedAt = "2026-11-09T01:00:00.000Z";
  api.list.mockImplementation(async () => [summary(), other]);
  await vi.advanceTimersByTimeAsync(10_000);
  await within(screen.getByLabelText("工单队列")).findByText(other.title);
  await screen.findByText(current.description);
  expect(screen.getByLabelText("发送给 Agent")).toHaveProperty("value", "keep this draft");
});

it("keeps the last queue and draft visible when polling fails, then recovers", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  await open();
  fireEvent.input(screen.getByLabelText("发送给 Agent"), { target: { value: "unsent" } });
  api.list.mockRejectedValueOnce(new Error("list_offline"));
  await vi.advanceTimersByTimeAsync(10_000);
  await screen.findByText("list_offline");
  expect(within(screen.getByLabelText("工单队列")).getByText(current.title)).toBeTruthy();
  expect(screen.getByRole("heading", { name: current.title })).toBeTruthy();
  expect(screen.getByLabelText("发送给 Agent")).toHaveProperty("value", "unsent");
  await vi.advanceTimersByTimeAsync(10_000);
  await waitFor(() => expect(screen.queryByText("list_offline")).toBeNull());
});

it("keeps one snapshot across the queue and homepage while a fresh sample is pending", async () => {
  const stream = await open();
  current.title = "Shared latest title";
  stream.emit("message", { id: "workspace", event: { type: "tool_execution_end", toolCallId: "workspace", toolName: "workspace", result: { content: [] }, isError: false } });
  await within(screen.getByLabelText("工单队列")).findByText(current.title);
  let finish!: () => void;
  api.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve([summary()]);
      }),
  );
  fireEvent.click(screen.getByRole("radio", { name: "首页" }));
  await within(await screen.findByRole("list", { name: "待处理工单" })).findByText(current.title);
  expect(screen.getByRole("region", { name: "当前运营状态" })).toBeTruthy();
  finish();
});

it("ignores a refresh from the old workspace after returning to the same Issue", async () => {
  const stream = await open();
  const old = structuredClone(current);
  let finish!: (detail: IssueDetail) => void;
  api.detail.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  stream.emit("message", { id: "old", event: { type: "issue_status", status: "complete" } });
  await waitFor(() => expect(api.detail).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("radio", { name: "首页" }));
  await screen.findByRole("heading", { name: "运营总览" });
  current.description = "Latest after return";
  fireEvent.click(screen.getByRole("radio", { name: "工单" }));
  await screen.findByText(current.description);
  finish({ ...old, description: "Obsolete refresh" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByText("Obsolete refresh")).toBeNull();
  expect(screen.getByText(current.description)).toBeTruthy();
});

it("reports failed detail synchronization and retries on the next sample even when summary fields are unchanged", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const stream = await open();
  api.detail.mockRejectedValue(new Error("details_offline"));
  stream.emit("message", { id: "workspace", event: { type: "tool_execution_end", toolCallId: "workspace", toolName: "workspace", result: { content: [] }, isError: false } });
  await screen.findByText("工单详情刷新失败：details_offline");
  expect(screen.getByRole("heading", { name: current.title })).toBeTruthy();
  current.description = "Recovered details";
  api.detail.mockImplementation(async () => structuredClone(current));
  await vi.advanceTimersByTimeAsync(10_000);
  await screen.findByText(current.description);
  await waitFor(() => expect(screen.queryByText("工单详情刷新失败：details_offline")).toBeNull());
});

it("refreshes related Issue cards independently of the selected Issue and preserves an open editor", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let related: IssueExecutionItem = { ...summary(), id: "ISSUE-20261109-002", title: "Related original" };
  current.relatedIssues = [related];
  api.list.mockImplementation(async () => [summary(), related]);
  await open();
  fireEvent.click(screen.getByRole("button", { name: "编辑工单" }));
  fireEvent.input(await screen.findByLabelText("编辑工单标题"), { target: { value: "unsaved title" } });
  const calls = api.detail.mock.calls.length;
  related = { ...related, title: "Related renamed", status: "resolved", assignee: "Bob", assigneeSubject: "bob" };
  current.relatedIssues = [related];
  await vi.advanceTimersByTimeAsync(10_000);
  await waitFor(() => expect(screen.getByRole("link", { name: `打开关联工单 ${related.id}` })).toHaveProperty("title", related.title));
  const card = screen.getByRole("link", { name: `打开关联工单 ${related.id}` });
  expect(within(card).getByText("已解决")).toBeTruthy();
  expect(within(card).getByText("Bob")).toBeTruthy();
  expect(screen.getByLabelText("编辑工单标题")).toHaveProperty("value", "unsaved title");
  expect(api.detail).toHaveBeenCalledTimes(calls + 1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(api.detail).toHaveBeenCalledTimes(calls + 1);
});

it("removes a disappeared related Issue without waiting for selected metadata to change", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const related = { ...summary(), id: "ISSUE-20261109-002", title: "Related original" };
  current.relatedIssues = [related];
  api.list.mockResolvedValue([summary(), related]);
  await open();
  expect(screen.getByRole("link", { name: `打开关联工单 ${related.id}` })).toBeTruthy();
  current.relatedIssues = [];
  api.list.mockImplementation(async () => [summary()]);
  await vi.advanceTimersByTimeAsync(10_000);
  await waitFor(() => expect(screen.queryByRole("link", { name: `打开关联工单 ${related.id}` })).toBeNull());
});
