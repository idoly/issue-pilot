import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal, For } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { CapabilityName, Config } from "../data/client";

const state = vi.hoisted(() => ({ save: vi.fn(), refresh: vi.fn(), configuration: undefined as unknown }));
vi.mock("./ApplicationResources", () => ({ useApplicationResources: () => ({ configuration: () => (state.configuration as () => Config)(), refreshConfiguration: state.refresh }) }));
vi.mock("../data/client", async original => ({ ...await original<typeof import("../data/client")>(), updateService: state.save }));
import { CapabilityConfigurationDialog } from "./CapabilityConfigurationDialog";

afterEach(() => { cleanup(); vi.resetAllMocks(); });

for (const outcome of ["success", "failure"] as const) it(`keeps a new identity's capability editor open after the previous editor's save ${outcome}`, async () => {
  const configuration: Config = {
    agent: { provider: "fixture", model: "fixture", thinkingLevel: "off", codemode: "on", runtime: {} }, agentModels: [],
    environments: [{ key: "prod", name: "正式" }],
    services: [{ key: "orders", name: "Orders", description: "", repositories: [{ id: "repo", alias: "app", url: "git@example.test:app.git" }], deployments: [{
      environmentKey: "prod", capabilities: ["redis", "mq"], repositoryBranches: [{ repositoryId: "repo", repositoryAlias: "app", baseBranch: "main" }],
      redis: { host: "redis.example.test", port: 6379, database: 0, username: "", credentialConfigured: false },
      mq: { host: "mq.example.test", managementPort: 15672, username: "reader", virtualHost: "/", credentialConfigured: true },
    }] }],
  };
  const [getConfiguration, setConfiguration] = createSignal(configuration, { ownedWrite: true });
  state.configuration = getConfiguration;
  state.refresh.mockImplementation(async () => { setConfiguration(structuredClone(configuration)); });
  let finish!: () => void;
  state.save.mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
    finish = outcome === "success" ? resolve : () => reject(new Error("closed_editor_save_failed"));
  }));
  const [selected, setSelected] = createSignal<CapabilityName | null>("redis", { ownedWrite: true });
  render(() => <><button onClick={() => setSelected("mq")}>打开 MQ</button><For each={selected() ? [selected()!] : []}>{capability => <CapabilityConfigurationDialog capability={capability} onClose={() => setSelected(null)} />}</For></>);
  const dialog = await screen.findByRole("dialog", { name: "REDIS 配置" });
  fireEvent.input(within(dialog).getByLabelText("redis host 1"), { target: { value: "updated.example.test" } });
  const save = within(dialog).getByRole("button", { name: "保存" });
  await waitFor(() => expect(save).toHaveProperty("disabled", false));
  fireEvent.click(save);
  await waitFor(() => expect(state.save).toHaveBeenCalledOnce());
  // CapabilityManagement unmounts this editor when identity or permissions change.
  setSelected(null);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "REDIS 配置" })).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "打开 MQ" }));
  const next = await screen.findByRole("dialog", { name: "MQ 配置" });
  fireEvent.input(within(next).getByLabelText("mq host 1"), { target: { value: "unsaved.example.test" } });
  finish();
  if (outcome === "success") await waitFor(() => expect(state.refresh).toHaveBeenCalledOnce());
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(screen.getByRole("dialog", { name: "MQ 配置" })).toBeTruthy();
  expect(screen.getByLabelText("mq host 1")).toHaveProperty("value", "unsaved.example.test");
  expect(screen.queryByText("closed_editor_save_failed")).toBeNull();
});
