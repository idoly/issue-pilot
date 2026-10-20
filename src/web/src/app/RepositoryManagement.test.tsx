import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Person } from "../data/client";

const state = vi.hoisted(() => ({ user: undefined as unknown, update: vi.fn(), load: vi.fn(), create: vi.fn() }));
vi.mock("./ApplicationResources", () => ({ useApplicationResources: () => ({ currentUser: state.user, refreshConfiguration: async () => {}, refreshCatalog: async () => {} }) }));
vi.mock("../data/client", async original => ({
  ...await original<typeof import("../data/client")>(),
  loadRepositories: state.load,
  updateRepository: state.update,
  createRepository: state.create,
}));
import { RepositoryManagement } from "./RepositoryManagement";

const repository = { id: "repository", name: "Example", url: "git@example.test:example.git", services: [], createdAt: "2026-10-18T00:00:00.000Z", updatedAt: "2026-10-18T00:00:00.000Z" };
beforeEach(() => { state.load.mockResolvedValue([repository]); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const alice: Person = { subject: "alice", name: "Alice", email: "alice@example.test", role: "developer" };

for (const outcome of ["success", "failure"] as const) it(`ignores a previous identity's repository load ${outcome}`, async () => {
  const [user, setUser] = createSignal<Person>(alice, { ownedWrite: true }); state.user = user;
  let finish!: () => void;
  state.load.mockImplementationOnce(() => new Promise((resolve, reject) => {
    finish = outcome === "success" ? () => resolve([{ ...repository, name: "Stale repository" }]) : () => reject(new Error("old_identity_load_failed"));
  }));
  render(() => <RepositoryManagement />);
  await waitFor(() => expect(state.load).toHaveBeenCalledOnce());
  setUser({ ...alice, subject: "bob", name: "Bob" });
  try {
    await waitFor(() => expect(state.load).toHaveBeenCalledTimes(2));
    await screen.findByText("Example");
    finish();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.queryByText("Stale repository")).toBeNull();
    expect(screen.queryByText("old_identity_load_failed")).toBeNull();
    expect(screen.getByText("Example")).toBeTruthy();
  } finally { finish(); }
});

it("keeps the refreshed repository list when the initial load arrives after creation", async () => {
  state.user = () => alice;
  let finish!: () => void;
  state.load.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve([{ ...repository, name: "Stale repository" }]); }));
  render(() => <RepositoryManagement />);
  await waitFor(() => expect(state.load).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "添加仓库" }));
  const dialog = await screen.findByRole("dialog", { name: "添加仓库" });
  fireEvent.input(within(dialog).getByLabelText("统一仓库名称"), { target: { value: "Example" } });
  fireEvent.input(within(dialog).getByLabelText("统一仓库地址"), { target: { value: repository.url } });
  const save = within(dialog).getByRole("button", { name: "保存" });
  await waitFor(() => expect(save).toHaveProperty("disabled", false));
  fireEvent.click(save);
  await waitFor(() => expect(state.create).toHaveBeenCalledOnce());
  await screen.findByText("Example");
  finish();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(screen.queryByText("Stale repository")).toBeNull();
  expect(screen.getByText("Example")).toBeTruthy();
});

it("closes repository edits and deletion confirmation when the same user's developer role is removed", async () => {
  const [user, setUser] = createSignal<Person>(alice, { ownedWrite: true }); state.user = user;
  render(() => <RepositoryManagement />);
  const panel = screen.getByRole("region", { name: "仓库管理" });
  fireEvent.click(await within(panel).findByRole("button", { name: "编辑" }));
  const dialog = await screen.findByRole("dialog", { name: "编辑仓库" });
  fireEvent.input(within(dialog).getByLabelText("统一仓库地址"), { target: { value: "git@example.test:unsent.git" } });
  setUser({ ...alice, role: "product" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑仓库" })).toBeNull());
  expect(state.update).not.toHaveBeenCalled();
  setUser(alice);
  fireEvent.click(await waitFor(() => { const button = within(panel).getByRole("button", { name: "删除" }); expect(button).toHaveProperty("disabled", false); return button; }));
  await screen.findByRole("dialog", { name: "删除仓库" });
  setUser({ ...alice, role: "test" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "删除仓库" })).toBeNull());
});

it("preserves repository drafts when the same identity and role refresh", async () => {
  const [user, setUser] = createSignal<Person>(alice, { ownedWrite: true }); state.user = user;
  render(() => <RepositoryManagement />);
  fireEvent.click(await within(screen.getByRole("region", { name: "仓库管理" })).findByRole("button", { name: "编辑" }));
  const dialog = await screen.findByRole("dialog", { name: "编辑仓库" });
  fireEvent.input(within(dialog).getByLabelText("统一仓库名称"), { target: { value: "Unsent name" } });
  setUser({ ...alice, name: "Updated Alice" });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(within(screen.getByRole("dialog", { name: "编辑仓库" })).getByLabelText("统一仓库名称")).toHaveProperty("value", "Unsent name");
});
