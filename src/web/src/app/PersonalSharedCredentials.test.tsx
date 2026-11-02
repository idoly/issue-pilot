import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { PersonalCredentialStatus } from "../data/client";

const state = vi.hoisted(() => ({
  user: undefined as unknown as () => { subject: string; name: string; role: string; isAdmin?: boolean },
  load: vi.fn(), savePersonal: vi.fn(), loadDms: vi.fn(), saveDms: vi.fn(), loadSls: vi.fn(), saveSls: vi.fn(), saveAgent: vi.fn(), refresh: vi.fn(),
}));
const agent = { provider: "shared", model: "shared-model", thinkingLevel: "high" as const, codemode: "on" as const, runtime: { networkAllowedDomains: ["maven.aliyun.com:443"] }, apiKeyConfigured: true };
vi.mock("./ApplicationResources", () => ({ useApplicationResources: () => ({
  currentUser: () => state.user(), configurationLoaded: () => true, refreshConfiguration: state.refresh,
  configuration: () => ({ agent, agentModels: [{ provider: "shared", id: "shared-model", thinkingLevels: ["medium", "high"] }, { provider: "personal", id: "personal-model", thinkingLevels: ["low", "medium"] }] }),
}) }));
vi.mock("../data/client", async original => ({ ...await original<typeof import("../data/client")>(),
  loadPersonalCredentials: state.load, updatePersonalCredentials: state.savePersonal, loadSharedDmsCredentials: state.loadDms, updateSharedDmsCredentials: state.saveDms,
  loadSharedSlsCredentials: state.loadSls, updateSharedSlsCredentials: state.saveSls, updateAgentConfiguration: state.saveAgent }));
import { PersonalCredentials } from "./PersonalCredentials";

const status: PersonalCredentialStatus = { revision: 2, model: { provider: "personal", model: "personal-model", thinkingLevel: "low", codemode: "off" }, gitSshConfigured: false, productionDmsConfigured: true, productionDmsUrl: "https://personal.example.test/sse" };
const admin = { subject: "alice", name: "Alice", role: "developer", isAdmin: true };
beforeEach(() => {
  state.user = () => admin;
  state.load.mockResolvedValue(status); state.savePersonal.mockResolvedValue({ ...status, revision: 3 });
  state.loadDms.mockResolvedValue({ configured: true, url: "https://shared.example.test/sse", revision: 5 }); state.saveDms.mockResolvedValue({ configured: true, url: "https://new.example.test/sse", revision: 6 });
  state.loadSls.mockResolvedValue({ configured: true, revision: 7 }); state.saveSls.mockResolvedValue({ configured: false, revision: 8 });
  state.saveAgent.mockResolvedValue({ ok: true }); state.refresh.mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const openGroup = async (index: number) => {
  render(() => <PersonalCredentials />);
  await screen.findByText("API Key");
  fireEvent.click(within(screen.getByRole("region", { name: "我的凭证" })).getAllByRole("button")[index]!);
  return screen.findByRole("dialog");
};

test("admins edit the shared DMS group by default without revealing its Authorization", async () => {
  const dialog = await openGroup(2);
  expect(within(dialog).getByRole("checkbox", { name: /共享凭证/ })).toHaveProperty("checked", true);
  expect(within(dialog).getByLabelText("DMS 地址")).toHaveProperty("value", "https://shared.example.test/sse");
  expect(within(dialog).getByLabelText("新凭证")).toHaveProperty("value", "");
  await fireEvent.input(within(dialog).getByLabelText("DMS 地址"), { target: { value: "https://new.example.test/sse" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("Authorization");
  await fireEvent.input(within(dialog).getByLabelText("新凭证"), { target: { value: "Bearer shared" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(state.saveDms).toHaveBeenCalledWith({ expectedRevision: 5, mode: "replace", url: "https://new.example.test/sse", authorization: "Bearer shared" }));
  expect(state.savePersonal).not.toHaveBeenCalled();
});

test("clearing the checkbox switches the dialog to the admin's personal credentials", async () => {
  const dialog = await openGroup(2);
  fireEvent.click(within(dialog).getByRole("checkbox", { name: /共享凭证/ }));
  await waitFor(() => expect(within(dialog).getByLabelText("DMS 地址")).toHaveProperty("value", "https://personal.example.test/sse"));
  await fireEvent.input(within(dialog).getByLabelText("新凭证"), { target: { value: "Bearer personal" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(state.savePersonal).toHaveBeenCalledWith({ expectedRevision: 2, production: { dms: { mode: "replace", url: "https://personal.example.test/sse", authorization: "Bearer personal" } } }));
  expect(state.saveDms).not.toHaveBeenCalled();
});

test("shared SLS can be cleared with its own revision", async () => {
  const dialog = await openGroup(3);
  fireEvent.click(within(dialog).getByRole("button", { name: "清除凭证" }));
  await waitFor(() => expect(state.saveSls).toHaveBeenCalledWith({ expectedRevision: 7, mode: "clear" }));
});

test("the shared API key reuses the model dialog and keeps the global runtime settings", async () => {
  const dialog = await openGroup(0);
  expect(within(dialog).getByRole("checkbox", { name: /共享凭证/ })).toHaveProperty("checked", true);
  expect(within(dialog).getByLabelText("模型").closest(".ui-select")?.textContent).toContain("shared-model");
  await fireEvent.input(within(dialog).getByLabelText("API Key"), { target: { value: "shared-key" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(state.saveAgent).toHaveBeenCalledWith({ provider: "shared", model: "shared-model", thinkingLevel: "high", codemode: "on", runtime: agent.runtime, apiKey: { mode: "replace", value: "shared-key" } }));
  await waitFor(() => expect(state.refresh).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(within(screen.getByRole("region", { name: "我的凭证" })).getAllByRole("button")[0]!);
  const reopened = await screen.findByRole("dialog");
  fireEvent.click(within(reopened).getByRole("checkbox", { name: /共享凭证/ }));
  await waitFor(() => expect(within(reopened).getByLabelText("模型").closest(".ui-select")?.textContent).toContain("personal-model"));
  fireEvent.click(within(reopened).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(state.savePersonal).toHaveBeenCalledWith({ expectedRevision: 2, model: { mode: "replace", provider: "personal", model: "personal-model", thinkingLevel: "low", codemode: "off" } }));
});

test("non-admins see no shared switch and never read shared credential status", async () => {
  state.user = () => ({ ...admin, isAdmin: false });
  const dialog = await openGroup(2);
  expect(within(dialog).queryByRole("checkbox")).toBeNull();
  expect(within(dialog).getByLabelText("DMS 地址")).toHaveProperty("value", "https://personal.example.test/sse");
  expect(state.loadDms).not.toHaveBeenCalled(); expect(state.loadSls).not.toHaveBeenCalled();
});

test("admins without the developer role can only edit the shared API key", async () => {
  state.user = () => ({ ...admin, role: "product" });
  const dialog = await openGroup(0);
  const checkbox = within(dialog).getByRole("checkbox", { name: /共享凭证/ });
  expect(checkbox).toHaveProperty("checked", true); expect(checkbox).toHaveProperty("disabled", true);
});

test("an identity change discards the previous admin's shared status", async () => {
  const [user, setUser] = createSignal(admin, { ownedWrite: true }); state.user = user;
  render(() => <PersonalCredentials />);
  await screen.findByText("API Key");
  await waitFor(() => expect(state.loadDms).toHaveBeenCalledTimes(1));
  setUser({ ...admin, subject: "bob", name: "Bob", isAdmin: false });
  await waitFor(() => expect(state.load).toHaveBeenCalledTimes(2));
  expect(state.loadDms).toHaveBeenCalledTimes(1);
});
