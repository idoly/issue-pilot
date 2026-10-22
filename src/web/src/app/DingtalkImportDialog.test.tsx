import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../data/client", async importOriginal => {
  const actual = await importOriginal<typeof import("../data/client")>();
  const users = [ { subject: "alice", name: "Alice", email: "alice@example.test", role: "developer" as const }, { subject: "bob", name: "Bob", email: "bob@example.test", role: "developer" as const } ];
  return { ...actual,
    loadUsers: vi.fn(async () => users), loadCurrentUser: vi.fn(async () => users.find(user => user.subject === actual.currentUserSubject()) ?? users[0]!),
    loadCatalog: vi.fn(async () => ({ environments: [{ key: "prod", name: "正式" }], services: [{ key: "orders", name: "Orders", deployments: [{ environmentKey: "prod" }] }] })),
    loadDingtalkSource: vi.fn(async () => { const user = users.find(user => user.subject === actual.currentUserSubject()) ?? users[0]!; return { user, url: "https://alidocs.dingtalk.com/i/nodes/base?sheetId=table", assignee: user.name, connection: { available: true, kind: "shared" as const, name: "dingtalk" } }; }),
    previewDingtalkRecords: vi.fn(), importDingtalkRecords: vi.fn(),
  };
});
import { importDingtalkRecords, previewDingtalkRecords, setCurrentUserSubject, type DingtalkPreviewRecord, type DingtalkPreviewResponse } from "../data/client";
import { ApplicationResourcesProvider, useApplicationResources } from "./ApplicationResources";
import { DingtalkImportButton } from "./DingtalkImportDialog";

const user = { subject: "alice", name: "Alice", email: "alice@example.test", role: "developer" as const };
const row = (id: string): DingtalkPreviewRecord => ({ recordId: id, title: `Task ${id}`, description: `Description ${id}`, assignee: "Alice", status: "A待安排", module: "Orders", number: id, creatable: true, token: id.repeat(64) });
function preview(records = [row("a"), row("b")]): DingtalkPreviewResponse {
  return { user, fields: [{ id: "title", name: "工单标题", type: "text" }, { id: "owner", name: "参与人", type: "text" }], columns: { title: "title", assignee: "owner", description: "", status: "", module: "", number: "" }, records, scanned: 10, cursor: "", statusOptions: [], needsMapping: false };
}
function Harness(props: { created: () => void }) {
  const { selectCurrentUser } = useApplicationResources();
  return <><button onClick={() => selectCurrentUser("bob")}>切换为 Bob</button><DingtalkImportButton onCreated={props.created} onOpenIssue={() => true} /></>;
}
beforeEach(() => { vi.clearAllMocks(); setCurrentUserSubject(null); vi.mocked(previewDingtalkRecords).mockResolvedValue(preview()); });
afterEach(() => { cleanup(); setCurrentUserSubject(null); });
async function open(created = vi.fn()) {
  render(() => <ApplicationResourcesProvider><Harness created={created} /></ApplicationResourcesProvider>);
  const button = screen.getByRole("button", { name: "钉钉" });
  await waitFor(() => expect(button).toHaveProperty("disabled", false)); fireEvent.click(button);
  await waitFor(() => expect(screen.getByRole("button", { name: "读取表格" })).toHaveProperty("disabled", false));
  return created;
}

test("navigation opens a read-only preview; only selected records are created and successful rows survive partial failure", async () => {
  const created = await open();
  expect(importDingtalkRecords).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "读取表格" }));
  await screen.findByText("Task a");
  expect(importDingtalkRecords).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "创建选中工单" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("checkbox", { name: "选择全部可导入记录" }));
  vi.mocked(importDingtalkRecords).mockResolvedValue({ user, results: [{ recordId: "a", status: "created", issueKey: "ISSUE-20261021-001" }, { recordId: "b", status: "failed", error: "issue_creation_failed" }] });
  await waitFor(() => expect(screen.getByRole("button", { name: "创建选中工单" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "创建选中工单" }));
  await waitFor(() => expect(importDingtalkRecords).toHaveBeenCalledOnce());
  await screen.findByRole("button", { name: "ISSUE-20261021-001" });
  expect(importDingtalkRecords).toHaveBeenCalledWith(expect.objectContaining({ serviceKey: "orders", workMode: "production_analysis", startAgent: false, records: [{ recordId: "a", token: "a".repeat(64) }, { recordId: "b", token: "b".repeat(64) }] }), expect.any(AbortSignal));
  expect(screen.getByRole("checkbox", { name: "选择 Task a" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("checkbox", { name: "选择 Task b" })).toHaveProperty("checked", true);
  expect(created).toHaveBeenCalledOnce();
});

test("changing identity aborts an outstanding read and ignores its late result", async () => {
  let resolve!: (value: DingtalkPreviewResponse) => void;
  vi.mocked(previewDingtalkRecords).mockImplementationOnce(() => new Promise(value => { resolve = value; }));
  await open();
  fireEvent.click(screen.getByRole("button", { name: "读取表格" }));
  await waitFor(() => expect(previewDingtalkRecords).toHaveBeenCalledOnce());
  const signal = vi.mocked(previewDingtalkRecords).mock.calls[0]![1]!;
  fireEvent.click(screen.getByRole("button", { name: "切换为 Bob" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(signal.aborted).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "钉钉" }));
  await screen.findByText(/当前用户：Bob/);
  resolve(preview());
  await waitFor(() => expect(screen.queryByText("Task a")).toBeNull());
  expect(importDingtalkRecords).not.toHaveBeenCalled();
});
