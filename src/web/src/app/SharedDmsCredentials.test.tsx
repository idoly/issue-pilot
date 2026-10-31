import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
const state = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), user: () => ({ subject: "dev", role: "developer" }) }));
vi.mock("../data/client", async original => ({ ...await original<typeof import("../data/client")>(), loadSharedDmsCredentials: state.load, updateSharedDmsCredentials: state.save }));
vi.mock("./ApplicationResources", () => ({ useApplicationResources: () => ({ currentUser: () => state.user() }) }));
import { SharedCredentials } from "./SharedCredentials";
const status = { configured: true, revision: 3, url: "https://dms.example.test/sse" };
beforeEach(() => { state.load.mockResolvedValue(status); state.save.mockResolvedValue({ ...status, revision: 4 }); state.user = () => ({ subject: "dev", role: "developer" }); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const open = async () => { render(() => <SharedCredentials capability="dms" />); fireEvent.click(await screen.findByRole("button", { name: "更新凭据" })); return screen.findByRole("dialog", { name: "共享 DMS 凭据" }); };
it("keeps stored Authorization out of the form and preserves blank saves", async () => {
  const dialog = await open();
  expect(within(dialog).getByLabelText("共享 DMS 地址")).toHaveProperty("value", status.url);
  expect(within(dialog).getByLabelText("共享 DMS Authorization")).toHaveProperty("value", "");
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); expect(state.save).not.toHaveBeenCalled();
});
it("requires Authorization when changing the URL and sends a complete versioned group", async () => {
  const dialog = await open();
  await fireEvent.input(within(dialog).getByLabelText("共享 DMS 地址"), { target: { value: "https://new.example.test/sse" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("更换地址时需同时填写");
  expect(state.save).not.toHaveBeenCalled();
  await fireEvent.input(within(dialog).getByLabelText("共享 DMS Authorization"), { target: { value: "Bearer replacement" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(state.save).toHaveBeenCalledExactlyOnceWith({ expectedRevision: 3, mode: "replace", url: "https://new.example.test/sse", authorization: "Bearer replacement" }));
});
it("clears the shared group explicitly and keeps conflicts recoverable", async () => {
  state.save.mockRejectedValueOnce(new Error("configuration_changed"));
  const dialog = await open(); fireEvent.click(within(dialog).getByRole("button", { name: "清除凭据" }));
  expect(await within(dialog).findByRole("button", { name: "重新加载" })).toBeTruthy();
  expect(state.save).toHaveBeenCalledExactlyOnceWith({ expectedRevision: 3, mode: "clear" });
  fireEvent.click(within(dialog).getByRole("button", { name: "重新加载" }));
  await waitFor(() => expect(state.load).toHaveBeenCalledTimes(2));
});
it("clears unsent secrets when the selected identity changes", async () => {
  const [user, setUser] = createSignal({ subject: "dev", role: "developer" }, { ownedWrite: true }); state.user = user;
  const dialog = await open();
  await fireEvent.input(within(dialog).getByLabelText("共享 DMS Authorization"), { target: { value: "Bearer unsent" } });
  setUser({ subject: "other", role: "developer" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(await screen.findByRole("button", { name: "更新凭据" }));
  expect(await screen.findByLabelText("共享 DMS Authorization")).toHaveProperty("value", "");
});
it("hides shared credentials from non-developers", () => {
  state.user = () => ({ subject: "viewer", role: "product" }); render(() => <SharedCredentials capability="dms" />);
  expect(screen.queryByRole("region", { name: "共享 DMS 凭据" })).toBeNull(); expect(state.load).not.toHaveBeenCalled();
});
