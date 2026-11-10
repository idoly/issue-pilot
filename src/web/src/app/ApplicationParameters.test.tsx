import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ApplicationParameterEditorState, ApplicationParameters, Person } from "../data/client";

const state = vi.hoisted(() => ({
  user: undefined as unknown,
  load: vi.fn(),
  save: vi.fn(),
}));
vi.mock("./ApplicationResources", () => ({ useApplicationResources: () => ({ currentUser: state.user }) }));
vi.mock("../data/client", async (original) => ({
  ...(await original<typeof import("../data/client")>()),
  loadApplicationParameters: state.load,
  updateApplicationParameters: state.save,
}));
import { ApplicationParametersView } from "./ApplicationParameters";

const admin: Person = { subject: "alice", name: "Alice", email: "alice@example.test", role: "developer", isAdmin: true };
const defaults: ApplicationParameters = {
  maxConcurrentIssues: 10,
  modelResponseIdleMs: 300_000,
  workspaceRetentionMs: 168 * 3_600_000,
  workspaceHighWaterBytes: 20 * 1024 ** 3,
  workspaceTargetBytes: 16 * 1024 ** 3,
  workspaceMaintenanceIntervalMs: 15 * 60_000,
  capabilityConnectionMs: 10_000,
  mcpExecutionMs: 120_000,
  dmsExecutionMs: 120_000,
  slsExecutionMs: 30_000,
  dingtalkAttachmentHosts: ["files.example.test"],
  networkAllowedDomains: ["registry.example.test"],
  networkMode: "open",
};
const parameterState = (overrides: Partial<typeof defaults> = {}, revision = 0): ApplicationParameterEditorState => ({
  revision,
  overrides,
  values: { ...defaults, ...overrides },
  defaults,
  issueSearch: { enabled: false, accountId: "", tokenConfigured: false, revision: 0 },
  bounds: {
    numbers: Object.fromEntries(
      Object.keys(defaults)
        .filter((key) => typeof defaults[key as keyof typeof defaults] === "number")
        .map((key) => [key, { minimum: 0, maximum: key === "maxConcurrentIssues" ? 64 : 10 ** 12 }]),
    ) as ApplicationParameterEditorState["bounds"]["numbers"],
    listEntries: 100,
  },
});

beforeEach(() => {
  state.load.mockReset();
  state.save.mockReset();
});
afterEach(() => cleanup());

test("shows defaults in their display units and saves only values that differ from the project defaults", async () => {
  const [user] = createSignal<Person | null>(admin);
  state.user = user;
  state.load.mockResolvedValue(parameterState({ mcpExecutionMs: 60_000 }, 3));
  state.save.mockResolvedValue(parameterState({ maxConcurrentIssues: 4, mcpExecutionMs: 60_000 }, 4));
  render(() => <ApplicationParametersView />);

  const concurrency: HTMLInputElement = await screen.findByLabelText("同时运行的工单");
  await waitFor(() => expect(concurrency.value).toBe("10"));
  expect((screen.getByLabelText("工作区保留时长") as HTMLInputElement).value).toBe("168");
  expect((screen.getByLabelText("磁盘高水位") as HTMLInputElement).value).toBe("20480");
  expect((screen.getByLabelText("MCP 调用超时") as HTMLInputElement).value).toBe("60");
  expect(screen.getByRole("textbox", { name: "钉钉附件主机" })).toHaveProperty("value", "files.example.test");
  expect(screen.getByRole("combobox", { name: "工单网络访问" }).textContent).toBe("开放网络");
  expect(screen.queryByLabelText("Agent 网络基础白名单")).toBeNull();

  await fireEvent.input(concurrency, { target: { value: "4" } });
  fireEvent.click(screen.getByRole("button", { name: "保存参数" }));
  await waitFor(() => expect(state.save).toHaveBeenCalledTimes(1));
  // Defaults keep flowing from the project configuration; only edited values are stored.
  expect(state.save).toHaveBeenCalledWith({
    expectedRevision: 3,
    overrides: {
      maxConcurrentIssues: 4,
      mcpExecutionMs: 60_000,
    },
  });
  await waitFor(() => expect((screen.getByLabelText("同时运行的工单") as HTMLInputElement).value).toBe("4"));
});

for (const highWaterBytes of [10 * 1024 ** 2 + 1, Number.MAX_SAFE_INTEGER])
  test(`preserves exact stored values including ${highWaterBytes} bytes when saving a different parameter`, async () => {
    state.user = () => admin;
    const overrides = { mcpExecutionMs: 1_501, workspaceRetentionMs: 3_600_001, workspaceMaintenanceIntervalMs: 60_001, workspaceHighWaterBytes: highWaterBytes, workspaceTargetBytes: 1 };
    const original = parameterState(overrides, 2);
    original.bounds.numbers.workspaceHighWaterBytes.maximum = Number.MAX_SAFE_INTEGER;
    state.load.mockResolvedValue(original);
    state.save.mockResolvedValue(original);
    render(() => <ApplicationParametersView />);
    const concurrency = await screen.findByLabelText("同时运行的工单");
    await fireEvent.input(concurrency, { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "保存参数" }));
    await waitFor(() => expect(state.save).toHaveBeenCalledWith({ expectedRevision: 2, overrides: { ...overrides, maxConcurrentIssues: 4 } }));
    expect(screen.getByLabelText("MCP 调用超时")).toHaveProperty("value", "1.501");
  });

test("converts decimal display units to exact integers without floating point loss", async () => {
  state.user = () => admin;
  const original = parameterState({}, 2);
  original.bounds.numbers.workspaceHighWaterBytes.maximum = Number.MAX_SAFE_INTEGER;
  state.load.mockResolvedValue(original);
  state.save.mockResolvedValue(original);
  render(() => <ApplicationParametersView />);
  await fireEvent.input(await screen.findByLabelText("MCP 调用超时"), { target: { value: "1.001" } });
  await fireEvent.input(screen.getByLabelText("工作区保留时长"), { target: { value: "1.5" } });
  await fireEvent.input(screen.getByLabelText("磁盘高水位"), { target: { value: "8589934591.99999904632568359375" } });
  fireEvent.click(screen.getByRole("button", { name: "保存参数" }));
  await waitFor(() =>
    expect(state.save).toHaveBeenCalledWith({ expectedRevision: 2, overrides: { mcpExecutionMs: 1_001, workspaceRetentionMs: 5_400_000, workspaceHighWaterBytes: Number.MAX_SAFE_INTEGER } }),
  );
});

for (const [label, value] of [
  ["同时运行的工单", "1.5"],
  ["MCP 调用超时", "1.0001"],
  ["磁盘高水位", "20480.0000001"],
  ["磁盘高水位", "8589934592"],
] as const)
  test(`rejects ${label}=${value} instead of rounding to a valid stored integer`, async () => {
    state.user = () => admin;
    const original = parameterState();
    original.bounds.numbers.workspaceHighWaterBytes.maximum = Number.MAX_SAFE_INTEGER;
    state.load.mockResolvedValue(original);
    render(() => <ApplicationParametersView />);
    await fireEvent.input(await screen.findByLabelText(label), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "保存参数" }));
    await screen.findByRole("alert");
    expect(state.save).not.toHaveBeenCalled();
  });

const selectNetworkMode = async (label: "开放网络" | "域名白名单") => {
  fireEvent.click(screen.getByRole("combobox", { name: "工单网络访问" }));
  fireEvent.click(await screen.findByRole("option", { name: label }));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "工单网络访问" }).textContent).toBe(label));
};

test("keeps allowlist drafts across mode switches and preserves the saved list while network access is open", async () => {
  state.user = () => admin;
  let persisted = parameterState({ networkMode: "allowlist", networkAllowedDomains: ["saved.example.test"] }, 2);
  state.load.mockImplementation(async () => persisted);
  state.save.mockImplementation(async (input: { expectedRevision: number; overrides: Partial<ApplicationParameters> }) => {
    persisted = parameterState(input.overrides, input.expectedRevision + 1);
    return persisted;
  });
  const view = render(() => <ApplicationParametersView />);
  const domains = await screen.findByLabelText("Agent 网络基础白名单");
  expect(domains).toHaveProperty("disabled", false);
  await fireEvent.input(domains, { target: { value: "draft.example.test\npackages.example.test" } });
  await selectNetworkMode("开放网络");
  expect(screen.queryByLabelText("Agent 网络基础白名单")).toBeNull();
  await selectNetworkMode("域名白名单");
  expect(screen.getByLabelText("Agent 网络基础白名单")).toHaveProperty("disabled", false);
  expect(screen.getByLabelText("Agent 网络基础白名单")).toHaveProperty("value", "draft.example.test\npackages.example.test");
  fireEvent.click(screen.getByRole("button", { name: "保存参数" }));
  await waitFor(() => expect(state.save).toHaveBeenCalledTimes(1));
  expect(state.save).toHaveBeenLastCalledWith({
    expectedRevision: 2,
    overrides: { networkMode: "allowlist", networkAllowedDomains: ["draft.example.test", "packages.example.test"] },
  });
  await waitFor(() => expect(screen.getByRole("button", { name: "保存参数" })).toHaveProperty("disabled", false));

  await selectNetworkMode("开放网络");
  fireEvent.click(screen.getByRole("button", { name: "保存参数" }));
  await waitFor(() => expect(state.save).toHaveBeenCalledTimes(2));
  expect(state.save).toHaveBeenLastCalledWith({ expectedRevision: 3, overrides: { networkAllowedDomains: ["draft.example.test", "packages.example.test"] } });
  await waitFor(() => expect(screen.getByRole("button", { name: "保存参数" })).toHaveProperty("disabled", false));
  view.unmount();
  render(() => <ApplicationParametersView />);
  expect((await screen.findByRole("combobox", { name: "工单网络访问" })).textContent).toBe("开放网络");
  expect(screen.queryByLabelText("Agent 网络基础白名单")).toBeNull();
  await selectNetworkMode("域名白名单");
  const reloaded = screen.getByLabelText("Agent 网络基础白名单");
  expect(reloaded).toHaveProperty("disabled", false);
  expect(reloaded).toHaveProperty("value", "draft.example.test\npackages.example.test");
});

test("reloads the current network mode and allowlist after a revision conflict", async () => {
  state.user = () => admin;
  state.load.mockResolvedValueOnce(parameterState({}, 1)).mockResolvedValueOnce(parameterState({ networkMode: "allowlist", networkAllowedDomains: ["current.example.test"] }, 2));
  state.save.mockRejectedValueOnce(new Error("configuration_changed"));
  render(() => <ApplicationParametersView />);
  await screen.findByRole("combobox", { name: "工单网络访问" });
  await selectNetworkMode("域名白名单");
  await fireEvent.input(screen.getByLabelText("Agent 网络基础白名单"), { target: { value: "draft.example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "保存参数" }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText("Agent 网络基础白名单")).toHaveProperty("value", "draft.example.test");
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  await waitFor(() => expect(screen.getByLabelText("Agent 网络基础白名单")).toHaveProperty("value", "current.example.test"));
  expect(screen.getByRole("combobox", { name: "工单网络访问" }).textContent).toBe("域名白名单");
  expect(screen.getByLabelText("Agent 网络基础白名单")).toHaveProperty("disabled", false);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("rejects an invalid field before saving and reloads after a revision conflict", async () => {
  const [user] = createSignal<Person | null>(admin);
  state.user = user;
  state.load.mockResolvedValue(parameterState({}, 1));
  state.save.mockRejectedValueOnce(new Error("configuration_changed")).mockResolvedValueOnce(parameterState({ workspaceTargetBytes: 1024 ** 3 * 2 }, 3));
  render(() => <ApplicationParametersView />);

  const target = (await screen.findByLabelText("回收目标")) as HTMLInputElement;
  await fireEvent.input(target, { target: { value: "abc" } });
  fireEvent.click(screen.getByRole("button", { name: "保存参数" }));
  expect((await screen.findByRole("alert")).textContent).toContain("回收目标 需为 0 到");
  expect(state.save).not.toHaveBeenCalled();

  await fireEvent.input(target, { target: { value: "2048" } });
  await fireEvent.click(screen.getByRole("button", { name: "保存参数" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("配置已被更新"));
  fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
  await waitFor(() => expect(state.load).toHaveBeenCalledTimes(2));
  await waitFor(() => expect((screen.getByLabelText("回收目标") as HTMLInputElement).value).toBe("2048"));
});

test("hides the form from users without management access", async () => {
  const [user] = createSignal<Person | null>({ ...admin, isAdmin: false });
  state.user = user;
  render(() => <ApplicationParametersView />);
  expect(await screen.findByText("只有管理人员可以查看和修改运行参数。")).not.toBeNull();
  expect(screen.queryByRole("button", { name: "保存参数" })).toBeNull();
  expect(state.load).not.toHaveBeenCalled();
});

for (const outcome of ["success", "failure"] as const)
  test(`switching administrators resets saving and ignores the previous save's ${outcome}`, async () => {
    const [user, setUser] = createSignal<Person | null>(admin, { ownedWrite: true });
    state.user = user;
    state.load.mockResolvedValueOnce(parameterState({}, 1)).mockResolvedValue(parameterState({ maxConcurrentIssues: 6 }, 2));
    let finishPrevious!: () => void;
    state.save.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finishPrevious = outcome === "success" ? () => resolve(parameterState({ maxConcurrentIssues: 4 }, 2)) : () => reject(new Error("previous_save_failed"));
        }),
    );
    render(() => <ApplicationParametersView />);
    await screen.findByLabelText("同时运行的工单");
    fireEvent.click(screen.getByRole("button", { name: "保存参数" }));
    await waitFor(() => expect(state.save).toHaveBeenCalledTimes(1));

    setUser({ ...admin, subject: "bob", name: "Bob" });
    await waitFor(() => expect(screen.getByLabelText("同时运行的工单")).toHaveProperty("value", "6"));
    expect(screen.getByRole("button", { name: "保存参数" })).toHaveProperty("disabled", false);
    let finishCurrent!: () => void;
    state.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCurrent = () => resolve(parameterState({ maxConcurrentIssues: 7 }, 3));
        }),
    );
    await fireEvent.input(screen.getByLabelText("同时运行的工单"), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "保存参数" }));
    await waitFor(() => expect(state.save).toHaveBeenCalledTimes(2));
    expect(state.save).toHaveBeenLastCalledWith({ expectedRevision: 2, overrides: { maxConcurrentIssues: 7 } });

    finishPrevious();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole("button", { name: "保存参数" })).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("同时运行的工单")).toHaveProperty("value", "7");
    expect(screen.queryByRole("alert")).toBeNull();
    finishCurrent();
    await waitFor(() => expect(screen.getByRole("button", { name: "保存参数" })).toHaveProperty("disabled", false));
  });

test("reloads parameters when the current user's management access changes", async () => {
  const [user, setUser] = createSignal<Person | null>({ ...admin, isAdmin: false }, { ownedWrite: true });
  state.user = user;
  state.load.mockResolvedValueOnce(parameterState({ maxConcurrentIssues: 4 }, 1)).mockResolvedValueOnce(parameterState({ maxConcurrentIssues: 6 }, 2));
  render(() => <ApplicationParametersView />);
  expect(await screen.findByText("只有管理人员可以查看和修改运行参数。")).not.toBeNull();
  setUser(admin);
  await waitFor(() => expect(state.load).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByLabelText("同时运行的工单")).toHaveProperty("value", "4"));

  setUser({ ...admin, isAdmin: false });
  await screen.findByText("只有管理人员可以查看和修改运行参数。");
  setUser(admin);
  await waitFor(() => expect(state.load).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByLabelText("同时运行的工单")).toHaveProperty("value", "6"));
});

test("revoking management access removes the form and ignores an in-flight save failure", async () => {
  const [user, setUser] = createSignal<Person | null>(admin, { ownedWrite: true });
  state.user = user;
  state.load.mockResolvedValue(parameterState({}, 1));
  let failSave!: () => void;
  state.save.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        failSave = () => reject(new Error("admin_required"));
      }),
  );
  render(() => <ApplicationParametersView />);
  await screen.findByLabelText("同时运行的工单");
  fireEvent.click(screen.getByRole("button", { name: "保存参数" }));
  await waitFor(() => expect(state.save).toHaveBeenCalledTimes(1));
  setUser({ ...admin, isAdmin: false });
  await screen.findByText("只有管理人员可以查看和修改运行参数。");
  expect(screen.queryByRole("region", { name: "参数表单" })).toBeNull();
  expect(screen.queryByRole("button", { name: "保存参数" })).toBeNull();
  failSave();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(state.save).toHaveBeenCalledTimes(1);

  setUser(admin);
  await screen.findByLabelText("同时运行的工单");
  expect(screen.getByRole("button", { name: "保存参数" })).toHaveProperty("disabled", false);
  expect(screen.queryByRole("alert")).toBeNull();
});
