import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import type { IssueDetail, IssueScopeTransitionPlan } from "../data/client";

const state = vi.hoisted(() => ({ plan: vi.fn(), create: vi.fn(), list: vi.fn(), user: () => ({ subject: "developer", role: "developer" }) }));
vi.mock("../data/client", async original => ({ ...await original<typeof import("../data/client")>(), planIssueScopeTransition: state.plan, createIssue: state.create, listIssues: state.list }));
vi.mock("./ApplicationResources", () => ({ useApplicationResources: () => ({
  currentUser: () => state.user(), people: () => [], peopleError: () => "",
  catalog: () => ({ environments: [{ key: "prod", name: "正式" }, { key: "test", name: "测试" }], services: [
    { key: "orders", name: "Orders", deployments: [{ environmentKey: "prod" }, { environmentKey: "test" }] },
    { key: "inventory", name: "Inventory", deployments: [{ environmentKey: "test" }] },
  ] }),
}) }));
import { IssueWorkspace } from "./IssueWorkspace";

const issue: IssueDetail = { id: "ISSUE-20261018-001", title: "Synthetic scope", description: "", priority: "p2", type: "smart_analysis", status: "pending", assignee: null, assigneeSubject: null, service: { key: "orders", name: "Orders" }, environmentKey: "prod", updatedAt: "2026-10-18T00:00:00Z", repositories: [], workspace: { status: "ready", sourceAvailable: false }, attachments: [], comments: [] };
function plan(current: boolean): IssueScopeTransitionPlan {
  return { planHash: `sha256:${"a".repeat(64)}`, expectedIssueUpdatedAt: issue.updatedAt, action: "rebind_read_only", current: { service: issue.service, workMode: "production_analysis", repositoryAccess: "read" }, target: { service: current ? { key: "inventory", name: "Inventory" } : issue.service, workMode: current ? "test_analysis" : "production_analysis", repositoryAccess: "read" }, repositories: { retained: [], removed: [], added: [{ name: current ? "current-plan-repository" : "stale-plan-repository", url: "https://example.test/repo.git", baseBranch: "main" }] }, branch: null, session: { closeCurrent: true, preserveConversation: true }, preserved: ["attachments", "comments", "conversation"], warnings: [] };
}
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); state.user = () => ({ subject: "developer", role: "developer" }); });

for (const outcome of ["success", "failure"] as const) for (const currentPending of [false, true]) it(`ignores a closed related editor's ${outcome} while the new load is ${currentPending ? "pending" : "complete"}`, async () => {
  let finishOld!: () => void, finishCurrent!: () => void;
  const candidates = (count: number) => Array.from({ length: count }, (_, index) => ({ ...issue, id: `ISSUE-20261017-00${index + 1}`, workspaceStatus: "ready", agentRunning: false, resolvedAt: null }));
  state.list.mockImplementationOnce(() => new Promise((resolve, reject) => {
    finishOld = outcome === "success" ? () => resolve(candidates(1)) : () => reject(new Error("closed_related_load_failed"));
  }));
  state.list.mockImplementationOnce(() => new Promise(resolve => { finishCurrent = () => resolve(candidates(2)); }));
  render(() => <IssueWorkspace issue={issue} onOpenSource={() => {}} onUpdated={async () => {}} onCreatedFollowUp={() => {}} />);
  try {
    fireEvent.click(screen.getByRole("button", { name: "编辑关联" }));
    const old = await screen.findByRole("dialog", { name: "编辑关联工单" });
    await waitFor(() => expect(state.list).toHaveBeenCalledOnce());
    fireEvent.click(within(old).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑关联工单" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "编辑关联" }));
    const current = await screen.findByRole("dialog", { name: "编辑关联工单" });
    await waitFor(() => expect(state.list).toHaveBeenCalledTimes(2));
    if (!currentPending) { finishCurrent(); await within(current).findByText("关联工单（2 个可选，最多选择 20 个）"); }
    finishOld(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.queryByText("closed_related_load_failed")).toBeNull();
    expect(within(current).queryByText("关联工单（1 个可选，最多选择 20 个）")).toBeNull();
    expect(within(current).getByRole("button", { name: "保存关联" })).toHaveProperty("disabled", currentPending);
    if (currentPending) finishCurrent();
    await within(current).findByText("关联工单（2 个可选，最多选择 20 个）");
  } finally { finishOld?.(); finishCurrent?.(); }
});

it("explains why queued intent from an earlier scope was not replayed", () => {
  const failed: IssueDetail = { ...issue, status: "open", workspace: { ...issue.workspace, status: "failed", retryable: true, lastError: "agent_message_scope_changed" } };
  render(() => <IssueWorkspace issue={failed} onOpenSource={() => {}} onUpdated={async () => {}} onCreatedFollowUp={() => {}} />);
  expect(screen.getByRole("alert").textContent).toBe("历史排队消息的处理范围已变更，已停止恢复。请核对历史输入后重试，或按当前范围重新发送。");
  expect(screen.getByRole("button", { name: "重试处理" })).toBeTruthy();
});

it("offers an explicit retry after a failed model response", () => {
  const failed: IssueDetail = { ...issue, status: "open", workspace: { ...issue.workspace, status: "failed", retryable: true, lastError: "model_response_failed" } };
  render(() => <IssueWorkspace issue={failed} onOpenSource={() => {}} onUpdated={async () => {}} onCreatedFollowUp={() => {}} />);
  expect(screen.getByRole("alert").textContent).toBe("模型响应中断，处理未完成。已有对话和文件已保留，请核对结果后重试处理。");
  expect(screen.getByRole("button", { name: "重试处理" })).toBeTruthy();
  expect(screen.queryByText("确认解决")).toBeNull();
});

it("shows related Issue handler, status, service and environment with a navigable card", async () => {
  const open = vi.fn();
  const related = { ...issue, id: "ISSUE-20261017-002", assignee: "处理人甲", assigneeSubject: "handler", workspaceStatus: "ready" as const, agentRunning: false, resolvedAt: null };
  const unassigned = { ...related, id: "ISSUE-20261017-003", assignee: null, assigneeSubject: null };
  const detailed = { ...issue, description: "[诊断日志](work/diagnostics.log)", relatedIssues: [related, unassigned] };
  render(() => <IssueWorkspace issue={detailed} onOpenIssue={open} onOpenSource={() => {}} onUpdated={async () => {}} onCreatedFollowUp={() => {}} />);
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
  expect(screen.getByRole("link", { name: "诊断日志" }).getAttribute("href")).toBe(`/api/issues/${issue.id}/files/download?path=diagnostics.log`);
  fireEvent.click(link);
  expect(open).toHaveBeenCalledWith(related.id);
});

it("omits comments and places attachments immediately after the Issue header", () => {
  render(() => <IssueWorkspace issue={issue} onOpenSource={() => {}} onUpdated={async () => {}} onCreatedFollowUp={() => {}} />);
  expect(screen.queryByRole("heading", { name: "评论与备注" })).toBeNull();
  expect(screen.queryByLabelText("添加评论或备注")).toBeNull();
  const header = document.querySelector(".issue-header")!;
  expect(header.nextElementSibling?.getAttribute("aria-labelledby")).toBe("attachments-title");
});

it("does not navigate to a follow-up created after the workspace unmounts", async () => {
  let finish!: () => void;
  state.create.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ id: "ISSUE-20261018-999" }); }));
  const created = vi.fn();
  const development: IssueDetail = { ...issue, environmentKey: "dev", type: "defect_fix", workspace: { status: "ready", sourceAvailable: true } };
  const view = render(() => <IssueWorkspace issue={development} onOpenSource={() => {}} onUpdated={async () => {}} onCreatedFollowUp={created} />);
  fireEvent.click(screen.getByRole("button", { name: "创建正式跟进" }));
  const dialog = await screen.findByRole("dialog", { name: "创建正式跟进工单" });
  fireEvent.click(within(dialog).getByRole("button", { name: "创建并关联" }));
  await waitFor(() => expect(state.create).toHaveBeenCalledOnce());
  view.unmount(); finish();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(created).not.toHaveBeenCalled();
});

it("offers previews for supported attachments", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"result":"previewed-json"}'));
  vi.stubGlobal("fetch", fetchMock);
  const detailed: IssueDetail = { ...issue, attachments: [
    { id: "text", fileName: "results.json", mediaType: "application/json", size: 30, sha256: "a".repeat(64) },
    { id: "workbook", fileName: "input.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 512, sha256: "a".repeat(64) },
    { id: "image", fileName: "image.png", mediaType: "image/png", size: 512, sha256: "a".repeat(64) },
    { id: "archive", fileName: "archive.zip", mediaType: "application/zip", size: 512, sha256: "a".repeat(64) },
  ] };
  render(() => <IssueWorkspace issue={detailed} onOpenSource={() => {}} onUpdated={async () => {}} onCreatedFollowUp={() => {}} />);
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

for (const outcome of ["success", "failure"] as const) it(`ignores a scope plan's ${outcome} after the target changes`, async () => {
  let finish!: () => void;
  state.plan.mockImplementationOnce(() => new Promise<IssueScopeTransitionPlan>((resolve, reject) => { finish = outcome === "success" ? () => resolve(plan(false)) : () => reject(new Error("stale_plan_failed")); }));
  state.plan.mockResolvedValueOnce(plan(true));
  render(() => <IssueWorkspace issue={issue} onOpenSource={() => {}} onUpdated={async () => {}} onCreatedFollowUp={() => {}} />);
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
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(within(dialog).queryByRole("region", { name: "范围变更预览" })).toBeNull();
    expect(screen.queryByText("stale_plan_failed")).toBeNull();
    const button = within(dialog).getByRole("button", { name: "预检变更" });
    await waitFor(() => expect(button).toHaveProperty("disabled", false));
    fireEvent.click(button);
    await within(dialog).findByText("新增 · current-plan-repository");
    expect(state.plan).toHaveBeenLastCalledWith(issue.id, { serviceKey: "inventory", workMode: "test_analysis" });
  } finally { finish?.(); }
});
