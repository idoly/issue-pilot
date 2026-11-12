import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueExecutionItem } from "../data/client";
import { Dashboard } from "./Dashboard";

vi.mock("./ApplicationResources", () => ({ useApplicationResources: () => ({ catalog: () => ({ environments: [{ key: "test", name: "测试" }] }) }) }));

function issue(id: string, overrides: Partial<IssueExecutionItem> = {}): IssueExecutionItem {
  return {
    id,
    title: `Issue ${id}`,
    priority: "p1",
    type: "smart_analysis",
    status: "open",
    assignee: null,
    assigneeSubject: null,
    service: { key: "orders", name: "Orders" },
    environmentKey: "test",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
    workspaceStatus: "ready",
    agentRunning: false,
    resolvedAt: null,
    ...overrides,
  };
}
const order = () => screen.getAllByRole("listitem").map((row) => within(row).getByText(/^ISSUE-/).textContent);
afterEach(cleanup);

describe("Dashboard focus ranking", () => {
  it("keeps failure/execution priority, descending update time and stable ties without changing the input", () => {
    const issues = [
      issue("ISSUE-20261101-001", { status: "pending", updatedAt: "2026-11-04T00:00:00.000Z" }),
      issue("ISSUE-20261101-002", { workspaceStatus: "failed" }),
      issue("ISSUE-20261101-003", { workspaceStatus: "running", updatedAt: "2026-11-04T00:00:00.000Z", assigneeSubject: "developer", assignee: "Developer" }),
      issue("ISSUE-20261101-004", { status: "resolved", workspaceStatus: "failed", resolvedAt: "2026-11-05T00:00:00.000Z" }),
      issue("ISSUE-20261101-005", { workspaceStatus: "preparing", updatedAt: "2026-11-03T00:00:00.000Z" }),
      issue("ISSUE-20261101-006", { workspaceStatus: "failed", updatedAt: "2026-11-03T00:00:00.000Z" }),
      issue("ISSUE-20261101-007", { updatedAt: "2026-11-04T00:00:00.000Z" }),
    ];
    const before = structuredClone(issues);
    render(() => <Dashboard issues={issues} loading={false} loadError="" refreshing={false} onRefresh={() => {}} onSelectIssue={() => {}} />);
    expect(order()).toEqual([6, 2, 3, 5, 1, 7].map((n) => `ISSUE-20261101-00${n}`));
    const metric = (label: string) =>
      within(screen.getByRole("region", { name: "当前运营状态" }))
        .getByText(label)
        .parentElement!.querySelector("strong")!.textContent;
    expect(metric("活动工单")).toBe("6");
    expect(metric("正在执行")).toBe("2");
    expect(metric("执行失败")).toBe("2");
    expect(metric("未分配")).toBe("5");
    expect(issues).toEqual(before);
  });

  it("opens the selected Issue after recomputing the ranking", async () => {
    const [issues, setIssues] = createSignal(
      [issue("ISSUE-20261101-001", { workspaceStatus: "failed", assigneeSubject: "developer", assignee: "Developer" }), issue("ISSUE-20261101-002", { updatedAt: "2026-11-03T00:00:00.000Z" })],
      { ownedWrite: true },
    );
    const selected = vi.fn();
    render(() => <Dashboard issues={issues()} loading={false} loadError="" refreshing={false} onRefresh={() => {}} onSelectIssue={selected} />);
    expect(order()).toEqual(["ISSUE-20261101-001", "ISSUE-20261101-002"]);
    setIssues((rows) => rows.map((row) => (row.id.endsWith("001") ? { ...row, workspaceStatus: "ready" } : row)));
    await waitFor(() => expect(order()).toEqual(["ISSUE-20261101-002", "ISSUE-20261101-001"]));
    fireEvent.click(within(screen.getAllByRole("listitem")[1]!).getByRole("button"));
    expect(selected).toHaveBeenCalledWith("ISSUE-20261101-001");
  });
});

describe("Dashboard refresh failures", () => {
  it("keeps the ranked list and shows the failure as a banner when a poll fails", () => {
    const issues = [issue("ISSUE-20261101-001"), issue("ISSUE-20261101-002")];
    render(() => <Dashboard issues={issues} loading={false} loadError="fixture_poll_failed" refreshing={false} onRefresh={() => {}} onSelectIssue={() => {}} />);
    expect(screen.getByRole("alert").textContent).toContain("fixture_poll_failed");
    expect(order()).toEqual(["ISSUE-20261101-001", "ISSUE-20261101-002"]);
  });

  it("exposes the full title and an exact timestamp on rows", () => {
    render(() => (
      <Dashboard
        issues={[issue("ISSUE-20261101-003", { title: "A very long title that the row truncates" })]}
        loading={false}
        loadError=""
        refreshing={false}
        onRefresh={() => {}}
        onSelectIssue={() => {}}
      />
    ));
    expect(screen.getByText("A very long title that the row truncates").getAttribute("title")).toBe("A very long title that the row truncates");
    expect(document.querySelector(".dashboard-attention-item time")?.getAttribute("datetime")).toBe("2026-11-02T00:00:00.000Z");
  });
});
