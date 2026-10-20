import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { issuePilotConfig } from "../../../../issue-pilot.config.ts";
import { createSignal } from "solid-js";
import type { IssueDetail, IssueScopeTransitionPlan } from "../data/client";

const state = vi.hoisted(() => ({ plan: vi.fn(), comment: vi.fn(), create: vi.fn(), user: () => ({ subject: "developer", role: "developer" }) }));
vi.mock("../data/client", async original => ({ ...await original<typeof import("../data/client")>(), planIssueScopeTransition: state.plan, addIssueComment: state.comment, createIssue: state.create }));
vi.mock("./ApplicationResources", () => ({ useApplicationResources: () => ({
  currentUser: () => state.user(), people: () => [], peopleError: () => "",
  catalog: () => ({ environments: [{ key: "prod", name: "正式" }, { key: "test", name: "测试" }], services: [
    { key: "orders", name: "Orders", deployments: [{ environmentKey: "prod" }, { environmentKey: "test" }] },
    { key: "inventory", name: "Inventory", deployments: [{ environmentKey: "test" }] },
  ] }),
}) }));
import { IssueWorkspace } from "./IssueWorkspace";

const issue: IssueDetail = { id: "ISSUE-20261018-001", title: "Synthetic scope", description: "", priority: "p2", type: "smart_analysis", status: "pending", assignee: null, assigneeSubject: null, service: { key: "orders", name: "Orders" }, environmentKey: "prod", updatedAt: "2026-10-18T00:00:00Z", repositories: [], workspace: { status: "ready", sourceAvailable: false }, attachments: [], outputs: [], comments: [] };
function plan(current: boolean): IssueScopeTransitionPlan {
  return { planHash: `sha256:${"a".repeat(64)}`, expectedIssueUpdatedAt: issue.updatedAt, action: "rebind_read_only", current: { service: issue.service, workMode: "production_analysis", repositoryAccess: "read" }, target: { service: current ? { key: "inventory", name: "Inventory" } : issue.service, workMode: current ? "test_analysis" : "production_analysis", repositoryAccess: "read" }, repositories: { retained: [], removed: [], added: [{ name: current ? "current-plan-repository" : "stale-plan-repository", url: "https://example.test/repo.git", baseBranch: "main" }] }, branch: null, session: { closeCurrent: true, preserveConversation: true }, preserved: ["attachments", "comments", "conversation"], warnings: [] };
}
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); state.user = () => ({ subject: "developer", role: "developer" }); });

it("preserves a newer comment draft while an earlier comment is being published", async () => {
  let finish!: () => void;
  state.comment.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  render(() => <IssueWorkspace issue={issue} onOpenSource={() => {}} onUpdated={async () => {}} onCreatedFollowUp={() => {}} />);
  const input = screen.getByLabelText("添加评论或备注");
  fireEvent.input(input, { target: { value: "first comment" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "发布评论" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "发布评论" }));
  await waitFor(() => expect(state.comment).toHaveBeenCalledWith(issue.id, "first comment"));
  fireEvent.input(input, { target: { value: "next unsaved comment" } });
  finish();
  await waitFor(() => expect(screen.getByRole("button", { name: "发布评论" })).toHaveProperty("disabled", false));
  expect(input).toHaveProperty("value", "next unsaved comment");
});

for (const outcome of ["success", "failure"] as const) it(`isolates the previous identity's comment ${outcome}`, async () => {
  const [user, setUser] = createSignal({ subject: "alice", role: "developer" }, { ownedWrite: true }); state.user = user;
  let finish!: () => void;
  state.comment.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { finish = outcome === "success" ? resolve : () => reject(new Error("old_comment_failed")); }));
  const updated = vi.fn(async () => {});
  render(() => <IssueWorkspace issue={issue} onOpenSource={() => {}} onUpdated={updated} onCreatedFollowUp={() => {}} />);
  fireEvent.input(screen.getByLabelText("添加评论或备注"), { target: { value: "alice comment" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "发布评论" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "发布评论" }));
  await waitFor(() => expect(state.comment).toHaveBeenCalledOnce());
  setUser({ subject: "bob", role: "developer" });
  await waitFor(() => expect(screen.getByLabelText("添加评论或备注")).toHaveProperty("value", ""));
  fireEvent.input(screen.getByLabelText("添加评论或备注"), { target: { value: "bob draft" } });
  finish();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(screen.getByLabelText("添加评论或备注")).toHaveProperty("value", "bob draft");
  expect(screen.queryByText("old_comment_failed")).toBeNull();
  expect(updated).not.toHaveBeenCalled();
});

it("keeps the comment draft when the same identity's profile refreshes", async () => {
  const initial = { subject: "alice", role: "developer", name: "Alice" };
  const [user, setUser] = createSignal(initial, { ownedWrite: true }); state.user = user;
  render(() => <IssueWorkspace issue={issue} onOpenSource={() => {}} onUpdated={async () => {}} onCreatedFollowUp={() => {}} />);
  const input = screen.getByLabelText("添加评论或备注");
  fireEvent.input(input, { target: { value: "unsaved comment" } });
  setUser({ ...initial, name: "Updated Alice" });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(input).toHaveProperty("value", "unsaved comment");
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

it("offers previews only for supported outputs and attachments", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"result":"previewed-json"}'));
  vi.stubGlobal("fetch", fetchMock);
  const detailed: IssueDetail = { ...issue, outputs: [
    { fileName: "delivery.xlsx", size: 512, updatedAt: issue.updatedAt },
    { fileName: "results.json", size: 30, updatedAt: issue.updatedAt },
    { fileName: "large.txt", size: issuePilotConfig.web.outputPreviewBytes + 1, updatedAt: issue.updatedAt },
  ], attachments: [
    { id: "workbook", fileName: "input.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 512, sha256: "a".repeat(64) },
    { id: "image", fileName: "image.png", mediaType: "image/png", size: 512, sha256: "a".repeat(64) },
    { id: "archive", fileName: "archive.zip", mediaType: "application/zip", size: 512, sha256: "a".repeat(64) },
  ] };
  render(() => <IssueWorkspace issue={detailed} onOpenSource={() => {}} onUpdated={async () => {}} onCreatedFollowUp={() => {}} />);
  for (const fileName of ["delivery.xlsx", "large.txt", "input.xlsx", "archive.zip"]) {
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
