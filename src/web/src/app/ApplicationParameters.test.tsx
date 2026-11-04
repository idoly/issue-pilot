import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ApplicationParameterState, Person } from "../data/client";

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
const defaults = {
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
};
const parameterState = (overrides: Partial<typeof defaults> = {}, revision = 0): ApplicationParameterState => ({
  revision,
  overrides,
  values: { ...defaults, ...overrides },
  defaults,
  bounds: {
    numbers: Object.fromEntries(
      Object.keys(defaults)
        .filter((key) => typeof defaults[key as keyof typeof defaults] === "number")
        .map((key) => [key, { minimum: 0, maximum: key === "maxConcurrentIssues" ? 64 : 10 ** 12 }]),
    ) as ApplicationParameterState["bounds"]["numbers"],
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
  expect((screen.getByLabelText("钉钉附件主机") as HTMLTextAreaElement).value).toBe("files.example.test");

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
