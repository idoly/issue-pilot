import { cleanup, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentConfiguration } from "../data/client";

const state = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("../data/client", async original => ({ ...await original<typeof import("../data/client")>(), updateGlobalAgent: state.save }));
import { createAgentConfigurationEditor } from "./agent-configuration";

const initial: AgentConfiguration = { provider: "fixture", model: "fixture", thinkingLevel: "off", codemode: "on", runtime: {} };
afterEach(() => { cleanup(); vi.useRealTimers(); vi.resetAllMocks(); });

for (const outcome of ["success", "failure"] as const) it(`ignores a previous identity generation's save ${outcome} after switching away and back`, async () => {
  vi.useFakeTimers();
  const [identity, setIdentity] = createSignal<string | null>("alice", { ownedWrite: true });
  let editor!: ReturnType<typeof createAgentConfigurationEditor>, finish!: () => void;
  const refresh = vi.fn(async () => ({ ...initial, model: "current-alice-draft" }));
  state.save.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { finish = outcome === "success" ? resolve : () => reject(new Error("old_generation_failed")); }));
  state.save.mockResolvedValue(undefined);
  function Probe() { editor = createAgentConfigurationEditor(() => initial, identity, refresh); return null; }
  render(() => <Probe />);
  editor.update({ ...initial, model: "old-alice-edit" });
  await vi.advanceTimersByTimeAsync(500);
  expect(state.save).toHaveBeenCalledOnce();
  setIdentity("bob"); await vi.advanceTimersByTimeAsync(0);
  setIdentity("alice"); await vi.advanceTimersByTimeAsync(0);
  editor.update({ ...initial, model: "current-alice-draft" });
  finish(); await vi.advanceTimersByTimeAsync(0);
  expect(editor.error()).toBe("");
  expect(refresh).not.toHaveBeenCalled();
  expect(editor.draft().model).toBe("current-alice-draft");
  await vi.advanceTimersByTimeAsync(500);
  expect(state.save).toHaveBeenCalledTimes(2);
  expect(state.save).toHaveBeenLastCalledWith({ ...initial, model: "current-alice-draft" });
  expect(editor.draft().model).toBe("current-alice-draft");
  expect(editor.error()).toBe("");
});

it("does not restore an abandoned failed save as retryable after returning to the same user", async () => {
  vi.useFakeTimers();
  const [identity, setIdentity] = createSignal<string | null>("alice", { ownedWrite: true });
  let editor!: ReturnType<typeof createAgentConfigurationEditor>, rejectOld!: (error: Error) => void;
  state.save.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectOld = reject; }));
  const refresh = vi.fn(async () => initial);
  function Probe() { editor = createAgentConfigurationEditor(() => initial, identity, refresh); return null; }
  render(() => <Probe />);
  editor.update({ ...initial, model: "abandoned-edit" });
  await vi.advanceTimersByTimeAsync(500);
  setIdentity("bob"); await vi.advanceTimersByTimeAsync(0);
  setIdentity("alice"); await vi.advanceTimersByTimeAsync(0);
  rejectOld(new Error("abandoned_save_failed"));
  await vi.advanceTimersByTimeAsync(0);
  editor.retry(); await vi.advanceTimersByTimeAsync(500);
  expect(state.save).toHaveBeenCalledOnce();
  expect(editor.error()).toBe("");
  expect(editor.draft()).toEqual(initial);
  expect(editor.saving()).toBe(false);
});

it("does not replace a new identity generation's draft when an old refresh completes", async () => {
  vi.useFakeTimers();
  const [identity, setIdentity] = createSignal<string | null>("alice", { ownedWrite: true });
  let editor!: ReturnType<typeof createAgentConfigurationEditor>, finishRefresh!: (value: AgentConfiguration) => void;
  state.save.mockResolvedValue(undefined);
  const refresh = vi.fn(() => new Promise<AgentConfiguration>(resolve => { finishRefresh = resolve; }));
  function Probe() { editor = createAgentConfigurationEditor(() => initial, identity, refresh); return null; }
  render(() => <Probe />);
  editor.update({ ...initial, model: "old-edit" });
  await vi.advanceTimersByTimeAsync(500);
  expect(refresh).toHaveBeenCalledOnce();
  setIdentity("bob"); await vi.advanceTimersByTimeAsync(0);
  setIdentity("alice"); await vi.advanceTimersByTimeAsync(0);
  expect(editor.draft()).toEqual(initial);
  finishRefresh({ ...initial, model: "stale-refresh" });
  await vi.advanceTimersByTimeAsync(0);
  expect(editor.draft()).toEqual(initial);
});
