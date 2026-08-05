import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../data/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/client")>();
  const now = new Date().toISOString();
  const service = { key: "srm", name: "SRM" };
  const issue = (id: string, title: string, status: string, retryable = false) => ({
    id, title, description: `${title}描述`, priority: "p1", type: "incident", status,
    assignee: id === "ISSUE-0038" ? null : "陈默", assigneeSubject: id === "ISSUE-0038" ? null : "fixture-user",
    service, version: 1, createdAt: now, updatedAt: now, repositories: [], attachments: [], comments: [], ccRecipients: [],
    reporter: { subject: "fixture-user", name: "严欣", email: "owner@example.test" }, environmentKey: "test",
    workspace: { status: retryable ? "failed" : "ready", url: null, retryable }, agentSession: null, terminalTranscript: null,
  });
  const issues = [
    issue("ISSUE-0042", "结算页提交后订单状态未刷新", "in_progress"),
    issue("ISSUE-0041", "客户导出的 CSV 缺少时区信息", "pending"),
    issue("ISSUE-0038", "批量审批偶发超时", "open", true),
  ];
  const configuration = {
    environments: [{ id: "env-test", key: "test", name: "测试", kind: "test", scope: "global" }],
    capabilityCatalog: [
      { key: "configuration_read", label: "配置读取", description: "读取配置" },
      { key: "database_read", label: "数据库读取", description: "读取数据库" },
    ],
    services: [{
      id: "service-srm", key: "srm", name: "SRM", description: "供应商关系管理服务。", scope: "global", environmentIds: ["env-test"],
      deployments: [{ id: "srm-test", environmentId: "env-test", baseBranch: "develop", capabilities: ["configuration_read", "database_read"] }],
      repositories: [{ id: "srm-repository", kind: "backend", url: "git@example.com:team/srm.git" }],
    }],
  };
  return {
    ...actual,
    loadPeople: async () => [{ subject: "fixture-user", name: "严欣", email: "owner@example.test" }],
    loadConfig: async () => structuredClone(configuration),
    listIssues: async () => structuredClone(issues),
    getIssue: async (id: string) => structuredClone(issues.find((item) => item.id === id)),
    retryIssue: async (id: string) => { const selected = issues.find((item) => item.id === id); if (selected) selected.workspace.retryable = false; },
  };
});

import { App } from "./App";

describe("issue pilot workspace", () => {
  afterEach(() => document.body.replaceChildren());

  test("renders issues and data-backed statistics, then opens configuration", async () => {
    render(() => <App />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "结算页提交后订单状态未刷新" })).toBeTruthy());
    expect(screen.getByRole("region", { name: "ISSUE-0042 pi 终端" })).toBeTruthy();

    fireEvent.click(screen.getByText("ISSUE-0038").closest("button")!);
    const retryButton = await waitFor(() => screen.getByRole("button", { name: "重试处理" }));
    fireEvent.click(retryButton);
    await waitFor(() => expect(screen.queryByRole("button", { name: "重试处理" })).toBeNull());

    fireEvent.click(screen.getByRole("radio", { name: "统计" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "工单处理统计" })).toBeTruthy());
    const submitted = await waitFor(() => screen.getByText("提出工单"));
    expect(submitted.parentElement?.textContent).toContain("3");
    expect(screen.getByText("已完成").parentElement?.textContent).toContain("0");
    expect(screen.getByRole("heading", { name: "个人处理情况" })).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "配置" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "配置" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "SRM" })).toBeTruthy();
    expect(screen.getByText("供应商关系管理服务。")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "编辑服务" }));
    const serviceDialog = await waitFor(() => screen.getByRole("dialog", { name: "编辑服务" }));
    expect(screen.queryByLabelText("服务类型")).toBeNull();
    expect(serviceDialog.textContent).toContain("环境部署");
    const repositoryInput = screen.getByLabelText("仓库地址 1") as HTMLInputElement;
    repositoryInput.focus();
    fireEvent.input(repositoryInput, { target: { value: "git@example.test:team/updated.git" } });
    expect(document.activeElement).toBe(repositoryInput);
    expect(repositoryInput.value).toBe("git@example.test:team/updated.git");
    const branchInput = screen.getByLabelText("部署分支 1") as HTMLInputElement;
    branchInput.focus();
    fireEvent.input(branchInput, { target: { value: "release/test" } });
    expect(document.activeElement).toBe(branchInput);
    expect(branchInput.value).toBe("release/test");
    const configurationCapability = [...serviceDialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"][value="configuration_read"]')].find((input) => input.checked)!;
    const databaseCapability = [...serviceDialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"][value="database_read"]')].find((input) => input.checked)!;
    expect(configurationCapability.checked).toBe(true);
    expect(databaseCapability.checked).toBe(true);
    fireEvent.click(configurationCapability);
    expect(configurationCapability.checked).toBe(false);
    expect(databaseCapability.checked).toBe(true);

  });
});
