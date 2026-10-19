import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Person, PersonalCredentialStatus } from "../data/client";

const state = vi.hoisted(() => ({ user: undefined as unknown, provider: (): string => "fixture", save: vi.fn(), load: vi.fn() }));
vi.mock("./ApplicationResources", () => ({ useApplicationResources: () => ({ currentUser: state.user, configuration: () => ({ agent: { provider: state.provider() } }), configurationLoaded: () => true }) }));
vi.mock("../data/client", async (original) => ({ ...await original<typeof import("../data/client")>(), loadPersonalCredentials: state.load, updatePersonalCredentials: state.save }));
import { PersonalCredentials } from "./PersonalCredentials";

describe("personal credentials", () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); state.provider = () => "fixture"; });
  it("saves a model key for the provider shown while editing", async () => {
    state.user = () => ({ subject: "alice", name: "Alice", email: "a@example.test", role: "developer" });
    state.provider = () => "provider-a";
    state.load.mockResolvedValue({ provider: "provider-a", modelProviders: [], gitSshConfigured: false });
    state.save.mockResolvedValue({ provider: "provider-b", modelProviders: ["provider-a"], gitSshConfigured: false });
    render(() => <PersonalCredentials />);
    const key = await screen.findByLabelText("apiKey");
    expect(key.closest("label")?.textContent).toContain("provider-a");
    fireEvent.input(key, { target: { value: "provider-a-private-key" } });
    const button = screen.getByRole("button", { name: "保存凭证" });
    await waitFor(() => expect(button).toHaveProperty("disabled", false));
    fireEvent.click(button);
    await waitFor(() => expect(state.save).toHaveBeenCalledWith({ model: { provider: "provider-a", mode: "replace", apiKey: "provider-a-private-key" } }));
  });

  it("clears only the model-key draft when the global provider changes", async () => {
    const [provider, setProvider] = createSignal("provider-a", { ownedWrite: true }); state.provider = provider;
    state.user = () => ({ subject: "alice", name: "Alice", email: "a@example.test", role: "developer" });
    state.load.mockResolvedValue({ provider: "provider-a", modelProviders: ["provider-a"], gitSshConfigured: false });
    state.save.mockResolvedValue({ provider: "provider-b", modelProviders: ["provider-a", "provider-b"], gitSshConfigured: true });
    render(() => <PersonalCredentials />);
    const key = await screen.findByLabelText("apiKey");
    fireEvent.input(key, { target: { value: "old-provider-key" } });
    fireEvent.input(screen.getByLabelText("sshKey"), { target: { value: "ssh-draft" } });
    fireEvent.input(screen.getByLabelText("生产 DMS Token"), { target: { value: "Bearer dms-draft" } });
    setProvider("provider-b");
    await waitFor(() => expect(key).toHaveProperty("value", ""));
    expect(key.closest("label")?.textContent).toContain("provider-b");
    expect(screen.getByLabelText("sshKey")).toHaveProperty("value", "ssh-draft");
    expect(screen.getByLabelText("生产 DMS Token")).toHaveProperty("value", "Bearer dms-draft");
    fireEvent.input(key, { target: { value: "new-provider-key" } });
    const button = screen.getByRole("button", { name: "保存凭证" });
    await waitFor(() => expect(button).toHaveProperty("disabled", false));
    fireEvent.click(button);
    await waitFor(() => expect(state.save).toHaveBeenCalledWith({ model: { provider: "provider-b", mode: "replace", apiKey: "new-provider-key" }, git: { mode: "replace", type: "ssh", privateKey: "ssh-draft" } }));
  });

  for (const outcome of ["success", "failure"] as const) it(`ignores an old model provider's save ${outcome}`, async () => {
    const [provider, setProvider] = createSignal("provider-a", { ownedWrite: true }); state.provider = provider;
    state.user = () => ({ subject: "alice", name: "Alice", email: "a@example.test", role: "developer" });
    state.load.mockResolvedValue({ provider: "provider-a", modelProviders: [], gitSshConfigured: false });
    let finish!: () => void;
    state.save.mockImplementationOnce(() => new Promise<PersonalCredentialStatus>((resolve, reject) => { finish = outcome === "success" ? () => resolve({ provider: "provider-b", modelProviders: ["provider-a"], gitSshConfigured: false }) : () => reject(new Error("old_provider_save_failed")); }));
    render(() => <PersonalCredentials />);
    try {
      const key = await screen.findByLabelText("apiKey");
      fireEvent.input(key, { target: { value: "old-provider-key" } });
      const button = screen.getByRole("button", { name: "保存凭证" });
      await waitFor(() => expect(button).toHaveProperty("disabled", false));
      fireEvent.click(button); await waitFor(() => expect(finish).toBeTypeOf("function"));
      setProvider("provider-b");
      await waitFor(() => expect(key).toHaveProperty("value", ""));
      fireEvent.input(key, { target: { value: "new-provider-draft" } });
      finish(); await waitFor(() => expect(button).toHaveProperty("disabled", false));
      expect(key).toHaveProperty("value", "new-provider-draft");
      expect(screen.queryByText("old_provider_save_failed")).toBeNull();
      expect(screen.queryByText("已保存")).toBeNull();
    } finally { finish?.(); }
  });

  it("uses one card and saves production rows independently without sending other drafts", async () => {
    const [user] = createSignal<Person>({ subject: "alice", name: "Alice", email: "a@example.test", role: "developer" }, { ownedWrite: true });
    state.user = user;
    state.load.mockResolvedValue({ provider: "fixture", modelProviders: [], gitSshConfigured: false });
    state.save.mockResolvedValue({ modelProviders: [], gitSshConfigured: false, productionDmsConfigured: true, productionDmsUrl: "https://dms.example.test/sse" });
    const view = render(() => <PersonalCredentials />);
    await waitFor(() => expect(state.load).toHaveBeenCalled());
    expect(screen.getByRole("region", { name: "我的凭证" })).toBeTruthy();
    expect(screen.queryByText("Alice")).toBeNull(); expect(screen.queryByText("a@example.test")).toBeNull();
    fireEvent.input(screen.getByLabelText("生产 DMS 地址"), { target: { value: "https://dms.example.test/sse" } });
    fireEvent.input(screen.getByLabelText("生产 DMS Token"), { target: { value: "Bearer personal" } });
    fireEvent.input(screen.getByLabelText("生产 SLS AccessKey ID"), { target: { value: "unsaved-id" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "保存 DMS 生产凭证" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "保存 DMS 生产凭证" }));
    await waitFor(() => expect(state.save).toHaveBeenCalledWith({ production: { dms: { mode: "replace", url: "https://dms.example.test/sse", authorization: "Bearer personal" } } }));
    await waitFor(() => expect(screen.getByLabelText("生产 DMS Token")).toHaveProperty("value", ""));
    expect(screen.getByLabelText("生产 SLS AccessKey ID")).toHaveProperty("value", "unsaved-id");
    expect(view.container.querySelectorAll(".production-credentials-form > div")).toHaveLength(3);
    view.unmount();
  });
  it("retains credential drafts when only the current user's profile details change", async () => {
    const original: Person = { subject: "alice", name: "Alice", email: "a@example.test", role: "developer" };
    const [user, setUser] = createSignal(original, { ownedWrite: true }); state.user = user;
    state.load.mockResolvedValue({ provider: "fixture", modelProviders: [], gitSshConfigured: false });
    render(() => <PersonalCredentials />);
    await waitFor(() => expect(screen.getByRole("button", { name: "保存凭证" })).toHaveProperty("disabled", true));
    const values = { apiKey: "unsaved-api-key", sshKey: "unsaved-ssh-key", "生产 DMS 地址": "https://new.example.test/sse", "生产 DMS Token": "Bearer draft", "生产 SLS AccessKey ID": "draft-id", "生产 SLS AccessKey Secret": "draft-secret" };
    for (const [label, value] of Object.entries(values)) fireEvent.input(screen.getByLabelText(label), { target: { value } });
    await waitFor(() => expect(screen.getByRole("button", { name: "保存凭证" })).toHaveProperty("disabled", false));
    setUser({ ...original, name: "Updated Alice" });
    await new Promise(resolve => setTimeout(resolve, 0));
    for (const [label, value] of Object.entries(values)) expect(screen.getByLabelText(label)).toHaveProperty("value", value);
    expect(state.load).toHaveBeenCalledOnce();
  });

  it("does not overwrite a DMS address entered while credential status is loading", async () => {
    const [user] = createSignal<Person>({ subject: "alice", name: "Alice", email: "a@example.test", role: "developer" }, { ownedWrite: true }); state.user = user;
    let finish!: (value: PersonalCredentialStatus) => void;
    state.load.mockImplementationOnce(() => new Promise<PersonalCredentialStatus>(resolve => { finish = resolve; }));
    render(() => <PersonalCredentials />);
    const saved = { provider: "fixture", modelProviders: [], gitSshConfigured: false, productionDmsConfigured: true, productionDmsUrl: "https://old.example.test/sse" };
    try {
      const input = screen.getByLabelText("生产 DMS 地址");
      fireEvent.input(input, { target: { value: "https://new.example.test/sse" } });
      finish(saved);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(input).toHaveProperty("value", "https://new.example.test/sse");
    } finally { finish?.(saved); }
  });

  for (const kind of ["dms", "sls"] as const) it(`preserves newer ${kind.toUpperCase()} inputs when an older save finishes`, async () => {
    const [user] = createSignal<Person>({ subject: "alice", name: "Alice", email: "a@example.test", role: "developer" }, { ownedWrite: true });
    state.user = user;
    state.load.mockResolvedValue({ provider: "fixture", modelProviders: [], gitSshConfigured: false });
    let finish!: (value: PersonalCredentialStatus) => void;
    state.save.mockImplementationOnce(() => new Promise<PersonalCredentialStatus>(resolve => { finish = resolve; }));
    const saved = { provider: "fixture", modelProviders: [], gitSshConfigured: false, productionDmsConfigured: true, productionDmsUrl: "https://old.example.test/sse", productionSlsConfigured: true };
    render(() => <PersonalCredentials />);
    try {
      await waitFor(() => expect(state.load).toHaveBeenCalled());
      const first = screen.getByLabelText(kind === "dms" ? "生产 DMS 地址" : "生产 SLS AccessKey ID");
      const secret = screen.getByLabelText(kind === "dms" ? "生产 DMS Token" : "生产 SLS AccessKey Secret");
      fireEvent.input(first, { target: { value: kind === "dms" ? "https://old.example.test/sse" : "old-id" } });
      fireEvent.input(secret, { target: { value: kind === "dms" ? "Bearer old" : "old-secret" } });
      const button = screen.getByRole("button", { name: kind === "dms" ? "保存 DMS 生产凭证" : "保存 SLS 生产凭证" });
      await waitFor(() => expect(button).toHaveProperty("disabled", false));
      fireEvent.click(button);
      await waitFor(() => expect(finish).toBeTypeOf("function"));
      const next = kind === "dms" ? "https://new.example.test/sse" : "new-id";
      fireEvent.input(first, { target: { value: next } });
      fireEvent.input(secret, { target: { value: "new-private-draft" } });
      finish(saved);
      await waitFor(() => expect(screen.getByRole("status").textContent).toContain("已保存"));
      expect(first).toHaveProperty("value", next);
      expect(secret).toHaveProperty("value", "new-private-draft");
      expect(screen.getByRole("status").textContent).toContain("当前输入尚未保存");
    } finally { finish?.(saved); }
  });

  it("saves keys for the current user, does not display stored secrets, and clears drafts on user switch", async () => {
    const [user, setUser] = createSignal<Person>({ subject: "alice", name: "Alice", email: "a@example.test", role: "developer" }, { ownedWrite: true });
    state.user = user;
    state.load.mockResolvedValue({ provider: "fixture", modelProviders: ["fixture"], gitSshConfigured: false });
    state.save.mockResolvedValue({ modelProviders: ["fixture"], gitSshConfigured: false });
    const view = render(() => <PersonalCredentials />);
    const key = await screen.findByLabelText("apiKey") as HTMLInputElement;
    await waitFor(() => expect(state.load).toHaveBeenCalled());
    expect(screen.queryByLabelText("个人模型服务商")).toBeNull();
    expect(view.baseElement.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Show password" })).toBeNull();
    expect(key.value).toBe("");
    fireEvent.input(key, { target: { value: "alice-secret" } });
    const ssh = screen.getByLabelText("sshKey") as HTMLTextAreaElement;
    fireEvent.input(ssh, { target: { value: "alice-ssh-key\nsecond-line" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "保存凭证" })).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "保存凭证" }));
    await waitFor(() => expect(state.save).toHaveBeenCalledWith({ model: { provider: "fixture", mode: "replace", apiKey: "alice-secret" }, git: { mode: "replace", type: "ssh", privateKey: "alice-ssh-key\nsecond-line" } }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("已保存"));
    expect(key.value).toBe("alice-secret");
    expect(ssh.value).toBe("alice-ssh-key\nsecond-line");
    fireEvent.input(key, { target: { value: "unsaved-secret" } });
    setUser({ subject: "bob", name: "Bob", email: "b@example.test", role: "developer" });
    await waitFor(() => expect(key.value).toBe(""));
    setUser({ subject: "product", name: "Product", email: "p@example.test", role: "product" });
    await waitFor(() => expect(screen.queryByLabelText("apiKey")).toBeNull());
    expect(screen.getByRole("region", { name: "我的凭证" })).toBeTruthy();
    expect(screen.getByLabelText("生产 DMS 地址")).toBeTruthy();
    expect(screen.getByLabelText("生产 SLS AccessKey ID")).toBeTruthy();
    view.unmount();
  });
});
