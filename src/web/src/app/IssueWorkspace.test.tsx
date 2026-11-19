import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import type { IssueDetail, IssueScopeTransitionPlan } from "../data/client";

const state = vi.hoisted(() => ({
  related: vi.fn<typeof import("../data/client").updateIssueRelatedIssues>(),
  apply: vi.fn<typeof import("../data/client").applyIssueScopeTransition>(),
  plan: vi.fn<typeof import("../data/client").planIssueScopeTransition>(),
  create: vi.fn<typeof import("../data/client").createIssue>(),
  list: vi.fn<typeof import("../data/client").listIssues>(),
  retry: vi.fn<typeof import("../data/client").retryIssue>(),
  user: () => ({ subject: "developer", role: "developer" }),
}));
vi.mock("../data/client", async (original) => ({
  ...(await original<typeof import("../data/client")>()),
  listIssueWorkFiles: vi.fn<typeof import("../data/client").listIssueWorkFiles>(async () => []),
  planIssueScopeTransition: state.plan,
  updateIssueRelatedIssues: state.related,
  applyIssueScopeTransition: state.apply,
  createIssue: state.create,
  listIssues: state.list,
  retryIssue: state.retry,
}));
vi.mock("./ApplicationResources", () => ({
  useApplicationResources: () => ({
    currentUser: () => state.user(),
    people: () => [],
    peopleError: () => "",
    catalog: () => ({
      environments: [
        { key: "prod", name: "正式" },
        { key: "test", name: "测试" },
      ],
      services: [
        { key: "orders", name: "Orders", deployments: [{ environmentKey: "prod" }, { environmentKey: "test" }] },
        { key: "inventory", name: "Inventory", deployments: [{ environmentKey: "test" }] },
      ],
    }),
  }),
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
  workspaceStatus: "ready",
  agentRunning: false,
  resolvedAt: null,
  repositories: [],
  workingDirectory: "/fixture/workspaces/issue",
  workspace: { status: "ready", sourceAvailable: false, runtimeReady: true, lastError: null, retryable: false },
  attachments: [],
  collaboratingServices: [],
  relatedIssues: [],
  scopeTransitions: [],
  ccRecipients: [],
};
function plan(current: boolean): IssueScopeTransitionPlan {
  return {
    planHash: `sha256:${"a".repeat(64)}`,
    expectedIssueUpdatedAt: issue.updatedAt,
    action: "rebind_read_only",
    current: { service: issue.service, workMode: "production_analysis", repositoryAccess: "read" },
    target: { service: current ? { key: "inventory", name: "Inventory" } : issue.service, workMode: current ? "test_analysis" : "production_analysis", repositoryAccess: "read" },
    repositories: { retained: [], removed: [], added: [{ name: current ? "current-plan-repository" : "stale-plan-repository", url: "https://example.test/repo.git", baseBranch: "main" }] },
    branch: null,
    session: { closeCurrent: true, preserveConversation: true },
    preserved: ["attachments", "conversation"],
    warnings: [],
  };
}
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  state.user = () => ({ subject: "developer", role: "developer" });
});

for (const outcome of ["success", "failure"] as const)
  for (const currentPending of [false, true])
    it(`ignores a closed related editor's ${outcome} while the new load is ${currentPending ? "pending" : "complete"}`, async () => {
      let finishOld!: () => void, finishCurrent!: () => void;
      const candidates = (count: number) =>
        Array.from({ length: count }, (_, index) => ({ ...issue, id: `ISSUE-20261017-00${index + 1}`, workspaceStatus: "ready" as const, agentRunning: false, resolvedAt: null }));
      state.list.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finishOld = outcome === "success" ? () => resolve(candidates(1)) : () => reject(new Error("closed_related_load_failed"));
          }),
      );
      state.list.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishCurrent = () => resolve(candidates(2));
          }),
      );
      render(() => <Workspace issue={issue} onOpenSource={() => {}} onUpdated={async () => {}} onCreatedFollowUp={() => {}} />);
      try {
        fireEvent.click(screen.getByRole("button", { name: "编辑关联" }));
        const old = await screen.findByRole("dialog", { name: "编辑关联工单" });
        await waitFor(() => expect(state.list).toHaveBeenCalledOnce());
        fireEvent.click(within(old).getByRole("button", { name: "取消" }));
        await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑关联工单" })).toBeNull());
        fireEvent.click(screen.getByRole("button", { name: "编辑关联" }));
        const current = await screen.findByRole("dialog", { name: "编辑关联工单" });
        await waitFor(() => expect(state.list).toHaveBeenCalledTimes(2));
        if (!currentPending) {
          finishCurrent();
          await within(current).findByText("关联工单（2 个可选，最多选择 20 个）");
        }
        finishOld();
        await settle();
        expect(screen.queryByText("closed_related_load_failed")).toBeNull();
        expect(within(current).queryByText("关联工单（1 个可选，最多选择 20 个）")).toBeNull();
        expect(within(current).getByRole("button", { name: "保存关联" })).toHaveProperty("disabled", currentPending);
        if (currentPending) finishCurrent();
        await within(current).findByText("关联工单（2 个可选，最多选择 20 个）");
      } finally {
        finishOld?.();
        finishCurrent?.();
      }
    });

for (const scope of [false, true])
  it(`does not repeat a committed ${scope ? "scope change" : "relation save"} while refreshing or after refresh failure`, async () => {
    let failRefresh!: (error: Error) => void;
    const onUpdated = vi.fn<() => Promise<void>>(
      () =>
        new Promise<void>((_resolve, reject) => {
          failRefresh = reject;
        }),
    );
    state.list.mockResolvedValue([]);
    state.plan.mockResolvedValue(plan(true));
    render(() => <Workspace issue={issue} onOpenSource={() => {}} onUpdated={onUpdated} onCreatedFollowUp={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: scope ? "变更处理范围" : "编辑关联" }));
    const dialog = within(await screen.findByRole("dialog"));
    if (scope) fireEvent.click(dialog.getByRole("button", { name: "预检变更" }));
    const submit = await dialog.findByRole("button", { name: scope ? "确认变更" : "保存关联" });
    await waitFor(() => expect(submit).toHaveProperty("disabled", false));
    fireEvent.click(submit);
    await waitFor(() => expect(onUpdated).toHaveBeenCalledOnce());
    const lockedDuringRefresh = (submit as HTMLButtonElement).disabled;
    failRefresh(new Error("offline"));
    await dialog.findByRole("alert");
    expect(lockedDuringRefresh).toBe(true);
    expect(submit).toHaveProperty("disabled", true);
    expect(dialog.getByRole("button", { name: "关闭弹窗" })).toHaveProperty("disabled", false);
    expect(scope ? state.apply : state.related).toHaveBeenCalledOnce();
  });

it("explains why queued intent from an earlier scope was not replayed", () => {
  const failed: IssueDetail = { ...issue, status: "open", workspace: { ...issue.workspace, status: "failed", retryable: true, lastError: "agent_message_scope_changed" } };
  render(() => <Workspace issue={failed} onOpenSource={() => {}} onUpdated={async () => {}} onCreatedFollowUp={() => {}} />);
  expect(screen.getByRole("alert").textContent).toBe("历史排队消息的处理范围已变更，已停止恢复。请核对历史输入后重试，或按当前范围重新发送。");
  expect(screen.getByRole("button", { name: "重试处理" })).toBeTruthy();
});

it("offers an explicit retry after a failed model response", () => {
  const failed: IssueDetail = { ...issue, status: "open", workspaceStatus: "failed", workspace: { ...issue.workspace, status: "failed", retryable: true, lastError: "model_response_failed" } };
  render(() => <Workspace issue={failed} onOpenSource={() => {}} onUpdated={async () => {}} onCreatedFollowUp={() => {}} />);
  expect(screen.getByRole("alert").textContent).toBe("模型响应中断，处理未完成。已有对话和文件已保留，请核对结果后重试处理。");
  // The failed round stays visible in the header instead of the plain "open" business status.
  expect(document.querySelector(".issue-heading-meta .ui-badge")!.textContent).toBe("执行失败");
  expect(screen.getByRole("button", { name: "重试处理" })).toBeTruthy();
  expect(screen.queryByText("确认解决")).toBeNull();
});

it("shows related Issue handler, status, service and environment with a navigable card", async () => {
  const open = vi.fn<NonNullable<Parameters<typeof import("./IssueWorkspace").IssueWorkspace>[0]["onOpenIssue"]>>();
  const related = { ...issue, id: "ISSUE-20261017-002", assignee: "处理人甲", assigneeSubject: "handler", workspaceStatus: "ready" as const, agentRunning: false, resolvedAt: null };
  const unassigned = { ...related, id: "ISSUE-20261017-003", assignee: null, assigneeSubject: null };
  const detailed = { ...issue, description: "[诊断日志](work/diagnostics.log)", relatedIssues: [related, unassigned] };
  render(() => <Workspace issue={detailed} onOpenIssue={open} onOpenSource={() => {}} onUpdated={async () => {}} onCreatedFollowUp={() => {}} />);
  const link = screen.getByRole("link", { name: `打开关联工单 ${related.id}` });
  expect(link.getAttribute("href")).toBe(`/?issue=${related.id}`);
  expect(within(link).getByText("处理人甲")).toBeTruthy();
  expect(within(link).getByText("待确认")).toBeTruthy();
  expect(within(link).getByText("Orders")).toBeTruthy();
  expect(within(link).getByText("正式")).toBeTruthy();
  expect(within(link).queryByText(related.title)).toBeNull();
  expect(link.getAttribute("title")).toBe(related.title);
  expect(link.querySelectorAll("[title]")).toHaveLength(0);
  expect(within(screen.getByRole("link", { name: `打开关联工单 ${unassigned.id}` })).getByText("未分配")).toBeTruthy();
  expect(screen.getByRole("link", { name: "诊断日志" }).getAttribute("href")).toBe(`/api/issues/${issue.id}/files/download?path=${encodeURIComponent("work/diagnostics.log")}`);
  fireEvent.click(link);
  expect(open).toHaveBeenCalledWith(related.id);
});

it("places attachments immediately after the Issue header", () => {
  render(() => <Workspace issue={issue} onOpenSource={() => {}} onUpdated={async () => {}} onCreatedFollowUp={() => {}} />);
  const header = document.querySelector(".issue-header")!;
  expect(header.nextElementSibling?.getAttribute("aria-labelledby")).toBe("attachments-title");
});

for (const change of ["unmount", "subject", "role"] as const)
  it(`does not navigate to an old follow-up after ${change}`, async () => {
    let finish!: () => void;
    state.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ ...issue, id: "ISSUE-20261018-999", workspaceStatus: "ready", agentRunning: false, resolvedAt: null });
        }),
    );
    const created = vi.fn<NonNullable<Parameters<typeof import("./IssueWorkspace").IssueWorkspace>[0]["onCreatedFollowUp"]>>();
    const development: IssueDetail = { ...issue, environmentKey: "dev", type: "defect_fix", workspace: { ...issue.workspace, sourceAvailable: true } };
    const [user, setUser] = createSignal({ subject: "developer", role: "developer" });
    state.user = user;
    const view = render(() => <Workspace issue={development} onOpenSource={() => {}} onUpdated={async () => {}} onCreatedFollowUp={created} />);
    fireEvent.click(screen.getByRole("button", { name: "创建正式跟进" }));
    const dialog = await screen.findByRole("dialog", { name: "创建正式跟进工单" });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建并关联" }));
    await waitFor(() => expect(state.create).toHaveBeenCalledOnce());
    if (change === "unmount") view.unmount();
    else setUser(change === "subject" ? { subject: "other", role: "developer" } : { subject: "developer", role: "product" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "创建正式跟进工单" })).toBeNull());
    finish();
    await settle();
    expect(created).not.toHaveBeenCalled();
  });

it("offers previews for supported attachments", async () => {
  const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{"result":"previewed-json"}'));
  vi.stubGlobal("fetch", fetchMock);
  const detailed: IssueDetail = {
    ...issue,
    attachments: [
      { id: "text", fileName: "results.json", storedFileName: "results.json", mediaType: "application/json", size: 30, sha256: "a".repeat(64), createdAt: new Date().toISOString() },
      {
        id: "workbook",
        fileName: "input.xlsx",
        storedFileName: "input.xlsx",
        mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: 512,
        sha256: "a".repeat(64),
        createdAt: new Date().toISOString(),
      },
      { id: "image", fileName: "image.png", storedFileName: "image.png", mediaType: "image/png", size: 512, sha256: "a".repeat(64), createdAt: new Date().toISOString() },
      { id: "archive", fileName: "archive.zip", storedFileName: "archive.zip", mediaType: "application/zip", size: 512, sha256: "a".repeat(64), createdAt: new Date().toISOString() },
    ],
  };
  render(() => <Workspace issue={detailed} onOpenSource={() => {}} onUpdated={async () => {}} onCreatedFollowUp={() => {}} />);
  for (const fileName of ["input.xlsx", "archive.zip"]) {
    expect(screen.queryByRole("button", { name: `预览 ${fileName}` })).toBeNull();
    expect(screen.getByRole("link", { name: `下载 ${fileName}` })).toBeTruthy();
  }
  expect(screen.getByRole("button", { name: "预览 image.png" })).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "预览 results.json" }));
  await screen.findByText(/previewed-json/);
  expect(screen.getByRole("dialog", { name: "results.json" })).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledOnce();
});

for (const outcome of ["success", "failure"] as const)
  it(`ignores a scope plan's ${outcome} after the target changes`, async () => {
    let finish!: () => void;
    state.plan.mockImplementationOnce(
      () =>
        new Promise<IssueScopeTransitionPlan>((resolve, reject) => {
          finish = outcome === "success" ? () => resolve(plan(false)) : () => reject(new Error("stale_plan_failed"));
        }),
    );
    state.plan.mockResolvedValueOnce(plan(true));
    render(() => <Workspace issue={issue} onOpenSource={() => {}} onUpdated={async () => {}} onCreatedFollowUp={() => {}} />);
    try {
      fireEvent.click(screen.getByRole("button", { name: "变更处理范围" }));
      const dialog = await screen.findByRole("dialog", { name: "变更处理范围" });
      fireEvent.click(within(dialog).getByRole("button", { name: "预检变更" }));
      await waitFor(() => expect(state.plan).toHaveBeenCalledOnce());
      fireEvent.click(within(dialog).getByLabelText("目标处理方式"));
      fireEvent.click(await screen.findByRole("option", { name: "测试问题调查" }));
      fireEvent.click(within(dialog).getByLabelText("目标服务"));
      fireEvent.click(await screen.findByRole("option", { name: "Inventory" }));
      finish();
      await settle();
      expect(within(dialog).queryByRole("region", { name: "范围变更预览" })).toBeNull();
      expect(screen.queryByText("stale_plan_failed")).toBeNull();
      const button = within(dialog).getByRole("button", { name: "预检变更" });
      await waitFor(() => expect(button).toHaveProperty("disabled", false));
      fireEvent.click(button);
      await within(dialog).findByText("新增 · current-plan-repository");
      expect(state.plan).toHaveBeenLastCalledWith(issue.id, { serviceKey: "inventory", workMode: "test_analysis" }, expect.any(AbortSignal));
    } finally {
      finish?.();
    }
  });

it("allows detaching relations without a prepared runtime view while refusing additions", async () => {
  const existing = { ...issue, id: "ISSUE-20261017-001", workspaceStatus: "ready" as const, agentRunning: false, resolvedAt: null };
  const candidate = { ...issue, id: "ISSUE-20261017-002", workspaceStatus: "ready" as const, agentRunning: false, resolvedAt: null };
  state.list.mockResolvedValue([existing, candidate]);
  const fetchMock = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal("fetch", fetchMock);
  render(() => (
    <Workspace
      issue={{ ...issue, relatedIssues: [existing], workspace: { ...issue.workspace, runtimeReady: false, lastError: null } }}
      onOpenSource={() => {}}
      onUpdated={async () => {}}
      onCreatedFollowUp={() => {}}
    />
  ));
  const button = screen.getByRole("button", { name: "编辑关联" });
  expect(button).toHaveProperty("disabled", false);
  fireEvent.click(button);
  const dialog = await screen.findByRole("dialog", { name: "编辑关联工单" });
  const selector = await waitFor(() => within(dialog).getByLabelText("编辑关联工单"));
  fireEvent.click(selector);
  fireEvent.click(within(await screen.findByRole("listbox")).getByText(/ISSUE-20261017-002/));
  await waitFor(() => expect(selector.closest(".ui-select")?.textContent).toContain("ISSUE-20261017-002"));
  fireEvent.click(within(dialog).getByRole("button", { name: "保存关联" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("工作区尚未就绪");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("offers a read-only scope rebind on a resolved Issue but hides related editing", () => {
  const resolved: IssueDetail = { ...issue, status: "resolved", resolvedAt: "2026-10-19T00:00:00Z", workspace: { ...issue.workspace, status: "stopped" } };
  render(() => <Workspace issue={resolved} onOpenSource={() => {}} onUpdated={async () => {}} onCreatedFollowUp={() => {}} />);
  expect(screen.getByRole("button", { name: "变更处理范围" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "编辑关联" })).toBeNull();
});

it("shows a readable message instead of a raw retry error code", async () => {
  const failed: IssueDetail = { ...issue, status: "open", workspace: { ...issue.workspace, status: "failed", retryable: true } };
  state.retry.mockRejectedValueOnce(new Error("issue_not_retryable"));
  render(() => <Workspace issue={failed} onOpenSource={() => {}} onUpdated={async () => {}} onCreatedFollowUp={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "重试处理" }));
  await screen.findByText("工单当前无需重试，请刷新查看最新状态。");
  expect(screen.queryByText("issue_not_retryable")).toBeNull();
});
