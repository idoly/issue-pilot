import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../data/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/client")>();
  const now = new Date().toISOString();
  const service = { key: "srm", name: "SRM" };
  const issue = (id: string, title: string, status: string, retryable = false) => ({
    id, title, description: `${title}描述`, priority: "p1", type: "incident", status,
    assignee: id === "ISSUE-0038" ? null : "陈默", assigneeSubject: id === "ISSUE-0038" ? null : "fixture-user",
    service, version: 1, createdAt: now, updatedAt: now, repositories: [], attachments: [{ id: "attachment-1", fileName: "existing.csv", mediaType: "text/csv", size: 2048, sha256: "a".repeat(64), createdAt: now }], comments: [] as Array<{ id: string; author: string; body: string; createdAt: string }>, ccRecipients: [],
    reporter: { subject: "fixture-user", name: "严欣", email: "owner@example.test" }, environmentKey: "test",
    workspace: { status: retryable ? "failed" : "ready", url: null, retryable }, agentSession: null,
  });
  const issues = [
    issue("ISSUE-0042", "结算页提交后订单状态未刷新", "in_progress"),
    issue("ISSUE-0041", "客户导出的 CSV 缺少时区信息", "pending"),
    issue("ISSUE-0038", "批量审批偶发超时", "open", true),
  ];
  const configuration = {
    environments: [{ id: "env-test", key: "test", name: "测试", kind: "test", scope: "global" }],
    capabilityCatalog: [
      { key: "playwright" },
      { key: "nacos" },
      { key: "db" },
      { key: "redis" },
      { key: "mq" },
      { key: "es" },
      { key: "sls" },
    ],
    services: [{
      id: "service-srm", key: "srm", name: "SRM", description: "供应商关系管理服务。", scope: "global", environmentIds: ["env-test"],
      deployments: [{ id: "srm-test", environmentId: "env-test", baseBranch: "develop", capabilities: ["nacos", "db"], nacos: { serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP", username: "operator", password: "nacos-secret" }, db: { url: "mysql://db.example.test:3306/srm", username: "readonly", password: "db-secret" } }],
      repositories: [{ id: "srm-repository", kind: "backend", url: "git@example.com:team/srm.git" }],
    }],
  };
  return {
    ...actual,
    loadPeople: async () => [{ subject: "fixture-user", name: "严欣", email: "owner@example.test" }],
    loadConfig: async () => structuredClone(configuration),
    listIssues: async () => structuredClone(issues),
    getIssue: async (id: string) => structuredClone(issues.find((item) => item.id === id)),
    addIssueComment: async (id: string, body: string) => {
      const selected = issues.find((item) => item.id === id)!;
      const comment = { id: `comment-${selected.comments.length + 1}`, author: "fixture-user", body, createdAt: now };
      selected.comments.push(comment);
      return structuredClone(comment);
    },
    retryIssue: async (id: string) => { const selected = issues.find((item) => item.id === id); if (selected) selected.workspace.retryable = false; },
    fetchAttachment: vi.fn(async () => new Blob(["order_id,status\n42,ready\n"], { type: "text/csv" })),
    sendAgentMessage: vi.fn(async () => undefined),
    abortAgent: vi.fn(async () => undefined),
    updateService: vi.fn(async () => undefined),
  };
});

import { App } from "./App";

describe("issue pilot workspace", () => {
  afterEach(() => document.body.replaceChildren());

  test("renders issues and data-backed statistics, then opens configuration", async () => {
    render(() => <App />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "结算页提交后订单状态未刷新" })).toBeTruthy());
    expect(screen.getByRole("radiogroup", { name: "工作台视图" })).toBeTruthy();
    expect(screen.queryByText("生产")).toBeNull();
    const agentRegion = screen.getByRole("region", { name: "ISSUE-0042 Agent 会话" });
    expect(agentRegion.querySelector(".agent-terminal-output")).toBeTruthy();
    expect(agentRegion.querySelector(".agent-terminal-input")).toBeTruthy();
    expect(agentRegion.querySelector(".agent-terminal-footer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "预览 existing.csv" }));
    const previewDialog = await waitFor(() => screen.getByRole("dialog", { name: "existing.csv" }));
    await waitFor(() => expect(within(previewDialog).getByText(/42,ready/)).toBeTruthy());
    expect(within(previewDialog).getByRole("button", { name: "复制文字" })).toBeTruthy();
    fireEvent.click(within(previewDialog).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "existing.csv" })).toBeNull());
    const commentInput = screen.getByLabelText("添加评论或备注") as HTMLTextAreaElement;
    fireEvent.input(commentInput, { target: { value: "**供其他用户查看的备注**" } });
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "评论编辑模式" })).getByRole("radio", { name: "预览" }));
    await waitFor(() => expect(screen.getByText("供其他用户查看的备注").tagName).toBe("STRONG"));
    const publishComment = screen.getByRole("button", { name: "发布评论" }) as HTMLButtonElement;
    await waitFor(() => expect(publishComment.disabled).toBe(false));
    fireEvent.click(publishComment);
    await waitFor(() => expect(screen.getByText("供其他用户查看的备注")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "编辑工单" }));
    const issueDialog = await waitFor(() => screen.getByRole("dialog", { name: "编辑工单" }));
    fireEvent.click(within(issueDialog).getByRole("button", { name: "放大编辑工单描述" }));
    const descriptionDialog = await waitFor(() => screen.getByRole("dialog", { name: "编辑描述" }));
    fireEvent.input(within(descriptionDialog).getByLabelText("放大描述编辑器"), { target: { value: "# 放大后的详细描述" } });
    fireEvent.click(within(descriptionDialog).getByRole("radio", { name: "预览" }));
    await waitFor(() => expect(within(descriptionDialog).getByRole("heading", { name: "放大后的详细描述" })).toBeTruthy());
    fireEvent.click(within(descriptionDialog).getByRole("button", { name: "应用" }));
    await waitFor(() => expect((within(issueDialog).getByLabelText("编辑工单描述") as HTMLTextAreaElement).value).toBe("# 放大后的详细描述"));
    expect(within(issueDialog).getByText("existing.csv")).toBeTruthy();
    expect(within(issueDialog).getByText("1")).toBeTruthy();
    const attachmentInput = within(issueDialog).getByLabelText("编辑工单选择附件") as HTMLInputElement;
    Object.defineProperty(attachmentInput, "files", { configurable: true, value: [new File(["details"], "details.txt", { type: "text/plain" })] });
    fireEvent.change(attachmentInput);
    await waitFor(() => expect(within(issueDialog).getByText("details.txt")).toBeTruthy());
    expect(within(issueDialog).queryByText("已有附件")).toBeNull();
    expect(within(issueDialog).queryByText("待上传")).toBeNull();
    expect(within(issueDialog).queryByText("已上传")).toBeNull();
    fireEvent.click(within(issueDialog).getByRole("button", { name: "移除existing.csv" }));
    await waitFor(() => expect(within(issueDialog).queryByText("existing.csv")).toBeNull());
    expect(within(issueDialog).getByText("1")).toBeTruthy();
    fireEvent.click(within(issueDialog).getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑工单" }));
    const reopenedIssueDialog = await waitFor(() => screen.getByRole("dialog", { name: "编辑工单" }));
    expect(within(reopenedIssueDialog).getByText("existing.csv")).toBeTruthy();
    expect(within(reopenedIssueDialog).getByText("1")).toBeTruthy();
    fireEvent.click(within(reopenedIssueDialog).getByRole("button", { name: "取消" }));

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
    expect(screen.queryByLabelText("Agent Provider 1")).toBeNull();
    expect(screen.queryByLabelText("Agent Model 1")).toBeNull();
    const nacosServerUrl = screen.getByLabelText("nacos serverUrl 1");
    const databaseUrl = screen.getByLabelText("db url 1");
    expect(nacosServerUrl.closest("label")?.querySelector(".required-field")?.textContent).toBe("serverUrl");
    expect(databaseUrl.closest("label")?.querySelector(".required-field")?.textContent).toBe("url");
    fireEvent.click(within(serviceDialog).getByRole("button", { name: "es" }));
    const esUrl = await waitFor(() => screen.getByLabelText("es url 1"));
    expect(esUrl.closest("label")?.querySelector(".required-field")?.textContent).toBe("url");
    expect(screen.getByLabelText("es username 1")).toBeTruthy();
    expect(screen.getByLabelText("es password 1")).toBeTruthy();
    expect(screen.queryByLabelText(/es clusterNodes/i)).toBeNull();
    expect(screen.queryByLabelText(/es indexes/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "nacos" }));
    await waitFor(() => expect(screen.queryByLabelText("nacos serverUrl 1")).toBeNull());
    expect(screen.getByLabelText("db url 1")).toBeTruthy();
    fireEvent.click(within(serviceDialog).getByRole("button", { name: "es" }));
    await waitFor(() => expect(screen.queryByLabelText("es url 1")).toBeNull());
    fireEvent.click(within(serviceDialog).getByRole("button", { name: "保存" }));
    const client = await import("../data/client");
    await waitFor(() => {
      const alert = within(serviceDialog).queryByRole("alert");
      if (alert) throw new Error(alert.textContent ?? "service save failed");
      expect(client.updateService).toHaveBeenCalled();
    });
    const savedService = vi.mocked(client.updateService).mock.calls.at(-1)?.[1];
    expect(savedService?.deployments[0]?.agent).toBeUndefined();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑服务" })).toBeNull());

  });
});
