import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../data/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/client")>();
  const { Blob } = await import("node:buffer");
  const { issuePilotConfig } = await import("../../../../issue-pilot.config.ts");
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
      key: "srm", name: "SRM", description: "供应商关系管理服务。", context: "供应商关系管理服务。\n\n### 测试环境\n\n代码基准分支：develop\n\nNacos（nacos）：srm-test.yaml",
      deployments: [{ environmentKey: "test", repositoryBranches: [{ repositoryId: "srm-repository", repositoryAlias: "srm", baseBranch: "develop" }], capabilities: ["nacos", "db"], nacos: { serverUrl: "https://nacos.example.test", namespace: "test", group: issuePilotConfig.defaults.nacos.group, dataIds: ["srm-test.yaml", "srm-shared.yaml"], username: "operator", password: "", credentialConfigured: true }, db: { databases: [{ url: "mysql://db.example.test:3306/srm", username: "readonly", password: "", credentialConfigured: true }] } }],
      repositories: [{ id: "srm-repository", alias: "srm", url: "git@example.com:team/srm.git" }],
    }, {
      key: "orders", name: "Orders", description: "订单服务。",
      deployments: [
        { environmentKey: "prod", repositoryBranches: [{ repositoryId: "orders-repository", repositoryAlias: "orders", baseBranch: "main" }], capabilities: [] },
        { environmentKey: "dev", repositoryBranches: [{ repositoryId: "orders-repository", repositoryAlias: "orders", baseBranch: "develop" }], capabilities: [] },
      ],
      repositories: [{ id: "orders-repository", alias: "orders", url: "git@example.com:team/orders.git" }],
    }],
  };
  const capabilitySwitches = ["nacos", "db", "redis", "mq", "es", "dms", "sls"].map(key => ({ key, enabled: true }));
  return {
    ...actual,
    loadUsers: vi.fn(async () => structuredClone(managedUsers.filter((user) => user.active).map(({ subject, name, email, role }) => ({ subject, name, email, role })))),
    loadManagedUsers: vi.fn(async () => structuredClone(managedUsers)),
    createUser: vi.fn(async (input: { subject: string; name: string; email: string }) => {
      const user = { ...input, role: "product", active: true, createdAt: now, updatedAt: now };
      managedUsers.push(user);
      return structuredClone(user);
    }),
    updateUser: vi.fn(async (subject: string, input: { name: string; email: string; active: boolean }) => {
      const user = managedUsers.find((candidate) => candidate.subject === subject)!;
      Object.assign(user, input, { updatedAt: now });
      return structuredClone(user);
    }),
    loadCurrentUser: vi.fn(async () => ({ subject: "fixture-user", name: "严欣", email: "owner@example.test", role: "developer" })),
    loadPersonalCredentials: vi.fn(async () => ({ provider: "enterprise-ai", modelProviders: [], gitSshConfigured: false })),
    updatePersonalCredentials: vi.fn(async () => ({ modelProviders: ["enterprise-ai"], gitSshConfigured: true })),
    loadCatalog: vi.fn(async () => ({
      environments: structuredClone(configuration.environments),
      services: configuration.services.map(({ key, name, deployments }) => ({ key, name, deployments: deployments.map(({ environmentKey }) => ({ environmentKey })) })),
    })),
    loadApplicationEndpoints: vi.fn(async () => ({ endpoints: [{ name: "Issue Pilot MCP", path: "/mcp", transport: "Streamable HTTP", readOnly: true, tools: [{ name: "issue_get", description: "Read Issue details", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { key: { type: "string", description: "Issue key" } }, required: ["key"] } }] }] })),
    importMcpServices: vi.fn(async () => []),
    loadMcpServices: vi.fn(async () => []),
    loadMcpServiceConfiguration: vi.fn(async (id: string) => id === "local" ? { mcpServers: { Local: { command: "npx", args: ["@playwright/mcp@0.0.83"], env: { TOKEN: "private-token" } } } } : { mcpServers: { Docs: { url: "https://mcp.example.test/mcp", headers: { Authorization: "Bearer stored-token" } } } }),
    updateMcpService: vi.fn(async () => ({ id: "mcp-1", name: "Docs", url: "https://mcp.example.test/mcp", transport: "streamable_http", enabled: false, credentialConfigured: false })),
    deleteMcpService: vi.fn(async () => undefined),
    testMcpService: vi.fn(async () => ({ tools: [{ name: "search", readOnly: true }] })),
    loadCapabilitySwitches: vi.fn(async () => structuredClone(capabilitySwitches)),
    updateCapabilitySwitch: vi.fn(async (key, enabled) => { const row = capabilitySwitches.find(row => row.key === key)!; row.enabled = enabled; return structuredClone(row); }),
    loadRepositories: vi.fn(async () => [
      ...configuration.services.flatMap((service) => service.repositories.map((repository) => ({ id: repository.id, name: repository.alias, url: repository.url, createdAt: now, updatedAt: now, services: [{ key: service.key, name: service.name }] }))),
      { id: "updated-repository", name: "Updated repository", url: "git@example.test:team/updated.git", createdAt: now, updatedAt: now, services: [] },
    ]),
    createRepository: vi.fn(async () => ({ id: "new-repository" })),
    updateRepository: vi.fn(async () => ({ ok: true })),
    deleteRepository: vi.fn(async () => undefined),
    loadServiceConfigurationDescription: vi.fn(async (key: string) => ({ context: configuration.services.find(service => service.key === key)?.context ?? configuration.services.find(service => service.key === key)?.description ?? "" })),
    loadConfig: vi.fn(async () => structuredClone(configuration)),
    updateGlobalAgent: vi.fn(async (agent) => { configuration.agent = { ...agent }; return { ok: true as const }; }),
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
  afterEach(() => { cleanup(); setCurrentUserSubject(null); localStorage.clear(); document.body.replaceChildren(); vi.restoreAllMocks(); });

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
    fireEvent.click(within(await screen.findByRole("listbox")).getByText("正式数据处理"));
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
    fireEvent.click(await screen.findByRole("option", { name: "正式数据处理" }));
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
    expect(within(reopenedIssueDialog).queryByLabelText("编辑工单环境")).toBeNull();
    expect(within(reopenedIssueDialog).queryByLabelText("编辑工单服务")).toBeNull();
    expect(within(reopenedIssueDialog).queryByLabelText("编辑工单类型")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "切换调查范围" })).toBeNull();
    fireEvent.click(within(reopenedIssueDialog).getByRole("button", { name: "取消" }));

    fireEvent.input(commentInput, { target: { value: "另一个工单不应继承的草稿" } });
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
    const scopeHistory = screen.getByRole("heading", { name: "处理范围历史" }).closest("section")!;
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
    fireEvent.click(await screen.findByRole("tab", { name: "服务" }));
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
    expect(within(serviceDialog).getByRole("button", { name: "展开部署2" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByLabelText("部署 2 仓库 srm 分支")).toBeNull();
    fireEvent.click(within(serviceDialog).getByRole("button", { name: "展开部署2" }));
    await waitFor(() => expect(within(serviceDialog).getByRole("button", { name: "收起部署2" }).getAttribute("aria-expanded")).toBe("true"));
    expect(screen.getByLabelText("部署 2 环境").textContent).toContain("测试");
    expect(screen.getByLabelText("部署 2 能力").textContent).toContain("nacos");
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
    expect([...serviceDialog.querySelectorAll(".deployment-capability-options button")].map((item) => item.textContent)).toEqual(["redis", "mq", "es", "dms", "sls"]);
    expect(within(serviceDialog).queryByRole("button", { name: "playwright" })).toBeNull();
    expect(screen.queryByLabelText("dms Authorization 2")).toBeNull();
    expect(screen.queryByLabelText("sls accessKeySecret 2")).toBeNull();
    expect([...serviceDialog.querySelectorAll(".capability-settings-head code")].map((item) => item.textContent)).toEqual(["代码分支", "nacos", "db"]);
    const nacosServerUrl = screen.getByLabelText("nacos serverUrl 2");
    expect((screen.getByLabelText("nacos dataIds 2") as HTMLInputElement).value).toBe("srm-test.yaml, srm-shared.yaml");
    const databaseUrl = screen.getByLabelText("db url 2-1");
    expect(nacosServerUrl.closest("label")?.querySelector(".required-field")?.textContent).toBe("serverUrl");
    expect(databaseUrl.closest("label")?.querySelector(".required-field")?.textContent).toBe("url");
    fireEvent.click(within(serviceDialog).getByRole("button", { name: "收起部署2" }));
    await waitFor(() => expect(screen.queryByLabelText("db url 2-1")).toBeNull());
    expect(screen.queryByLabelText("部署环境 1")).toBeNull();
    expect(screen.getByLabelText("部署 2 环境").textContent).toContain("测试");
    expect(screen.getByLabelText("部署 2 能力").textContent).toContain("nacos");
    fireEvent.click(within(serviceDialog).getByRole("button", { name: "展开部署2" }));
    expect(((await screen.findByLabelText("db password 2-1")) as HTMLInputElement).value).toBe("");
    fireEvent.click(within(serviceDialog).getByRole("button", { name: "添加 MySQL 数据库" }));
    fireEvent.input(await screen.findByLabelText("db url 2-2"), { target: { value: "mysql://analytics.example.test:3306/srm_report" } });
    fireEvent.input(screen.getByLabelText("db username 2-2"), { target: { value: "reporter" } });
    fireEvent.input(screen.getByLabelText("db password 2-2"), { target: { value: "report-secret" } });
    const client = await import("../data/client");
    fireEvent.click(within(serviceDialog).getByRole("button", { name: "es" }));
    const esUrl = await waitFor(() => screen.getByLabelText("es url 2"));
    expect(esUrl.closest("label")?.querySelector(".required-field")?.textContent).toBe("url");
    const esAuthentication = screen.getByLabelText("es 认证 2");
    expect(esAuthentication.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByLabelText("es username 2")).toBeNull();
    fireEvent.click(esAuthentication);
    await waitFor(() => expect(screen.getByLabelText("es username 2")).toBeTruthy());
    expect(screen.getByLabelText("es password 2")).toBeTruthy();
    expect(screen.queryByLabelText(/es clusterNodes/i)).toBeNull();
    expect(screen.queryByLabelText(/es indexes/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "移除 nacos 能力" }));
    await waitFor(() => expect(screen.queryByLabelText("nacos serverUrl 2")).toBeNull());
    expect(screen.getByLabelText("db url 2-1")).toBeTruthy();
    fireEvent.click(within(serviceDialog).getByRole("button", { name: "移除 es 能力" }));
    await waitFor(() => expect(screen.queryByLabelText("es url 2")).toBeNull());
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
    expect(savedService?.deployments[1]?.db).toEqual({ databases: [
      { url: "mysql://db.example.test:3306/srm", username: "readonly", credentialUpdate: { mode: "preserve" } },
      { url: "mysql://analytics.example.test:3306/srm_report", username: "reporter", credentialUpdate: { mode: "replace", values: { password: "report-secret" } } },
    ] });
    expect(savedService?.deployments[1]?.dms).toBeUndefined();
    expect(savedService?.deployments[1]?.sls).toBeUndefined();
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
    fireEvent.click(await screen.findByRole("tab", { name: "服务" }));
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

  test("keeps development editing to code branches and uses the existing service description editor", async () => {
    render(() => <App initialView="configuration" />);
    expect(screen.queryByRole("tab", { name: "环境" })).toBeNull();
    fireEvent.click(await screen.findByRole("tab", { name: "服务" }));
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
    expect(await within(dialog).findByLabelText("部署 1 仓库 orders 分支")).toHaveProperty("value", "develop");
    expect(within(dialog).queryByLabelText("redis host 2")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "dms" })).toBeNull();
    expect(within(dialog).getByLabelText("部署 1 能力").textContent).toContain("继承正式/测试能力");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  });

  test("keeps a service draft when the current user's details refresh without a permission change", async () => {
    const client = await import("../data/client");
    render(() => <App initialView="configuration" />);
    await waitFor(() => expect(screen.getByLabelText("当前用户").closest(".identity")?.textContent).toContain("owner@example.test"));
    let finish!: (user: Awaited<ReturnType<typeof client.loadCurrentUser>>) => void;
    vi.mocked(client.loadCurrentUser).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const refreshed = { subject: "fixture-user", name: "Updated User", email: "owner@example.test", role: "developer" as const };
    try {
      fireEvent.click(screen.getByRole("tab", { name: "用户" }));
      const users = await screen.findByRole("region", { name: "用户列表" });
      const row = within(users).getByText("fixture-user").closest(".user-table-row") as HTMLElement;
      fireEvent.click(within(row).getByRole("button", { name: "编辑" }));
      const userDialog = await screen.findByRole("dialog", { name: "编辑用户" });
      fireEvent.click(within(userDialog).getByRole("button", { name: "保存" }));
      await waitFor(() => expect(finish).toBeTypeOf("function"));
      fireEvent.click(screen.getByRole("tab", { name: "服务" }));
      const panel = document.querySelector(".service-panel") as HTMLElement;
      fireEvent.click(await within(panel).findByRole("button", { name: "编辑" }));
      const dialog = await screen.findByRole("dialog", { name: "编辑服务" });
      fireEvent.input(within(dialog).getByLabelText("服务名称"), { target: { value: "preserved service draft" } });
      finish(refreshed);
      await waitFor(() => expect(screen.getByLabelText("当前用户").closest(".identity")?.getAttribute("title")).toContain("Updated User"));
      expect(screen.getByRole("dialog", { name: "编辑服务" })).toBe(dialog);
      expect(within(dialog).getByLabelText("服务名称")).toHaveProperty("value", "preserved service draft");
    } finally { finish?.(refreshed); }
  });

  test("clears service credential drafts when the selected identity changes", async () => {
    render(() => <App initialView="configuration" />);
    fireEvent.click(await screen.findByRole("tab", { name: "服务" }));
    const panel = document.querySelector(".service-panel") as HTMLElement;
    fireEvent.click(await within(panel).findByRole("button", { name: "编辑" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑服务" });
    fireEvent.click(within(dialog).getByRole("button", { name: "展开部署2" }));
    const password = await within(dialog).findByLabelText("db password 2-1");
    fireEvent.input(password, { target: { value: "old-identity-private-draft" } });
    fireEvent.click(screen.getByLabelText("当前用户"));
    fireEvent.click(await screen.findByRole("option", { name: "刘宜展 · lyz@example.test" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑服务" })).toBeNull());
    expect(password.isConnected).toBe(false);
    fireEvent.click(within(panel).getByRole("button", { name: "编辑" }));
    const currentDialog = await screen.findByRole("dialog", { name: "编辑服务" });
    fireEvent.click(within(currentDialog).getByRole("button", { name: "展开部署2" }));
    expect(await within(currentDialog).findByLabelText("db password 2-1")).toHaveProperty("value", "");
  });

  for (const outcome of ["success", "failure"] as const) test(`ignores an old identity's service-save ${outcome} after a new editor opens`, async () => {
    const client = await import("../data/client");
    let finish!: () => void;
    vi.mocked(client.updateService).mockImplementationOnce(() => new Promise<void>((resolve, reject) => { finish = outcome === "success" ? resolve : () => reject(new Error("old_service_save_failed")); }));
    render(() => <App initialView="configuration" />);
    try {
      fireEvent.click(await screen.findByRole("tab", { name: "服务" }));
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
    fireEvent.click(await screen.findByRole("tab", { name: "服务" }));
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

  test("shows the upstream DMS rate limit while resolving a database", async () => {
    const client = await import("../data/client");
    const configuration = structuredClone(await client.loadConfig());
    const deployment = configuration.services[0]!.deployments[0]!;
    deployment.capabilities.push("dms");
    deployment.dms = { url: "https://dms.example.test/sse", credentialConfigured: true, databases: [{ instanceAlias: "SRM", schemaName: "srm", instanceId: "i1", instanceHost: "db.example.test", instancePort: "3306", databaseId: "42" }] };
    vi.mocked(client.loadConfig).mockResolvedValueOnce(configuration);
    vi.mocked(client.resolveDmsScope).mockRejectedValueOnce(new Error("dms_mcp_http_429"));
    render(() => <App initialView="configuration" />);
    fireEvent.click(await screen.findByRole("tab", { name: "服务" }));
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
    fireEvent.click(await screen.findByRole("tab", { name: "服务" }));
    const panel = await screen.findByRole("tablist", { name: "服务列表" });
    await waitFor(() => expect(within(panel).getByRole("tab", { name: "SRM" })).toBeTruthy());
    fireEvent.click(document.querySelector(".service-tab-actions button:last-child")!);
    const dialog = await screen.findByRole("dialog", { name: "编辑服务" });
    fireEvent.click(within(dialog).getByRole("button", { name: "展开部署2" }));
    const token = await within(dialog).findByLabelText("dms Token 2");
    fireEvent.input(token, { target: { value: "Bearer replacement" } });
    await waitFor(() => expect(within(dialog).getByText("DatabaseId 42")).toBeTruthy());
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(client.updateService).toHaveBeenCalled());
    const saved = vi.mocked(client.updateService).mock.calls.at(-1)![1];
    expect(saved.deployments[1]?.dms?.databases[0]?.databaseId).toBe("42");
    expect(saved.deployments[1]?.dms?.credentialUpdate).toEqual({ mode: "replace", values: { authorization: "Bearer replacement" } });
    expect(client.resolveDmsScope).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "编辑服务" })).toBeNull());
  });

  test("opens an unconfigured native capability directly as an unsaved form", async () => {
    const client = await import("../data/client");
    vi.mocked(client.updateService).mockClear();
    render(() => <App initialView="configuration" />);
    fireEvent.click(await screen.findByRole("tab", { name: "能力" }));
    const panel = await screen.findByRole("region", { name: "能力管理" });
    const row = (await within(panel).findAllByText("Redis"))[0]!.closest(".capability-switch-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "配置" }));
    const dialog = await screen.findByRole("dialog", { name: "REDIS 配置" });
    fireEvent.click(within(dialog).getByLabelText("能力配置环境"));
    fireEvent.click(await screen.findByRole("option", { name: "测试" }));
    expect(await within(dialog).findByLabelText("redis host 1")).toHaveProperty("value", "");
    expect(within(dialog).queryByRole("button", { name: "redis" })).toBeNull();
    expect(client.updateService).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  });

  test("opens native capability configuration in place without navigating to services", async () => {
    render(() => <App initialView="configuration" />);
    fireEvent.click(await screen.findByRole("tab", { name: "能力" }));
    const panel = await screen.findByRole("region", { name: "能力管理" });
    const row = (await within(panel).findByText("MySQL")).closest(".capability-switch-row") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "配置" }));
    const dialog = await screen.findByRole("dialog", { name: "DB 配置" });
    expect(screen.getByRole("tab", { name: "能力" }).getAttribute("aria-selected")).toBe("true");
    expect(within(dialog).getByLabelText("能力配置服务")).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText("能力配置环境"));
    fireEvent.click(await screen.findByRole("option", { name: "测试" }));
    expect(await within(dialog).findByLabelText("db url 1-1")).toHaveProperty("value", "mysql://db.example.test:3306/srm");
    expect(within(dialog).queryByLabelText("nacos serverUrl 1")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  });

  test("edits an external MCP service using its saved JSON configuration", async () => {
    const client = await import("../data/client");
    vi.mocked(client.updateMcpService).mockClear();
    vi.spyOn(client, "loadMcpServices").mockResolvedValue([{ id: "docs", name: "Docs", url: "https://mcp.example.test/mcp", transport: "streamable_http", enabled: true, credentialConfigured: true }]);
    render(() => <App initialView="configuration" />);
    fireEvent.click(await screen.findByRole("tab", { name: "能力" }));
    const builtIn = await screen.findByRole("region", { name: "能力管理" });
    const external = screen.getByRole("region", { name: "外部能力管理" });
    expect(within(builtIn).getByText("内建")).toBeTruthy();
    expect(within(external).getByText("外部", { exact: true })).toBeTruthy();
    expect(within(builtIn).queryByRole("button", { name: /^添加$/ })).toBeNull();
    expect(within(external).getByText(/启用后向所有工单提供全部工具/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /添加 MCP|添加能力/ })).toBeNull();
    const row = (await within(external).findByText("Docs")).closest("tr")!;
    expect(within(row).getByText("所有工单")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "配置" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑 MCP" });
    const field = await within(dialog).findByLabelText("mcpServers JSON");
    const initial = JSON.parse((field as HTMLTextAreaElement).value);
    expect(initial).toEqual({ mcpServers: { Docs: { url: "https://mcp.example.test/mcp", headers: { Authorization: "Bearer stored-token" } } } });
    expect(within(dialog).queryByLabelText("能力 Authorization")).toBeNull();
    const input = { mcpServers: { Docs: { ...initial.mcpServers.Docs, headers: { Authorization: "Bearer secret-token" } } } };
    await fireEvent.input(field, { target: { value: JSON.stringify(input) } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(client.updateMcpService).toHaveBeenCalledWith("docs", input));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("edits a stdio MCP process with private launch configuration", async () => {
    const client = await import("../data/client"); vi.mocked(client.updateMcpService).mockClear();
    vi.spyOn(client, "loadMcpServices").mockResolvedValue([{ id: "local", name: "Local", url: "", transport: "stdio", enabled: true, credentialConfigured: true }]);
    render(() => <App initialView="configuration" />);
    fireEvent.click(await screen.findByRole("tab", { name: "能力" }));
    const external = await screen.findByRole("region", { name: "外部能力管理" });
    const row = (await within(external).findByText("Local")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "配置" }));
    const dialog = await screen.findByRole("dialog", { name: "编辑 MCP" });
    const config = { command: "npx", args: ["@playwright/mcp@0.0.83"], env: { TOKEN: "private-token" } };
    const field = await within(dialog).findByLabelText("mcpServers JSON");
    expect(JSON.parse((field as HTMLTextAreaElement).value)).toEqual({ mcpServers: { Local: config } });
    const footer = dialog.querySelector(".ui-modal-footer") as HTMLElement;
    expect(within(footer).getAllByRole("button").map(button => button.textContent)).toEqual(["取消", "保存", "删除"]);
    expect(dialog.querySelector(".ui-modal-body")?.textContent).not.toContain("删除");
    fireEvent.click(within(footer).getByRole("button", { name: /^删除$/ }));
    const confirmation = await screen.findByRole("dialog", { name: /^删除$/ });
    fireEvent.click(within(confirmation).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /^删除$/ })).toBeNull());
    const input = { mcpServers: { Local: { ...config, enabled: true } } };
    await fireEvent.input(field, { target: { value: JSON.stringify(input) } });
    expect(within(dialog).queryByLabelText("能力地址")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(client.updateMcpService).toHaveBeenCalledWith("local", input));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("discards a pending private configuration load when the editor is closed", async () => {
    const client = await import("../data/client");
    vi.spyOn(client, "loadCurrentUser").mockResolvedValueOnce({ subject: "fixture-user", name: "严欣", email: "owner@example.test", role: "developer", isAdmin: true });
    vi.spyOn(client, "loadMcpServices").mockResolvedValue([{ id: "local", name: "Local", url: "", transport: "stdio", enabled: true, credentialConfigured: true }]);
    let resolve!: (input: { mcpServers: Record<string, unknown> }) => void;
    let signal: AbortSignal | undefined;
    vi.spyOn(client, "loadMcpServiceConfiguration").mockImplementationOnce((_id, requestSignal) => { signal = requestSignal; return new Promise(done => { resolve = done; }); });
    render(() => <App initialView="configuration" />);
    fireEvent.click(await screen.findByRole("tab", { name: "能力" }));
    const external = await screen.findByRole("region", { name: "外部能力管理" });
    const row = (await within(external).findByText("Local")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "配置" }));
    const editor = await screen.findByRole("dialog", { name: "编辑 MCP" });
    expect(within(editor).getByRole("button", { name: "保存" })).toHaveProperty("disabled", true);
    fireEvent.click(within(editor).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(signal?.aborted).toBe(true));
    fireEvent.click(within(external).getByRole("button", { name: /^添加$/ }));
    const adding = await screen.findByRole("dialog", { name: /^添加$/ });
    resolve({ mcpServers: { Local: { command: "private-command" } } });
    await waitFor(() => expect(within(adding).getByLabelText("mcpServers JSON")).toHaveProperty("value", ""));
  });

  test("imports mcpServers JSON and reports malformed input without echoing secrets", async () => {
    const client = await import("../data/client"); vi.mocked(client.importMcpServices).mockClear();
    vi.spyOn(client, "loadCurrentUser").mockResolvedValue({ subject: "fixture-user", name: "严欣", email: "owner@example.test", role: "developer", isAdmin: true });
    render(() => <App initialView="configuration" />);
    fireEvent.click(await screen.findByRole("tab", { name: "能力" }));
    fireEvent.click(await screen.findByRole("button", { name: /^添加$/ }));
    const dialog = await screen.findByRole("dialog", { name: /^添加$/ });
    expect(within(dialog).queryByLabelText("能力名称")).toBeNull();
    const field = within(dialog).getByLabelText("mcpServers JSON");
    await fireEvent.input(field, { target: { value: '{"TOKEN":"private-import-token"' } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^添加$/ }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("请输入有效的 JSON");
    expect(client.importMcpServices).not.toHaveBeenCalled();
    const value = { mcpServers: { playwright: { command: "npx", args: ["@playwright/mcp@latest"] } } };
    await fireEvent.input(field, { target: { value: JSON.stringify(value) } });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /^添加$/ })).toHaveProperty("disabled", false));
    fireEvent.click(within(dialog).getByRole("button", { name: /^添加$/ }));
    await waitFor(() => expect(client.importMcpServices).toHaveBeenCalledWith(value));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  for (const actor of ["product", "test", "developer", "manager"] as const) test(`only management sees the external add button: ${actor}`, async () => {
    const client = await import("../data/client");
    const isAdmin = actor === "manager", role = isAdmin ? "developer" : actor;
    vi.spyOn(client, "loadCurrentUser").mockResolvedValue({ subject: "fixture-user", name: "严欣", email: "owner@example.test", role, isAdmin });
    render(() => <App initialView="configuration" />);
    fireEvent.click(await screen.findByRole("tab", { name: "能力" }));
    const external = await screen.findByRole("region", { name: "外部能力管理" });
    await within(external).findByText(/尚未添加外部能力/);
    expect(Boolean(within(external).queryByRole("button", { name: /^添加$/ }))).toBe(isAdmin);
  });

  test("manages global capability switches in their own settings tab", async () => {
    const client = await import("../data/client");
    vi.mocked(client.updateCapabilitySwitch).mockClear();
    render(() => <App initialView="configuration" />);
    fireEvent.click(await screen.findByRole("tab", { name: "能力" }));
    const panel = await screen.findByRole("region", { name: "能力管理" });
    const toggle = await within(panel).findByRole("switch", { name: "DMS 全局开关" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => expect(client.updateCapabilitySwitch).toHaveBeenCalledWith("dms", false));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    await waitFor(() => expect(toggle).toHaveProperty("disabled", false));
    fireEvent.click(toggle);
    await waitFor(() => expect(client.updateCapabilitySwitch).toHaveBeenLastCalledWith("dms", true));
  });

  test("sorts repositories by their address directories without rendering group headings", async () => {
    const client = await import("../data/client");
    const now = new Date().toISOString();
    const urls = ["git@example.test:team/sub/z.git", "git@example.test:team/z.git", "git@example.test:team/sub/a.git", "git@example.test:team/a.git"];
    const loadRepositories = vi.mocked(client.loadRepositories), original = loadRepositories.getMockImplementation()!;
    loadRepositories.mockResolvedValue(urls.map((url, index) => ({ id: `repo-${index}`, name: `Repository ${3 - index}`, url, createdAt: now, updatedAt: now, services: [] })));
    try {
      render(() => <App initialView="configuration" />);
      fireEvent.click(await screen.findByRole("tab", { name: "仓库" }));
      const panel = await screen.findByRole("region", { name: "仓库管理" });
      await within(panel).findByText("git@example.test:team/sub/z.git");
      expect(panel.querySelector(".repository-catalog-group")).toBeNull();
      expect([...panel.querySelectorAll(".repository-catalog-row > code")].map(row => row.textContent)).toEqual(["git@example.test:team/a.git", "git@example.test:team/z.git", "git@example.test:team/sub/a.git", "git@example.test:team/sub/z.git"]);
    } finally { loadRepositories.mockImplementation(original); }
  });

  test("manages repositories from their own settings tab and selects registered URLs in services", async () => {
    const client = await import("../data/client");
    vi.mocked(client.createRepository).mockClear();
    render(() => <App initialView="configuration" />);
    fireEvent.click(await screen.findByRole("tab", { name: "仓库" }));
    const panel = await screen.findByRole("region", { name: "仓库管理" });
    await waitFor(() => expect(within(panel).getByText("git@example.com:team/srm.git")).toBeTruthy());
    fireEvent.click(within(panel).getByRole("button", { name: "添加仓库" }));
    const dialog = await screen.findByRole("dialog", { name: "添加仓库" });
    fireEvent.input(within(dialog).getByLabelText("统一仓库名称"), { target: { value: "Shared API" } });
    fireEvent.input(within(dialog).getByLabelText("统一仓库地址"), { target: { value: "git@example.test:team/shared-api.git" } });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "保存" })).toHaveProperty("disabled", false));
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(client.createRepository).toHaveBeenCalledWith({ name: "Shared API", url: "git@example.test:team/shared-api.git" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("shows repository actions disabled when the selected user cannot maintain repositories", async () => {
    const client = await import("../data/client");
    vi.mocked(client.loadCurrentUser).mockResolvedValueOnce({ subject: "fixture-user", name: "严欣", email: "owner@example.test", role: "test" });
    render(() => <App initialView="configuration" />);
    fireEvent.click(await screen.findByRole("tab", { name: "仓库" }));
    const panel = await screen.findByRole("region", { name: "仓库管理" });
    await within(panel).findByText("git@example.com:team/srm.git");
    expect(within(panel).getByRole("button", { name: "添加仓库" })).toHaveProperty("disabled", true);
    for (const button of within(panel).getAllByRole("button", { name: "编辑" })) expect(button).toHaveProperty("disabled", true);
    for (const button of within(panel).getAllByRole("button", { name: "删除" })) expect(button).toHaveProperty("disabled", true);
    expect(within(panel).queryByText("仅开发可维护")).toBeNull();
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
    expect(screen.getByRole("tab", { name: "基座" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "服务" })).toBeTruthy();
    const userList = await screen.findByRole("region", { name: "用户列表" });
    await waitFor(() => expect(within(userList).getByText("fixture-user")).toBeTruthy());
    expect(within(userList).getByText("second-user")).toBeTruthy();

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
      expect(client.createUser).toHaveBeenCalledWith({ subject: "new-user@example.test", name: "新用户", email: "new.user@example.test", role: "product" });
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "添加用户" })).toBeNull());
    const newUserRow = await waitFor(() => screen.getByText("new-user@example.test").closest(".user-table-row") as HTMLElement);
    expect(newUserRow).toBeTruthy();
    fireEvent.click(within(newUserRow).getByRole("button", { name: "停用" }));
    await waitFor(() => expect(client.updateUser).toHaveBeenCalledWith("new-user@example.test", { active: false }));
    await waitFor(() => expect(within(screen.getByText("new-user@example.test").closest(".user-table-row") as HTMLElement).getByText("停用")).toBeTruthy());
  });

  test("automatically saves the global model only after a setting changes", async () => {
    const client = await import("../data/client");
    const initial = await client.loadConfig(); vi.mocked(client.updateGlobalAgent).mockClear();
    const view = render(() => <App initialView="configuration" />);
    await screen.findByLabelText("全局模型 provider");
    expect(screen.queryByRole("button", { name: "保存 Agent 配置" })).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 550));
    expect(client.updateGlobalAgent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("全局模型 provider"));
    fireEvent.click(await screen.findByRole("option", { name: /^enterprise-ai$/ }));
    await new Promise(resolve => setTimeout(resolve, 550));
    expect(client.updateGlobalAgent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("全局模型 thinking level"));
    fireEvent.click(await screen.findByRole("option", { name: /^high$/ }));
    await waitFor(() => expect(client.updateGlobalAgent).toHaveBeenCalledWith({ ...initial.agent, thinkingLevel: "high" }));
    await waitFor(() => expect(screen.queryByText("保存中…")).toBeNull());
    view.unmount(); await client.updateGlobalAgent(initial.agent);
  });

  test("puts the Agent base first and saves codemode independently of the selected model", async () => {
    const client = await import("../data/client"); vi.mocked(client.updateGlobalAgent).mockClear();
    render(() => <App initialView="configuration" />);
    const tabs = await screen.findByRole("tablist", { name: "配置分类" });
    expect(within(tabs).getAllByRole("tab")[0]?.textContent).toBe("基座");
    expect(within(tabs).getByRole("tab", { name: "基座" }).getAttribute("aria-selected")).toBe("true");
    const select = await screen.findByLabelText("全局 Agent Codemode");
    expect(select.closest(".ui-select")?.textContent).toContain("开启");
    fireEvent.click(select);
    fireEvent.click(await screen.findByRole("option", { name: "仅 Codemode" }));
    await waitFor(() => expect(select.closest(".ui-select")?.textContent).toContain("仅 Codemode"));
    await waitFor(() => expect(client.updateGlobalAgent).toHaveBeenCalledWith({ provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "medium", codemode: "only", runtime: {} }));
    await waitFor(() => expect(screen.queryByText("保存中…")).toBeNull());
  });

  test("simplifies the Agent base while retaining existing runtime settings on save", async () => {
    const client = await import("../data/client"); vi.mocked(client.updateGlobalAgent).mockClear();
    const initial = structuredClone(await client.loadConfig()); initial.agent.codemode = "on";
    initial.agent.runtime = { settings: { retry: { maxRetries: 2, baseDelayMs: 1234 }, cacheWarming: "off", transport: "sse", compaction: { keepRecentTokens: 12000 } } };
    vi.mocked(client.loadConfig).mockResolvedValueOnce(initial);
    render(() => <App initialView="configuration" />);
    await screen.findByLabelText("最大重试次数");
    expect(screen.getByLabelText("最大重试次数")).toHaveProperty("value", "2");
    expect(document.querySelector(".global-model-summary")).toBeNull();
    expect(screen.queryByLabelText("其他 Pi 参数")).toBeNull();
    expect(screen.queryByText("Skills、Prompts 与扩展")).toBeNull();
    await fireEvent.click(screen.getByRole("switch", { name: "自动压缩上下文" }));
    const runtime = { settings: { ...initial.agent.runtime.settings, compaction: { keepRecentTokens: 12000, enabled: false } } };
    await waitFor(() => expect(client.updateGlobalAgent).toHaveBeenCalledWith({ provider: "enterprise-ai", model: "engineering-model", thinkingLevel: "medium", codemode: "on", runtime }));
    await waitFor(() => expect(screen.queryByText("保存中…")).toBeNull());
  });

  test("coalesces Agent edits while a save is pending without replacing newer input", async () => {
    const client = await import("../data/client"), initial = await client.loadConfig();
    const update = vi.mocked(client.updateGlobalAgent), persist = update.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    update.mockClear(); update.mockImplementationOnce(async input => { await gate; return persist(input); });
    const view = render(() => <App initialView="configuration" />);
    try {
      const input = await screen.findByLabelText("最大重试次数");
      fireEvent.input(input, { target: { value: "4" } });
      await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
      fireEvent.input(input, { target: { value: "5" } }); fireEvent.input(input, { target: { value: "6" } });
      await new Promise(resolve => setTimeout(resolve, 550));
      expect(update).toHaveBeenCalledTimes(1);
      release();
      await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByText("保存中…")).toBeNull());
      expect(update.mock.calls.map(([value]) => value.runtime.settings?.retry?.maxRetries)).toEqual([4, 6]);
      expect(input).toHaveProperty("value", "6");
    } finally { release(); view.unmount(); await client.updateGlobalAgent(initial.agent); }
  });

  test("keeps an unsuccessful Agent edit until an explicit retry", async () => {
    const client = await import("../data/client"), initial = await client.loadConfig();
    const update = vi.mocked(client.updateGlobalAgent); update.mockClear();
    update.mockRejectedValueOnce(new Error("global_configuration_has_running_issues"));
    const view = render(() => <App initialView="configuration" />);
    const toggle = await screen.findByRole("switch", { name: "失败自动重试" });
    fireEvent.click(toggle);
    const alert = await screen.findByRole("alert"); expect(alert.textContent).toContain("有正在执行的工单");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await new Promise(resolve => setTimeout(resolve, 550)); expect(update).toHaveBeenCalledTimes(1);
    fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("保存中…")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    view.unmount(); await client.updateGlobalAgent(initial.agent);
  });

  test("retains a rejected Agent autosave across navigation", async () => {
    const client = await import("../data/client"), initial = await client.loadConfig();
    const update = vi.mocked(client.updateGlobalAgent); update.mockClear();
    update.mockRejectedValueOnce(new Error("global_configuration_has_running_issues"));
    const view = render(() => <App initialView="configuration" />);
    try {
      fireEvent.input(await screen.findByLabelText("最大重试次数"), { target: { value: "9" } });
      fireEvent.click(screen.getByRole("radio", { name: "工单" }));
      await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      fireEvent.click(screen.getByRole("radio", { name: "配置" }));
      const input = await screen.findByLabelText("最大重试次数");
      expect(input).toHaveProperty("value", "9");
      const alert = await screen.findByRole("alert"); expect(alert.textContent).toContain("有正在执行的工单");
      fireEvent.click(within(alert).getByRole("button", { name: "重试" }));
      await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByText("保存中…")).toBeNull());
      expect(input).toHaveProperty("value", "9");
    } finally { view.unmount(); await client.updateGlobalAgent(initial.agent); }
  });

  test("does not submit a queued Agent edit under a different selected identity", async () => {
    const client = await import("../data/client"); vi.mocked(client.updateGlobalAgent).mockClear();
    const view = render(() => <App initialView="configuration" />);
    fireEvent.input(await screen.findByLabelText("最大重试次数"), { target: { value: "7" } });
    client.setCurrentUserSubject("second-user");
    await new Promise(resolve => setTimeout(resolve, 550));
    expect(client.updateGlobalAgent).not.toHaveBeenCalled();
    view.unmount();
  });

  test("flushes a pending Agent edit when leaving the settings page", async () => {
    const client = await import("../data/client"), initial = await client.loadConfig();
    vi.mocked(client.updateGlobalAgent).mockClear();
    const view = render(() => <App initialView="configuration" />);
    fireEvent.input(await screen.findByLabelText("最大重试次数"), { target: { value: "8" } });
    view.unmount();
    await waitFor(() => expect(client.updateGlobalAgent).toHaveBeenCalledWith({ ...initial.agent, runtime: { ...initial.agent.runtime, settings: { ...initial.agent.runtime.settings, retry: { ...initial.agent.runtime.settings?.retry, maxRetries: 8 } } } }));
    await client.updateGlobalAgent(initial.agent);
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
    await waitFor(() => expect(client.loadConfig).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole("tab", { name: "服务" }));
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
