import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Config } from "../data/client";

const state = vi.hoisted(() => ({ configuration: undefined as unknown as () => Config, refresh: vi.fn(), save: vi.fn(), user: undefined as unknown as () => { subject: string; role: string; isAdmin?: boolean }, loaded: true }));
vi.mock("./ApplicationResources", () => ({ useApplicationResources: () => ({ configuration: state.configuration, configurationLoaded: () => state.loaded, configurationError: () => "", currentUser: state.user, refreshConfiguration: state.refresh }) }));
vi.mock("../data/client", async original => ({ ...await original<typeof import("../data/client")>(), updateAgentConfiguration: state.save }));
import { AgentModelSettings } from "./AgentModelSettings";

function configuration(): Config {
  return {
    agent: { provider: "deepseek", model: "deepseek-flash", thinkingLevel: "medium", codemode: "on", runtime: { networkAllowedDomains: ["maven.aliyun.com:443"] }, apiKeyConfigured: true },
    agentModels: [
      { provider: "deepseek", id: "deepseek-flash", thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"] },
      { provider: "deepseek", id: "deepseek-v4-pro", thinkingLevels: ["off", "high", "max"] },
      { provider: "xhgj", id: "gpt-6.1-sol", thinkingLevels: ["off", "low", "medium", "high"] },
    ],
    environments: [],
    services: [],
  };
}
beforeEach(() => {
  state.configuration = configuration;
  state.user = () => ({ subject: "alice", role: "developer", isAdmin: true }); state.loaded = true;
  state.refresh.mockResolvedValue(configuration()); state.save.mockResolvedValue({ ok: true });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

test("shared API key dialog offers only the providers and models the global Pi models.json exposes", async () => {
  render(() => <AgentModelSettings />);
  const card = await screen.findByRole("region", { name: "共享 API Key" });
  expect(card.textContent).toContain("deepseek / deepseek-flash");
  fireEvent.click(within(card).getByRole("button", { name: "更新凭据" }));
  const dialog = await screen.findByRole("dialog", { name: "共享 API Key" });
  fireEvent.click(within(dialog).getByLabelText("Provider"));
  expect((await screen.findAllByRole("option")).map(option => option.textContent)).toEqual(["deepseek", "xhgj"]);
  fireEvent.click(screen.getByRole("option", { name: "xhgj" }));
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  await waitFor(() => expect(within(dialog).getByLabelText("模型").closest(".ui-select")?.textContent).toContain("gpt-6.1-sol"));
  fireEvent.click(within(dialog).getByLabelText("模型"));
  expect((await screen.findAllByRole("option")).map(option => option.textContent)).toEqual(["gpt-6.1-sol"]);
});

test("switching providers requires a new key before saving and sends it as a replacement", async () => {
  render(() => <AgentModelSettings />);
  fireEvent.click(within(await screen.findByRole("region", { name: "共享 API Key" })).getByRole("button", { name: "更新凭据" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByLabelText("Provider"));
  fireEvent.click(await screen.findByRole("option", { name: "xhgj" }));
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("更换 provider");
  expect(state.save).not.toHaveBeenCalled();
  await fireEvent.input(within(dialog).getByLabelText("API Key"), { target: { value: "shared-key" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(state.save).toHaveBeenCalledWith(expect.objectContaining({ provider: "xhgj", model: "gpt-6.1-sol", apiKey: { mode: "replace", value: "shared-key" } })));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("clearing the shared key sends an explicit clear", async () => {
  render(() => <AgentModelSettings />);
  fireEvent.click(within(await screen.findByRole("region", { name: "共享 API Key" })).getByRole("button", { name: "更新凭据" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "清除凭据" }));
  await waitFor(() => expect(state.save).toHaveBeenCalledWith(expect.objectContaining({ provider: "deepseek", apiKey: { mode: "clear" } })));
});

test("saving preserves the stored key while the provider stays the same", async () => {
  render(() => <AgentModelSettings />);
  fireEvent.click(within(await screen.findByRole("region", { name: "共享 API Key" })).getByRole("button", { name: "更新凭据" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByLabelText("模型"));
  fireEvent.click(await screen.findByRole("option", { name: "deepseek-v4-pro" }));
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  await waitFor(() => expect(within(dialog).getByLabelText("思考级别").closest(".ui-select")?.textContent).toContain("off"));
  fireEvent.click(within(dialog).getByLabelText("Codemode"));
  fireEvent.click(await screen.findByRole("option", { name: /only/ }));
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(state.save).toHaveBeenCalledWith({ provider: "deepseek", model: "deepseek-v4-pro", thinkingLevel: "off", codemode: "only", runtime: { networkAllowedDomains: ["maven.aliyun.com:443"] } }));
  await waitFor(() => expect(state.refresh).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("a rejected model change keeps the dialog open and explains the availability rule", async () => {
  state.save.mockRejectedValueOnce(new Error("agent_model_not_available"));
  render(() => <AgentModelSettings />);
  fireEvent.click(within(await screen.findByRole("region", { name: "共享 API Key" })).getByRole("button", { name: "更新凭据" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("全局 Pi models.json");
  expect(screen.getByRole("dialog")).toBe(dialog);
});

test("users without management access do not see the shared API key", async () => {
  state.user = () => ({ subject: "bob", role: "developer", isAdmin: false });
  render(() => <AgentModelSettings />);
  await Promise.resolve();
  expect(screen.queryByRole("region", { name: "共享 API Key" })).toBeNull();
});

test("an unloaded configuration renders a placeholder instead of an empty model list", async () => {
  state.loaded = false;
  render(() => <AgentModelSettings />);
  const card = await screen.findByRole("region", { name: "共享 API Key" });
  expect(within(card).queryByText("当前模型")).toBeNull();
  expect(within(card).queryByRole("button", { name: "更新凭据" })).toBeNull();
});
