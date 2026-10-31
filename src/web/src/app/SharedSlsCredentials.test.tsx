import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({ user: () => ({ subject: "alice", role: "developer" }), load: vi.fn(), save: vi.fn() }));
vi.mock("./ApplicationResources", () => ({ useApplicationResources: () => ({ currentUser: () => state.user() }) }));
vi.mock("../data/client", async original => ({ ...await original<typeof import("../data/client")>(), loadSharedSlsCredentials: state.load, updateSharedSlsCredentials: state.save }));
import { SharedCredentials } from "./SharedCredentials";
beforeEach(() => { vi.resetAllMocks(); state.user = () => ({ subject: "alice", role: "developer" }); state.load.mockResolvedValue({ configured: true, revision: 5 }); });
afterEach(cleanup);

test("shared SLS only exposes status and supports blank-preserve, complete replacement and clear", async () => {
  state.save.mockResolvedValueOnce({ configured: true, revision: 6 }).mockResolvedValueOnce({ configured: false, revision: 7 });
  render(() => <SharedCredentials capability="sls" />);
  const region = await screen.findByRole("region", { name: "共享 SLS 凭据" });
  fireEvent.click(await within(region).findByRole("button", { name: "更新凭据" }));
  let dialog = await screen.findByRole("dialog", { name: "共享 SLS 凭据" });
  expect(within(dialog).getByLabelText("共享 SLS AccessKey ID")).toHaveProperty("value", "");
  expect(within(dialog).getByLabelText("共享 SLS AccessKey Secret")).toHaveProperty("type", "password");
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); expect(state.save).not.toHaveBeenCalled();
  fireEvent.click(within(region).getByRole("button", { name: "更新凭据" })); dialog = await screen.findByRole("dialog");
  await fireEvent.input(within(dialog).getByLabelText("共享 SLS AccessKey ID"), { target: { value: "replacement-id" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("完整凭据"); expect(state.save).not.toHaveBeenCalled();
  await fireEvent.input(within(dialog).getByLabelText("共享 SLS AccessKey Secret"), { target: { value: "replacement-secret" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(state.save).toHaveBeenCalledWith({ expectedRevision: 5, mode: "replace", accessKeyId: "replacement-id", accessKeySecret: "replacement-secret" });
  fireEvent.click(within(region).getByRole("button", { name: "更新凭据" })); dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "清除凭据" }));
  await waitFor(() => expect(state.save).toHaveBeenLastCalledWith({ expectedRevision: 6, mode: "clear" }));
  await within(region).findByRole("button", { name: "设置凭据" });
});

test("shared credential conflicts retain input and provide an explicit reload", async () => {
  state.save.mockRejectedValueOnce(new Error("configuration_changed"));
  render(() => <SharedCredentials capability="sls" />);
  fireEvent.click(await screen.findByRole("button", { name: "更新凭据" }));
  const dialog = await screen.findByRole("dialog");
  await fireEvent.input(within(dialog).getByLabelText("共享 SLS AccessKey ID"), { target: { value: "draft-id" } });
  await fireEvent.input(within(dialog).getByLabelText("共享 SLS AccessKey Secret"), { target: { value: "draft-secret" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await within(dialog).findByRole("button", { name: "重新加载" });
  expect(within(dialog).getByLabelText("共享 SLS AccessKey Secret")).toHaveProperty("value", "draft-secret");
  fireEvent.click(within(dialog).getByRole("button", { name: "重新加载" }));
  await waitFor(() => expect(state.load).toHaveBeenCalledTimes(2));
});

for (const failed of [false, true]) test(`identity changes clear shared secret drafts and ignore late ${failed ? "failure" : "success"}`, async () => {
  const [user, setUser] = createSignal({ subject: "alice", role: "developer" }, { ownedWrite: true }); state.user = user;
  let finish!: () => void;
  state.save.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = failed ? () => reject(new Error("old_save_failed")) : () => resolve({ configured: true, revision: 6 }); }));
  render(() => <SharedCredentials capability="sls" />);
  fireEvent.click(await screen.findByRole("button", { name: "更新凭据" })); let dialog = await screen.findByRole("dialog");
  await fireEvent.input(within(dialog).getByLabelText("共享 SLS AccessKey ID"), { target: { value: "old-id" } });
  await fireEvent.input(within(dialog).getByLabelText("共享 SLS AccessKey Secret"), { target: { value: "old-secret" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" })); await waitFor(() => expect(state.save).toHaveBeenCalledOnce());
  state.load.mockResolvedValueOnce({ configured: false, revision: 8 }); setUser({ subject: "bob", role: "developer" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); await screen.findByRole("button", { name: "设置凭据" });
  finish(); await Promise.resolve();
  fireEvent.click(screen.getByRole("button", { name: "设置凭据" })); dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByLabelText("共享 SLS AccessKey Secret")).toHaveProperty("value", "");
  expect(within(dialog).queryByRole("alert")).toBeNull();
});

test("non-developers do not mount shared credential controls or read their status", () => {
  state.user = () => ({ subject: "viewer", role: "product" }); render(() => <SharedCredentials capability="sls" />);
  expect(screen.queryByRole("region", { name: "共享 SLS 凭据" })).toBeNull(); expect(state.load).not.toHaveBeenCalled();
});
