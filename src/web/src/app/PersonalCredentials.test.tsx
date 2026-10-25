import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import type { PersonalCredentialStatus } from "../data/client";

const state = vi.hoisted(() => ({ user: undefined as unknown, load: vi.fn() }));
vi.mock("./ApplicationResources", () => ({ useApplicationResources: () => ({ currentUser: state.user, configuration: () => ({ agent: { provider: "fixture" } }) }) }));
vi.mock("../data/client", async original => ({ ...await original<typeof import("../data/client")>(), loadPersonalCredentials: state.load }));
import { PersonalCredentials } from "./PersonalCredentials";
afterEach(() => { cleanup(); vi.resetAllMocks(); });

test("shows exactly four personal credential groups without revealing secret values or account management", async () => {
  state.user = () => ({ subject: "alice", name: "Alice", role: "developer" });
  state.load.mockResolvedValue({ modelProviders: ["fixture"], gitSshConfigured: true, productionDmsConfigured: true, productionSlsConfigured: true });
  render(() => <PersonalCredentials />);
  const region = screen.getByRole("region", { name: "我的凭证" });
  await within(region).findByText("API Key");
  for (const label of ["API Key", "SSH Key", "SLS", "DMS"]) expect(within(region).getByText(label)).toBeTruthy();
  expect(within(region).getAllByText("已配置")).toHaveLength(4);
  expect(within(region).queryByText("钉钉")).toBeNull();
  expect(within(region).queryByRole("textbox")).toBeNull();
  expect(within(region).getAllByRole("button", { name: "更新凭证" })).toHaveLength(4);
  expect(screen.queryByRole("region", { name: "用户列表" })).toBeNull();
});

test("ignores a credential response belonging to the previously selected user", async () => {
  const [user, setUser] = createSignal({ subject: "alice", name: "Alice" }, { ownedWrite: true }); state.user = user;
  let finish!: (value: PersonalCredentialStatus) => void;
  state.load.mockImplementationOnce(() => new Promise<PersonalCredentialStatus>(resolve => { finish = resolve; })).mockResolvedValue({ modelProviders: [], gitSshConfigured: false });
  render(() => <PersonalCredentials />);
  await waitFor(() => expect(state.load).toHaveBeenCalledOnce());
  setUser({ subject: "bob", name: "Bob" });
  await screen.findByText("API Key");
  finish({ modelProviders: ["fixture"], gitSshConfigured: true });
  await waitFor(() => expect(screen.getAllByText("未配置")).toHaveLength(4));
});

test("reports credential status failures without showing false configuration state", async () => {
  state.user = () => ({ subject: "alice", name: "Alice" });
  state.load.mockRejectedValue(new Error("credential_status_failed"));
  render(() => <PersonalCredentials />);
  expect((await screen.findByRole("alert")).textContent).toContain("credential_status_failed");
  expect(screen.queryByText("未配置")).toBeNull();
});
