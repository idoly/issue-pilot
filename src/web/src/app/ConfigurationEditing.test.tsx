import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Config } from "../data/client";

const state = vi.hoisted(() => ({ configuration: undefined as unknown as () => Config, replaceConfiguration: undefined as unknown as (value: Config) => void, mysql: vi.fn(), repositories: vi.fn(), description: vi.fn(), refresh: vi.fn(), catalog: vi.fn(), save: vi.fn(), create: vi.fn() }));
vi.mock("./ApplicationResources", () => ({ useApplicationResources: () => ({ currentUser: () => ({ subject: "alice", role: "developer" }), configuration: state.configuration, configurationLoaded: () => true, refreshConfiguration: state.refresh, refreshCatalog: state.catalog, configurationError: () => "" }) }));
vi.mock("../data/client", async original => ({ ...await original<typeof import("../data/client")>(), loadServiceDbHubTargets: state.mysql, loadRepositories: state.repositories, loadServiceConfigurationDescription: state.description, updateService: state.save, createService: state.create }));
import { ConfigurationView } from "./ConfigurationView";

const mysql = { host: "db.example.test", port: 3306, username: "reader", password: "fixture-old-secret", database: "orders" };
function configuration(): Config {
  return {
    agent: { provider: "fixture", model: "model", thinkingLevel: "medium", codemode: "off", runtime: {} }, agentModels: [],
    environments: [{ key: "dev", name: "开发" }, { key: "test", name: "测试" }, { key: "prod", name: "正式" }],
    services: [{ key: "orders", name: "Orders", description: "", context: "", revision: 1, repositories: [{ id: "repo", alias: "app", url: "git@example.test:team/app.git" }], deployments: ["dev", "test", "prod"].map(environmentKey => ({ environmentKey, capabilities: [], repositoryBranches: [{ repositoryId: "repo", repositoryAlias: "app", baseBranch: "main" }], ...(environmentKey === "prod" ? { mysql: [{ host: mysql.host, port: mysql.port, username: mysql.username, database: mysql.database, passwordConfigured: true }] } : {}) })) }],
  };
}
beforeEach(() => {
  const [value, setValue] = createSignal(configuration(), { ownedWrite: true }); state.configuration = value; state.replaceConfiguration = next => { setValue(next); };
  state.repositories.mockResolvedValue([{ id: "catalog", name: "App", url: "git@example.test:team/app.git", services: [] }]);
  state.description.mockResolvedValue({ context: "" }); state.mysql.mockResolvedValue({ revision: 1, deployments: [{ environmentKey: "prod", dbhub: [{ ...mysql, type: "mysql" }] }] });
  state.refresh.mockImplementation(async () => { const next = configuration(); setValue(next); return next; });
  state.catalog.mockResolvedValue({}); state.create.mockResolvedValue({ key: "new" }); state.save.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

for (const outcome of ["success", "failure"] as const) test(`closing a private MySQL load invalidates its late ${outcome} before creating another service`, async () => {
  let finish!: () => void;
  state.mysql.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = outcome === "success" ? () => resolve({ revision: 1, deployments: [{ environmentKey: "prod", dbhub: [{ ...mysql, type: "mysql" }] }] }) : () => reject(new Error("old_mysql_load_failed")); }));
  render(() => <ConfigurationView />);
  fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
  let dialog = await screen.findByRole("dialog"); await waitFor(() => expect(state.mysql).toHaveBeenCalled());
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" })); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "添加" })); dialog = await screen.findByRole("dialog", { name: "添加服务" });
  fireEvent.input(within(dialog).getByLabelText("服务名称"), { target: { value: "New draft" } });
  finish(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(within(dialog).queryByRole("alert")).toBeNull();
  fireEvent.click(within(dialog).getByLabelText("关联仓库")); fireEvent.click(await screen.findByRole("option", { name: /App/ }));
  await waitFor(() => expect(within(dialog).getByLabelText("关联仓库").closest(".ui-select")?.textContent).toContain("App"));
  fireEvent.click(within(dialog).getByRole("button", { name: "添加" }));
  await waitFor(() => expect(state.create).toHaveBeenCalled());
  const input = state.create.mock.calls[0]![0]; expect(input.name).toBe("New draft");
  expect(input.deployments.every((row: { mysql?: unknown[] }) => !row.mysql?.length)).toBe(true);
  expect(JSON.stringify(input)).not.toContain(mysql.password);
});

test("a private version conflict offers reload and a fresh editor can save and close normally", async () => {
  state.mysql.mockResolvedValue({ revision: 2, deployments: [{ environmentKey: "prod", dbhub: [{ ...mysql, type: "mysql" }] }] });
  state.refresh.mockImplementation(async () => { const next = configuration(); next.services[0]!.revision = 2; state.replaceConfiguration(next); return next; });
  render(() => <ConfigurationView />);
  fireEvent.click(await screen.findByRole("button", { name: "编辑" })); let dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toContain("配置已更新"));
  expect(within(dialog).getByRole("button", { name: "保存" })).toHaveProperty("disabled", true);
  fireEvent.click(within(dialog).getByRole("button", { name: "重新加载" }));
  await waitFor(() => expect(state.refresh).toHaveBeenCalled()); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(await screen.findByRole("button", { name: "编辑" })); dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "保存" })).toHaveProperty("disabled", false));
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); expect(state.save.mock.calls[0]![1].expectedRevision).toBe(2);
  fireEvent.click(screen.getByRole("button", { name: "添加" }));
  const nextDialog = await screen.findByRole("dialog", { name: "添加服务" });
  await waitFor(() => expect(within(nextDialog).getByRole("button", { name: "添加" })).toHaveProperty("disabled", false));
});

test("a stale save retains its draft and shows reload inside the edit dialog", async () => {
  state.save.mockRejectedValueOnce(new Error("configuration_changed")); render(() => <ConfigurationView />);
  fireEvent.click(await screen.findByRole("button", { name: "编辑" })); const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "保存" })).toHaveProperty("disabled", false));
  fireEvent.input(within(dialog).getByLabelText("服务名称"), { target: { value: "Retained draft" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await within(dialog).findByRole("alert"); expect(within(dialog).getByLabelText("服务名称")).toHaveProperty("value", "Retained draft");
  expect(within(dialog).getByRole("button", { name: "重新加载" })).toBeTruthy();
});

for (const failed of ["configuration", "catalog"] as const) test(`a successful service save reports ${failed} refresh failure without offering to resubmit`, async () => {
  const refresh = failed === "configuration" ? state.refresh : state.catalog;
  refresh.mockRejectedValueOnce(new Error("refresh_unavailable"));
  render(() => <ConfigurationView />);
  fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(within(dialog).getByRole("button", { name: "保存" })).toHaveProperty("disabled", false));
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const error = await screen.findByRole("alert");
  expect(error.textContent).toContain("已保存"); expect(error.textContent).toContain("refresh_unavailable");
  expect(state.save).toHaveBeenCalledTimes(1);
  fireEvent.click(within(error).getByRole("button", { name: "重新加载" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(state.save).toHaveBeenCalledTimes(1);
});

test("DBHub converts existing MySQL targets and saves PostgreSQL fields with the selected default port", async () => {
  render(() => <ConfigurationView />);
  fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
  const dialog = await screen.findByRole("dialog");
  await waitFor(() => expect(state.mysql).toHaveBeenCalledOnce());
  fireEvent.click(await within(dialog).findByRole("button", { name: "展开部署3" }));
  const type = await within(dialog).findByRole("combobox", { name: "dbhub prod 1 type" });
  expect(within(dialog).getByLabelText("dbhub prod 1 host")).toHaveProperty("value", mysql.host);
  expect(dialog.textContent).toContain("PostgreSQL、MySQL、MariaDB、SQL Server、Oracle");
  fireEvent.click(type);
  fireEvent.click(await screen.findByRole("option", { name: /^PostgreSQL$/ }));
  await waitFor(() => expect(within(dialog).getByLabelText("dbhub prod 1 port")).toHaveProperty("value", "5432"));
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await waitFor(() => expect(state.save).toHaveBeenCalledOnce());
  const deployment = state.save.mock.calls[0]![1].deployments.find((row: { environmentKey: string }) => row.environmentKey === "prod");
  expect(deployment.dbhub).toEqual([{ ...mysql, type: "postgres", port: 5432 }]);
  expect(deployment.mysql).toBeUndefined();
});

test("DBHub is an optional service ability and can be added and removed like the others", async () => {
  const value = configuration();
  for (const deployment of value.services[0]!.deployments) delete deployment.mysql;
  state.replaceConfiguration(value);
  render(() => <ConfigurationView />);
  fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
  const dialog = await screen.findByRole("dialog");
  await fireEvent.click(within(dialog).getByRole("button", { name: "展开部署2" }));
  const environment = within(dialog).getByLabelText("部署 2 环境").closest(".service-deployment-row")!;
  expect(within(environment as HTMLElement).queryByRole("button", { name: "添加 DBHub" })).toBeNull();
  expect(within(environment as HTMLElement).getByRole("checkbox", { name: "DMS" })).toBeTruthy();
  await fireEvent.click(within(environment as HTMLElement).getByRole("checkbox", { name: "DBHub" }));
  const host = await within(environment as HTMLElement).findByLabelText("dbhub test 1 host");
  await fireEvent.input(host, { target: { value: "retained-draft.example.test" } });
  await fireEvent.click(within(environment as HTMLElement).getByRole("checkbox", { name: "DBHub" }));
  expect(within(environment as HTMLElement).queryByLabelText("dbhub test 1 host")).toBeNull();
  expect(within(environment as HTMLElement).getByRole("checkbox", { name: "DBHub" })).toBeTruthy();
  await fireEvent.click(within(environment as HTMLElement).getByRole("checkbox", { name: "DBHub" }));
  expect(await within(environment as HTMLElement).findByLabelText("dbhub test 1 host")).toHaveProperty("value", "retained-draft.example.test");
  const summary = within(dialog).getByLabelText("部署 2 能力");
  expect(within(summary).getAllByRole("checkbox")).toHaveLength(3);
  expect(summary.querySelector(".capability-labels")).toBeNull();
  await fireEvent.click(within(dialog).getByRole("button", { name: "收起部署2" }));
  expect(within(summary).queryByRole("checkbox")).toBeNull();
  expect(summary.querySelector("code")?.textContent).toBe("DBHub");
  await fireEvent.click(within(dialog).getByRole("button", { name: "展开部署2" }));
  expect(within(summary).getByRole("checkbox", { name: "DBHub" })).toHaveProperty("checked", true);
  expect(await within(environment as HTMLElement).findByLabelText("dbhub test 1 host")).toHaveProperty("value", "retained-draft.example.test");
});
