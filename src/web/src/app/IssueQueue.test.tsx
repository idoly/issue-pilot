import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IssueExecutionItem } from "../data/client";

const mocks = vi.hoisted(() => ({
  pins: vi.fn<typeof import("../data/client").listIssuePins>(),
  pin: vi.fn<typeof import("../data/client").setIssuePinned>(),
  create: vi.fn<typeof import("../data/client").createIssue>(),
  list: vi.fn<typeof import("../data/client").listIssues>(),
}));
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
import { createIssueList, type QueueScope } from "./issue-list";
import { settle } from "../test-settle";

function Queue(props: Omit<Parameters<typeof IssueQueue>[0], "issueList" | "scope" | "onScopeChange">) {
  const issueList = createIssueList();
  const [scope, setScope] = createSignal<QueueScope>("assigned", { ownedWrite: true });
  return <IssueQueue {...props} issueList={issueList} scope={scope()} onScopeChange={setScope} />;
}

const rows = (): IssueExecutionItem[] =>
  ["alice", "bob"].map((subject) => ({
    id: subject,
    title: `${subject} task`,
    assignee: subject,
    assigneeSubject: subject,
    reporterSubject: "reporter",
    ccSubjects: [],
    service: { key: "orders", name: "Orders" },
    environmentKey: "test",
    type: "smart_analysis",
    status: "open",
    priority: "p2",
    revision: `${subject}:1`,
    createdAt: new Date().toISOString(),
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
  vi.useRealTimers();
  vi.resetAllMocks();
});

for (const change of ["status", "assignee", "title"] as const)
  it(`preserves selection when a background ${change} change excludes it from the queue filter`, async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let items = [rows()[0]!, { ...rows()[0]!, id: "second", title: "second task" }];
    mocks.list.mockImplementation(async () => items);
    const [selected, setSelected] = createSignal("alice", { ownedWrite: true });
    const select = vi.fn<(key: string) => void>(setSelected);
    render(() => <Queue selectedId={selected()} userSubject="alice" onSelect={select} />);
    await screen.findByText("alice task");
    fireEvent.click(screen.getByLabelText("按状态筛选"));
    fireEvent.click(await screen.findByRole("option", { name: "未解决" }));
    fireEvent.input(screen.getByLabelText("搜索工单"), { target: { value: "task" } });
    const updates = { status: { status: "resolved" as const }, assignee: { assigneeSubject: "bob" }, title: { title: "renamed" } };
    items = [{ ...items[0]!, ...updates[change] }, items[1]!];
    select.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    await waitFor(() => expect(screen.queryByText("alice task")).toBeNull());
    expect(select).not.toHaveBeenCalled();
    expect(selected()).toBe("alice");
    // An explicit filter change can still select the first matching Issue.
    fireEvent.input(screen.getByLabelText("搜索工单"), { target: { value: "second" } });
    await waitFor(() => expect(selected()).toBe("second"));
  });

it("shows a failed or running execution ahead of the business status", async () => {
  const [alice] = rows();
  mocks.list.mockResolvedValue([
    { ...alice!, workspaceStatus: "failed" },
    { ...alice!, id: "running", title: "running task", agentRunning: true },
    { ...alice!, id: "resolved", title: "resolved task", status: "resolved", workspaceStatus: "failed", resolvedAt: new Date().toISOString() },
  ]);
  render(() => <Queue selectedId="alice" userSubject="alice" onSelect={() => {}} />);
  await screen.findByText("alice task");
  fireEvent.click(screen.getByLabelText("按状态筛选"));
  fireEvent.click(await screen.findByRole("option", { name: "全部工单" }));
  const badge = async (title: string) => (await screen.findByText(title)).closest("[role=listitem]")!.querySelector(".queue-status")!.textContent;
  expect(await badge("alice task")).toBe("执行失败");
  expect(await badge("running task")).toBe("执行中");
  // A resolved Issue keeps its business status even if its last Workspace operation failed.
  expect(await badge("resolved task")).toBe("已解决");
});

it("changes selection for an explicit identity change and for a removed Issue", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let items = rows();
  mocks.list.mockImplementation(async () => items);
  const [selected, setSelected] = createSignal("alice", { ownedWrite: true });
  const [subject, setSubject] = createSignal("alice", { ownedWrite: true });
  render(() => <Queue selectedId={selected()} userSubject={subject()} onSelect={setSelected} />);
  await screen.findByText("alice task");
  setSubject("bob");
  await waitFor(() => expect(selected()).toBe("bob"));
  items = items.filter((item) => item.id !== "bob");
  await vi.advanceTimersByTimeAsync(10_000);
  await waitFor(() => expect(selected()).toBe(""));
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
  render(() => <Queue selectedId="" userSubject="alice" onSelect={() => {}} />);
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
  render(() => <Queue selectedId="alice" userSubject="alice" onSelect={() => {}} />);
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
  render(() => <Queue selectedId="alice" userSubject="alice" onSelect={() => {}} />);
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
  render(() => <Queue selectedId="" userSubject={subject()} onSelect={() => {}} />);
  await screen.findByRole("button", { name: "固定 alice" });
  setSubject("bob");
  const current = await screen.findByRole("button", { name: "固定 bob" });
  finishOld(["alice"]);
  await settle();
  expect(current).toHaveProperty("disabled", true);
  finishCurrent(["bob"]);
  await waitFor(() => expect(screen.getByRole("button", { name: "取消固定 bob" })).toHaveProperty("disabled", false));
});

it("waits for an identity before opening the creation dialog", async () => {
  const [subject, setSubject] = createSignal("", { ownedWrite: true });
  render(() => <Queue selectedId="" userSubject={subject()} onSelect={() => {}} />);
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
    render(() => <Queue selectedId="alice" userSubject="alice" onSelect={() => {}} />);
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
    await settle();
    // Candidates are the shared list: the superseded refresh neither replaces nor clears it.
    expect(within(current).getByText("关联工单（2 个）")).toBeTruthy();
    expect(screen.queryByText("closed_candidate_load_failed")).toBeNull();
    finishCurrent();
    await waitFor(() => expect(within(current).getByText("关联工单（2 个）")).toBeTruthy());
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
  render(() => <Queue selectedId={selected()} userSubject="alice" onSelect={setSelected} />);
  try {
    fireEvent.click(screen.getByRole("button", { name: "新建工单" }));
    const dialog = await screen.findByRole("dialog", { name: "新建工单" });
    fireEvent.input(within(dialog).getByLabelText("工单标题"), { target: { value: created.title } });
    const save = within(dialog).getByRole("button", { name: "创建" });
    await waitFor(() => expect(save).toHaveProperty("disabled", false));
    fireEvent.click(save);
    await screen.findByText(created.title);
    finishOld();
    await settle();
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
        finish = () => resolve({ ...rows()[0]!, id: "late-created" });
      }),
  );
  const selected = vi.fn<(key: string) => void>();
  const view = render(() => <Queue selectedId="alice" userSubject="alice" onSelect={selected} />);
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
  await settle();
  expect(selected).not.toHaveBeenCalled();
});

for (const outcome of ["success", "failure"] as const)
  it(`keeps a new identity's creation pending after the old creation ${outcome}`, async () => {
    let finishOld!: () => void, finishCurrent!: () => void;
    mocks.create.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finishOld = outcome === "success" ? () => resolve({ ...rows()[0]!, id: "old-created", assigneeSubject: "alice" }) : () => reject(new Error("old_creation_failed"));
        }),
    );
    mocks.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCurrent = () =>
            resolve({
              ...rows()[1]!,
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
    const selected = vi.fn<(key: string) => void>();
    render(() => <Queue selectedId="" userSubject={subject()} onSelect={selected} />);
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
    await settle();
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
    render(() => <Queue selectedId="" userSubject={subject()} onSelect={() => {}} />);
    const previous = await screen.findByRole("button", { name: "固定 alice" });
    await waitFor(() => expect(previous).toHaveProperty("disabled", false));
    fireEvent.click(previous);
    setSubject("bob");
    const button = await screen.findByRole("button", { name: "固定 bob" });
    await waitFor(() => expect(button).toHaveProperty("disabled", false));
    fireEvent.click(button);
    await waitFor(() => expect(mocks.pin).toHaveBeenCalledTimes(2));
    finishOld();
    await settle();
    expect(button).toHaveProperty("disabled", true);
    expect(screen.queryByText("old_identity_pin_failed")).toBeNull();
    finishCurrent();
    await screen.findByRole("button", { name: "取消固定 bob" });
  });

it("filters by assigned, reported, CC and all scopes while keeping pins assignee-only", async () => {
  const base = rows()[0]!;
  mocks.list.mockResolvedValue([
    { ...base, id: "assigned", title: "assigned task" },
    { ...base, id: "reported", title: "reported task", assigneeSubject: "bob", reporterSubject: "alice" },
    { ...base, id: "copied", title: "copied task", assigneeSubject: null, ccSubjects: ["alice", "carol"] },
    { ...base, id: "unrelated", title: "unrelated task", assigneeSubject: null },
  ]);
  render(() => <Queue selectedId="" keepExternalSelection userSubject="alice" onSelect={() => {}} />);
  const titles = () => screen.getAllByRole("listitem").map((item) => item.querySelector(".queue-title")?.textContent);
  // The default scope preserves the previous assignee-only queue.
  await waitFor(() => expect(titles()).toEqual(["assigned task"]));
  const choose = async (label: string) => {
    fireEvent.click(screen.getByLabelText("按范围筛选"));
    fireEvent.click(await screen.findByRole("option", { name: label }));
  };
  await choose("我报告的");
  await waitFor(() => expect(titles()).toEqual(["reported task"]));
  expect(screen.queryByRole("button", { name: "固定 reported" })).toBeNull();
  await choose("抄送我的");
  await waitFor(() => expect(titles()).toEqual(["copied task"]));
  await choose("全部");
  await waitFor(() => expect(titles()).toEqual(["assigned task", "reported task", "copied task", "unrelated task"]));
  // Unassigned and other people's Issues are visible but cannot be pinned by the current user.
  expect(screen.getByRole("button", { name: "固定 assigned" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "固定 unrelated" })).toBeNull();
});

it("reveals an external selection by widening to a scope that contains it", async () => {
  const base = rows()[0]!;
  mocks.list.mockResolvedValue([
    { ...base, id: "assigned", title: "assigned task" },
    { ...base, id: "copied", title: "copied task", assigneeSubject: "bob", ccSubjects: ["alice"] },
    { ...base, id: "unrelated", title: "unrelated task", assigneeSubject: "bob" },
  ]);
  const [reveal, setReveal] = createSignal<Parameters<typeof IssueQueue>[0]["reveal"]>(undefined, { ownedWrite: true });
  const [selected, setSelected] = createSignal("assigned", { ownedWrite: true });
  render(() => <Queue selectedId={selected()} keepExternalSelection userSubject="alice" reveal={reveal()} onSelect={setSelected} />);
  await screen.findByText("assigned task");
  setSelected("copied");
  setReveal({ key: "copied", subject: "alice", issue: { assigneeSubject: "bob", reporterSubject: "reporter", ccSubjects: ["alice"] } });
  await screen.findByText("copied task");
  expect(screen.getByLabelText("按范围筛选").textContent).toContain("抄送我的");
  setSelected("unrelated");
  setReveal({ key: "unrelated", subject: "alice", issue: { assigneeSubject: "bob", reporterSubject: "reporter", ccSubjects: [] } });
  await screen.findByText("unrelated task");
  expect(screen.getByLabelText("按范围筛选").textContent).toContain("全部");
  // A scope that already contains the revealed Issue is kept.
  setSelected("copied");
  setReveal({ key: "copied", subject: "alice", issue: { assigneeSubject: "bob", reporterSubject: "reporter", ccSubjects: ["alice"] } });
  await waitFor(() => expect(screen.getByText("unrelated task")).toBeTruthy());
  expect(screen.getByLabelText("按范围筛选").textContent).toContain("全部");
  expect(selected()).toBe("copied");
});
