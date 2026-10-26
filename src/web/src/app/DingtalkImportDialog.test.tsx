import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
vi.mock("../data/client", async original => {
  const actual = await original<typeof import("../data/client")>();
  const users = [{ subject: "alice", name: "Alice", email: "alice@example.test", role: "developer" as const }, { subject: "bob", name: "Bob", email: "bob@example.test", role: "developer" as const }];
  return { ...actual, loadUsers: vi.fn(async () => users), loadCurrentUser: vi.fn(async () => users.find(user => user.subject === actual.currentUserSubject()) ?? users[0]!), loadCatalog: vi.fn(async () => ({ environments: [{ key: "prod", name: "Prod" }], services: [{ key: "orders", name: "Orders", deployments: [{ environmentKey: "prod" }] }, { key: "inventory", name: "Inventory", deployments: [{ environmentKey: "prod" }] }] })), loadDingtalkSource: vi.fn(async () => ({ user: users.find(user => user.subject === actual.currentUserSubject()) ?? users[0]!, url: "", connection: { available: true, name: "dingtalk" } })), importDingtalkRecords: vi.fn() };
});
import { importDingtalkRecords, setCurrentUserSubject, type DingtalkImportResponse } from "../data/client";
import { ApplicationResourcesProvider, useApplicationResources } from "./ApplicationResources";
import { DingtalkImportButton } from "./DingtalkImportDialog";
const user = { subject: "alice", name: "Alice", email: "alice@example.test", role: "developer" as const };
const url = "https://alidocs.dingtalk.com/notable/record?dentryUuid=base&sheetId=table&rowId=one";
function Harness(props: { created: () => void; opened: (key: string) => boolean }) { const { selectCurrentUser } = useApplicationResources(); return <><button onClick={() => selectCurrentUser("bob")}>切换为 Bob</button><DingtalkImportButton onCreated={props.created} onOpenIssue={props.opened} /></>; }
beforeEach(() => { vi.clearAllMocks(); setCurrentUserSubject(null); });
afterEach(() => { cleanup(); setCurrentUserSubject(null); });
async function open(created = vi.fn(), opened = vi.fn(() => true)) {
  render(() => <ApplicationResourcesProvider><Harness created={created} opened={opened} /></ApplicationResourcesProvider>);
  await waitFor(() => expect(screen.getByRole("button", { name: "钉钉" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "钉钉" }));
  await waitFor(() => expect(screen.getByRole("textbox", { name: "钉钉记录链接" })).toHaveProperty("disabled", false));
  return { created, opened };
}
for (const status of ["created", "existing"] as const) test(`closes the import dialog and opens the ${status} Issue`, async () => {
  const { created, opened } = await open();
  expect(screen.queryByText(/当前用户：/)).toBeNull();
  expect(screen.queryByRole("checkbox", { name: "创建后立即启动 Agent" })).toBeNull();
  expect(screen.queryByRole("button", { name: "读取表格" })).toBeNull();
  expect(screen.queryByRole("table")).toBeNull();
  expect(screen.queryByLabelText("钉钉标题字段")).toBeNull();
  fireEvent.input(screen.getByRole("textbox", { name: "钉钉记录链接" }), { target: { value: url } });
  vi.mocked(importDingtalkRecords).mockResolvedValueOnce({ user, status, issueKey: "ISSUE-20261022-001" });
  await waitFor(() => expect(screen.getByRole("button", { name: "导入工单" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "导入工单" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "导入" })).toBeNull());
  expect(importDingtalkRecords).toHaveBeenCalledWith({ url, serviceKey: "orders", workMode: "production_analysis", priority: "p2", startAgent: true }, expect.any(AbortSignal));
  expect(opened).toHaveBeenCalledExactlyOnceWith("ISSUE-20261022-001");
  expect(created).toHaveBeenCalledTimes(status === "created" ? 1 : 0);
});
test("keeps the imported Issue available when navigation is declined", async () => {
  const { created, opened } = await open(vi.fn(), vi.fn(() => false));
  fireEvent.input(screen.getByRole("textbox", { name: "钉钉记录链接" }), { target: { value: url } });
  vi.mocked(importDingtalkRecords).mockResolvedValueOnce({ user, status: "created", issueKey: "ISSUE-20261022-001" });
  await waitFor(() => expect(screen.getByRole("button", { name: "导入工单" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "导入工单" }));
  const issueLink = await screen.findByRole("button", { name: "ISSUE-20261022-001" });
  expect(screen.getByRole("dialog", { name: "导入" })).toBeTruthy();
  expect(created).toHaveBeenCalledOnce();
  expect(screen.getByRole("textbox", { name: "钉钉记录链接" })).toHaveProperty("value", "");
  opened.mockReturnValue(true);
  fireEvent.click(issueLink);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "导入" })).toBeNull());
  expect(opened).toHaveBeenCalledTimes(2);
  expect(importDingtalkRecords).toHaveBeenCalledOnce();
});
test("shows a useful import failure and keeps the entered link for retry", async () => {
  await open(); fireEvent.input(screen.getByRole("textbox", { name: "钉钉记录链接" }), { target: { value: url } });
  vi.mocked(importDingtalkRecords).mockRejectedValueOnce(new Error("dingtalk_fields_changed"));
  await waitFor(() => expect(screen.getByRole("button", { name: "导入工单" })).toHaveProperty("disabled", false)); fireEvent.click(screen.getByRole("button", { name: "导入工单" }));
  expect((await screen.findByRole("alert")).textContent).toContain("个人或共享字段映射");
  expect(screen.getByRole("textbox", { name: "钉钉记录链接" })).toHaveProperty("value", url);
});
test("identity changes abort the old import and ignore its late result", async () => {
  let resolve!: (value: DingtalkImportResponse) => void;
  vi.mocked(importDingtalkRecords).mockImplementationOnce(() => new Promise(finish => { resolve = finish; }));
  const { created, opened } = await open(); fireEvent.input(screen.getByRole("textbox", { name: "钉钉记录链接" }), { target: { value: url } });
  await waitFor(() => expect(screen.getByRole("button", { name: "导入工单" })).toHaveProperty("disabled", false)); fireEvent.click(screen.getByRole("button", { name: "导入工单" }));
  await waitFor(() => expect(importDingtalkRecords).toHaveBeenCalledOnce()); const signal = vi.mocked(importDingtalkRecords).mock.calls[0]![1]!;
  fireEvent.click(screen.getByRole("button", { name: "切换为 Bob" })); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); expect(signal.aborted).toBe(true);
  resolve({ user, status: "created", issueKey: "ISSUE-20261022-001" }); await Promise.resolve(); expect(created).not.toHaveBeenCalled(); expect(opened).not.toHaveBeenCalled();
});
