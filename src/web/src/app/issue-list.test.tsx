import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { IssueExecutionItem } from "../data/client";
const api = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../data/client", async (original) => ({ ...(await original<typeof import("../data/client")>()), listIssues: api.list }));
import { createIssueList, type IssueListResource } from "./issue-list";

const row = (title: string): IssueExecutionItem => ({
  id: "ISSUE-20261109-001",
  title,
  priority: "p2",
  type: "smart_analysis",
  status: "open",
  assignee: null,
  assigneeSubject: null,
  service: { key: "orders", name: "Orders" },
  environmentKey: "prod",
  updatedAt: "2026-11-09T00:00:00Z",
  workspaceStatus: "ready",
  agentRunning: false,
  resolvedAt: null,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

it("lets slow samples finish and retains the last good list through failure and retry", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const slow = deferred<IssueExecutionItem[]>();
  api.list
    .mockReturnValueOnce(slow.promise)
    .mockRejectedValueOnce(new Error("poll_failed"))
    .mockResolvedValueOnce([row("recovered")]);
  let list!: IssueListResource;
  function Probe() {
    list = createIssueList();
    return (
      <output>
        {JSON.stringify(list.items())}:{list.error()}
      </output>
    );
  }
  render(() => <Probe />);
  await waitFor(() => expect(api.list).toHaveBeenCalledOnce());
  const signal = api.list.mock.calls[0]![0] as AbortSignal;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(api.list).toHaveBeenCalledOnce();
  expect(signal.aborted).toBe(false);
  slow.resolve([row("saved")]);
  await waitFor(() => expect(list.items()[0]?.title).toBe("saved"));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(list.error()).toBe("poll_failed");
  expect(list.items()[0]?.title).toBe("saved");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(list.error()).toBe("");
  expect(list.items()[0]?.title).toBe("recovered");
});

it("rejects old snapshots after explicit refresh, navigation and disposal", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const old = deferred<IssueExecutionItem[]>(),
    leaving = deferred<IssueExecutionItem[]>(),
    closing = deferred<IssueExecutionItem[]>();
  api.list
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce([row("new")])
    .mockReturnValueOnce(leaving.promise)
    .mockResolvedValueOnce([row("home")])
    .mockReturnValueOnce(closing.promise);
  const [scope, setScope] = createSignal<string | false>("issues", { ownedWrite: true });
  let list!: IssueListResource;
  function Probe() {
    list = createIssueList(scope);
    return (
      <output>
        {JSON.stringify(list.items())}:{list.error()}
      </output>
    );
  }
  const view = render(() => <Probe />);
  await waitFor(() => expect(api.list).toHaveBeenCalledOnce());
  await list.refresh();
  expect(api.list.mock.calls[0]![0].aborted).toBe(true);
  old.resolve([row("obsolete")]);
  await Promise.resolve();
  expect(list.items()[0]?.title).toBe("new");
  const pending = list.refresh();
  setScope(false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await waitFor(() => expect(api.list.mock.calls[2]![0].aborted).toBe(true));
  leaving.resolve([row("left page")]);
  await pending;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(api.list).toHaveBeenCalledTimes(3);
  expect(list.items()[0]?.title).toBe("new");
  setScope("dashboard");
  await waitFor(() => expect(list.items()[0]?.title).toBe("home"));
  const final = list.refresh();
  view.unmount();
  expect(api.list.mock.calls[4]![0].aborted).toBe(true);
  closing.reject(new Error("late error"));
  await final;
  await vi.advanceTimersByTimeAsync(20_000);
  await list.refresh();
  expect(api.list).toHaveBeenCalledTimes(5);
  expect(list.error()).toBe("");
});
