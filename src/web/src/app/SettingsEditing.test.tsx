import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ManagedUser, Person, PersonalCredentialStatus } from "../data/client";

const state = vi.hoisted(() => ({ user: undefined as unknown, users: vi.fn(), createUser: vi.fn(), updateUser: vi.fn(), credentials: vi.fn(), saveCredentials: vi.fn(), repositories: vi.fn(), register: vi.fn(), updateRepository: vi.fn(), removeRepository: vi.fn(), refreshPeople: vi.fn(), refreshConfiguration: vi.fn(), refreshCatalog: vi.fn() }));
vi.mock("./ApplicationResources", () => ({ useApplicationResources: () => ({ currentUser: state.user, configuration: () => ({ agent: { provider: "fixture" } }), refreshPeople: state.refreshPeople, refreshConfiguration: state.refreshConfiguration, refreshCatalog: state.refreshCatalog }) }));
vi.mock("../data/client", async original => ({ ...await original<typeof import("../data/client")>(), loadManagedUsers: state.users, createUser: state.createUser, updateUser: state.updateUser, loadPersonalCredentials: state.credentials, updatePersonalCredentials: state.saveCredentials, loadRepositories: state.repositories, registerRepository: state.register, updateRepository: state.updateRepository, deleteRepository: state.removeRepository }));
import { PersonalCredentials } from "./PersonalCredentials";
import { UserManagement } from "./UserManagement";
import { RepositoryManagement } from "./RepositoryManagement";

const alice: Person = { subject: "alice", name: "Alice", email: "alice@example.test", role: "developer", isAdmin: true };
const users: ManagedUser[] = [{ ...alice, revision: 2, active: true, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }, { ...alice, subject: "inactive", name: "Inactive", email: "inactive@example.test", revision: 0, active: false, isAdmin: false, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }];
const status: PersonalCredentialStatus = { modelProviders: ["fixture"], gitSshConfigured: true, productionDmsConfigured: false, productionSlsConfigured: false, revision: 3 };
beforeEach(() => {
  state.user = () => alice;
  state.users.mockResolvedValue(structuredClone(users)); state.createUser.mockResolvedValue(users[0]); state.updateUser.mockResolvedValue(users[0]);
  state.credentials.mockResolvedValue(status); state.saveCredentials.mockResolvedValue({ ...status, revision: 4 });
  state.repositories.mockResolvedValue([{ id: "repo", name: "Repository", url: "git@example.test:team/repo.git", services: [], revision: 2 }]);
  state.register.mockResolvedValue({ id: "new" }); state.updateRepository.mockResolvedValue({ ok: true }); state.removeRepository.mockResolvedValue(undefined);
  state.refreshPeople.mockResolvedValue([]); state.refreshConfiguration.mockResolvedValue({}); state.refreshCatalog.mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

test("inactive personnel are hidden until requested and enablement carries the row revision", async () => {
  render(() => <UserManagement />);
  await screen.findByText("Alice"); expect(screen.queryByText("Inactive")).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "显示停用人员" }));
  await screen.findByText("Inactive"); fireEvent.click(screen.getByRole("button", { name: "启用" }));
  await waitFor(() => expect(state.updateUser).toHaveBeenCalledWith("inactive", { active: true, expectedRevision: 0 }));
  await waitFor(() => expect(state.refreshPeople).toHaveBeenCalled());
});

test("new personnel use a stable email account and failures retain the draft", async () => {
  state.createUser.mockRejectedValueOnce(new Error("conflict"));
  render(() => <UserManagement />); await screen.findByText("Alice");
  fireEvent.click(screen.getByRole("button", { name: "添加人员" }));
  const dialog = await screen.findByRole("dialog", { name: "添加人员" });
  await fireEvent.input(within(dialog).getByLabelText("人员姓名"), { target: { value: "New person" } });
  await fireEvent.input(within(dialog).getByLabelText("人员邮箱"), { target: { value: "NEW@example.test" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await within(dialog).findByRole("alert"); expect(within(dialog).getByLabelText("人员姓名")).toHaveProperty("value", "New person");
  expect(state.createUser).toHaveBeenCalledWith({ subject: "new@example.test", name: "New person", email: "NEW@example.test", role: "product", isAdmin: false });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

for (const outcome of ["success", "failure"] as const) test(`old identity personnel save ${outcome} cannot close or overwrite the next editor`, async () => {
  const [user, setUser] = createSignal<Person>(alice, { ownedWrite: true }); state.user = user;
  let finish!: () => void;
  state.createUser.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = outcome === "success" ? () => resolve(users[0]) : () => reject(new Error("old_user_save_failed")); }));
  render(() => <UserManagement />); await screen.findByText("Alice");
  fireEvent.click(screen.getByRole("button", { name: "添加人员" }));
  let dialog = await screen.findByRole("dialog");
  await fireEvent.input(within(dialog).getByLabelText("人员姓名"), { target: { value: "Old draft" } });
  await fireEvent.input(within(dialog).getByLabelText("人员邮箱"), { target: { value: "old@example.test" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" })); await waitFor(() => expect(finish).toBeTypeOf("function"));
  setUser({ ...alice, subject: "bob", name: "Bob" }); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "添加人员" })); dialog = await screen.findByRole("dialog");
  await fireEvent.input(within(dialog).getByLabelText("人员姓名"), { target: { value: "Current draft" } });
  finish(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(screen.getByRole("dialog")).toBe(dialog); expect(within(dialog).getByLabelText("人员姓名")).toHaveProperty("value", "Current draft");
  expect(screen.queryByText("old_user_save_failed")).toBeNull();
});

test("credential popup opens directly, preserves blanks and reports stale writes without discarding the new value", async () => {
  state.saveCredentials.mockRejectedValueOnce(new Error("configuration_changed"));
  render(() => <PersonalCredentials />); await screen.findByText("API Key");
  fireEvent.click(screen.getAllByRole("button", { name: "更新凭证" })[0]!);
  let dialog = await screen.findByRole("dialog");
  expect(within(dialog).queryByRole("button", { name: "替换" })).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); expect(state.saveCredentials).not.toHaveBeenCalled();
  fireEvent.click(screen.getAllByRole("button", { name: "更新凭证" })[0]!); dialog = await screen.findByRole("dialog");
  await fireEvent.input(within(dialog).getByLabelText("新凭证"), { target: { value: "replacement-private-key" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("配置已被更新");
  expect(within(dialog).getByLabelText("新凭证")).toHaveProperty("value", "replacement-private-key");
  expect(state.saveCredentials).toHaveBeenCalledWith({ expectedRevision: 3, model: { mode: "replace", provider: "fixture", apiKey: "replacement-private-key" } });
});

test("identity changes clear secret drafts and late credential success cannot mutate the next identity", async () => {
  const [user, setUser] = createSignal<Person>(alice, { ownedWrite: true }); state.user = user;
  let finish!: () => void;
  state.saveCredentials.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ ...status, productionDmsConfigured: true }); }));
  render(() => <PersonalCredentials />); await screen.findByText("API Key");
  fireEvent.click(screen.getAllByRole("button", { name: "更新凭证" })[0]!);
  await fireEvent.input(await screen.findByLabelText("新凭证"), { target: { value: "old-secret" } });
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(finish).toBeTypeOf("function")); setUser({ ...alice, subject: "bob", name: "Bob" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); await screen.findByText("API Key");
  finish(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(screen.queryByText("old-secret")).toBeNull(); expect(screen.getAllByText("未配置")).toHaveLength(2);
});

test("repository saving infers a name, preserves stale drafts and refreshes shared configuration", async () => {
  state.register.mockRejectedValueOnce(new Error("conflict"));
  render(() => <RepositoryManagement />); await screen.findByText("Repository");
  fireEvent.click(screen.getByRole("button", { name: "登记仓库" })); const dialog = await screen.findByRole("dialog");
  await fireEvent.input(within(dialog).getByLabelText("仓库地址"), { target: { value: "git@example.test:team/added.git" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await within(dialog).findByRole("alert"); expect(within(dialog).getByLabelText("仓库地址")).toHaveProperty("value", "git@example.test:team/added.git");
  expect(state.register).toHaveBeenCalledWith({ name: "added", url: "git@example.test:team/added.git" });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" })); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(state.refreshCatalog).toHaveBeenCalled()); expect(state.refreshConfiguration).toHaveBeenCalled();
});

test("repository usage navigates to its service and linked repositories cannot be deleted", async () => {
  state.repositories.mockResolvedValue([{ id: "repo", name: "Repository", url: "git@example.test:team/repo.git", revision: 2, services: [{ key: "orders", name: "Orders" }] }]);
  const select = vi.fn(); render(() => <RepositoryManagement onSelectService={select} />); await screen.findByText("Repository");
  fireEvent.click(screen.getByRole("button", { name: "Orders" })); expect(select).toHaveBeenCalledWith("orders");
  expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
});

for (const failedRead of ["configuration", "catalog"] as const) test(`repository retry restores shared ${failedRead} after a successful write without repeating it`, async () => {
  const shared = failedRead === "configuration" ? state.refreshConfiguration : state.refreshCatalog;
  shared.mockRejectedValueOnce(new Error("shared_refresh_failed"));
  render(() => <RepositoryManagement />); await screen.findByText("Repository");
  fireEvent.click(screen.getByRole("button", { name: "登记仓库" })); const dialog = await screen.findByRole("dialog");
  await fireEvent.input(within(dialog).getByLabelText("仓库地址"), { target: { value: "git@example.test:team/retry.git" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const error = await screen.findByRole("alert"); expect(error.textContent).toContain("shared_refresh_failed");
  fireEvent.click(within(error).getByRole("button", { name: "重试" }));
  await waitFor(() => expect(shared).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull()); expect(state.register).toHaveBeenCalledTimes(1);
});

test("personnel retry refreshes shared identities after a successful write without creating another user", async () => {
  state.refreshPeople.mockRejectedValueOnce(new Error("people_refresh_failed"));
  render(() => <UserManagement />); await screen.findByText("Alice");
  fireEvent.click(screen.getByRole("button", { name: "添加人员" })); const dialog = await screen.findByRole("dialog");
  await fireEvent.input(within(dialog).getByLabelText("人员姓名"), { target: { value: "New member" } });
  await fireEvent.input(within(dialog).getByLabelText("人员邮箱"), { target: { value: "new@example.test" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const error = await screen.findByRole("alert"); expect(error.textContent).toContain("people_refresh_failed");
  fireEvent.click(within(error).getByRole("button", { name: "重试" }));
  await waitFor(() => expect(state.refreshPeople).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull()); expect(state.createUser).toHaveBeenCalledTimes(1);
});

test("user management translates the actual admin authorization error and preserves its draft", async () => {
  state.createUser.mockRejectedValueOnce(new Error("admin_role_required"));
  render(() => <UserManagement />); await screen.findByText("Alice");
  fireEvent.click(screen.getByRole("button", { name: "添加人员" })); const dialog = await screen.findByRole("dialog");
  await fireEvent.input(within(dialog).getByLabelText("人员姓名"), { target: { value: "New member" } });
  await fireEvent.input(within(dialog).getByLabelText("人员邮箱"), { target: { value: "new@example.test" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("此操作需要管理权限");
  expect(within(dialog).getByLabelText("人员姓名")).toHaveProperty("value", "New member");
});
