import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../data/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/client")>();
  const now = new Date().toISOString();
  const service = { key: "srm", name: "SRM" };
  const issue = (id: string, title: string, status: string, retryable = false) => ({
    id, title, description: `${title}描述`, priority: "p1", type: "defect_fix", status,
    assignee: id === "ISSUE-0038" ? null : "陈默", assigneeSubject: id === "ISSUE-0038" ? null : "fixture-user",
    service, createdAt: now, updatedAt: now, repositories: [{ url: "git@example.com:team/srm.git", baseBranch: "prod", workingBranch: "hotfix-issue" }], attachments: [{ id: "attachment-1", fileName: "existing.csv", mediaType: "text/csv", size: 2048, sha256: "a".repeat(64), createdAt: now }], comments: [] as Array<{ id: string; author: string; body: string; createdAt: string }>, ccRecipients: [],
    reporter: { subject: "fixture-user", name: "严欣", email: "owner@example.test" }, environmentKey: "test",
    workspace: { status: retryable ? "failed" : "ready", url: `http://127.0.0.1:18080/?folder=${encodeURIComponent(`/home/coder/state/workspaces/${id.toLowerCase()}`)}`, retryable, bytes: id === "ISSUE-0041" ? 4 * 1024 ** 3 : 0, releasable: id === "ISSUE-0041", releaseBlockedReason: id === "ISSUE-0041" ? null : "workspace_missing" },
  });
  const issues = [
    issue("ISSUE-0042", "结算页提交后订单状态未刷新", "in_progress"),
    issue("ISSUE-0041", "客户导出的 CSV 缺少时区信息", "pending"),
    issue("ISSUE-0038", "批量审批偶发超时", "open", true),
  ];
  const configuration = {
    agentModels: [{ provider: "enterprise-ai", id: "engineering-model", thinkingLevels: ["low", "medium", "high"] }],
    environments: [{ key: "test", name: "测试" }],
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
      key: "srm", name: "SRM", description: "供应商关系管理服务。",
      deployments: [{ environmentKey: "test", baseBranch: "develop", capabilities: ["nacos", "db"], agent: { provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "medium" }, nacos: { serverUrl: "https://nacos.example.test", namespace: "test", group: "DEFAULT_GROUP", dataIds: ["srm-test.yaml", "srm-shared.yaml"], username: "operator", password: "nacos-secret" }, db: { url: "mysql://db.example.test:3306/srm", username: "readonly", password: "db-secret" } }],
      repositories: [{ id: "srm-repository", url: "git@example.com:team/srm.git" }],
    }],
  };
  return {
    ...actual,
    loadPeople: vi.fn(async () => [{ subject: "fixture-user", name: "严欣", email: "owner@example.test" }]),
    loadCurrentUser: vi.fn(async () => ({ subject: "fixture-user", name: "严欣", email: "owner@example.test" })),
    loadConfig: vi.fn(async () => structuredClone(configuration)),
    listIssues: async () => structuredClone(issues),
    loadWorkspaceStats: async () => ({
      totalBytes: 4 * 1024 ** 3,
      policy: { retentionHours: 168, highWaterBytes: 20 * 1024 ** 3, targetBytes: 16 * 1024 ** 3, maintenanceIntervalMinutes: 15 },
      workspaces: [{ issueKey: "ISSUE-0041", issueStatus: "pending", workspaceStatus: "ready", resolvedAt: null, bytes: 4 * 1024 ** 3, releasable: true, blockedReason: null }],
    }),
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
    updateService: vi.fn(async () => undefined),
  };
});

import { App } from "./App";

describe("issue pilot workspace", () => {
  afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

  test("renders issues and data-backed statistics, then opens configuration", async () => {
    const consoleWarning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(() => <App />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "结算页提交后订单状态未刷新" })).toBeTruthy());
    expect(screen.getByRole("radiogroup", { name: "工作台视图" })).toBeTruthy();
    expect(screen.queryByText("生产")).toBeNull();
    const agentRegion = screen.getByRole("region", { name: "ISSUE-0042 Agent 会话" });
    expect(agentRegion.querySelector(".agent-conversation")).toBeTruthy();
    expect(agentRegion.querySelector(".agent-composer")).toBeTruthy();
    expect(agentRegion.querySelector(".agent-meta")?.textContent).toContain("~/.issue-pilot/sessions/issue-0042/runtime");
    expect(screen.getByRole("heading", { name: "代码分支" })).toBeTruthy();
    expect(screen.getByText("hotfix-issue")).toBeTruthy();
    const agentInput = within(agentRegion).getByLabelText("发送给 Agent") as HTMLTextAreaElement;
    const pastedMessage = Array.from({ length: 41 }, (_, index) => `line ${index + 1}`).join("\n");
    fireEvent.paste(agentInput, { clipboardData: { getData: () => pastedMessage } });
    await waitFor(() => expect(agentInput.value).toBe("[paste #1 +41 lines]"));
    expect(within(agentRegion).queryByRole("button", { name: "发送" })).toBeNull();
    fireEvent.keyDown(agentInput, { key: "Enter", code: "Enter", shiftKey: false });
    const { fetchAttachment, sendAgentMessage } = await import("../data/client");
    await waitFor(() => expect(sendAgentMessage).toHaveBeenCalledWith("ISSUE-0042", pastedMessage));
    fireEvent.click(screen.getByRole("button", { name: "在 code-server 中打开工单代码" }));
    const codeServerFrame = await waitFor(() => screen.getByTitle("ISSUE-0042 code-server 编辑器") as HTMLIFrameElement);
    const codeServerUrl = new URL(codeServerFrame.src);
    expect(codeServerUrl.pathname).toBe("/code-server/");
    expect(codeServerUrl.searchParams.get("folder")).toBe("/home/coder/state/workspaces/issue-0042");
    fireEvent.click(screen.getByRole("button", { name: "还原 code-server" }));
    await waitFor(() => expect(screen.queryByTitle("ISSUE-0042 code-server 编辑器")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "预览 existing.csv" }));
    const previewDialog = await waitFor(() => screen.getByRole("dialog", { name: "existing.csv" }));
    await waitFor(() => expect(within(previewDialog).getByText(/42,ready/)).toBeTruthy());
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
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

    fireEvent.input(commentInput, { target: { value: "另一个工单不应继承的草稿" } });
    fireEvent.click(await screen.findByText("ISSUE-0041"));
    await waitFor(() => expect(screen.getByRole("button", { name: "确认解决" })).toBeTruthy());
    const issueActions = document.querySelector(".issue-actions");
    expect(issueActions).toBeTruthy();
    expect([...issueActions!.children].map((element) => element.textContent)).toEqual(["确认解决", "编辑工单"]);
    expect([...issueActions!.children].every((element) => element.tagName === "BUTTON")).toBe(true);
    expect(screen.queryByRole("button", { name: "释放工作区" })).toBeNull();
    fireEvent.click(screen.getByText("ISSUE-0038").closest("button")!);
    await waitFor(() => expect((screen.getByLabelText("添加评论或备注") as HTMLTextAreaElement).value).toBe(""));
    const retryButton = await waitFor(() => screen.getByRole("button", { name: "重试处理" }));
    fireEvent.click(retryButton);
    await waitFor(() => expect(screen.queryByRole("button", { name: "重试处理" })).toBeNull());

    fireEvent.click(screen.getByRole("radio", { name: "统计" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "工单处理统计" })).toBeTruthy());
    const submitted = await waitFor(() => screen.getByText("提出工单"));
    expect(submitted.parentElement?.textContent).toContain("3");
    expect(screen.getByText("已完成").parentElement?.textContent).toContain("0");
    expect(screen.getByRole("heading", { name: "Workspace 存储" })).toBeTruthy();
    expect(screen.getByText("每 15 分钟自动检查 · 已解决保留 7 天")).toBeTruthy();
    expect(screen.getByText("20.0 GB")).toBeTruthy();
    expect(screen.getByText("解决后纳入")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "个人处理情况" })).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "配置" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "配置" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: /拖动排序/ })).toBeNull();
    expect(screen.getByRole("button", { name: "SRM" })).toBeTruthy();
    expect(screen.getByText("供应商关系管理服务。")).toBeTruthy();
    const deploymentHead = document.querySelector(".deployment-detail-head");
    expect([...deploymentHead!.children].map((item) => item.textContent)).toEqual(["环境", "分支", "模型", "能力"]);
    expect(document.querySelector('.deployment-detail-row [data-label="模型"]')?.textContent).toContain("enterprise-ai/engineering-model");

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
    expect(screen.getByLabelText("model provider 1")).toBeTruthy();
    expect(screen.getByLabelText("model id 1")).toBeTruthy();
    expect(screen.getByLabelText("model thinkingLevel 1")).toBeTruthy();
    const modelButton = within(serviceDialog).getByRole("button", { name: "model" }) as HTMLButtonElement;
    expect(modelButton.disabled).toBe(true);
    expect(modelButton.getAttribute("aria-pressed")).toBe("true");
    const nacosServerUrl = screen.getByLabelText("nacos serverUrl 1");
    expect((screen.getByLabelText("nacos dataIds 1") as HTMLInputElement).value).toBe("srm-test.yaml, srm-shared.yaml");
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
    expect(savedService?.deployments[0]?.agent).toEqual({ provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "medium" });
    expect(savedService?.deployments[0]?.db?.password).toBe("db-secret");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑服务" })).toBeNull());
    expect(client.loadConfig).toHaveBeenCalledTimes(2);
    expect(client.loadPeople).toHaveBeenCalledTimes(1);
    expect(client.loadCurrentUser).toHaveBeenCalledTimes(1);
    expect(consoleWarning.mock.calls.flat().filter((message) => String(message).includes("STRICT_READ_UNTRACKED"))).toEqual([]);
  });
});
