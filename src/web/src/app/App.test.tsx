import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../data/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/client")>();
  const { issuePilotConfig } = await import("../../../../issue-pilot.config.ts");
  const now = new Date().toISOString();
  const service = { key: "srm", name: "SRM" };
  const issue = (id: string, title: string, status: string, retryable = false) => ({
    id, title, description: `${title}描述`, priority: "p1", type: "defect_fix", status,
    workspaceStatus: retryable ? "failed" : status === "in_progress" ? "running" : "ready", agentRunning: status === "in_progress", resolvedAt: status === "resolved" ? now : null,
    assignee: id === "ISSUE-20260810-038" ? "刘宜展" : "严欣", assigneeSubject: id === "ISSUE-20260810-038" ? "second-user" : "fixture-user",
    service, createdAt: now, updatedAt: now, repositories: [{ name: "srm", url: "git@example.com:team/srm.git", baseBranch: "prod", workingBranch: "hotfix-issue" as string | null }], attachments: [{ id: "attachment-1", fileName: "existing.csv", mediaType: "text/csv", size: 2048, sha256: "a".repeat(64), createdAt: now }], comments: [] as Array<{ id: string; author: string; body: string; createdAt: string }>, ccRecipients: [],
    reporter: { subject: "fixture-user", name: "严欣", email: "owner@example.test" }, environmentKey: "test",
    workspace: { status: retryable ? "failed" : "ready", sourceAvailable: true, retryable },
  });
  const issues = [
    issue("ISSUE-20260810-042", "结算页提交后订单状态未刷新", "in_progress"),
    issue("ISSUE-20260810-041", "客户导出的 CSV 缺少时区信息", "pending"),
    issue("ISSUE-20260810-038", "批量审批偶发超时", "open", true),
  ];
  issues[1]!.type = "smart_analysis";
  issues[1]!.environmentKey = "prod";
  issues[1]!.service = { key: "orders", name: "Orders" };
  issues[1]!.repositories[0]!.workingBranch = null;
  const managedUsers = [
    { subject: "fixture-user", name: "严欣", email: "owner@example.test", active: true, createdAt: now, updatedAt: now },
    { subject: "second-user", name: "刘宜展", email: "lyz@example.test", active: true, createdAt: now, updatedAt: now },
  ];
  const configuration = {
    agent: { provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "medium" },
    agentModels: [{ provider: "enterprise-ai", id: "engineering-model", thinkingLevels: ["low", "medium", "high"] }],
    environments: [{ key: "test", name: "测试" }, { key: "prod", name: "正式" }],
    services: [{
      key: "srm", name: "SRM", description: "供应商关系管理服务。",
      deployments: [{ environmentKey: "test", repositoryBranches: [{ repositoryId: "srm-repository", repositoryAlias: "srm", baseBranch: "develop" }], capabilities: ["nacos", "db", "dms"], nacos: { serverUrl: "https://nacos.example.test", namespace: "test", group: issuePilotConfig.defaults.nacos.group, dataIds: ["srm-test.yaml", "srm-shared.yaml"], username: "operator", password: "nacos-secret", credentialConfigured: true }, db: { url: "mysql://db.example.test:3306/srm", username: "readonly", password: "db-secret", credentialConfigured: true }, dms: { url: "https://dms.example.test/sse", authorization: "Bearer dms-token", credentialConfigured: true } }],
      repositories: [{ id: "srm-repository", alias: "srm", url: "git@example.com:team/srm.git" }],
    }, {
      key: "orders", name: "Orders", description: "订单服务。",
      deployments: [{ environmentKey: "prod", repositoryBranches: [{ repositoryId: "orders-repository", repositoryAlias: "orders", baseBranch: "main" }], capabilities: [] }],
      repositories: [{ id: "orders-repository", alias: "orders", url: "git@example.com:team/orders.git" }],
    }],
  };
  return {
    ...actual,
    loadUsers: vi.fn(async () => structuredClone(managedUsers.filter((user) => user.active).map(({ subject, name, email }) => ({ subject, name, email })))),
    loadManagedUsers: vi.fn(async () => structuredClone(managedUsers)),
    createUser: vi.fn(async (input: { subject: string; name: string; email: string }) => {
      const user = { ...input, active: true, createdAt: now, updatedAt: now };
      managedUsers.push(user);
      return structuredClone(user);
    }),
    updateUser: vi.fn(async (subject: string, input: { name: string; email: string; active: boolean }) => {
      const user = managedUsers.find((candidate) => candidate.subject === subject)!;
      Object.assign(user, input, { updatedAt: now });
      return structuredClone(user);
    }),
    loadCurrentUser: vi.fn(async () => ({ subject: "fixture-user", name: "严欣", email: "owner@example.test" })),
    loadCatalog: vi.fn(async () => ({
      environments: structuredClone(configuration.environments),
      services: configuration.services.map(({ key, name, deployments }) => ({ key, name, deployments: deployments.map(({ environmentKey }) => ({ environmentKey })) })),
    })),
    loadConfig: vi.fn(async () => structuredClone(configuration)),
    updateGlobalAgent: vi.fn(async (agent) => { configuration.agent = { ...agent }; return { ok: true as const }; }),
    listIssues: vi.fn(async (_signal?: AbortSignal) => structuredClone(issues)),
    resolveDmsScope: vi.fn(async () => ({ instanceId: "instance-1", instanceHost: "db.example.test", instancePort: "3306", instanceLabel: "SRM-PROD · db.example.test:3306 · mysql/product", databaseId: "123", databaseLabel: "srm" })),
    loadWorkspaceStats: vi.fn(async (_signal?: AbortSignal) => ({
      totalBytes: 4 * 1024 ** 3 + 2048,
      policy: { retentionHours: 168, highWaterBytes: 20 * 1024 ** 3, targetBytes: 16 * 1024 ** 3, maintenanceIntervalMinutes: 15 },
      workspaces: [
        { issueKey: "ISSUE-20260810-041", issueStatus: "pending", workspaceStatus: "ready", resolvedAt: null, bytes: 4 * 1024 ** 3, releasable: true, blockedReason: null },
        { issueKey: "ISSUE-20260810-090", issueStatus: "resolved", workspaceStatus: "failed", resolvedAt: now, bytes: 1024, releasable: false, blockedReason: "workspace_repository_missing" },
        { issueKey: "ISSUE-20260810-091", issueStatus: "resolved", workspaceStatus: "failed", resolvedAt: now, bytes: 1024, releasable: false, blockedReason: "development_repository_state_invalid" },
        { issueKey: "ISSUE-20260810-092", issueStatus: "resolved", workspaceStatus: "failed", resolvedAt: now, bytes: 1024, releasable: false, blockedReason: "workspace_path_does_not_match_repository" },
        { issueKey: "ISSUE-20260810-093", issueStatus: "resolved", workspaceStatus: "failed", resolvedAt: now, bytes: 1024, releasable: false, blockedReason: "repository_workspace_name_conflict" },
      ],
    })),
    getIssue: vi.fn(async (id: string) => structuredClone(issues.find((item) => item.id === id))),
    loadSourceRepositories: vi.fn(async () => [
      { name: "srm", url: "git@example.com:team/srm.git", branch: "hotfix-issue", access: "write" as const },
      { name: "srm-server", url: "git@example.com:team/srm-server.git", branch: "hotfix-issue", access: "write" as const },
    ]),
    loadSourceTree: vi.fn(async (_id: string, sourceRepository: string, sourcePath: string) => sourcePath
      ? { path: sourcePath, entries: [{ name: "index.ts", path: "src/index.ts", type: "file" as const, size: 32 }], truncated: false }
      : sourceRepository === "srm-server"
        ? { path: "", entries: [{ name: "pom.xml", path: "pom.xml", type: "file" as const, size: 24 }], truncated: false }
        : { path: "", entries: [{ name: "src", path: "src", type: "directory" as const, size: null }, { name: "README.md", path: "README.md", type: "file" as const, size: 24 }], truncated: false }),
    loadSourceFile: vi.fn(async (_id: string, _repository: string, sourcePath: string) => ({ path: sourcePath, content: sourcePath === "README.md" ? "# SRM source\n" : "export const ready = true;\n", size: 24 })),
    searchSource: vi.fn(async () => ({ matches: [{ path: "src/index.ts", line: 1, column: 14, preview: "export const ready = true;" }], truncated: false })),
    loadSourceHistory: vi.fn(async () => ({ commits: [{ hash: "b".repeat(40), shortHash: "b".repeat(8), parents: ["a".repeat(40)], author: "Fixture User", date: now, subject: "Fix source browser" }], truncated: false })),
    loadSourceCommit: vi.fn(async () => ({ files: [{ status: "modified" as const, path: "README.md", previousPath: null }], truncated: false })),
    loadSourceCommitFile: vi.fn(async () => ({
      file: { status: "modified" as const, path: "README.md", previousPath: null },
      before: { path: "README.md", revision: "a".repeat(40), content: "# Old SRM source\n" },
      after: { path: "README.md", revision: "b".repeat(40), content: "# SRM source\n" },
    })),
    loadSourceDiff: vi.fn(async () => ({ files: [{ status: "modified" as const, path: "README.md", previousPath: null }], truncated: false })),
    loadSourceDiffFile: vi.fn(async () => ({
      file: { status: "modified" as const, path: "README.md", previousPath: null },
      before: { path: "README.md", version: "index" as const, content: "# Indexed SRM source\n" },
      after: { path: "README.md", version: "working-tree" as const, content: "# SRM source\n" },
    })),
    addIssueComment: async (id: string, body: string) => {
      const selected = issues.find((item) => item.id === id)!;
      const comment = { id: `comment-${selected.comments.length + 1}`, author: "fixture-user", body, createdAt: now };
      selected.comments.push(comment);
      return structuredClone(comment);
    },
    retryIssue: async (id: string) => { const selected = issues.find((item) => item.id === id); if (selected) selected.workspace.retryable = false; },
    updateIssueStatus: vi.fn(async (id: string, status: "open" | "resolved") => {
      const selected = issues.find((item) => item.id === id)!;
      selected.status = status;
      return structuredClone(selected);
    }),
    convertIssueToDevelopment: vi.fn(async (id: string) => {
      const selected = issues.find((item) => item.id === id)!;
      selected.environmentKey = "dev";
      selected.type = "defect_fix";
      selected.repositories[0]!.workingBranch = `hotfix-${id.toLowerCase()}`;
      return { issueKey: id };
    }),
    fetchAttachment: vi.fn(async () => new Blob(["order_id,status\n42,ready\n"], { type: "text/csv" })),
    sendAgentMessage: vi.fn(async () => undefined),
    updateService: vi.fn(async () => undefined),
  };
});

import { EventSourceMock } from "../test-setup";
import { App } from "./App";

describe("issue pilot workspace", () => {
  afterEach(() => { localStorage.clear(); document.body.replaceChildren(); vi.restoreAllMocks(); });

  test("shows operational attention and workload on the home dashboard and opens an Issue", async () => {
    const client = await import("../data/client");
    vi.mocked(client.listIssues).mockClear();
    render(() => <App />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "运营总览" })).toBeTruthy());
    const attention = await waitFor(() => screen.getByRole("region", { name: "团队工单动态" }));
    expect(within(attention).getByText("执行失败")).toBeTruthy();
    expect(within(attention).getByText("Agent 执行中")).toBeTruthy();
    expect(screen.getByLabelText("当前运营状态").textContent).toContain("正在执行1");
    expect(screen.getByLabelText("当前运营状态").textContent).toContain("执行失败1");
    expect(within(attention).getByText("刘宜展")).toBeTruthy();

    fireEvent.click(within(attention).getByText("批量审批偶发超时").closest("button")!);
    await waitFor(() => expect(screen.getByRole("heading", { name: "批量审批偶发超时" })).toBeTruthy());
    expect(screen.getByRole("radio", { name: "工单" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByLabelText("工单队列").querySelector(".queue-item.selected")?.textContent).toContain("ISSUE-20260810-038");
  });

  test("keeps every active Issue in the scrollable team activity list", async () => {
    const client = await import("../data/client");
    const [base] = await client.listIssues();
    const manyIssues = Array.from({ length: 12 }, (_, index) => ({
      ...structuredClone(base!),
      id: `ISSUE-20260811-${String(index + 1).padStart(3, "0")}`,
      title: `团队动态 ${index + 1}`,
      status: "open" as const,
      workspaceStatus: "ready" as const,
      agentRunning: false,
    }));
    vi.mocked(client.listIssues).mockResolvedValueOnce(manyIssues);
    render(() => <App />);

    const attention = await waitFor(() => screen.getByRole("region", { name: "团队工单动态" }));
    expect(within(attention).getAllByRole("listitem")).toHaveLength(12);
  });

  test("collapses and expands a long Issue description", async () => {
    const client = await import("../data/client");
    const detail = (await client.getIssue("ISSUE-20260810-042"))!;
    detail.description = Array.from({ length: 8 }, (_, index) => `第 ${index + 1} 段详细调查说明，包含足够多的上下文供处理人阅读。`).join("\n\n");
    vi.mocked(client.getIssue).mockResolvedValueOnce(detail);
    render(() => <App initialView="issues" />);

    const toggle = await screen.findByRole("button", { name: "展开完整描述" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByRole("button", { name: "收起描述" }).getAttribute("aria-expanded")).toBe("true"));
  });

  test("renders issues and data-backed statistics, then opens configuration", async () => {
    const consoleWarning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(() => <App initialView="issues" />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "结算页提交后订单状态未刷新" })).toBeTruthy());
    const initialClient = await import("../data/client");
    expect(initialClient.loadCatalog).toHaveBeenCalledTimes(1);
    expect(initialClient.loadConfig).not.toHaveBeenCalled();
    expect(screen.getByRole("radiogroup", { name: "工作台视图" })).toBeTruthy();
    const currentUserSelect = screen.getByLabelText("当前用户");
    expect(currentUserSelect.closest(".ads-select")?.textContent).toContain("owner@example.test");
    expect(screen.queryByText("生产")).toBeNull();
    expect(screen.queryByText("ISSUE-20260810-038")).toBeNull();
    const agentRegion = screen.getByRole("region", { name: "ISSUE-20260810-042 Agent 会话" });
    expect(agentRegion.querySelector(".agent-conversation")).toBeTruthy();
    expect(agentRegion.querySelector(".agent-composer")).toBeTruthy();
    expect(agentRegion.querySelector(".agent-meta")?.textContent).toContain("~/.issue-pilot/issues/issue-20260810-042/runtime");
    expect(screen.getByRole("heading", { name: "代码分支" })).toBeTruthy();
    expect(screen.getByText("hotfix-issue")).toBeTruthy();
    const agentInput = within(agentRegion).getByLabelText("发送给 Agent") as HTMLTextAreaElement;
    const pastedMessage = Array.from({ length: 41 }, (_, index) => `line ${index + 1}`).join("\n");
    fireEvent.paste(agentInput, { clipboardData: { getData: () => pastedMessage } });
    await waitFor(() => expect(agentInput.value).toBe("[paste #1 +41 lines]"));
    expect(within(agentRegion).queryByRole("button", { name: "发送" })).toBeNull();
    fireEvent.keyDown(agentInput, { key: "Enter", code: "Enter", shiftKey: false });
    const { fetchAttachment, sendAgentMessage } = await import("../data/client");
    await waitFor(() => expect(sendAgentMessage).toHaveBeenCalledWith("ISSUE-20260810-042", pastedMessage));
    fireEvent.input(agentInput, { target: { value: "还原后保留的 Agent 草稿" } });
    const commentInput = screen.getByLabelText("添加评论或备注") as HTMLTextAreaElement;
    fireEvent.input(commentInput, { target: { value: "还原后保留的评论草稿" } });
    const issueQueue = screen.getByLabelText("工单队列") as HTMLElement;
    const issueWorkspace = document.querySelector(".issue-workspace") as HTMLElement;
    fireEvent.click(screen.getByRole("button", { name: "浏览工单代码" }));
    const sourceBrowser = await waitFor(() => screen.getByRole("region", { name: "ISSUE-20260810-042 代码浏览器" }));
    expect(issueQueue.hidden).toBe(true);
    expect(issueWorkspace.hidden).toBe(false);
    expect(issueWorkspace.classList.contains("source-detail-panel")).toBe(true);
    expect(agentRegion.hidden).toBe(false);
    expect(issueQueue.isConnected && issueWorkspace.isConnected && agentRegion.isConnected).toBe(true);
    expect(document.querySelector(".app-content")?.classList.contains("workbench-ready")).toBe(false);
    expect(within(sourceBrowser).getByRole("status", { name: "代码工作台加载中" })).toBeTruthy();
    const workbench = within(sourceBrowser).getByTitle("ISSUE-20260810-042 VS Code工作台") as HTMLIFrameElement;
    expect(workbench.src).toContain("/vscode.html?issue=ISSUE-20260810-042");
    expect(workbench.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    const viewToolbar = within(sourceBrowser).getByRole("toolbar", { name: "代码视图" });
    expect(within(viewToolbar).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Explorer", "Search", "Source Control"]);
    const searchToggle = within(viewToolbar).getByRole("button", { name: "Search" });
    fireEvent.click(searchToggle);
    await waitFor(() => expect(searchToggle.getAttribute("aria-pressed")).toBe("true"));
    expect(within(viewToolbar).getByRole("button", { name: "Explorer" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(searchToggle);
    await waitFor(() => expect(searchToggle.getAttribute("aria-pressed")).toBe("false"));
    fireEvent.click(searchToggle);
    await waitFor(() => expect(searchToggle.getAttribute("aria-pressed")).toBe("true"));
    const agentToggle = within(sourceBrowser).getByRole("button", { name: "Agent面板" });
    expect(agentToggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(agentToggle);
    await waitFor(() => expect(agentToggle.getAttribute("aria-pressed")).toBe("false"));
    expect(agentRegion.hidden).toBe(true);
    fireEvent.click(agentToggle);
    await waitFor(() => expect(agentToggle.getAttribute("aria-pressed")).toBe("true"));
    expect(agentRegion.hidden).toBe(false);

    const detailsToggle = within(sourceBrowser).getByRole("button", { name: "工单详情" });
    expect(detailsToggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(detailsToggle);
    await waitFor(() => expect(detailsToggle.getAttribute("aria-pressed")).toBe("false"));
    expect(issueWorkspace.classList.contains("details-open")).toBe(false);
    fireEvent.click(detailsToggle);
    await waitFor(() => expect(detailsToggle.getAttribute("aria-pressed")).toBe("true"));
    expect(issueWorkspace.classList.contains("details-open")).toBe(true);
    Object.defineProperties(workbench, {
      clientWidth: { configurable: true, value: 1360 },
      clientHeight: { configurable: true, value: 820 },
    });
    window.dispatchEvent(new MessageEvent("message", {
      origin: window.location.origin,
      source: workbench.contentWindow,
      data: { kind: "issue-pilot-workbench-ready", issueKey: "ISSUE-20260810-042" },
    }));
    await waitFor(() => expect(within(sourceBrowser).queryByRole("status", { name: "代码工作台加载中" })).toBeNull());
    window.dispatchEvent(new MessageEvent("message", {
      origin: window.location.origin,
      source: workbench.contentWindow,
      data: {
        kind: "issue-pilot-workbench-layout",
        issueKey: "ISSUE-20260810-042",
        panel: { x: 300, y: 520, width: 700, height: 300 },
        auxiliary: { x: 1000, y: 0, width: 360, height: 820 },
        theme: {
          background: "#181818", foreground: "#cccccc", mutedForeground: "#999999", border: "#2b2b2b",
          inputBackground: "#242424", inputForeground: "#f0f0f0", inputBorder: "#3c3c3c", focusBorder: "#007fd4",
          buttonBackground: "#0e639c", buttonForeground: "#ffffff", buttonHoverBackground: "#1177bb", hoverBackground: "#2a2d2e",
        },
      },
    }));
    await waitFor(() => expect((document.querySelector(".app-content") as HTMLElement).style.getPropertyValue("--source-panel-x")).toBe("300px"));
    expect((document.querySelector(".app-content") as HTMLElement).style.getPropertyValue("--workbench-input-bg")).toBe("#242424");
    expect(document.querySelector(".app-content")?.classList.contains("workbench-ready")).toBe(true);
    fireEvent.click(within(sourceBrowser).getByRole("button", { name: "关闭代码浏览器" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "ISSUE-20260810-042 代码浏览器" })).toBeNull());
    expect(screen.getByLabelText("工单队列")).toBe(issueQueue);
    expect(document.querySelector(".issue-workspace")).toBe(issueWorkspace);
    expect(issueWorkspace.classList.contains("source-detail-panel")).toBe(false);
    expect(screen.getByRole("region", { name: "ISSUE-20260810-042 Agent 会话" })).toBe(agentRegion);
    expect(agentInput.value).toBe("还原后保留的 Agent 草稿");
    expect(commentInput.value).toBe("还原后保留的评论草稿");
    expect(screen.getByRole("heading", { name: "结算页提交后订单状态未刷新" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "预览 existing.csv" }));
    const previewDialog = await waitFor(() => screen.getByRole("dialog", { name: "existing.csv" }));
    await waitFor(() => expect(within(previewDialog).getByText(/42,ready/)).toBeTruthy());
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
    expect(within(previewDialog).getByRole("button", { name: "复制文字" })).toBeTruthy();
    fireEvent.click(within(previewDialog).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "existing.csv" })).toBeNull());
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
    fireEvent.click(within(reopenedIssueDialog).getByLabelText("编辑工单环境"));
    fireEvent.click(within(await screen.findByRole("listbox")).getByText("正式"));
    await waitFor(() => expect(within(reopenedIssueDialog).getByLabelText("编辑工单类型").closest(".ads-select")?.textContent).toMatch(/数据处理|智能分析/));
    await waitFor(() => expect(within(reopenedIssueDialog).getByLabelText("编辑工单服务").closest(".ads-select")?.textContent).toContain("Orders"));
    fireEvent.click(within(reopenedIssueDialog).getByRole("button", { name: "保存" }));
    const scopeDialog = await waitFor(() => screen.getByRole("dialog", { name: "切换调查范围" }));
    expect(within(scopeDialog).getByText(/Orders \/ 正式.*已有对话、附件和评论会保留/)).toBeTruthy();
    fireEvent.click(within(scopeDialog).getByRole("button", { name: "返回编辑" }));
    const returnedIssueDialog = await waitFor(() => screen.getByRole("dialog", { name: "编辑工单" }));
    fireEvent.click(within(returnedIssueDialog).getByRole("button", { name: "取消" }));

    fireEvent.input(commentInput, { target: { value: "另一个工单不应继承的草稿" } });
    fireEvent.click(await screen.findByText("ISSUE-20260810-041"));
    await waitFor(() => expect(screen.getByRole("button", { name: "确认解决" })).toBeTruthy());
    const issueActions = document.querySelector(".issue-actions");
    expect(issueActions).toBeTruthy();
    expect([...issueActions!.children].map((element) => element.textContent)).toEqual(["转开发修复", "确认解决", "编辑工单"]);
    fireEvent.click(screen.getByRole("button", { name: "转开发修复" }));
    const conversionDialog = await waitFor(() => screen.getByRole("dialog", { name: "转开发修复" }));
    expect(within(conversionDialog).getByText(/已有分析对话、附件和评论保持不变，转换后 Agent 将继续处理/)).toBeTruthy();
    fireEvent.click(within(conversionDialog).getByRole("button", { name: "确认转换" }));
    const clientAfterConversion = await import("../data/client");
    await waitFor(() => expect(clientAfterConversion.convertIssueToDevelopment).toHaveBeenCalledWith("ISSUE-20260810-041"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "转开发修复" })).toBeNull());
    expect(screen.queryByRole("button", { name: "转开发修复" })).toBeNull();
    expect([...issueActions!.children].map((element) => element.textContent)).toEqual(["确认解决", "编辑工单"]);
    expect([...issueActions!.children].every((element) => element.tagName === "BUTTON")).toBe(true);
    expect(screen.queryByRole("button", { name: "释放工作区" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "编辑工单" }));
    const developmentEditor = await waitFor(() => screen.getByRole("dialog", { name: "编辑工单" }));
    expect((within(developmentEditor).getByLabelText("编辑工单环境") as HTMLButtonElement).disabled).toBe(true);
    expect((within(developmentEditor).getByLabelText("编辑工单服务") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(developmentEditor).getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "浏览工单代码" }));
    const developmentSource = await waitFor(() => screen.getByRole("region", { name: "ISSUE-20260810-041 代码浏览器" }));
    expect((within(developmentSource).getByTitle("ISSUE-20260810-041 VS Code工作台") as HTMLIFrameElement).src).toContain("view=source-control");
    expect(within(developmentSource).getByRole("button", { name: "Source Control" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(developmentSource).getByRole("button", { name: "Agent面板" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(developmentSource).getByRole("button", { name: "工单详情" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(developmentSource).getByRole("button", { name: "关闭代码浏览器" }));
    fireEvent.click(screen.getByLabelText("当前用户"));
    fireEvent.click(await screen.findByText("刘宜展 · lyz@example.test"));
    await waitFor(() => expect(currentUserSelect.closest(".ads-select")?.textContent).toContain("lyz@example.test"));
    await waitFor(() => expect(screen.getByText("ISSUE-20260810-038")).toBeTruthy());
    await waitFor(() => expect((screen.getByLabelText("添加评论或备注") as HTMLTextAreaElement).value).toBe(""));
    const retryButton = await waitFor(() => screen.getByRole("button", { name: "重试处理" }));
    fireEvent.click(retryButton);
    await waitFor(() => expect(screen.queryByRole("button", { name: "重试处理" })).toBeNull());

    fireEvent.click(screen.getByRole("radio", { name: "首页" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "运营洞察" })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "产出" }));
    const submitted = await waitFor(() => screen.getByText("周期新增"));
    expect(submitted.parentElement?.textContent).toContain("3");
    expect(screen.getByText("周期解决").parentElement?.textContent).toContain("0");
    fireEvent.click(screen.getByRole("tab", { name: "资源" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Workspace 存储" })).toBeTruthy());
    expect(screen.getByText("每 15 分钟自动检查 · 已解决保留 7 天")).toBeTruthy();
    expect(screen.getByText("20.0 GB")).toBeTruthy();
    expect(screen.getByText("解决后纳入")).toBeTruthy();
    expect(screen.getByText("仓库目录缺失")).toBeTruthy();
    expect(screen.getByText("仓库状态异常")).toBeTruthy();
    expect(screen.getByText("仓库路径不一致")).toBeTruthy();
    expect(screen.getByText("仓库目录名冲突")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "团队" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "个人处理情况" })).toBeTruthy());

    fireEvent.click(screen.getByRole("radio", { name: "配置" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "SRM" })).toBeTruthy());
    const servicePanel = document.querySelector(".service-panel") as HTMLElement;
    expect(screen.queryByRole("button", { name: /拖动排序/ })).toBeNull();
    expect(screen.queryByLabelText("选择服务")).toBeNull();
    expect(document.querySelector(".environment-panel")).toBeNull();
    expect(within(servicePanel).getByText("供应商关系管理服务。")).toBeTruthy();
    expect(servicePanel.textContent).toContain("develop");
    expect(servicePanel.textContent).toContain("nacos");

    fireEvent.click(within(servicePanel).getByRole("button", { name: "编辑" }));
    const serviceDialog = await waitFor(() => screen.getByRole("dialog", { name: "编辑服务" }));
    expect(screen.queryByLabelText("服务类型")).toBeNull();
    expect(serviceDialog.textContent).toContain("环境部署");
    expect(within(serviceDialog).getByRole("button", { name: "展开部署1" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByLabelText("部署 1 仓库 srm 分支")).toBeNull();
    fireEvent.click(within(serviceDialog).getByRole("button", { name: "展开部署1" }));
    await waitFor(() => expect(within(serviceDialog).getByRole("button", { name: "收起部署1" }).getAttribute("aria-expanded")).toBe("true"));
    expect(screen.getByLabelText("部署 1 环境").textContent).toContain("测试");
    expect(screen.getByLabelText("部署 1 能力").textContent).toContain("nacos");
    const repositoryAliasInput = screen.getByLabelText("仓库别名 1") as HTMLInputElement;
    fireEvent.input(repositoryAliasInput, { target: { value: "srm-api" } });
    expect(repositoryAliasInput.value).toBe("srm-api");
    const repositoryInput = screen.getByLabelText("仓库地址 1") as HTMLInputElement;
    repositoryInput.focus();
    fireEvent.input(repositoryInput, { target: { value: "git@example.test:team/updated.git" } });
    expect(document.activeElement).toBe(repositoryInput);
    expect(repositoryInput.value).toBe("git@example.test:team/updated.git");
    const branchInput = screen.getByLabelText(/部署 1 仓库 .* 分支/) as HTMLInputElement;
    branchInput.focus();
    for (const value of ["r", "re", "rel", "release/test"]) {
      fireEvent.input(branchInput, { target: { value } });
      expect(document.activeElement).toBe(branchInput);
      expect(branchInput.isConnected).toBe(true);
      expect(screen.getByLabelText("部署 1 仓库 srm 分支")).toBe(branchInput);
      expect(branchInput.value).toBe(value);
    }
    expect([...serviceDialog.querySelectorAll(".deployment-capability-options button")].map((item) => item.textContent)).toEqual(["nacos", "db", "redis", "mq", "es", "dms", "sls"]);
    expect(within(serviceDialog).queryByRole("button", { name: "playwright" })).toBeNull();
    fireEvent.click(within(serviceDialog).getByRole("button", { name: "sls" }));
    await waitFor(() => expect([...serviceDialog.querySelectorAll(".capability-settings-head code")].map((item) => item.textContent).slice(-2)).toEqual(["dms", "sls"]));
    fireEvent.click(within(serviceDialog).getByRole("button", { name: "sls" }));
    await waitFor(() => expect(screen.queryByLabelText("sls accessKeyId 1")).toBeNull());
    expect([...serviceDialog.querySelectorAll(".capability-settings-head code")].map((item) => item.textContent)).toEqual(["代码分支", "nacos", "db", "dms"]);
    const nacosServerUrl = screen.getByLabelText("nacos serverUrl 1");
    expect((screen.getByLabelText("nacos dataIds 1") as HTMLInputElement).value).toBe("srm-test.yaml, srm-shared.yaml");
    const databaseUrl = screen.getByLabelText("db url 1");
    expect(nacosServerUrl.closest("label")?.querySelector(".required-field")?.textContent).toBe("serverUrl");
    expect(databaseUrl.closest("label")?.querySelector(".required-field")?.textContent).toBe("url");
    const dmsUrl = screen.getByLabelText("dms url 1") as HTMLInputElement;
    expect(dmsUrl.value).toBe("https://dms.example.test/sse");
    expect(dmsUrl.disabled).toBe(false);
    expect((screen.getByLabelText("dms Authorization 1") as HTMLInputElement).value).toBe("Bearer dms-token");
    fireEvent.click(within(serviceDialog).getByRole("button", { name: "收起部署1" }));
    await waitFor(() => expect(screen.queryByLabelText("dms url 1")).toBeNull());
    expect(screen.queryByLabelText("部署环境 1")).toBeNull();
    expect(screen.getByLabelText("部署 1 环境").textContent).toContain("测试");
    expect(screen.getByLabelText("部署 1 能力").textContent).toContain("nacos");
    expect(screen.getByLabelText("部署 1 能力").textContent).toContain("dms");
    fireEvent.click(within(serviceDialog).getByRole("button", { name: "展开部署1" }));
    const restoredDmsUrl = await waitFor(() => screen.getByLabelText("dms url 1") as HTMLInputElement);
    expect(restoredDmsUrl.value).toBe("https://dms.example.test/sse");
    fireEvent.input(restoredDmsUrl, { target: { value: "https://dms-updated.example.test/sse" } });
    expect((screen.getByLabelText("db password 1") as HTMLInputElement).value).toBe("db-secret");
    fireEvent.input(screen.getByLabelText("dms Authorization 1"), { target: { value: "Bearer dms-token-updated" } });
    const client = await import("../data/client");
    vi.mocked(client.resolveDmsScope).mockClear();
    const dmsAliasInput = screen.getByLabelText("dms instance 1") as HTMLInputElement;
    fireEvent.input(dmsAliasInput, { target: { value: "SRM-PROD" } });
    await waitFor(() => expect(dmsAliasInput.value).toBe("SRM-PROD"));
    fireEvent.input(screen.getByLabelText("dms database 1"), { target: { value: "srm" } });
    await waitFor(() => expect(client.resolveDmsScope).toHaveBeenCalledWith({
      url: "https://dms-updated.example.test/sse",
      authorization: "Bearer dms-token-updated",
      instanceAlias: "SRM-PROD",
      schemaName: "srm",
    }), { timeout: 2_000 });
    await waitFor(() => expect(within(serviceDialog).getByText("DatabaseId 123")).toBeTruthy());
    fireEvent.click(within(serviceDialog).getByRole("button", { name: "es" }));
    const esUrl = await waitFor(() => screen.getByLabelText("es url 1"));
    expect(esUrl.closest("label")?.querySelector(".required-field")?.textContent).toBe("url");
    const esAuthentication = screen.getByLabelText("es 认证 1");
    expect(esAuthentication.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByLabelText("es username 1")).toBeNull();
    fireEvent.click(esAuthentication);
    await waitFor(() => expect(screen.getByLabelText("es username 1")).toBeTruthy());
    expect(screen.getByLabelText("es password 1")).toBeTruthy();
    expect(screen.queryByLabelText(/es clusterNodes/i)).toBeNull();
    expect(screen.queryByLabelText(/es indexes/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "nacos" }));
    await waitFor(() => expect(screen.queryByLabelText("nacos serverUrl 1")).toBeNull());
    expect(screen.getByLabelText("db url 1")).toBeTruthy();
    fireEvent.click(within(serviceDialog).getByRole("button", { name: "es" }));
    await waitFor(() => expect(screen.queryByLabelText("es url 1")).toBeNull());
    fireEvent.click(within(serviceDialog).getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const alert = within(serviceDialog).queryByRole("alert");
      if (alert) throw new Error(alert.textContent ?? "service save failed");
      expect(client.updateService).toHaveBeenCalled();
    });
    expect(vi.mocked(client.updateService).mock.calls.at(-1)?.[0]).toBe("srm");
    const savedService = vi.mocked(client.updateService).mock.calls.at(-1)?.[1];
    expect(savedService?.repositories[0]).toEqual({ id: "srm-repository", alias: "srm-api", url: "git@example.test:team/updated.git" });
    expect(savedService?.deployments[0]?.repositoryBranches).toEqual([{ repositoryAlias: "srm-api", baseBranch: "release/test" }]);
    expect(savedService?.deployments[0]?.db).toEqual({ url: "mysql://db.example.test:3306/srm", username: "readonly", credentialUpdate: { mode: "replace", values: { password: "db-secret" } } });
    expect(savedService?.deployments[0]?.dms).toEqual({ url: "https://dms-updated.example.test/sse", instanceId: "instance-1", instanceHost: "db.example.test", instancePort: "3306", instanceLabel: "SRM-PROD · db.example.test:3306 · mysql/product", databaseId: "123", databaseLabel: "srm", credentialUpdate: { mode: "replace", values: { authorization: "Bearer dms-token-updated" } } });
    expect(JSON.stringify(savedService)).toContain("db-secret");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑服务" })).toBeNull());
    expect(client.loadCatalog).toHaveBeenCalledTimes(2);
    expect(client.loadConfig).toHaveBeenCalledTimes(2);
    expect(client.loadUsers).toHaveBeenCalledTimes(1);
    expect(client.loadCurrentUser).toHaveBeenCalledTimes(1);
    expect(consoleWarning.mock.calls.flat().filter((message) => String(message).includes("STRICT_READ_UNTRACKED"))).toEqual([]);
  });

  test("adds, edits, and disables users from the user management view", async () => {
    const client = await import("../data/client");
    vi.mocked(client.createUser).mockClear();
    vi.mocked(client.updateUser).mockClear();
    render(() => <App initialView="issues" />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "结算页提交后订单状态未刷新" })).toBeTruthy());

    fireEvent.click(screen.getByRole("radio", { name: "配置" }));
    fireEvent.click(await waitFor(() => screen.getByRole("tab", { name: "用户" })));
    await waitFor(() => expect(screen.getByRole("button", { name: "添加用户" })).toBeTruthy());
    expect(screen.getByRole("tab", { name: "模型" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "服务" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("fixture-user")).toBeTruthy());
    expect(screen.getByText("second-user")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "添加用户" }));
    const dialog = await waitFor(() => screen.getByRole("dialog", { name: "添加用户" }));
    fireEvent.input(within(dialog).getByLabelText("用户标识"), { target: { value: "new-user@example.test" } });
    fireEvent.input(within(dialog).getByLabelText("用户姓名"), { target: { value: "新用户" } });
    fireEvent.input(within(dialog).getByLabelText("用户邮箱"), { target: { value: "new.user@example.test" } });
    const saveUser = within(dialog).getByRole("button", { name: "保存" }) as HTMLButtonElement;
    expect(saveUser.disabled).toBe(false);
    fireEvent.click(saveUser);
    await waitFor(() => {
      const alert = within(dialog).queryByRole("alert");
      if (alert) throw new Error(alert.textContent ?? "user save failed");
      expect(client.createUser).toHaveBeenCalledWith({ subject: "new-user@example.test", name: "新用户", email: "new.user@example.test" });
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "添加用户" })).toBeNull());
    const newUserRow = await waitFor(() => screen.getByText("new-user@example.test").closest(".user-table-row") as HTMLElement);
    expect(newUserRow).toBeTruthy();
    fireEvent.click(within(newUserRow).getByRole("button", { name: "停用" }));
    await waitFor(() => expect(client.updateUser).toHaveBeenCalledWith("new-user@example.test", { name: "新用户", email: "new.user@example.test", active: false }));
    await waitFor(() => expect(within(screen.getByText("new-user@example.test").closest(".user-table-row") as HTMLElement).getByText("停用")).toBeTruthy());
  });

  test("saves the single global model from the configuration model section", async () => {
    const client = await import("../data/client");
    vi.mocked(client.updateGlobalAgent).mockClear();
    render(() => <App initialView="configuration" />);
    fireEvent.click(await waitFor(() => screen.getByRole("tab", { name: "模型" })));
    await waitFor(() => expect(screen.getByLabelText("全局模型 provider")).toBeTruthy());
    expect(screen.getByLabelText("全局模型 provider").closest(".ads-select")?.textContent).toContain("enterprise-ai");
    expect(screen.getByLabelText("全局模型 model").closest(".ads-select")?.textContent).toContain("engineering-model");
    fireEvent.click(screen.getByRole("button", { name: "保存模型" }));
    await waitFor(() => expect(client.updateGlobalAgent).toHaveBeenCalledWith({ provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "medium" }));
  });

  test("retries the initial configuration request in place", async () => {
    const client = await import("../data/client");
    vi.mocked(client.loadConfig).mockClear();
    vi.mocked(client.loadConfig).mockRejectedValueOnce(new Error("configuration_unavailable"));
    const view = render(() => <App initialView="issues" />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "结算页提交后订单状态未刷新" })).toBeTruthy());

    fireEvent.click(screen.getByRole("radio", { name: "配置" }));
    const alert = await waitFor(() => screen.getByRole("alert"));
    expect(alert.textContent).toContain("configuration_unavailable");
    fireEvent.click(within(alert).getByRole("button", { name: "重试" }));

    await waitFor(() => expect(screen.getByRole("tab", { name: "SRM" })).toBeTruthy());
    expect(client.loadConfig).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  test("renders Issue statistics while Workspace inspection is pending and aborts it on navigation", async () => {
    const { loadWorkspaceStats } = await import("../data/client");
    let workspaceSignal: AbortSignal | undefined;
    vi.mocked(loadWorkspaceStats).mockImplementationOnce((signal) => new Promise((_resolve, reject) => {
      workspaceSignal = signal;
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const view = render(() => <App initialView="issues" />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "结算页提交后订单状态未刷新" })).toBeTruthy());

    fireEvent.click(screen.getByRole("radio", { name: "首页" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "运营洞察" })).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "资源" }));
    const workspaceSection = await waitFor(() => screen.getByRole("heading", { name: "Workspace 存储" }).closest("section"));
    expect(workspaceSection?.getAttribute("aria-busy")).toBe("true");

    fireEvent.click(screen.getByRole("radio", { name: "工单" }));
    await waitFor(() => expect(workspaceSignal?.aborted).toBe(true));
    view.unmount();
  });

  test("waits for the current user before selecting an Issue", async () => {
    const client = await import("../data/client");
    const getIssue = vi.mocked(client.getIssue);
    getIssue.mockClear();
    let resolveCurrentUser!: (user: Awaited<ReturnType<typeof client.loadCurrentUser>>) => void;
    const currentUser = new Promise<Awaited<ReturnType<typeof client.loadCurrentUser>>>((resolve) => { resolveCurrentUser = resolve; });
    vi.mocked(client.loadCurrentUser).mockImplementationOnce(() => currentUser);

    render(() => <App initialView="issues" />);

    await waitFor(() => expect(screen.getByText("没有匹配的工单")).toBeTruthy());
    expect(getIssue).not.toHaveBeenCalled();
    resolveCurrentUser({ subject: "fixture-user", name: "严欣", email: "owner@example.test" });
    await waitFor(() => expect(screen.getByRole("heading", { name: "结算页提交后订单状态未刷新" })).toBeTruthy());
    expect(getIssue).toHaveBeenCalledTimes(1);
    expect(getIssue).toHaveBeenCalledWith("ISSUE-20260810-042");
  });

  test("allows switching Issues while the selected Agent is working", async () => {
    EventSourceMock.instances.length = 0;
    render(() => <App initialView="issues" />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "结算页提交后订单状态未刷新" })).toBeTruthy());
    const source = EventSourceMock.instances.at(-1)!;
    source.emit("open");
    source.emit("snapshot_ready", { running: true, issueStatus: "in_progress" });
    await waitFor(() => expect(screen.getByText("Working...")).toBeTruthy());
    const client = await import("../data/client");
    vi.mocked(client.sendAgentMessage).mockClear();
    const composer = screen.getByLabelText("发送给 Agent") as HTMLTextAreaElement;
    expect(composer.disabled).toBe(false);
    fireEvent.input(composer, { target: { value: "working期间补充信息" } });
    await waitFor(() => expect(composer.value).toBe("working期间补充信息"));
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(client.sendAgentMessage).toHaveBeenCalledWith("ISSUE-20260810-042", "working期间补充信息"));
    fireEvent.click(screen.getByRole("button", { name: "编辑工单" }));
    const dialog = await waitFor(() => screen.getByRole("dialog", { name: "编辑工单" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));

    fireEvent.click(await screen.findByText("ISSUE-20260810-041"));

    await waitFor(() => expect(screen.getByRole("heading", { name: "客户导出的 CSV 缺少时区信息" })).toBeTruthy());
    expect(source.closed).toBe(true);
    expect(screen.getByLabelText("工单队列").querySelector(".queue-item.selected")?.textContent).toContain("ISSUE-20260810-041");
  });

  test("combines environment and service Issue queue filters", async () => {
    const client = await import("../data/client");
    const stableIssues = await client.listIssues();
    const productionIssue = stableIssues.find((item) => item.id === "ISSUE-20260810-041")!;
    productionIssue.environmentKey = "prod";
    productionIssue.service = { key: "orders", name: "Orders" };
    vi.mocked(client.listIssues).mockResolvedValueOnce(stableIssues);

    render(() => <App initialView="issues" />);
    const queue = screen.getByLabelText("工单队列");
    await waitFor(() => expect(within(queue).getAllByRole("listitem")).toHaveLength(2));
    fireEvent.click(within(queue).getByLabelText("按状态筛选"));
    const statusOptions = await screen.findByRole("listbox");
    expect(within(statusOptions).getAllByRole("option").map((option) => option.textContent)).toEqual(["未解决", "待确认", "已解决", "全部工单"]);
    fireEvent.click(within(statusOptions).getByText("全部工单"));

    fireEvent.click(within(queue).getByLabelText("按环境筛选"));
    const environmentOptions = await waitFor(() => {
      const listbox = screen.getAllByRole("listbox").find((candidate) => within(candidate).queryByText("正式"));
      if (!listbox) throw new Error("environment options not open");
      return listbox;
    });
    fireEvent.click(within(environmentOptions).getByText("正式"));
    await waitFor(() => expect(within(queue).getByText("ISSUE-20260810-041")).toBeTruthy());
    expect(within(queue).queryByText("ISSUE-20260810-042")).toBeNull();

    fireEvent.click(within(queue).getByLabelText("按服务筛选"));
    const serviceOptions = await waitFor(() => {
      const listbox = screen.getAllByRole("listbox").find((candidate) => within(candidate).queryByText("Orders"));
      if (!listbox) throw new Error("service options not open");
      return listbox;
    });
    fireEvent.click(within(serviceOptions).getByText("Orders"));
    await waitFor(() => expect(within(queue).getAllByRole("listitem")).toHaveLength(1));

    fireEvent.click(within(queue).getByLabelText("按服务筛选"));
    const changedServiceOptions = await waitFor(() => {
      const listbox = screen.getAllByRole("listbox").find((candidate) => within(candidate).queryByText("SRM"));
      if (!listbox) throw new Error("changed service options not open");
      return listbox;
    });
    fireEvent.click(within(changedServiceOptions).getByText("SRM"));
    await waitFor(() => expect(within(queue).queryAllByRole("listitem")).toHaveLength(0));
    expect(within(queue).getByText("没有匹配的工单")).toBeTruthy();
  });

  test("refreshes the Issue queue when an SSE event changes the selected Issue status", async () => {
    EventSourceMock.instances.length = 0;
    const client = await import("../data/client");
    const getIssue = vi.mocked(client.getIssue);
    const listIssues = vi.mocked(client.listIssues);
    render(() => <App initialView="issues" />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "结算页提交后订单状态未刷新" })).toBeTruthy());
    const current = await getIssue.mock.results[0]!.value;
    const pending = { ...current, type: "smart_analysis" as const, status: "pending" as const, workspace: { ...current.workspace, status: "ready" as const } };
    getIssue.mockClear();
    listIssues.mockClear();
    getIssue.mockResolvedValueOnce(pending);
    listIssues.mockResolvedValueOnce([pending]);

    const source = EventSourceMock.instances.at(-1)!;
    source.emit("snapshot_ready", { running: true, issueStatus: "in_progress" });
    source.emit("message", { id: "status-complete", issueId: current.id, createdAt: new Date().toISOString(), event: { type: "issue_status", status: "complete" } });

    await waitFor(() => expect(listIssues).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "确认解决" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "转开发修复" })).toBeTruthy();
    const queueItem = await waitFor(() => screen.getByRole("listitem"));
    expect(queueItem.textContent).toContain("ISSUE-20260810-042");
    expect(queueItem.textContent).toContain("待确认");
  });

  test("refreshes the Issue queue immediately when a resolved Issue is reopened", async () => {
    const client = await import("../data/client");
    const updateIssueStatus = vi.mocked(client.updateIssueStatus);
    const getIssue = vi.mocked(client.getIssue);
    const listIssues = vi.mocked(client.listIssues);
    await updateIssueStatus("ISSUE-20260810-038", "resolved");
    render(() => <App initialView="issues" />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "结算页提交后订单状态未刷新" })).toBeTruthy());
    fireEvent.click(screen.getByLabelText("当前用户"));
    fireEvent.click(await screen.findByText("刘宜展 · lyz@example.test"));
    fireEvent.click(screen.getByLabelText("按状态筛选"));
    fireEvent.click(await screen.findByText("全部工单"));
    fireEvent.click(await screen.findByText("ISSUE-20260810-038"));
    await waitFor(() => expect(screen.getByRole("button", { name: "重新打开" })).toBeTruthy());
    const resolvedIssue = await getIssue("ISSUE-20260810-038");
    let resolveDetail!: (issue: typeof resolvedIssue) => void;
    const detailRefresh = new Promise<typeof resolvedIssue>((resolve) => { resolveDetail = resolve; });
    getIssue.mockClear();
    listIssues.mockClear();
    updateIssueStatus.mockClear();
    getIssue.mockImplementationOnce(async () => detailRefresh);

    fireEvent.click(screen.getByRole("button", { name: "重新打开" }));

    await waitFor(() => expect(updateIssueStatus).toHaveBeenCalledWith("ISSUE-20260810-038", "open"));
    await waitFor(() => expect(listIssues).toHaveBeenCalledTimes(1));
    resolveDetail({ ...resolvedIssue, status: "open" });
    await waitFor(() => expect(screen.getByRole("button", { name: "编辑工单" })).toBeTruthy());
    await waitFor(() => expect((screen.getByLabelText("发送给 Agent") as HTMLTextAreaElement).disabled).toBe(false));
    const queueItem = screen.getAllByRole("listitem").find((item) => item.textContent?.includes("ISSUE-20260810-038"));
    expect(queueItem?.textContent).toContain("待处理");
  });

  test("keeps the newest Issue detail when SSE refreshes finish out of order", async () => {
    EventSourceMock.instances.length = 0;
    const client = await import("../data/client");
    const getIssue = vi.mocked(client.getIssue);
    render(() => <App initialView="issues" />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "结算页提交后订单状态未刷新" })).toBeTruthy());
    const current = await getIssue("ISSUE-20260810-042");
    let resolveOld!: (issue: typeof current) => void;
    let resolveNew!: (issue: typeof current) => void;
    const oldRefresh = new Promise<typeof current>((resolve) => { resolveOld = resolve; });
    const newRefresh = new Promise<typeof current>((resolve) => { resolveNew = resolve; });
    getIssue.mockImplementationOnce(async () => oldRefresh).mockImplementationOnce(async () => newRefresh);
    const source = EventSourceMock.instances.at(-1)!;

    source.emit("snapshot_ready", { running: false, issueStatus: "in_progress" });
    source.emit("message", { id: "status-old", issueId: "ISSUE-20260810-042", createdAt: new Date().toISOString(), event: { type: "issue_status", status: "complete" } });
    source.emit("message", { id: "status-new", issueId: "ISSUE-20260810-042", createdAt: new Date().toISOString(), event: { type: "issue_status", status: "complete" } });
    resolveNew({ ...current, status: "resolved", workspace: { ...current.workspace, status: "ready" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "重新打开" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "编辑工单" })).toBeNull();
    const currentSource = EventSourceMock.instances.at(-1)!;
    const connectionCount = EventSourceMock.instances.length;
    const requestCount = getIssue.mock.calls.length;
    currentSource.emit("snapshot_ready", { running: false, issueStatus: "resolved" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(EventSourceMock.instances).toHaveLength(connectionCount);
    expect(getIssue).toHaveBeenCalledTimes(requestCount);
    resolveOld({ ...current, status: "in_progress", workspace: { ...current.workspace, status: "running" } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.getByRole("button", { name: "重新打开" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
