import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IssueExecutionItem } from "../data/client";

const mocks = vi.hoisted(() => ({ pins: vi.fn(), pin: vi.fn(), create: vi.fn(), list: vi.fn() }));
vi.mock("../data/client", async (original) => ({
  ...(await original<typeof import("../data/client")>()),
  listIssues: mocks.list,
  listIssuePins: mocks.pins,
  setIssuePinned: mocks.pin,
  createIssue: mocks.create,
}));
vi.mock("./ApplicationResources", () => ({
  useApplicationResources: () => ({
    catalog: () => ({ services: [{ key: "orders", name: "Orders", deployments: [{ environmentKey: "prod" }] }], environments: [{ key: "prod", name: "正式" }] }),
    people: () => [],
    currentUser: () => ({ subject: "alice", role: "developer" }),
    catalogError: () => "",
    peopleError: () => "",
  }),
}));
import { IssueQueue } from "./IssueQueue";

const rows = (): IssueExecutionItem[] =>
  ["alice", "bob"].map((subject) => ({
    id: subject,
    title: `${subject} task`,
    assignee: subject,
    assigneeSubject: subject,
    service: { key: "orders", name: "Orders" },
    environmentKey: "test",
    type: "smart_analysis",
    status: "open",
    priority: "p2",
    updatedAt: new Date().toISOString(),
    workspaceStatus: "ready",
    agentRunning: false,
    resolvedAt: null,
  }));
beforeEach(() => {
  mocks.pins.mockResolvedValue([]);
  mocks.list.mockImplementation(async () => rows());
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("keeps original order within pinned and ordinary groups through pinning and filtering", async () => {
  const base = rows()[0]!;
  mocks.list.mockResolvedValue([
    { ...base, id: "first", title: "first task" },
    { ...base, id: "second", title: "second task", status: "pending" },
    { ...base, id: "other-owner", title: "other task", assigneeSubject: "bob" },
    { ...base, id: "third", title: "third task" },
    { ...base, id: "fourth", title: "fourth task", status: "resolved" },
  ]);
  // Pin preference order must not become a new within-group sort order.
  mocks.pins.mockResolvedValue(["fourth", "other-owner", "second"]);
  mocks.pin.mockResolvedValue(undefined);
  render(() => <IssueQueue selectedId="" userSubject="alice" refreshToken={0} onSelect={() => {}} />);
  const order = () => screen.getAllByRole("listitem").map((item) => item.querySelector(".issue-key")?.textContent);
  await waitFor(() => expect(order()).toEqual(["second", "fourth", "first", "third"]));
  expect(screen.queryByText("other task")).toBeNull();
  await waitFor(() => expect(screen.getByRole("button", { name: "固定 third" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "固定 third" }));
  await waitFor(() => expect(order()).toEqual(["second", "third", "fourth", "first"]));
  fireEvent.click(screen.getByRole("button", { name: "取消固定 second" }));
  await waitFor(() => expect(order()).toEqual(["third", "fourth", "first", "second"]));
  await fireEvent.input(screen.getByLabelText("搜索工单"), { target: { value: "fourth" } });
  await waitFor(() => expect(order()).toEqual(["fourth"]));
  await fireEvent.input(screen.getByLabelText("搜索工单"), { target: { value: "" } });
  await waitFor(() => expect(order()).toEqual(["third", "fourth", "first", "second"]));
  fireEvent.click(screen.getByLabelText("按状态筛选"));
  fireEvent.click(await screen.findByRole("option", { name: "未解决" }));
  await waitFor(() => expect(order()).toEqual(["third", "first", "second"]));
});

it("waits for saved pin preferences before changing an Issue's pin", async () => {
  let finish!: (pins: string[]) => void;
  mocks.pins.mockReturnValueOnce(
    new Promise<string[]>((resolve) => {
      finish = resolve;
    }),
  );
  mocks.pin.mockResolvedValue(undefined);
  render(() => <IssueQueue selectedId="alice" userSubject="alice" refreshToken={0} onSelect={() => {}} />);
  const pending = await screen.findByRole("button", { name: "固定 alice" });
  fireEvent.click(pending);
  expect(mocks.pin).not.toHaveBeenCalled();
  expect(pending).toHaveProperty("disabled", true);
  finish(["alice"]);
  const loaded = await screen.findByRole("button", { name: "取消固定 alice" });
  await waitFor(() => expect(loaded).toHaveProperty("disabled", false));
  fireEvent.click(loaded);
  await waitFor(() => expect(mocks.pin).toHaveBeenCalledWith("alice", false));
  await screen.findByRole("button", { name: "固定 alice" });
});

it("allows a new pin preference after the initial preferences fail to load", async () => {
  let fail!: (error: Error) => void;
  mocks.pins.mockReturnValueOnce(
    new Promise<string[]>((_resolve, reject) => {
      fail = reject;
    }),
  );
  mocks.pin.mockResolvedValue(undefined);
  render(() => <IssueQueue selectedId="alice" userSubject="alice" refreshToken={0} onSelect={() => {}} />);
  const pending = await screen.findByRole("button", { name: "固定 alice" });
  expect(pending).toHaveProperty("disabled", true);
  fail(new Error("pin_preferences_unavailable"));
  await screen.findByText("pin_preferences_unavailable");
  await waitFor(() => expect(pending).toHaveProperty("disabled", false));
  fireEvent.click(pending);
  await waitFor(() => expect(mocks.pin).toHaveBeenCalledWith("alice", true));
  await screen.findByRole("button", { name: "取消固定 alice" });
});

it("does not release a new identity's pin controls when the old preferences load", async () => {
  let finishOld!: (pins: string[]) => void, finishCurrent!: (pins: string[]) => void;
  mocks.pins.mockReturnValueOnce(
    new Promise<string[]>((resolve) => {
      finishOld = resolve;
    }),
  );
  mocks.pins.mockReturnValueOnce(
    new Promise<string[]>((resolve) => {
      finishCurrent = resolve;
    }),
  );
  const [subject, setSubject] = createSignal("alice", { ownedWrite: true });
  render(() => <IssueQueue selectedId="" userSubject={subject()} refreshToken={0} onSelect={() => {}} />);
  await screen.findByRole("button", { name: "固定 alice" });
  setSubject("bob");
  const current = await screen.findByRole("button", { name: "固定 bob" });
  finishOld(["alice"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(current).toHaveProperty("disabled", true);
  finishCurrent(["bob"]);
  await waitFor(() => expect(screen.getByRole("button", { name: "取消固定 bob" })).toHaveProperty("disabled", false));
});

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

for (const outcome of ["success", "failure"] as const)
  it(`ignores related-candidate ${outcome} after the creation dialog is reopened`, async () => {
    let finishOld!: () => void, finishCurrent!: () => void;
    mocks.list.mockResolvedValueOnce(rows());
    mocks.list.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finishOld = outcome === "success" ? () => resolve(rows().slice(0, 1)) : () => reject(new Error("closed_candidate_load_failed"));
        }),
    );
    mocks.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCurrent = () => resolve(rows());
        }),
    );
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
    finishOld();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(within(current).getByText("关联工单（0 个）")).toBeTruthy();
    expect(screen.queryByText("closed_candidate_load_failed")).toBeNull();
    finishCurrent();
    await within(current).findByText("关联工单（2 个）");
  });

it("keeps a newly created Issue when an older initial list finishes later", async () => {
  let finishOld!: () => void;
  const created = { ...rows()[0]!, id: "created", title: "newly created issue" };
  mocks.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishOld = () => resolve(rows());
      }),
  );
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
    finishOld();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText(created.title)).toBeTruthy();
    expect(selected()).toBe(created.id);
  } finally {
    finishOld();
  }
});

it("does not select an Issue created after the queue unmounts", async () => {
  let finish!: () => void;
  mocks.create.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ id: "late-created" });
      }),
  );
  const selected = vi.fn();
  const view = render(() => <IssueQueue selectedId="alice" userSubject="alice" refreshToken={0} onSelect={selected} />);
  fireEvent.click(screen.getByRole("button", { name: "新建工单" }));
  const dialog = await screen.findByRole("dialog", { name: "新建工单" });
  fireEvent.input(within(dialog).getByLabelText("工单标题"), { target: { value: "pending creation" } });
  const save = within(dialog).getByRole("button", { name: "创建" });
  await waitFor(() => expect(save).toHaveProperty("disabled", false));
  fireEvent.click(save);
  await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
  view.unmount();
  selected.mockClear();
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(selected).not.toHaveBeenCalled();
});

for (const outcome of ["success", "failure"] as const)
  it(`keeps a new identity's creation pending after the old creation ${outcome}`, async () => {
    let finishOld!: () => void, finishCurrent!: () => void;
    mocks.create.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finishOld = outcome === "success" ? () => resolve({ id: "old-created", assigneeSubject: "alice" }) : () => reject(new Error("old_creation_failed"));
        }),
    );
    mocks.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCurrent = () =>
            resolve({
              id: "bob-created",
              title: "bob creation",
              assigneeSubject: "bob",
              priority: "p2",
              status: "open",
              service: { key: "orders", name: "Orders" },
              environmentKey: "prod",
              updatedAt: new Date().toISOString(),
            });
        }),
    );
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole("dialog", { name: "新建工单" })).toBeTruthy();
    expect(currentSave).toHaveProperty("disabled", true);
    expect(screen.queryByText("old_creation_failed")).toBeNull();
    expect(selected).not.toHaveBeenCalledWith("old-created");
    finishCurrent();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "新建工单" })).toBeNull());
    expect(selected).toHaveBeenCalledWith("bob-created");
  });

for (const outcome of ["success", "failure"] as const)
  it(`ignores an old identity's pin ${outcome} while the current identity has a pending pin`, async () => {
    let finishOld!: () => void, finishCurrent!: () => void;
    mocks.pin.mockImplementationOnce(
      () =>
        new Promise<void>((resolve, reject) => {
          finishOld = outcome === "success" ? resolve : () => reject(new Error("old_identity_pin_failed"));
        }),
    );
    mocks.pin.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishCurrent = resolve;
        }),
    );
    const [subject, setSubject] = createSignal("alice", { ownedWrite: true });
    render(() => <IssueQueue selectedId="" userSubject={subject()} refreshToken={0} onSelect={() => {}} />);
    const previous = await screen.findByRole("button", { name: "固定 alice" });
    await waitFor(() => expect(previous).toHaveProperty("disabled", false));
    fireEvent.click(previous);
    setSubject("bob");
    const button = await screen.findByRole("button", { name: "固定 bob" });
    await waitFor(() => expect(button).toHaveProperty("disabled", false));
    fireEvent.click(button);
    await waitFor(() => expect(mocks.pin).toHaveBeenCalledTimes(2));
    finishOld();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(button).toHaveProperty("disabled", true);
    expect(screen.queryByText("old_identity_pin_failed")).toBeNull();
    finishCurrent();
    await screen.findByRole("button", { name: "取消固定 bob" });
  });
