import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IssueExecutionItem } from "../data/client";

const mocks = vi.hoisted(() => ({ pin: vi.fn(), create: vi.fn(), list: vi.fn() }));
vi.mock("../data/client", async original => ({
  ...await original<typeof import("../data/client")>(),
  listIssues: mocks.list,
  listIssuePins: async () => [],
  setIssuePinned: mocks.pin,
  createIssue: mocks.create,
}));
vi.mock("./ApplicationResources", () => ({ useApplicationResources: () => ({
  catalog: () => ({ services: [{ key: "orders", name: "Orders", deployments: [{ environmentKey: "prod" }] }], environments: [{ key: "prod", name: "正式" }] }), people: () => [], currentUser: () => ({ subject: "alice", role: "developer" }), catalogError: () => "", peopleError: () => "",
}) }));
import { IssueQueue } from "./IssueQueue";

const rows = (): IssueExecutionItem[] => ["alice", "bob"].map(subject => ({ id: subject, title: `${subject} task`, assignee: subject, assigneeSubject: subject, service: { key: "orders", name: "Orders" }, environmentKey: "test", type: "smart_analysis", status: "open", priority: "p2", updatedAt: new Date().toISOString(), workspaceStatus: "ready", agentRunning: false, resolvedAt: null }));
beforeEach(() => { mocks.list.mockImplementation(async () => rows()); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("waits for an identity before opening the creation dialog", async () => {
  const [subject, setSubject] = createSignal("", { ownedWrite: true });
  render(() => <IssueQueue selectedId="" userSubject={subject()} refreshToken={0} onSelect={() => {}} />);
  const create = screen.getByRole("button", { name: "新建工单" });
  expect(create).toHaveProperty("disabled", true);
  fireEvent.click(create);
  expect(screen.queryByRole("dialog", { name: "新建工单" })).toBeNull();
  setSubject("alice");
  await waitFor(() => expect(create).toHaveProperty("disabled", false));
  fireEvent.click(create);
  await screen.findByRole("dialog", { name: "新建工单" });
});

for (const outcome of ["success", "failure"] as const) it(`ignores related-candidate ${outcome} after the creation dialog is reopened`, async () => {
  let finishOld!: () => void, finishCurrent!: () => void;
  mocks.list.mockResolvedValueOnce(rows());
  mocks.list.mockImplementationOnce(() => new Promise((resolve, reject) => { finishOld = outcome === "success" ? () => resolve(rows().slice(0, 1)) : () => reject(new Error("closed_candidate_load_failed")); }));
  mocks.list.mockImplementationOnce(() => new Promise(resolve => { finishCurrent = () => resolve(rows()); }));
  render(() => <IssueQueue selectedId="alice" userSubject="alice" refreshToken={0} onSelect={() => {}} />);
  await screen.findByText("alice task");
  fireEvent.click(screen.getByRole("button", { name: "新建工单" }));
  const first = await screen.findByRole("dialog", { name: "新建工单" });
  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
  fireEvent.click(within(first).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "新建工单" })).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "新建工单" }));
  const current = await screen.findByRole("dialog", { name: "新建工单" });
  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3));
  finishOld(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(within(current).getByText("关联工单（可多选，共 0 个）")).toBeTruthy();
  expect(screen.queryByText("closed_candidate_load_failed")).toBeNull();
  finishCurrent();
  await within(current).findByText("关联工单（可多选，共 2 个）");
});

it("keeps a newly created Issue when an older initial list finishes later", async () => {
  let finishOld!: () => void;
  const created = { ...rows()[0]!, id: "created", title: "newly created issue" };
  mocks.list.mockImplementationOnce(() => new Promise(resolve => { finishOld = () => resolve(rows()); }));
  mocks.list.mockResolvedValueOnce([]).mockResolvedValueOnce([...rows(), created]);
  mocks.create.mockResolvedValueOnce(created);
  const [selected, setSelected] = createSignal("", { ownedWrite: true });
  render(() => <IssueQueue selectedId={selected()} userSubject="alice" refreshToken={0} onSelect={setSelected} />);
  try {
    fireEvent.click(screen.getByRole("button", { name: "新建工单" }));
    const dialog = await screen.findByRole("dialog", { name: "新建工单" });
    fireEvent.input(within(dialog).getByLabelText("工单标题"), { target: { value: created.title } });
    const save = within(dialog).getByRole("button", { name: "创建" });
    await waitFor(() => expect(save).toHaveProperty("disabled", false));
    fireEvent.click(save);
    await screen.findByText(created.title);
    finishOld(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.getByText(created.title)).toBeTruthy();
    expect(selected()).toBe(created.id);
  } finally { finishOld(); }
});

it("does not select an Issue created after the queue unmounts", async () => {
  let finish!: () => void;
  mocks.create.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ id: "late-created" }); }));
  const selected = vi.fn();
  const view = render(() => <IssueQueue selectedId="alice" userSubject="alice" refreshToken={0} onSelect={selected} />);
  fireEvent.click(screen.getByRole("button", { name: "新建工单" }));
  const dialog = await screen.findByRole("dialog", { name: "新建工单" });
  fireEvent.input(within(dialog).getByLabelText("工单标题"), { target: { value: "pending creation" } });
  const save = within(dialog).getByRole("button", { name: "创建" });
  await waitFor(() => expect(save).toHaveProperty("disabled", false));
  fireEvent.click(save); await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
  view.unmount(); selected.mockClear(); finish();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(selected).not.toHaveBeenCalled();
});

for (const outcome of ["success", "failure"] as const) it(`keeps a new identity's creation pending after the old creation ${outcome}`, async () => {
  let finishOld!: () => void, finishCurrent!: () => void;
  mocks.create.mockImplementationOnce(() => new Promise((resolve, reject) => { finishOld = outcome === "success" ? () => resolve({ id: "old-created", assigneeSubject: "alice" }) : () => reject(new Error("old_creation_failed")); }));
  mocks.create.mockImplementationOnce(() => new Promise(resolve => { finishCurrent = () => resolve({ id: "bob-created", title: "bob creation", assigneeSubject: "bob", priority: "p2", status: "open", service: { key: "orders", name: "Orders" }, environmentKey: "prod", updatedAt: new Date().toISOString() }); }));
  const [subject, setSubject] = createSignal("alice", { ownedWrite: true });
  const selected = vi.fn();
  render(() => <IssueQueue selectedId="" userSubject={subject()} refreshToken={0} onSelect={selected} />);
  fireEvent.click(screen.getByRole("button", { name: "新建工单" }));
  const old = await screen.findByRole("dialog", { name: "新建工单" });
  fireEvent.input(within(old).getByLabelText("工单标题"), { target: { value: "alice creation" } });
  const firstSave = within(old).getByRole("button", { name: "创建" });
  await waitFor(() => expect(firstSave).toHaveProperty("disabled", false));
  fireEvent.click(firstSave);
  await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
  setSubject("bob");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "新建工单" })).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "新建工单" }));
  const current = await screen.findByRole("dialog", { name: "新建工单" });
  expect(within(current).getByLabelText("工单标题")).toHaveProperty("value", "");
  fireEvent.input(within(current).getByLabelText("工单标题"), { target: { value: "bob creation" } });
  const currentSave = within(current).getByRole("button", { name: "创建" });
  await waitFor(() => expect(currentSave).toHaveProperty("disabled", false));
  fireEvent.click(currentSave);
  await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
  finishOld();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(screen.getByRole("dialog", { name: "新建工单" })).toBeTruthy();
  expect(currentSave).toHaveProperty("disabled", true);
  expect(screen.queryByText("old_creation_failed")).toBeNull();
  expect(selected).not.toHaveBeenCalledWith("old-created");
  finishCurrent();
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "新建工单" })).toBeNull());
  expect(selected).toHaveBeenCalledWith("bob-created");
});

for (const outcome of ["success", "failure"] as const) it(`ignores an old identity's pin ${outcome} while the current identity has a pending pin`, async () => {
  let finishOld!: () => void, finishCurrent!: () => void;
  mocks.pin.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { finishOld = outcome === "success" ? resolve : () => reject(new Error("old_identity_pin_failed")); }));
  mocks.pin.mockImplementationOnce(() => new Promise<void>(resolve => { finishCurrent = resolve; }));
  const [subject, setSubject] = createSignal("alice", { ownedWrite: true });
  render(() => <IssueQueue selectedId="" userSubject={subject()} refreshToken={0} onSelect={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "固定 alice" }));
  setSubject("bob");
  const button = await screen.findByRole("button", { name: "固定 bob" });
  fireEvent.click(button);
  await waitFor(() => expect(mocks.pin).toHaveBeenCalledTimes(2));
  finishOld();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(button).toHaveProperty("disabled", true);
  expect(screen.queryByText("old_identity_pin_failed")).toBeNull();
  finishCurrent();
  await screen.findByRole("button", { name: "取消固定 bob" });
});
