import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Person } from "../data/client";
const state = vi.hoisted(() => ({ user: undefined as unknown, load: vi.fn() }));
vi.mock("./ApplicationResources", () => ({ useApplicationResources: () => ({ currentUser: state.user }) }));
vi.mock("../data/client", async (original) => ({ ...(await original<typeof import("../data/client")>()), loadRepositories: state.load }));
import { RepositoryManagement } from "./RepositoryManagement";
const repository = { id: "repository", name: "Example", url: "git@example.test:example.git", services: [], createdAt: "2026-10-18T00:00:00.000Z", updatedAt: "2026-10-18T00:00:00.000Z" };
beforeEach(() => {
  state.load.mockResolvedValue([repository]);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const alice: Person = { subject: "alice", name: "Alice", email: "alice@example.test", role: "developer" };
for (const outcome of ["success", "failure"] as const)
  it(`ignores a previous identity's repository load ${outcome}`, async () => {
    const [user, setUser] = createSignal<Person>(alice, { ownedWrite: true });
    state.user = user;
    let finish!: () => void;
    state.load.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finish = outcome === "success" ? () => resolve([{ ...repository, name: "Stale repository" }]) : () => reject(new Error("old_identity_load_failed"));
        }),
    );
    render(() => <RepositoryManagement />);
    await waitFor(() => expect(state.load).toHaveBeenCalledOnce());
    setUser({ ...alice, subject: "bob", name: "Bob" });
    await screen.findByText("Example");
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Stale repository")).toBeNull();
    expect(screen.queryByText("old_identity_load_failed")).toBeNull();
  });
it("shows repository usage and developer controls while retaining the full address", async () => {
  state.user = () => alice;
  render(() => <RepositoryManagement />);
  const panel = screen.getByRole("region", { name: "仓库管理" });
  const address = await within(panel).findByText(repository.url);
  expect(address.getAttribute("title")).toBe(repository.url);
  expect([...panel.querySelectorAll("th")].map((node) => node.textContent)).toEqual(["名称", "地址", "使用服务", ""]);
  expect(within(panel).getByRole("button", { name: "登记仓库" })).toBeTruthy();
  expect(within(panel).getByRole("button", { name: "编辑" })).toBeTruthy();
});

it("defaults to all and filters by GitLab's top-level namespace without using service bindings", async () => {
  state.user = () => ({ ...alice, role: "product" });
  state.load.mockResolvedValue(
    [
      ["Mall front", "git@example.test:digital-biz-projects/xhgj-mall/fronts/mall-front.git"],
      ["Mall server", "https://example.test/digital-biz-projects/XHGJ-MALL/servers/mall-server.git"],
      ["MDM docking", "ssh://git@example.test:2222/digital-biz-projects/mdm/docking-servers/mdm-docking.git"],
      ["Other namespace", "git@example.test:digital-ai-projects/mdm/app.git"],
      ["Other repository", "git@example.test:digital-biz-projects/crm.git"],
    ].map(([name, url]) => ({ ...repository, id: name, name, url, services: [{ key: "crm", name: "crm" }] })),
  );
  render(() => <RepositoryManagement />);
  const list = await screen.findByRole("region", { name: "仓库列表" });
  const filter = screen.getByRole("combobox", { name: "仓库分组" });
  const choose = async (name: string) => {
    fireEvent.click(filter);
    fireEvent.click(await screen.findByRole("option", { name }));
    await waitFor(() => expect(filter.textContent).toBe(name));
  };
  await within(list).findByText("Mall front");
  expect(filter.textContent).toBe("全部");
  expect(list.tabIndex).toBe(0);
  expect(within(list).getAllByRole("row")).toHaveLength(6);
  expect(screen.queryByRole("button", { name: "登记仓库" })).toBeNull();
  fireEvent.click(filter);
  expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["全部", "oms", "srm", "mall", "mdm", "crm", "iqs", "mpm", "其他"]);
  fireEvent.click(screen.getByRole("option", { name: "mall" }));
  await waitFor(() => expect(filter.textContent).toBe("mall"));
  expect(within(list).getAllByRole("row")).toHaveLength(3);
  expect(within(list).getByText("Mall front")).toBeTruthy();
  expect(within(list).getByText("Mall server")).toBeTruthy();
  await choose("mdm");
  expect(within(list).getAllByRole("row")).toHaveLength(2);
  expect(within(list).getByText("MDM docking")).toBeTruthy();
  await choose("crm");
  expect(within(list).getByText("此分组暂无仓库")).toBeTruthy();
  await choose("其他");
  expect(within(list).getByText("Other namespace")).toBeTruthy();
  expect(within(list).getByText("Other repository")).toBeTruthy();
  await choose("全部");
  expect(within(list).getAllByRole("row")).toHaveLength(6);
  expect(state.load).toHaveBeenCalledOnce();
});
