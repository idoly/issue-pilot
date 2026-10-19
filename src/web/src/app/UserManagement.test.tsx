import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ManagedUser, Person } from "../data/client";

const state = vi.hoisted(() => ({ user: undefined as unknown, load: vi.fn(), create: vi.fn(), update: vi.fn(), refresh: vi.fn() }));
vi.mock("./ApplicationResources", () => ({ useApplicationResources: () => ({ currentUser: state.user, refreshPeople: state.refresh }) }));
vi.mock("./PersonalCredentials", () => ({ PersonalCredentials: () => null }));
vi.mock("../data/client", async original => ({ ...await original<typeof import("../data/client")>(), loadManagedUsers: state.load, createUser: state.create, updateUser: state.update }));
import { UserManagement } from "./UserManagement";

const alice: Person = { subject: "alice", name: "Alice", email: "alice@example.test", role: "developer", isAdmin: true };
const target: ManagedUser = { subject: "target-user", name: "Target", email: "target@example.test", role: "test", active: true, isAdmin: false, createdAt: "2026-10-18T00:00:00.000Z", updatedAt: "2026-10-18T00:00:00.000Z" };
const bob: Person = { ...alice, subject: "bob", name: "Bob" };
function deferred() {
  let resolve!: (value: ManagedUser) => void, reject!: (error: Error) => void;
  const promise = new Promise<ManagedUser>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function openEditor() {
  const row = (await screen.findByText(target.subject, { exact: true })).closest(".user-table-row") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "编辑" }));
  return screen.findByRole("dialog", { name: "编辑用户" });
}

beforeEach(() => {
  state.user = () => alice;
  state.load.mockResolvedValue([target]); state.create.mockResolvedValue(target); state.update.mockResolvedValue(target); state.refresh.mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

for (const [change, next] of [["identity", bob], ["role", { ...alice, role: "product" as const }], ["management access", { ...alice, isAdmin: false }]] as const) {
  it(`closes an unsent user editor after a change in ${change}`, async () => {
    const [user, setUser] = createSignal<Person>(alice, { ownedWrite: true }); state.user = user;
    render(() => <UserManagement />);
    const dialog = await openEditor();
    fireEvent.input(within(dialog).getByLabelText("用户姓名"), { target: { value: "Unsent draft" } });
    setUser(next);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑用户" })).toBeNull());
    expect(state.update).not.toHaveBeenCalled(); expect(state.create).not.toHaveBeenCalled();
    if (next.role === "developer") {
      const reopened = await openEditor();
      expect(within(reopened).getByLabelText("用户姓名")).toHaveProperty("value", target.name);
    }
  });
}

it("preserves user drafts when the same identity and permissions refresh", async () => {
  const [user, setUser] = createSignal<Person>(alice, { ownedWrite: true }); state.user = user;
  render(() => <UserManagement />);
  const dialog = await openEditor();
  fireEvent.input(within(dialog).getByLabelText("用户姓名"), { target: { value: "Unsent draft" } });
  setUser({ ...alice, name: "Updated Alice" });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(within(screen.getByRole("dialog", { name: "编辑用户" })).getByLabelText("用户姓名")).toHaveProperty("value", "Unsent draft");
  expect(state.load).toHaveBeenCalledOnce();
});

for (const outcome of ["success", "failure"] as const) it(`keeps the new identity's user save pending after an old save ${outcome}`, async () => {
  const [user, setUser] = createSignal<Person>(alice, { ownedWrite: true }); state.user = user;
  const first = deferred(), second = deferred();
  state.update.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
  render(() => <UserManagement />);
  try {
    let dialog = await openEditor();
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
    setUser(bob);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑用户" })).toBeNull());
    dialog = await openEditor();
    fireEvent.input(within(dialog).getByLabelText("用户姓名"), { target: { value: "Bob draft" } });
    const save = within(dialog).getByRole("button", { name: "保存" });
    fireEvent.click(save); await waitFor(() => expect(state.update).toHaveBeenCalledTimes(2));
    if (outcome === "success") first.resolve(target); else first.reject(new Error("old_user_save_failed"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.getByRole("dialog", { name: "编辑用户" })).toBeTruthy();
    expect(save).toHaveProperty("disabled", true);
    expect(within(dialog).getByLabelText("用户姓名")).toHaveProperty("value", "Bob draft");
    expect(screen.queryByText("old_user_save_failed")).toBeNull();
    second.resolve({ ...target, name: "Bob draft" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑用户" })).toBeNull());
    await waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(outcome === "success" ? 2 : 1));
  } finally { first.resolve(target); second.resolve(target); }
});

for (const outcome of ["success", "failure"] as const) it(`keeps the new identity's activation pending after an old activation ${outcome}`, async () => {
  const [user, setUser] = createSignal<Person>(alice, { ownedWrite: true }); state.user = user;
  const first = deferred(), second = deferred();
  state.update.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
  render(() => <UserManagement />);
  try {
    fireEvent.click(await screen.findByRole("button", { name: "停用" }));
    await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
    expect(state.update).toHaveBeenNthCalledWith(1, target.subject, { active: false });
    setUser(bob);
    const button = await waitFor(() => { const value = screen.getByRole("button", { name: "停用" }); expect(value).toHaveProperty("disabled", false); return value; });
    fireEvent.click(button); await waitFor(() => expect(state.update).toHaveBeenCalledTimes(2));
    if (outcome === "success") first.resolve(target); else first.reject(new Error("old_activation_failed"));
    await new Promise(resolve => setTimeout(resolve, 0));
    await waitFor(() => expect(screen.getByRole("button", { name: "停用" })).toHaveProperty("disabled", true));
    expect(screen.queryByText("old_activation_failed")).toBeNull();
    second.resolve(target);
    await waitFor(() => expect(state.refresh).toHaveBeenCalledTimes(outcome === "success" ? 2 : 1));
    await waitFor(() => expect(screen.getByRole("button", { name: "停用" })).toHaveProperty("disabled", false));
  } finally { first.resolve(target); second.resolve(target); }
});

it("refreshes shared profiles after an accepted save without reloading an unmounted user table", async () => {
  const response = deferred(); state.update.mockImplementationOnce(() => response.promise);
  const view = render(() => <UserManagement />);
  const dialog = await openEditor();
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(state.update).toHaveBeenCalledOnce());
  view.unmount(); response.resolve(target);
  await waitFor(() => expect(state.refresh).toHaveBeenCalledOnce());
  expect(state.load).toHaveBeenCalledOnce();
});
