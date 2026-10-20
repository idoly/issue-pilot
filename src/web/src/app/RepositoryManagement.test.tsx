import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { Person } from "../data/client";

const state = vi.hoisted(() => ({ user: undefined as unknown, update: vi.fn() }));
vi.mock("./ApplicationResources", () => ({ useApplicationResources: () => ({ currentUser: state.user, refreshConfiguration: async () => {}, refreshCatalog: async () => {} }) }));
vi.mock("../data/client", async original => ({
  ...await original<typeof import("../data/client")>(),
  loadRepositories: async () => [{ id: "repository", name: "Example", url: "git@example.test:example.git", services: [], createdAt: "2026-10-18T00:00:00.000Z", updatedAt: "2026-10-18T00:00:00.000Z" }],
  updateRepository: state.update,
}));
import { RepositoryManagement } from "./RepositoryManagement";

afterEach(() => { cleanup(); vi.resetAllMocks(); });
const alice: Person = { subject: "alice", name: "Alice", email: "alice@example.test", role: "developer" };

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
