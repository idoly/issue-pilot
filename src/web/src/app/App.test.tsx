import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../data/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/client")>();
  const { Blob } = await import("node:buffer");
  const now = new Date().toISOString();
  const service = { key: "srm", name: "SRM" };
  const issue = (id: string, title: string, status: string, retryable = false) => ({
    id, title, description: `${title}描述`, priority: "p1", type: "defect_fix", status,
    workspaceStatus: retryable ? "failed" : status === "in_progress" ? "running" : "ready", agentRunning: status === "in_progress", resolvedAt: status === "resolved" ? now : null,
    assignee: id === "ISSUE-20260810-038" ? "刘宜展" : "严欣", assigneeSubject: (id === "ISSUE-20260810-038" ? "second-user" : "fixture-user") as string | null,
    service, createdAt: now, updatedAt: now, repositories: [{ name: "srm", url: "git@example.com:team/srm.git", baseBranch: "prod", workingBranch: "hotfix-issue" as string | null }], attachments: [{ id: "attachment-1", fileName: "existing.csv", mediaType: "text/csv", size: 2048, sha256: "a".repeat(64), createdAt: now }], relatedIssues: [], scopeTransitions: [] as Array<Record<string, unknown>>, comments: [] as Array<{ id: string; author: string; body: string; createdAt: string }>, ccRecipients: [],
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
    { subject: "fixture-user", name: "严欣", email: "owner@example.test", role: "developer", active: true, createdAt: now, updatedAt: now },
    { subject: "second-user", name: "刘宜展", email: "lyz@example.test", role: "developer", active: true, createdAt: now, updatedAt: now },
  ];
  const configuration = {
    agent: { provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "medium", codemode: "on", runtime: {} },
    agentModels: [{ provider: "enterprise-ai", id: "engineering-model", thinkingLevels: ["low", "medium", "high"] }],
    environments: [{ key: "test", name: "测试" }, { key: "prod", name: "正式" }],
    services: [{
      revision: 0, key: "srm", name: "SRM", description: "供应商关系管理服务。", context: "供应商关系管理服务。\n\n### 测试环境\n\n代码基准分支：develop\n\nSLS（sls）：srm-test",
      deployments: [{ environmentKey: "test", repositoryBranches: [{ repositoryId: "srm-repository", repositoryAlias: "srm", baseBranch: "develop" }], capabilities: ["sls"], sls: { region: "cn-test", project: "srm-test", logstores: ["srm"], credentialConfigured: true } }],
      repositories: [{ id: "srm-repository", alias: "srm", url: "git@example.com:team/srm.git" }],
    }, {
      revision: 0, key: "orders", name: "Orders", description: "订单服务。",
      deployments: [
        { environmentKey: "prod", repositoryBranches: [{ repositoryId: "orders-repository", repositoryAlias: "orders", baseBranch: "main" }], capabilities: [] },
        { environmentKey: "dev", repositoryBranches: [{ repositoryId: "orders-repository", repositoryAlias: "orders", baseBranch: "develop" }], capabilities: [] },
      ],
      repositories: [{ id: "orders-repository", alias: "orders", url: "git@example.com:team/orders.git" }],
    }],
  };
  return {
    ...actual,
    loadManagedUsers: vi.fn(async () => structuredClone(managedUsers.map(user => ({ ...user, revision: 0 })))),
    loadUsers: vi.fn(async () => structuredClone(managedUsers.filter((user) => user.active).map(({ subject, name, email, role }) => ({ subject, name, email, role })))),
    loadCurrentUser: vi.fn(async () => ({ subject: "fixture-user", name: "严欣", email: "owner@example.test", role: "developer" })),
    loadSharedSlsCredentials: vi.fn(async () => ({ configured: true, revision: 0 })),
    loadPersonalCredentials: vi.fn(async () => ({ revision: 0, provider: "enterprise-ai", modelProviders: [], gitSshConfigured: false })),
    loadCatalog: vi.fn(async () => ({
      environments: structuredClone(configuration.environments),
      services: configuration.services.map(({ key, name, deployments }) => ({ key, name, deployments: deployments.map(({ environmentKey }) => ({ environmentKey })) })),
    })),
    loadApplicationEndpoints: vi.fn(async () => ({ endpoints: [{ name: "Issue Pilot MCP", path: "/mcp", transport: "Streamable HTTP", readOnly: true, tools: [{ name: "issue_get", description: "Read Issue details", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { key: { type: "string", description: "Issue key" } }, required: ["key"] } }] }] })),
    loadRepositories: vi.fn(async () => [
      ...configuration.services.flatMap((service) => service.repositories.map((repository) => ({ id: repository.id, revision: 0, name: repository.alias, url: repository.url, createdAt: now, updatedAt: now, services: [{ key: service.key, name: service.name }] }))),
      { id: "updated-repository", revision: 0, name: "Updated repository", url: "git@example.test:team/updated.git", createdAt: now, updatedAt: now, services: [] },
    ]),
    loadServiceConfigurationDescription: vi.fn(async (key: string) => ({ context: configuration.services.find(service => service.key === key)?.context ?? configuration.services.find(service => service.key === key)?.description ?? "" })),
    loadConfig: vi.fn(async () => structuredClone(configuration)),
    listIssues: vi.fn(async (_signal?: AbortSignal) => structuredClone(issues)),
    createIssue: vi.fn(async (input: { title: string; description: string; priority: string; workMode: string; serviceKey: string; assigneeSubject: string | null; ccSubjects: string[]; relatedIssueKeys?: string[] }) => {
      const created = issue("ISSUE-20260810-043", input.title, "open");
      created.description = input.description;
      created.priority = input.priority;
      created.type = "smart_analysis";
      created.environmentKey = "prod";
      created.service = configuration.services.find((candidate) => candidate.key === input.serviceKey) ?? created.service;
      created.assigneeSubject = input.assigneeSubject;
      issues.unshift(created);
      return structuredClone(created);
    }),
    listIssuePins: vi.fn(async (_signal?: AbortSignal) => [] as string[]),
    setIssuePinned: vi.fn(async (_id: string, _pinned: boolean) => undefined),
    updateIssueRelatedIssues: vi.fn(async (_id: string, _relatedIssueKeys: string[]) => undefined),
    resolveDmsScope: vi.fn(async (input: { schemaName: string }) => ({ instanceId: input.schemaName === "mdm" ? "instance-2" : "instance-1", instanceHost: `${input.schemaName}.db.example.test`, instancePort: "3306", databaseId: input.schemaName === "mdm" ? "456" : "123" })),
    loadWorkspaceStats: vi.fn(async (_signal?: AbortSignal) => ({
      sampledAt: now,
      totalBytes: 4 * 1024 ** 3 + 2048,
      sharedGitBytes: 1024 ** 3,
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
    loadSourceFile: vi.fn(async (_id: string, _repository: string, sourcePath: string) => ({ path: sourcePath, content: sourcePath === "README.md" ? "# SRM source\n" : "export const ready = true;\n", size: 24, sha256: "a".repeat(64) })),
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
    retryIssue: async (id: string) => { const selected = issues.find((item) => item.id === id); if (selected) selected.workspace.retryable = false; },
    updateIssueStatus: vi.fn(async (id: string, status: "open" | "resolved") => {
      const selected = issues.find((item) => item.id === id)!;
      selected.status = status;
      return structuredClone(selected);
    }),
    planIssueScopeTransition: vi.fn(async (id: string, target: { serviceKey: string; workMode: string }) => {
      const selected = issues.find((item) => item.id === id)!;
      return {
        planHash: `sha256:${"a".repeat(64)}`,
        expectedIssueUpdatedAt: selected.updatedAt,
        action: target.workMode === "development_fix" ? "convert_to_development" as const : "rebind_read_only" as const,
        current: { service: selected.service, workMode: selected.environmentKey === "prod" ? "production_analysis" as const : "test_analysis" as const, repositoryAccess: "read" as const },
        target: { service: selected.service, workMode: target.workMode, repositoryAccess: target.workMode === "development_fix" ? "write" as const : "read" as const },
        repositories: { retained: [{ name: "orders", url: selected.repositories[0]!.url, baseBranch: selected.repositories[0]!.baseBranch }], added: [], removed: [] },
        branch: target.workMode === "development_fix" ? `hotfix-${id.toLowerCase()}` : null,
        session: { closeCurrent: true, preserveConversation: true as const },
        preserved: ["attachments", "comments", "conversation"] as ["attachments", "comments", "conversation"],
        warnings: [],
      };
    }),
    applyIssueScopeTransition: vi.fn(async (id: string, target: { serviceKey: string; workMode: string }) => {
      const selected = issues.find((item) => item.id === id)!;
      const fromService = structuredClone(selected.service);
      const fromWorkMode = actual.issueWorkMode(selected.environmentKey as "prod" | "test" | "dev", selected.type as Parameters<typeof actual.issueWorkMode>[1])!;
      if (target.workMode === "development_fix") {
        selected.environmentKey = "dev";
        selected.type = "defect_fix";
        selected.repositories[0]!.workingBranch = `hotfix-${id.toLowerCase()}`;
      }
      selected.scopeTransitions.push({
        id: "transition-1", action: "convert_to_development",
        from: { service: fromService, workMode: fromWorkMode },
        to: { service: structuredClone(selected.service), workMode: target.workMode },
        repositories: { retained: [selected.repositories[0]!.url], added: [], removed: [] },
        planHash: `sha256:${"a".repeat(64)}`,
        actor: { subject: "fixture-user", name: "严欣" }, createdAt: now,
      });
      return { issueKey: id };
    }),
    fetchAttachment: vi.fn(async () => new Blob(["order_id,status\n42,ready\n"], { type: "text/csv" })),
    sendAgentMessage: vi.fn(async () => undefined),
    updateService: vi.fn(async () => undefined),
  };
});

import { EventSourceMock } from "../test-setup";
import { setCurrentUserSubject } from "../data/client";
import { App } from "./App";

describe("issue pilot workspace", () => {
  afterEach(() => { cleanup(); setCurrentUserSubject(null); localStorage.clear(); document.body.replaceChildren(); vi.restoreAllMocks(); window.history.replaceState(null, "", window.location.pathname); });

  test("opens a linked Issue even when it is outside the current user's queue", async () => {
    window.history.replaceState(null, "", "/home/idoly/issue-pilot/.issue-pilot/issues/issue-20260901-002/work/customer-state-sync-java8-tests.log?issue=ISSUE-20260810-038");
    render(() => <App />);
    await screen.findByRole("heading", { name: "批量审批偶发超时" });
    expect(screen.getByRole("radio", { name: "工单" }).getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(within(screen.getByLabelText("工单队列")).queryByText("ISSUE-20260810-038")).toBeNull());
    expect(new URLSearchParams(window.location.search).get("issue")).toBe("ISSUE-20260810-038");
    expect(window.location.pathname).toBe("/");
  });

  test("navigates through a related Issue card without changing identity or losing external selection", async () => {
    const client = await import("../data/client");
    const source = (await client.getIssue("ISSUE-20260810-042"))!;
    const target = (await client.getIssue("ISSUE-20260810-038"))!;
    source.relatedIssues = [{ ...target, workspaceStatus: target.workspace.status, agentRunning: false, resolvedAt: null }];
    vi.mocked(client.getIssue).mockResolvedValueOnce(source);
    render(() => <App initialView="issues" />);
    const link = await screen.findByRole("link", { name: `打开关联工单 ${target.id}` });
    expect(link.getAttribute("href")).toBe(`/?issue=${target.id}`);
    fireEvent.click(link);
    await screen.findByRole("heading", { name: target.title });
    expect(new URLSearchParams(window.location.search).get("issue")).toBe(target.id);
    expect(client.currentUserSubject()).toBe("fixture-user");
    await waitFor(() => expect(within(screen.getByLabelText("工单队列")).queryByText(target.id)).toBeNull());
    expect(screen.getByRole("heading", { name: target.title })).toBeTruthy();
    window.history.back();
    await screen.findByRole("heading", { name: source.title });
    expect(new URLSearchParams(window.location.search).get("issue")).toBe(source.id);
    window.history.forward();
    await screen.findByRole("heading", { name: target.title });
    expect(new URLSearchParams(window.location.search).get("issue")).toBe(target.id);
  });

  test("keeps the current Issue and draft when browser back is declined", async () => {
    const client = await import("../data/client");
    const source = (await client.getIssue("ISSUE-20260810-042"))!;
    const target = (await client.getIssue("ISSUE-20260810-038"))!;
    source.relatedIssues = [{ ...target, workspaceStatus: target.workspace.status, agentRunning: false, resolvedAt: null }];
    vi.mocked(client.getIssue).mockResolvedValueOnce(source);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(() => <App initialView="issues" />);
    fireEvent.click(await screen.findByRole("link", { name: `打开关联工单 ${target.id}` }));
    await screen.findByRole("heading", { name: target.title });
    fireEvent.click(await screen.findByRole("button", { name: "浏览工单代码" }));
    const browser = await screen.findByRole("region", { name: `${target.id} 代码浏览器` });
    fireEvent.click(await within(browser).findByRole("button", { name: /README\.md/ }));
    const editor = await within(browser).findByLabelText("代码内容 README.md") as HTMLTextAreaElement;
    await fireEvent.input(editor, { target: { value: "preserve draft on browser back" } });
    await screen.findByText(/README.md · 未保存/);
    window.history.back();
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("issue")).toBe(target.id));
    expect(browser.isConnected).toBe(true);
    expect(editor.value).toBe("preserve draft on browser back");
    confirm.mockReturnValue(true);
    window.history.back();
    await screen.findByRole("heading", { name: source.title });
    expect(new URLSearchParams(window.location.search).get("issue")).toBe(source.id);
  });

  test("shows operational attention and workload on the home dashboard and opens an Issue", async () => {
    const client = await import("../data/client");
    vi.mocked(client.listIssues).mockClear();
    render(() => <App />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "运营总览" })).toBeTruthy());
    const attention = await waitFor(() => screen.getByRole("region", { name: "团队工单动态" }));
    expect(within(attention).getByText("执行失败")).toBeTruthy();
    expect(within(attention).getByText("执行中")).toBeTruthy();
    expect(screen.getByLabelText("当前运营状态").textContent).toContain("正在执行1");
    expect(screen.getByLabelText("当前运营状态").textContent).toContain("执行失败1");
    expect(within(attention).getByText("刘宜展")).toBeTruthy();

    fireEvent.click(within(attention).getByText("批量审批偶发超时").closest("button")!);
    await waitFor(() => expect(screen.getByRole("heading", { name: "批量审批偶发超时" })).toBeTruthy());
    expect(screen.getByRole("radio", { name: "工单" }).getAttribute("aria-checked")).toBe("true");
    const personalQueue = screen.getByLabelText("工单队列");
    expect(within(personalQueue).getByText("ISSUE-20260810-038")).toBeTruthy();
    expect(personalQueue.querySelector(".queue-item.selected")?.textContent).toContain("ISSUE-20260810-038");
    expect(within(personalQueue).queryByText("ISSUE-20260810-042")).toBeNull();
    expect(client.currentUserSubject()).toBe("second-user");
    expect(screen.getByLabelText("当前用户").closest(".identity")?.textContent).toContain("lyz@example.test");
  });

  test("keeps the selected assignee when an older user-list request finishes after dashboard navigation", async () => {
    const client = await import("../data/client");
    const users = await client.loadUsers();
    let finish!: (value: typeof users) => void;
    vi.mocked(client.loadUsers).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(() => <App />);
    try {
      const attention = await screen.findByRole("region", { name: "团队工单动态" });
      fireEvent.click(within(attention).getByText("批量审批偶发超时").closest("button")!);
      await screen.findByRole("heading", { name: "批量审批偶发超时" });
      expect(client.currentUserSubject()).toBe("second-user");
      finish(users);
      await waitFor(() => expect(screen.getByLabelText("当前用户").closest(".identity")?.textContent).toContain("lyz@example.test"));
    } finally { finish(users); }
  });

  test("pins personal queue Issues above the existing queue order", async () => {
    const client = await import("../data/client");
    vi.mocked(client.setIssuePinned).mockClear();
    render(() => <App />);

    fireEvent.click(await screen.findByRole("radio", { name: "工单" }));
    const queue = await screen.findByLabelText("工单队列");
    await waitFor(() => expect(within(queue).getAllByRole("listitem")[0]?.textContent).toContain("ISSUE-20260810-042"));

    fireEvent.click(within(queue).getByRole("button", { name: "固定 ISSUE-20260810-041" }));
    await waitFor(() => expect(within(queue).getAllByRole("listitem")[0]?.textContent).toContain("ISSUE-20260810-041"));
    expect(client.setIssuePinned).toHaveBeenCalledWith("ISSUE-20260810-041", true);

    fireEvent.click(within(queue).getByRole("button", { name: "取消固定 ISSUE-20260810-041" }));
    await waitFor(() => expect(within(queue).getAllByRole("listitem")[0]?.textContent).toContain("ISSUE-20260810-042"));
    expect(client.setIssuePinned).toHaveBeenCalledWith("ISSUE-20260810-041", false);
  });

  test("scrolls a dashboard Issue detail into view on a narrow screen", async () => {
    const originalMatchMedia = window.matchMedia;
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    const scrollIntoView = vi.fn();
    Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: true })) });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    try {
      render(() => <App />);

      const attention = await waitFor(() => screen.getByRole("region", { name: "团队工单动态" }));
      fireEvent.click(within(attention).getByText("批量审批偶发超时").closest("button")!);

      await waitFor(() => expect(screen.getByRole("heading", { name: "批量审批偶发超时" })).toBeTruthy());
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" }));
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
      if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
      else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    }
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

  test("hides production-data and development work modes for product and test users", async () => {
    const client = await import("../data/client");
    for (const role of ["product", "test"] as const) {
      vi.mocked(client.loadCurrentUser).mockResolvedValueOnce({ subject: "fixture-user", name: "严欣", email: "owner@example.test", role });
      const view = render(() => <App initialView="issues" />);
      const queue = await screen.findByLabelText("工单队列");
      const create = within(queue).getByRole("button", { name: "新建工单" });
      await waitFor(() => expect(create).toHaveProperty("disabled", false));
      fireEvent.click(create);
      const dialog = await screen.findByRole("dialog", { name: "新建工单" });
      fireEvent.click(within(dialog).getByLabelText("工单处理方式"));
      const listbox = await screen.findByRole("listbox");
      expect(within(listbox).queryByText("正式数据处理")).toBeNull();
      expect(within(listbox).queryByText("开发缺陷修复")).toBeNull();
      expect(within(listbox).queryByText("开发功能开发")).toBeNull();
      expect(within(listbox).getByText("正式问题调查")).toBeTruthy();
      expect(within(listbox).getByText("测试问题调查")).toBeTruthy();
      view.unmount();
    }
  });

  test("shows related Issue candidates in every work mode and preserves selection across mode changes", async () => {
    const client = await import("../data/client");
    const catalog = await client.loadCatalog();
    const loadedIssues = await client.listIssues();
    const developmentIssue = loadedIssues.find((issue) => issue.id === "ISSUE-20260810-038")!;
    developmentIssue.environmentKey = "dev";
    developmentIssue.workspaceStatus = "ready";
    developmentIssue.agentRunning = false;
    vi.mocked(client.loadCatalog).mockResolvedValueOnce({
      environments: [...catalog.environments, { key: "dev", name: "开发" }],
      services: catalog.services.map((service) => service.key === "orders" ? { ...service, deployments: [...service.deployments, { environmentKey: "dev" }] } : service),
    });
    vi.mocked(client.listIssues).mockResolvedValueOnce(loadedIssues).mockResolvedValueOnce(loadedIssues);
    render(() => <App initialView="issues" />);

    const queue = screen.getByLabelText("工单队列");
    const create = within(queue).getByRole("button", { name: "新建工单" });
    await waitFor(() => expect(create).toHaveProperty("disabled", false));
    fireEvent.click(create);
    const dialog = await screen.findByRole("dialog", { name: "新建工单" });
    await waitFor(() => expect(within(dialog).getByLabelText("关联工单")).toBeTruthy());
    fireEvent.click(within(dialog).getByLabelText("工单处理方式"));
    fireEvent.click(within(await screen.findByRole("listbox")).getByText("测试问题调查"));
    await waitFor(() => expect(within(dialog).getByLabelText("关联工单")).toBeTruthy());

    fireEvent.click(within(dialog).getByLabelText("工单处理方式"));
    fireEvent.click(within(await screen.findByRole("listbox")).getByText("正式问题调查"));
    const relationSelect = await waitFor(() => within(dialog).getByLabelText("关联工单"));
    fireEvent.click(relationSelect);
    const options = await screen.findByRole("listbox");
    expect(within(options).getByText("ISSUE-20260810-038")).toBeTruthy();
    expect(within(options).getByText("ISSUE-20260810-041")).toBeTruthy();
    expect(within(options).getByText("批量审批偶发超时")).toBeTruthy();
    expect(within(options).getAllByText("SRM").length).toBeGreaterThan(0);
    fireEvent.click(within(options).getByText("ISSUE-20260810-038"));
    await waitFor(() => expect(relationSelect.closest(".ui-select")?.textContent).toContain("ISSUE-20260810-038"));
    fireEvent.keyDown(relationSelect, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    fireEvent.click(within(dialog).getByLabelText("工单处理方式"));
    fireEvent.click(await screen.findByRole("option", { name: "测试问题调查" }));
    await waitFor(() => expect(within(dialog).getByLabelText("关联工单").closest(".ui-select")?.textContent).toContain("ISSUE-20260810-038"));
  });

  test("updates related Issues from a production investigation", async () => {
    const client = await import("../data/client");
    const loadedIssues = await client.listIssues();
    const developmentIssue = loadedIssues.find((issue) => issue.id === "ISSUE-20260810-038")!;
    developmentIssue.environmentKey = "dev";
    developmentIssue.workspaceStatus = "ready";
    developmentIssue.agentRunning = false;
    vi.mocked(client.listIssues).mockResolvedValueOnce(loadedIssues).mockResolvedValueOnce(loadedIssues);
    render(() => <App initialView="issues" />);

    const queue = await waitFor(() => screen.getByLabelText("工单队列"));
    fireEvent.click(await waitFor(() => within(queue).getByText("ISSUE-20260810-041")));
    const editButton = await waitFor(() => screen.getByRole("button", { name: "编辑关联" }));
    fireEvent.click(editButton);
    const dialog = await screen.findByRole("dialog", { name: "编辑关联工单" });
    const selector = await waitFor(() => within(dialog).getByLabelText("编辑关联工单"));
    fireEvent.click(selector);
    const options = await screen.findByRole("listbox");
    fireEvent.click(within(options).getByText(/ISSUE-20260810-038/));
    await waitFor(() => expect(selector.closest(".ui-select")?.textContent).toContain("ISSUE-20260810-038"));
    fireEvent.click(within(dialog).getByText(/保存后当前 Agent session/));
    expect(selector.closest(".ui-select")?.textContent).toContain("ISSUE-20260810-038");
    fireEvent.click(within(dialog).getByRole("button", { name: "保存关联" }));
    await waitFor(() => expect(client.updateIssueRelatedIssues).toHaveBeenCalledWith("ISSUE-20260810-041", ["ISSUE-20260810-038"]));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑关联工单" })).toBeNull());
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

  test("keeps an unsaved code draft when navigation or identity changes are declined", async () => {
    const client = await import("../data/client");
    const source = (await client.getIssue("ISSUE-20260810-042"))!;
    const target = (await client.getIssue("ISSUE-20260810-038"))!;
    source.relatedIssues = [{ ...target, workspaceStatus: target.workspace.status, agentRunning: false, resolvedAt: null }];
    vi.mocked(client.getIssue).mockResolvedValueOnce(source);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(() => <App initialView="issues" />);
    fireEvent.click(await screen.findByRole("button", { name: "浏览工单代码" }));
    const browser = await screen.findByRole("region", { name: "ISSUE-20260810-042 代码浏览器" });
    fireEvent.click(await within(browser).findByRole("button", { name: /README\.md/ }));
    const editor = await within(browser).findByLabelText("代码内容 README.md") as HTMLTextAreaElement;
    await fireEvent.input(editor, { target: { value: "keep unsaved code" } });
    await screen.findByText(/README.md · 未保存/);
    fireEvent.click(screen.getByRole("radio", { name: "配置" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("radio", { name: "工单" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByLabelText("当前用户"));
    fireEvent.click(await screen.findByRole("option", { name: "刘宜展 · lyz@example.test" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("当前用户").closest(".identity")?.textContent).toContain("owner@example.test");
    fireEvent.click(within(browser).getByRole("button", { name: "关闭代码浏览器" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole("link", { name: "打开关联工单 ISSUE-20260810-038" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(4));
    expect(new URLSearchParams(window.location.search).get("issue")).toBe("ISSUE-20260810-042");
    expect(editor.value).toBe("keep unsaved code");
    expect(browser.isConnected).toBe(true);
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
    expect(currentUserSelect.closest(".ui-select")?.textContent).toContain("owner@example.test");
    expect(screen.queryByText("生产")).toBeNull();
    expect(screen.queryByText("ISSUE-20260810-038")).toBeNull();
    const agentRegion = screen.getByRole("region", { name: "ISSUE-20260810-042 Agent 会话" });
    expect(agentRegion.querySelector(".agent-conversation")).toBeTruthy();
    expect(agentRegion.querySelector(".agent-composer")).toBeTruthy();
    expect(agentRegion.querySelector(".agent-meta")?.textContent).toContain("~/.issue-pilot/workspaces/issue-20260810-042");
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
    const issueQueue = screen.getByLabelText("工单队列") as HTMLElement;
    const issueWorkspace = document.querySelector(".issue-workspace") as HTMLElement;
    fireEvent.click(screen.getByRole("button", { name: "浏览工单代码" }));
    const sourceBrowser = await waitFor(() => screen.getByRole("region", { name: "ISSUE-20260810-042 代码浏览器" }));
    expect(issueQueue.hidden).toBe(true);
    expect(issueWorkspace.hidden).toBe(false);
    expect(issueWorkspace.classList.contains("source-detail-panel")).toBe(true);
    expect(agentRegion.hidden).toBe(false);
    expect(issueQueue.isConnected && issueWorkspace.isConnected && agentRegion.isConnected).toBe(true);
    expect(sourceBrowser.querySelector("iframe")).toBeNull();
    fireEvent.click(await within(sourceBrowser).findByRole("button", { name: /README.md/ }));
    expect(await within(sourceBrowser).findByLabelText("代码内容 README.md")).toHaveProperty("value", "# SRM source\n");
    const viewToolbar = within(sourceBrowser).getByRole("toolbar", { name: "代码视图" });
    expect(within(viewToolbar).getAllByRole("button").map(button => button.getAttribute("aria-label"))).toEqual(["文件", "搜索", "变更"]);
    const searchToggle = within(viewToolbar).getByRole("button", { name: "搜索" });
    fireEvent.click(searchToggle);
    await waitFor(() => expect(searchToggle.getAttribute("aria-pressed")).toBe("true"));
    expect(within(viewToolbar).getByRole("button", { name: "文件" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(within(viewToolbar).getByRole("button", { name: "文件" }));
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
    fireEvent.click(within(sourceBrowser).getByRole("button", { name: "关闭代码浏览器" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "ISSUE-20260810-042 代码浏览器" })).toBeNull());
    expect(screen.getByLabelText("工单队列")).toBe(issueQueue);
    expect(document.querySelector(".issue-workspace")).toBe(issueWorkspace);
    expect(issueWorkspace.classList.contains("source-detail-panel")).toBe(false);
    expect(screen.getByRole("region", { name: "ISSUE-20260810-042 Agent 会话" })).toBe(agentRegion);
    expect(agentInput.value).toBe("还原后保留的 Agent 草稿");
    expect(screen.getByRole("heading", { name: "结算页提交后订单状态未刷新" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "预览 existing.csv" }));
    const previewDialog = await waitFor(() => screen.getByRole("dialog", { name: "existing.csv" }));
    await waitFor(() => expect(within(previewDialog).getByText(/42,ready/)).toBeTruthy());
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
    expect(within(previewDialog).getByRole("button", { name: "复制文字" })).toBeTruthy();
    fireEvent.click(within(previewDialog).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "existing.csv" })).toBeNull());

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
    expect(within(reopenedIssueDialog).queryByLabelText("编辑工单环境")).toBeNull();
    expect(within(reopenedIssueDialog).queryByLabelText("编辑工单服务")).toBeNull();
    expect(within(reopenedIssueDialog).queryByLabelText("编辑工单类型")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "切换调查范围" })).toBeNull();
    fireEvent.click(within(reopenedIssueDialog).getByRole("button", { name: "取消" }));

    fireEvent.click(await screen.findByText("ISSUE-20260810-041"));
    await waitFor(() => expect(screen.getByRole("button", { name: "确认解决" })).toBeTruthy());
    const issueActions = document.querySelector(".issue-actions");
    expect(issueActions).toBeTruthy();
    expect([...issueActions!.querySelectorAll("button")].map((element) => element.textContent)).toEqual(["确认解决", "变更处理范围", "编辑工单"]);
    fireEvent.click(screen.getByRole("button", { name: "变更处理范围" }));
    const scopeDialog = await waitFor(() => screen.getByRole("dialog", { name: "变更处理范围" }));
    fireEvent.click(within(scopeDialog).getByLabelText("目标处理方式"));
    fireEvent.click(within(await screen.findByRole("listbox")).getByText("开发缺陷修复"));
    await waitFor(() => expect(within(scopeDialog).getByLabelText("目标处理方式").closest(".ui-select")?.textContent).toContain("开发缺陷修复"));
    fireEvent.click(within(scopeDialog).getByRole("button", { name: "预检变更" }));
    const scopePreview = await waitFor(() => within(scopeDialog).getByRole("region", { name: "范围变更预览" }));
    expect(scopePreview.classList.contains("scope-transition-preview")).toBe(true);
    expect(scopePreview.querySelectorAll(".scope-transition-repository").length).toBeGreaterThan(0);
    expect(scopePreview.querySelector(".issue-attachment-row")).toBeNull();
    expect(within(scopeDialog).getByText(/hotfix-issue-20260810-041/)).toBeTruthy();
    fireEvent.click(within(scopeDialog).getByRole("button", { name: "确认变更" }));
    const clientAfterConversion = await import("../data/client");
    await waitFor(() => expect(clientAfterConversion.applyIssueScopeTransition).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "变更处理范围" })).toBeNull());
    expect(screen.getByRole("button", { name: "变更处理范围" })).toBeTruthy();
    expect([...issueActions!.querySelectorAll("button")].map((element) => element.textContent)).toEqual(["确认解决", "创建正式跟进", "变更处理范围", "编辑工单"]);
    fireEvent.click(screen.getByRole("button", { name: "创建正式跟进" }));
    const followUpDialog = await waitFor(() => screen.getByRole("dialog", { name: "创建正式跟进工单" }));
    expect((within(followUpDialog).getByLabelText("正式跟进标题") as HTMLInputElement).value).toBe("【正式跟进】客户导出的 CSV 缺少时区信息");
    expect(within(followUpDialog).getByText(/附件不会复制/)).toBeTruthy();
    fireEvent.click(within(followUpDialog).getByRole("button", { name: "取消" }));
    const scopeHistory = screen.getByRole("heading", { name: "处理历史" }).closest("section")!;
    expect(scopeHistory.textContent).toContain("Orders · 正式问题调查 → Orders · 开发缺陷修复");
    expect(scopeHistory.textContent).toContain("严欣");
    expect(screen.queryByRole("button", { name: "释放工作区" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "编辑工单" }));
    const developmentEditor = await waitFor(() => screen.getByRole("dialog", { name: "编辑工单" }));
    expect(within(developmentEditor).queryByLabelText("编辑工单环境")).toBeNull();
    expect(within(developmentEditor).queryByLabelText("编辑工单服务")).toBeNull();
    expect(within(developmentEditor).queryByLabelText("编辑工单类型")).toBeNull();
    fireEvent.click(within(developmentEditor).getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "浏览工单代码" }));
    const developmentSource = await waitFor(() => screen.getByRole("region", { name: "ISSUE-20260810-041 代码浏览器" }));
    expect(developmentSource.querySelector("iframe")).toBeNull();
    expect(within(developmentSource).getByRole("button", { name: "变更" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(developmentSource).getByRole("button", { name: "Agent面板" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(developmentSource).getByRole("button", { name: "工单详情" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(developmentSource).getByRole("button", { name: "关闭代码浏览器" }));
    fireEvent.click(screen.getByLabelText("当前用户"));
    fireEvent.click(await screen.findByText("刘宜展 · lyz@example.test"));
    await waitFor(() => expect(currentUserSelect.closest(".ui-select")?.textContent).toContain("lyz@example.test"));
    await waitFor(() => expect(screen.getByText("ISSUE-20260810-038")).toBeTruthy());
    expect(screen.queryByLabelText("添加评论或备注")).toBeNull();
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
    expect(await screen.findByText("每 15 分钟自动检查 · 已解决保留 7 天")).toBeTruthy();
    expect(screen.getByText("20.0 GB")).toBeTruthy();
    expect(screen.getByText("解决后纳入")).toBeTruthy();
    expect(screen.getByText("仓库目录缺失")).toBeTruthy();
    expect(screen.getByText("仓库记录不完整或混合")).toBeTruthy();
    expect(screen.getByText("仓库路径不一致")).toBeTruthy();
    expect(screen.getByText("仓库目录名冲突")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "团队" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "个人处理情况" })).toBeTruthy());

    fireEvent.click(screen.getByRole("radio", { name: "配置" }));
    await fireEvent.click(await screen.findByRole("tab", { name: "服务" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "SRM" })).toBeTruthy());
    const servicePanel = document.querySelector(".service-panel") as HTMLElement;
    expect(screen.queryByRole("button", { name: /拖动排序/ })).toBeNull();
    expect(screen.queryByLabelText("选择服务")).toBeNull();
    expect(document.querySelector(".environment-panel")).toBeNull();
    expect(within(servicePanel).getByText("供应商关系管理服务。")).toBeTruthy();
    expect(servicePanel.textContent).toContain("develop");
    expect(servicePanel.textContent).toContain("sls");

    fireEvent.click(within(servicePanel).getByRole("button", { name: "编辑" }));
    const serviceDialog = await waitFor(() => screen.getByRole("dialog", { name: "编辑服务" }));
    expect(screen.queryByLabelText("服务类型")).toBeNull();
    expect(serviceDialog.textContent).toContain("环境部署");
    expect(within(serviceDialog).getByRole("button", { name: "展开部署2" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByLabelText("部署 2 仓库 srm 分支")).toBeNull();
    fireEvent.click(within(serviceDialog).getByRole("button", { name: "展开部署2" }));
    await waitFor(() => expect(within(serviceDialog).getByRole("button", { name: "收起部署2" }).getAttribute("aria-expanded")).toBe("true"));
    expect(screen.getByLabelText("部署 2 环境").textContent).toContain("测试");
    expect(screen.getByLabelText("部署 2 能力").textContent).toContain("SLS");
    expect(screen.queryByLabelText("仓库别名 1")).toBeNull();
    const repositoryInput = screen.getByLabelText("关联仓库");
    fireEvent.click(repositoryInput);
    fireEvent.click(await screen.findByRole("option", { name: /git@example.com:team\/srm.git/ }));
    fireEvent.click(await screen.findByRole("option", { name: /Updated repository/ }));
    fireEvent.keyDown(repositoryInput, { key: "Escape" });
    await waitFor(() => expect(repositoryInput.closest(".ui-select")?.textContent).toContain("Updated repository"));
    const branchInput = screen.getByLabelText(/部署 2 仓库 .* 分支/) as HTMLInputElement;
    branchInput.focus();
    for (const value of ["r", "re", "rel", "release/test"]) {
      fireEvent.input(branchInput, { target: { value } });
      expect(document.activeElement).toBe(branchInput);
      expect(branchInput.isConnected).toBe(true);
      expect(screen.getByLabelText("部署 2 仓库 Updated repository 分支")).toBe(branchInput);
      expect(branchInput.value).toBe(value);
    }
    expect(within(serviceDialog).getAllByRole("checkbox").map(item => item.parentElement?.textContent)).toEqual(["DBHub", "DMS", "SLS"]);
    expect(within(serviceDialog).getByRole("checkbox", { name: "SLS" })).toHaveProperty("checked", true);
    expect(within(serviceDialog).queryByRole("button", { name: "playwright" })).toBeNull();
    expect([...serviceDialog.querySelectorAll(".capability-settings-head code")].map((item) => item.textContent)).toEqual(["代码分支", "SLS"]);
    const projectInput = screen.getByLabelText("sls project 2");
    fireEvent.input(projectInput, { target: { value: "srm-updated" } });
    fireEvent.click(within(serviceDialog).getByRole("button", { name: "收起部署2" }));
    await waitFor(() => expect(screen.queryByLabelText("sls project 2")).toBeNull());
    fireEvent.click(within(serviceDialog).getByRole("button", { name: "展开部署2" }));
    expect(await screen.findByLabelText("sls project 2")).toHaveProperty("value", "srm-updated");
    const client = await import("../data/client");
    fireEvent.click(within(serviceDialog).getByRole("button", { name: "保存" }));
    await waitFor(() => {
      const alert = within(serviceDialog).queryByRole("alert");
      if (alert) throw new Error(alert.textContent ?? "service save failed");
      expect(client.updateService).toHaveBeenCalled();
    });
    expect(vi.mocked(client.updateService).mock.calls.at(-1)?.[0]).toBe("srm");
    const savedService = vi.mocked(client.updateService).mock.calls.at(-1)?.[1];
    expect(savedService?.repositories[0]).toEqual({ alias: "repository-updated-repository", url: "git@example.test:team/updated.git" });
    expect(savedService?.deployments[1]?.repositoryBranches).toEqual([{ repositoryAlias: "repository-updated-repository", baseBranch: "release/test" }]);
    expect(savedService?.deployments[1]?.sls).toEqual({ region: "cn-test", project: "srm-updated", logstores: ["srm"] });
    expect(savedService?.deployments[1]?.dms).toBeUndefined();
    expect(JSON.stringify(savedService)).not.toContain("db-secret");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑服务" })).toBeNull());
    expect(client.loadCatalog).toHaveBeenCalledTimes(2);
    expect(client.loadConfig).toHaveBeenCalledTimes(2);
    expect(client.loadUsers).toHaveBeenCalledTimes(1);
    expect(client.loadCurrentUser).toHaveBeenCalledTimes(1);
    expect(consoleWarning.mock.calls.flat().filter((message) => String(message).includes("STRICT_READ_UNTRACKED"))).toEqual([]);
  });

  test("multi-selects service repositories without aliases and synchronizes environment branches", async () => {
    render(() => <App initialView="configuration" />);
    await fireEvent.click(await screen.findByRole("tab", { name: "服务" }));
    const panel = await waitFor(() => document.querySelector(".service-panel") as HTMLElement);
    fireEvent.click(await waitFor(() => within(panel).getByRole("button", { name: "添加" })));
    const dialog = await screen.findByRole("dialog", { name: "添加服务" });
    const selector = within(dialog).getByLabelText("关联仓库");
    await waitFor(() => expect(selector.getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(selector);
    fireEvent.click(await screen.findByRole("option", { name: /git@example.com:team\/srm.git/ }));
    fireEvent.click(await screen.findByRole("option", { name: /Updated repository/ }));
    fireEvent.keyDown(selector, { key: "Escape" });
    expect(within(dialog).queryByText("本服务别名")).toBeNull();
    fireEvent.click(await within(dialog).findByRole("button", { name: "展开部署2" }));
    const retained = await within(dialog).findByLabelText("部署 2 仓库 srm 分支");
    fireEvent.input(retained, { target: { value: "feature/keep" } });
    fireEvent.click(selector);
    fireEvent.click(await screen.findByRole("option", { name: /Updated repository/ }));
    fireEvent.click(await screen.findByRole("option", { name: /git@example.com:team\/orders.git/ }));
    fireEvent.keyDown(selector, { key: "Escape" });
    await waitFor(() => expect(within(dialog).getByLabelText("部署 2 仓库 srm 分支")).toHaveProperty("value", "feature/keep"));
    expect(within(dialog).getByLabelText("部署 2 仓库 orders 分支")).toHaveProperty("value", "main");
    expect(within(dialog).queryByLabelText("部署 2 仓库 Updated repository 分支")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(within(panel).queryByRole("button", { name: "管理仓库" })).toBeNull();
  });

  test("derives the readonly development baseline from production and retains the description editor", async () => {
    render(() => <App initialView="configuration" />);
    expect(screen.queryByRole("tab", { name: "环境" })).toBeNull();
    await fireEvent.click(await screen.findByRole("tab", { name: "服务" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Orders" }));
    const panel = document.querySelector(".service-panel") as HTMLElement;
    await waitFor(() => expect(within(panel).getByRole("tab", { name: "Orders" }).getAttribute("aria-selected")).toBe("true"));
    expect(panel.querySelector(".service-repositories")).toBeTruthy();
    expect(panel.querySelector(".service-environment-card")).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "编辑" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑服务" });
    const description = within(dialog).getByLabelText("项目描述");
    fireEvent.input(description, { target: { value: "开发时查询正式订单，测试时查询测试日志。" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "展开部署1" }));
    expect((await within(dialog).findByLabelText("orders 开发基线")).textContent).toBe("main");
    expect(within(dialog).queryByLabelText("部署 1 仓库 orders 分支")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "展开部署3" }));
    fireEvent.input(await within(dialog).findByLabelText("部署 3 仓库 orders 分支"), { target: { value: "release/current" } });
    await waitFor(() => expect(within(dialog).getByLabelText("orders 开发基线").textContent).toBe("release/current"));
    expect(within(dialog).queryByLabelText("redis host 2")).toBeNull();
    const developmentRow = within(dialog).getByLabelText("部署 1 能力").closest(".service-deployment-row") as HTMLElement;
    expect(within(developmentRow).queryByRole("button", { name: "dms" })).toBeNull();
    expect(within(dialog).getByLabelText("部署 1 能力").textContent).toContain("查询继承正式/测试");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  });

  test("clears service credential drafts when the selected identity changes", async () => {
    render(() => <App initialView="configuration" />);
    await fireEvent.click(await screen.findByRole("tab", { name: "服务" }));
    const panel = document.querySelector(".service-panel") as HTMLElement;
    fireEvent.click(await within(panel).findByRole("button", { name: "编辑" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑服务" });
    fireEvent.click(within(dialog).getByRole("button", { name: "展开部署2" }));
    await fireEvent.click(await within(dialog).findByRole("checkbox", { name: "DMS" }));
    const password = await within(dialog).findByLabelText("dms Token 2");
    fireEvent.input(password, { target: { value: "old-identity-private-draft" } });
    fireEvent.click(screen.getByLabelText("当前用户"));
    fireEvent.click(await screen.findByRole("option", { name: "刘宜展 · lyz@example.test" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑服务" })).toBeNull());
    expect(password.isConnected).toBe(false);
    fireEvent.click(within(panel).getByRole("button", { name: "编辑" }));
    const currentDialog = await screen.findByRole("dialog", { name: "编辑服务" });
    fireEvent.click(within(currentDialog).getByRole("button", { name: "展开部署2" }));
    await fireEvent.click(await within(currentDialog).findByRole("checkbox", { name: "DMS" }));
    expect(await within(currentDialog).findByLabelText("dms Token 2")).toHaveProperty("value", "");
  });

  for (const outcome of ["success", "failure"] as const) test(`ignores an old identity's service-save ${outcome} after a new editor opens`, async () => {
    const client = await import("../data/client");
    let finish!: () => void;
    vi.mocked(client.updateService).mockImplementationOnce(() => new Promise<void>((resolve, reject) => { finish = outcome === "success" ? resolve : () => reject(new Error("old_service_save_failed")); }));
    render(() => <App initialView="configuration" />);
    try {
      await fireEvent.click(await screen.findByRole("tab", { name: "服务" }));
      const panel = document.querySelector(".service-panel") as HTMLElement;
      fireEvent.click(await within(panel).findByRole("button", { name: "编辑" }));
      const dialog = await screen.findByRole("dialog", { name: "编辑服务" });
      const save = within(dialog).getByRole("button", { name: "保存" });
      await waitFor(() => expect(save).toHaveProperty("disabled", false));
      fireEvent.click(save);
      await waitFor(() => expect(finish).toBeTypeOf("function"));
      fireEvent.click(screen.getByLabelText("当前用户"));
      fireEvent.click(await screen.findByRole("option", { name: "刘宜展 · lyz@example.test" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑服务" })).toBeNull());
      fireEvent.click(within(panel).getByRole("button", { name: "编辑" }));
      const current = await screen.findByRole("dialog", { name: "编辑服务" });
      fireEvent.input(within(current).getByLabelText("服务名称"), { target: { value: "new identity draft" } });
      finish();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(screen.getByRole("dialog", { name: "编辑服务" })).toBe(current);
      expect(within(current).getByLabelText("服务名称")).toHaveProperty("value", "new identity draft");
      expect(screen.queryByText("old_service_save_failed")).toBeNull();
    } finally { finish?.(); }
  });

  test("shows developer configuration credentials and removes them when switching to a product user", async () => {
    const client = await import("../data/client");
    const users = await client.loadUsers();
    vi.mocked(client.loadUsers).mockResolvedValueOnce([...users, { subject: "viewer", name: "Viewer", email: "viewer@example.test", role: "product" }]);
    const loadDescription = vi.mocked(client.loadServiceConfigurationDescription).getMockImplementation()!;
    vi.mocked(client.loadServiceConfigurationDescription).mockResolvedValue({ context: "### 测试环境\n\n#### MySQL\n\n| 配置项 | 值 |\n| --- | --- |\n| 密码 | <code>synthetic-private-password</code> |" });
    render(() => <App initialView="configuration" />);
    await fireEvent.click(await screen.findByRole("tab", { name: "服务" }));
    await screen.findByText("synthetic-private-password");
    expect(document.querySelector(".service-description table")).toBeTruthy();
    const selector = screen.getByLabelText("当前用户");
    fireEvent.click(selector);
    fireEvent.click(await screen.findByRole("option", { name: "Viewer · viewer@example.test" }));
    await waitFor(() => expect(screen.queryByText("synthetic-private-password")).toBeNull());
    const panel = document.querySelector(".service-panel") as HTMLElement;
    expect(within(panel).getByRole("button", { name: "编辑" })).toHaveProperty("disabled", true);
    expect(within(panel).getByRole("button", { name: "添加" })).toHaveProperty("disabled", true);
    vi.mocked(client.loadServiceConfigurationDescription).mockImplementation(loadDescription);
  });

  test("copies application MCP configurations for JSON clients, VS Code and Codex", async () => {
    const clipboard = await import("../ui/clipboard");
    const copy = vi.spyOn(clipboard, "copyText").mockResolvedValue();
    render(() => <App initialView="configuration" />);
    const tabs = screen.getByRole("tablist", { name: "配置分类" });
    expect(within(tabs).getAllByRole("tab").at(-1)?.textContent).toBe("端点");
    fireEvent.click(within(tabs).getByRole("tab", { name: "端点" }));
    const panel = await screen.findByRole("region", { name: "端点说明" });
    const connection = { type: "http", url: `${window.location.origin}/mcp`, headers: { "X-Issue-Pilot-Subject": "fixture-user" } };
    const preview = () => within(panel).getByLabelText("MCP 客户端配置").textContent!;
    await waitFor(() => expect(JSON.parse(preview())).toEqual({ mcpServers: { "issue-pilot": connection } }));
    fireEvent.click(within(panel).getByRole("button", { name: "复制配置" }));
    await waitFor(() => expect(copy).toHaveBeenLastCalledWith(preview()));
    expect(await within(panel).findByRole("button", { name: "已复制配置" })).toBeTruthy();
    fireEvent.click(within(panel).getByLabelText("接入客户端"));
    fireEvent.click(await screen.findByRole("option", { name: "VS Code" }));
    await waitFor(() => expect(JSON.parse(preview())).toEqual({ servers: { "issue-pilot": connection } }));
    fireEvent.click(within(panel).getByRole("button", { name: "复制配置" }));
    await waitFor(() => expect(copy).toHaveBeenLastCalledWith(preview()));
    fireEvent.click(within(panel).getByLabelText("接入客户端"));
    fireEvent.click(await screen.findByRole("option", { name: "Codex" }));
    await waitFor(() => expect(preview()).toBe(`[mcp_servers.issue-pilot]\nurl = "${window.location.origin}/mcp"\nhttp_headers = { "X-Issue-Pilot-Subject" = "fixture-user" }`));
    fireEvent.click(within(panel).getByRole("button", { name: "复制配置" }));
    await waitFor(() => expect(copy).toHaveBeenLastCalledWith(preview()));
    expect(within(panel).queryByRole("button", { name: "复制地址" })).toBeNull();
    expect(await within(panel).findByText("issue_get")).toBeTruthy();
    expect(within(panel).getByText("Read Issue details")).toBeTruthy();
    expect(within(panel).queryByLabelText("搜索端点工具")).toBeNull();
    expect(within(panel).queryByText("完整输入格式")).toBeNull();
  });

  test("updates copied MCP identity when the selected user changes", async () => {
    const clipboard = await import("../ui/clipboard");
    const copy = vi.spyOn(clipboard, "copyText").mockResolvedValue();
    render(() => <App initialView="configuration" />);
    fireEvent.click(screen.getByRole("tab", { name: "端点" }));
    const panel = await screen.findByRole("region", { name: "端点说明" });
    await within(panel).findByLabelText("MCP 客户端配置");
    fireEvent.click(within(panel).getByRole("button", { name: "复制配置" }));
    await within(panel).findByRole("button", { name: "已复制配置" });
    fireEvent.click(screen.getByLabelText("当前用户"));
    fireEvent.click(await screen.findByRole("option", { name: "刘宜展 · lyz@example.test" }));
    await waitFor(() => expect(within(panel).getByLabelText("MCP 客户端配置").textContent).toContain('"X-Issue-Pilot-Subject": "second-user"'));
    expect(within(panel).queryByRole("button", { name: "已复制配置" })).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "复制配置" }));
    await waitFor(() => expect(JSON.parse(copy.mock.calls.at(-1)![0]).mcpServers["issue-pilot"].headers).toEqual({ "X-Issue-Pilot-Subject": "second-user" }));
  });

  test("keeps the MCP configuration available after copy failure and allows retry", async () => {
    const client = await import("../data/client");
    const clipboard = await import("../ui/clipboard");
    const copy = vi.spyOn(clipboard, "copyText").mockRejectedValueOnce(new Error("clipboard_write_failed")).mockResolvedValue();
    render(() => <App initialView="configuration" />);
    fireEvent.click(screen.getByRole("tab", { name: "端点" }));
    const panel = await screen.findByRole("region", { name: "端点说明" });
    const preview = await within(panel).findByLabelText("MCP 客户端配置");
    const requests = vi.mocked(client.loadApplicationEndpoints).mock.calls.length;
    fireEvent.click(within(panel).getByRole("button", { name: "复制配置" }));
    expect((await within(panel).findByRole("alert")).textContent).toContain("手动复制");
    expect(within(panel).getByLabelText("MCP 客户端配置").textContent).toBe(preview.textContent);
    fireEvent.click(within(panel).getByRole("button", { name: "复制配置" }));
    await within(panel).findByRole("button", { name: "已复制配置" });
    expect(within(panel).queryByRole("alert")).toBeNull();
    expect(copy).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.loadApplicationEndpoints).mock.calls.length).toBe(requests);
  });

  test("edits wildcard logstores without showing or changing internal SLS target names", async () => {
    const client = await import("../data/client");
    const configuration = structuredClone(await client.loadConfig());
    const deployment = configuration.services[0]!.deployments[0]!;
    const primary = { name: "primary", region: "cn-test", project: "srm-test", logstores: ["srm"] };
    const secondary = { name: "gateway", region: "cn-other", project: "gateway-prod", logstores: ["requests"] };
    deployment.sls = { ...deployment.sls!, targets: [primary, secondary] };
    vi.mocked(client.loadConfig).mockResolvedValueOnce(configuration);
    vi.mocked(client.updateService).mockClear();
    render(() => <App initialView="configuration" />);
    await fireEvent.click(await screen.findByRole("tab", { name: "服务" }));
    await screen.findByRole("tablist", { name: "服务列表" });
    fireEvent.click(document.querySelector(".service-tab-actions button:last-child")!);
    const dialog = await screen.findByRole("dialog", { name: "编辑服务" });
    fireEvent.click(within(dialog).getByRole("button", { name: "展开部署2" }));
    const project = await within(dialog).findByLabelText("sls project 2");
    expect(within(dialog).queryByText("目标名称")).toBeNull();
    expect(within(dialog).queryByLabelText("sls name 2-1")).toBeNull();
    await fireEvent.input(project, { target: { value: "srm-updated" } });
    await fireEvent.input(within(dialog).getByLabelText("sls logstore 2"), { target: { value: "*" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "收起部署2" }));
    await waitFor(() => expect(within(dialog).queryByLabelText("sls project 2")).toBeNull());
    fireEvent.click(within(dialog).getByRole("button", { name: "展开部署2" }));
    expect(await within(dialog).findByLabelText("sls project 2")).toHaveProperty("value", "srm-updated");
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(client.updateService).toHaveBeenCalled());
    const saved = vi.mocked(client.updateService).mock.calls.at(-1)![1];
    expect(saved.deployments[1]?.sls?.targets).toEqual([{ ...primary, project: "srm-updated", logstores: ["*"] }, secondary]);
    expect(saved.deployments[1]?.sls?.credentialUpdate).toBeUndefined();
  });

  test("edits DMS and SLS targets consistently while preserving credentials and resolved bindings", async () => {
    const client = await import("../data/client");
    const configuration = structuredClone(await client.loadConfig());
    const deployment = configuration.services[0]!.deployments[0]!;
    const database = { instanceAlias: "SRM", schemaName: "srm", instanceId: "i1", instanceHost: "db.example.test", instancePort: "3306", databaseId: "42" };
    const target = { name: "primary", region: "cn-test", project: "srm-test", logstores: ["srm"] };
    deployment.capabilities.push("dms");
    deployment.dms = { url: "https://dms.example.test/sse", credentialConfigured: true, databases: [database, { ...database, instanceAlias: "OTHER", schemaName: "other", databaseId: "43" }] };
    deployment.sls = { ...deployment.sls!, targets: [target, { ...target, name: "gateway", project: "gateway-test" }] };
    vi.mocked(client.loadConfig).mockResolvedValueOnce(configuration);
    vi.mocked(client.updateService).mockClear();
    vi.mocked(client.resolveDmsScope).mockClear();
    render(() => <App initialView="configuration" />);
    fireEvent.click(await screen.findByRole("tab", { name: "服务" }));
    await screen.findByRole("tablist", { name: "服务列表" });
    fireEvent.click(document.querySelector(".service-tab-actions button:last-child")!);
    const dialog = await screen.findByRole("dialog", { name: "编辑服务" });
    fireEvent.click(within(dialog).getByRole("button", { name: "展开部署2" }));
    for (const capability of ["DMS", "SLS"]) {
      const group = await within(dialog).findByRole("group", { name: `${capability} 配置` });
      if (capability === "DMS") expect(within(group).getByRole("region", { name: "DMS 连接凭证" })).toBeTruthy();
      else expect(within(group).queryByRole("region", { name: "SLS 连接凭证" })).toBeNull();
      const targets = within(group).getByRole("region", { name: `${capability} 查询目标` });
      expect(within(targets).getByRole("button", { name: `添加 ${capability} 目标` }).textContent).toBe("添加目标");
      fireEvent.click(within(targets).getByRole("button", { name: `移除 ${capability} 2 2` }));
      await waitFor(() => expect(within(targets).getByRole("button", { name: `移除 ${capability} 2 1` })).toHaveProperty("disabled", true));
    }
    expect(within(dialog).queryByLabelText("sls AccessKey Secret 2")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "收起部署2" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "展开部署2" }));
    expect(await within(dialog).findByLabelText("dms database 2-1")).toHaveProperty("value", "srm");
    expect(within(dialog).queryByLabelText("dms database 2-2")).toBeNull();
    expect(within(dialog).queryByLabelText("sls name 2-2")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(client.updateService).toHaveBeenCalledOnce());
    const saved = vi.mocked(client.updateService).mock.calls[0]![1].deployments[1]!;
    expect(saved.dms?.databases).toEqual([database]);
    expect(saved.dms?.credentialUpdate).toEqual({ mode: "preserve" });
    expect(saved.sls?.targets).toEqual([target]);
    expect(saved.sls?.credentialUpdate).toBeUndefined();
    expect(client.resolveDmsScope).not.toHaveBeenCalled();
  });

  test("shows the upstream DMS rate limit while resolving a database", async () => {
    const client = await import("../data/client");
    const configuration = structuredClone(await client.loadConfig());
    const deployment = configuration.services[0]!.deployments[0]!;
    deployment.capabilities.push("dms");
    deployment.dms = { url: "https://dms.example.test/sse", credentialConfigured: true, databases: [{ instanceAlias: "SRM", schemaName: "srm", instanceId: "i1", instanceHost: "db.example.test", instancePort: "3306", databaseId: "42" }] };
    vi.mocked(client.loadConfig).mockResolvedValueOnce(configuration);
    vi.mocked(client.resolveDmsScope).mockRejectedValueOnce(new Error("dms_mcp_http_429"));
    render(() => <App initialView="configuration" />);
    await fireEvent.click(await screen.findByRole("tab", { name: "服务" }));
    await screen.findByRole("tablist", { name: "服务列表" });
    fireEvent.click(document.querySelector(".service-tab-actions button:last-child")!);
    const dialog = await screen.findByRole("dialog", { name: "编辑服务" });
    fireEvent.click(within(dialog).getByRole("button", { name: "展开部署2" }));
    fireEvent.input(await within(dialog).findByLabelText("dms database 2-1"), { target: { value: "changed_schema" } });
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toContain("请求被限流（HTTP 429）"));
  });

  test("keeps parsed DMS targets when replacing only the Token", async () => {
    const client = await import("../data/client");
    const configuration = structuredClone(await client.loadConfig());
    const service = configuration.services[0]!;
    const deployment = service.deployments[0]!;
    deployment.capabilities.push("dms");
    deployment.dms = { url: "https://dms.example.test/sse", credentialConfigured: true, databases: [{ instanceAlias: "SRM", schemaName: "srm", instanceId: "i1", instanceHost: "db.example.test", instancePort: "3306", databaseId: "42" }] };
    vi.mocked(client.loadConfig).mockResolvedValueOnce(configuration);
    vi.mocked(client.updateService).mockClear();
    vi.mocked(client.resolveDmsScope).mockClear();
    render(() => <App initialView="configuration" />);
    await fireEvent.click(await screen.findByRole("tab", { name: "服务" }));
    const panel = await screen.findByRole("tablist", { name: "服务列表" });
    await waitFor(() => expect(within(panel).getByRole("tab", { name: "SRM" })).toBeTruthy());
    fireEvent.click(document.querySelector(".service-tab-actions button:last-child")!);
    const dialog = await screen.findByRole("dialog", { name: "编辑服务" });
    fireEvent.click(within(dialog).getByRole("button", { name: "展开部署2" }));
    const token = await within(dialog).findByLabelText("dms Token 2");
    fireEvent.input(token, { target: { value: "Bearer replacement" } });
    await waitFor(() => expect(within(dialog).getByText("数据库范围已确认")).toBeTruthy());
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(client.updateService).toHaveBeenCalled());
    const saved = vi.mocked(client.updateService).mock.calls.at(-1)![1];
    expect(saved.deployments[1]?.dms?.databases[0]?.databaseId).toBe("42");
    expect(saved.deployments[1]?.dms?.credentialUpdate).toEqual({ mode: "replace", values: { authorization: "Bearer replacement" } });
    expect(client.resolveDmsScope).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑服务" })).toBeNull());
  });

  test("omits the removed capability page from settings", async () => {
    render(() => <App initialView="configuration" />);
    await screen.findByRole("tab", { name: "用户" });
    expect(screen.queryByRole("tab", { name: "能力" })).toBeNull();
    expect(screen.queryByRole("region", { name: "能力管理" })).toBeNull();
  });

  test("sorts repositories by their address directories without rendering group headings", async () => {
    const client = await import("../data/client");
    const now = new Date().toISOString();
    const urls = ["git@example.test:team/sub/z.git", "git@example.test:team/z.git", "git@example.test:team/sub/a.git", "git@example.test:team/a.git"];
    const loadRepositories = vi.mocked(client.loadRepositories), original = loadRepositories.getMockImplementation()!;
    loadRepositories.mockResolvedValue(urls.map((url, index) => ({ id: `repo-${index}`, revision: 0, name: `Repository ${3 - index}`, url, createdAt: now, updatedAt: now, services: [] })));
    try {
      render(() => <App initialView="configuration" />);
      fireEvent.click(await screen.findByRole("tab", { name: "仓库" }));
      const panel = await screen.findByRole("region", { name: "仓库管理" });
      await within(panel).findByText("git@example.test:team/sub/z.git");
      expect(panel.querySelector(".repository-catalog-group")).toBeNull();
      expect([...panel.querySelectorAll(".settings-table tbody tr td:nth-child(2) code")].map(row => row.textContent)).toEqual(["git@example.test:team/a.git", "git@example.test:team/z.git", "git@example.test:team/sub/a.git", "git@example.test:team/sub/z.git"]);
    } finally { loadRepositories.mockImplementation(original); }
  });

  test("shows repository names, addresses, usage and developer maintenance controls", async () => {
    render(() => <App initialView="configuration" />);
    fireEvent.click(await screen.findByRole("tab", { name: "仓库" }));
    const panel = await screen.findByRole("region", { name: "仓库管理" });
    await within(panel).findByText("git@example.com:team/srm.git");
    expect(within(panel).getByRole("button", { name: "登记仓库" })).toBeTruthy();
    expect(within(panel).getAllByRole("button", { name: "编辑" }).length).toBeGreaterThan(0);
    expect(within(panel).queryByText("引用服务")).toBeNull();
    expect(within(panel).queryByText("操作")).toBeNull();
    expect(within(panel).queryByText(/修改后重启生效/)).toBeNull();
  });

  test("repository usage can select the same service again after a manual service Tab change", async () => {
    render(() => <App initialView="configuration" />);
    const categories = await screen.findByRole("tablist", { name: "配置分类" });
    fireEvent.click(within(categories).getByRole("tab", { name: "仓库" }));
    const repositories = await screen.findByRole("region", { name: "仓库管理" });
    fireEvent.click(await within(repositories).findByRole("button", { name: "SRM" }));
    const services = await screen.findByRole("tablist", { name: "服务列表" });
    await waitFor(() => expect(within(services).getByRole("tab", { name: "SRM" }).getAttribute("aria-selected")).toBe("true"));
    fireEvent.click(within(services).getByRole("tab", { name: "Orders" }));
    await waitFor(() => expect(within(services).getByRole("tab", { name: "Orders" }).getAttribute("aria-selected")).toBe("true"));
    fireEvent.click(within(categories).getByRole("tab", { name: "仓库" }));
    fireEvent.click(await screen.findByRole("button", { name: "SRM" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "SRM" }).getAttribute("aria-selected")).toBe("true"));
  });

  test("skip navigation focuses the workspace without changing the current URL", async () => {
    render(() => <App initialView="configuration" />);
    const link = await screen.findByRole("link", { name: "跳到主要内容" });
    const content = document.getElementById("app-content");
    const location = window.location.href;
    fireEvent.click(link);
    await waitFor(() => expect(document.activeElement).toBe(content));
    expect(window.location.href).toBe(location);
    expect(screen.getByRole("tablist", { name: "配置分类" })).toBeTruthy();
  });

  test("loads only visited settings categories and retains personnel filters across navigation", async () => {
    const client = await import("../data/client");
    for (const mock of [client.loadConfig, client.loadRepositories, client.loadApplicationEndpoints, client.loadServiceConfigurationDescription, client.loadManagedUsers]) vi.mocked(mock).mockClear();
    render(() => <App initialView="configuration" />);
    const credentials = await screen.findByRole("region", { name: "我的凭证" });
    await within(credentials).findByText("API Key");
    const members = await screen.findByRole("region", { name: "人员管理" });
    await within(members).findByText("严欣");
    expect(client.loadConfig).not.toHaveBeenCalled(); expect(client.loadRepositories).not.toHaveBeenCalled();
    expect(client.loadApplicationEndpoints).not.toHaveBeenCalled(); expect(client.loadServiceConfigurationDescription).not.toHaveBeenCalled();
    const search = within(members).getByLabelText("搜索人员");
    await fireEvent.input(search, { target: { value: "严欣" } });
    fireEvent.click(screen.getByRole("tab", { name: "仓库" }));
    await screen.findByRole("button", { name: "登记仓库" });
    await waitFor(() => expect(client.loadRepositories).toHaveBeenCalledTimes(1));
    expect(client.loadConfig).not.toHaveBeenCalled(); expect(client.loadApplicationEndpoints).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "用户" }));
    expect(screen.getByLabelText("搜索人员")).toBe(search); expect(search).toHaveProperty("value", "严欣");
    expect(client.loadManagedUsers).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("tab", { name: "端点" }));
    await screen.findByLabelText("MCP 客户端配置");
    expect(client.loadApplicationEndpoints).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("tab", { name: "服务" }));
    await screen.findByRole("tab", { name: "SRM" });
    expect(client.loadConfig).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(client.loadRepositories).toHaveBeenCalledTimes(2));
  });

  test("shows four personal credentials followed by personnel management", async () => {
    render(() => <App initialView="configuration" />);
    const tabs = await screen.findByRole("tablist", { name: "配置分类" });
    expect(within(tabs).getAllByRole("tab").map(tab => tab.textContent)).toEqual(["用户", "仓库", "服务", "端点"]);
    const credentials = await screen.findByRole("region", { name: "我的凭证" });
    await within(credentials).findByText("API Key");
    expect(within(credentials).getByText("SSH Key")).toBeTruthy();
    expect(within(credentials).getByText("SLS")).toBeTruthy();
    expect(within(credentials).getByText("DMS")).toBeTruthy();
    expect(within(credentials).queryByText("钉钉")).toBeNull();
    expect(screen.getByRole("region", { name: "人员管理" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "添加用户" })).toBeNull();
  });

  test("retries the initial configuration request in place", async () => {
    const client = await import("../data/client");
    vi.mocked(client.loadConfig).mockClear();
    vi.mocked(client.loadConfig).mockRejectedValueOnce(new Error("configuration_unavailable"));
    const view = render(() => <App initialView="issues" />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "结算页提交后订单状态未刷新" })).toBeTruthy());

    fireEvent.click(screen.getByRole("radio", { name: "配置" }));
    await fireEvent.click(await screen.findByRole("tab", { name: "服务" }));
    const alert = await waitFor(() => screen.getByRole("alert"));
    expect(alert.textContent).toContain("configuration_unavailable");
    fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(client.loadConfig).toHaveBeenCalledTimes(2));
    await fireEvent.click(await screen.findByRole("tab", { name: "服务" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "SRM" })).toBeTruthy());
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
    resolveCurrentUser({ subject: "fixture-user", name: "严欣", email: "owner@example.test", role: "developer" });
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

  test("shows relative queue update time with a creation-time tooltip and omits detail facts", async () => {
    const client = await import("../data/client");
    const rows = await client.listIssues();
    rows[0]!.createdAt = "2026-10-01T01:02:00.000Z";
    rows[0]!.updatedAt = "2026-10-22T08:00:00.000Z";
    vi.mocked(client.listIssues).mockResolvedValueOnce(rows);
    render(() => <App initialView="issues" />);
    await screen.findByRole("heading", { name: "结算页提交后订单状态未刷新" });
    const row = screen.getAllByRole("listitem").find(row => row.textContent?.includes(rows[0]!.id))!;
    const time = row.querySelector(".queue-time")!;
    expect(time.textContent).not.toBe("2026/10/01");
    expect(time.getAttribute("title")).toBe("2026/10/01 09:02");
    expect(time.getAttribute("title")).not.toContain("创建时间");
    expect(document.querySelector(".issue-facts")).toBeNull();
    expect(screen.getByRole("button", { name: "编辑工单" })).toBeTruthy();
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
    expect(screen.getByRole("button", { name: "变更处理范围" })).toBeTruthy();
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
