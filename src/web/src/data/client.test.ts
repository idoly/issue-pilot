import { afterEach, describe, expect, it, vi } from "vitest";

import { convertIssueToDevelopment, createIssue, createUser, deleteService, listIssues, loadCatalog, loadCurrentUser, loadManagedUsers, loadSourceBlame, loadSourceCommit, loadSourceCommitFile, loadSourceDiff, loadSourceDiffFile, loadSourceFile, saveSourceFile, searchSource, sendAgentMessage, setCurrentUserSubject, updateIssue, updateService, updateUser } from "./client";

describe("API client", () => {
  afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });

  it("creates an issue and its initial attachments in one request", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "ISSUE-20260810-001" }), { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    const file = new File(["evidence"], "evidence.txt", { type: "text/plain" });

    await createIssue({
      title: "Investigate",
      description: "Details",
      priority: "p1",
      type: "smart_analysis",
      serviceKey: "service-a",
      environmentKey: "test",
      assigneeSubject: null,
      ccSubjects: [],
      relatedIssueKeys: ["ISSUE-20260809-099"],
    }, [file]);

    const [, init] = fetch.mock.calls[0]!;
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("issue")).toContain('"title":"Investigate"');
    expect(JSON.parse(String((init.body as FormData).get("issue"))).relatedIssueKeys).toEqual(["ISSUE-20260809-099"]);
    const submittedFile = (init.body as FormData).get("files") as File;
    expect(submittedFile.name).toBe("evidence.txt");
    expect(submittedFile.type).toBe("text/plain");
    expect(await submittedFile.text()).toBe("evidence");
  });

  it("updates issue metadata and attachment changes in one request", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "ISSUE-20260810-001" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const file = new File(["new evidence"], "new.txt", { type: "text/plain" });
    const input = { title: "Updated", description: "Details", priority: "p2" as const, type: "smart_analysis" as const, serviceKey: "service-a", environmentKey: "test", assigneeSubject: null, ccSubjects: [] };

    await updateIssue("ISSUE-20260810-001", input, ["attachment-1"], [file]);

    const [, init] = fetch.mock.calls[0]!;
    expect(init.method).toBe("PATCH");
    expect(init.body).toBeInstanceOf(FormData);
    expect(JSON.parse(String((init.body as FormData).get("issue")))).toEqual({ ...input, removedAttachmentIds: ["attachment-1"] });
    expect(((init.body as FormData).get("files") as File).name).toBe("new.txt");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sends the selected user identity with API requests", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ subject: "lyz5613@xianhengguoji.com", name: "刘宜展", email: "lyz5613@xianhengguoji.com" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    setCurrentUserSubject("lyz5613@xianhengguoji.com");

    await loadCurrentUser();

    const [, init] = fetch.mock.calls[0]!;
    expect((init.headers as Headers).get("X-Issue-Pilot-Subject")).toBe("lyz5613@xianhengguoji.com");
  });

  it("uses the managed user endpoints without putting subjects in query strings", async () => {
    const user = { subject: "operator@example.test", name: "Operator", email: "operator@example.test", active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(user), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await loadManagedUsers();
    await createUser({ subject: user.subject, name: user.name, email: user.email });
    await updateUser(user.subject, { name: "Operations", email: user.email, active: false });

    expect(fetch.mock.calls[0]![0]).toBe("/api/users/manage");
    expect(fetch.mock.calls[1]![0]).toBe("/api/users");
    expect(fetch.mock.calls[1]![1]).toMatchObject({ method: "POST" });
    expect(fetch.mock.calls[2]![0]).toBe("/api/users/operator%40example.test");
    expect(fetch.mock.calls[2]![1]).toMatchObject({ method: "PATCH" });
  });

  it("loads the non-secret configuration catalog independently", async () => {
    const catalog = { environments: [{ key: "prod", name: "正式" }], services: [{ key: "orders", name: "Orders", deployments: [{ environmentKey: "prod" }] }] };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(catalog), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await expect(loadCatalog()).resolves.toEqual(catalog);
    expect(fetch).toHaveBeenCalledWith("/api/catalog", expect.any(Object));
  });

  it("sends direct Service configuration writes", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await updateService("orders", { name: "Orders", description: "", repositories: [], deployments: [] });
    await deleteService("orders");

    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "PATCH" });
    expect(fetch.mock.calls[1]![1]).toMatchObject({ method: "DELETE" });
  });

  it("passes cancellation to read-only list requests", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();

    await listIssues(controller.signal);

    expect(fetch).toHaveBeenCalledWith("/api/issues", expect.objectContaining({ signal: controller.signal }));
  });

  it("keeps source paths and search queries out of request URLs", async () => {
    const fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/source/commit-file")) return new Response(JSON.stringify({
        file: { status: "modified", path: "src/订单.ts", previousPath: null },
        before: { path: "src/订单.ts", revision: "b".repeat(40), content: "before" },
        after: { path: "src/订单.ts", revision: "a".repeat(40), content: "after" },
      }), { status: 200 });
      if (url.endsWith("/source/commit")) return new Response(JSON.stringify({ files: [{ status: "modified", path: "src/订单.ts", previousPath: null }], truncated: false }), { status: 200 });
      if (url.endsWith("/source/diff-file")) return new Response(JSON.stringify({
        file: { status: "modified", path: "src/订单.ts", previousPath: null },
        before: { path: "src/订单.ts", version: "index", content: "before" },
        after: { path: "src/订单.ts", version: "working-tree", content: "after" },
      }), { status: 200 });
      if (url.endsWith("/source/diff")) return new Response(JSON.stringify({ files: [{ status: "modified", path: "src/订单.ts", previousPath: null }], truncated: false }), { status: 200 });
      if (url.endsWith("/source/blame")) return new Response(JSON.stringify({ path: "src/订单.ts", line: 7, commit: "a".repeat(40), shortCommit: "a".repeat(8), author: "Fixture", date: "2026-08-15T00:00:00.000Z", subject: "Fix order" }), { status: 200 });
      return new Response(JSON.stringify({ path: "src/index.ts", content: "", size: 0 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    await loadSourceFile("ISSUE-20260810-001", "orders", "src/订单.ts");
    await searchSource("ISSUE-20260810-001", "orders", "客户编号");
    await loadSourceCommit("ISSUE-20260810-001", "orders", "a".repeat(40), "src/订单.ts");
    await loadSourceCommitFile("ISSUE-20260810-001", "orders", "a".repeat(40), "src/订单.ts");
    await loadSourceBlame("ISSUE-20260810-001", "orders", "src/订单.ts", 7);
    await loadSourceDiff("ISSUE-20260810-001", "orders", "src/订单.ts");
    await loadSourceDiffFile("ISSUE-20260810-001", "orders", "src/订单.ts");

    expect(fetch.mock.calls[0]![0]).toBe("/api/issues/ISSUE-20260810-001/source/file");
    expect((fetch.mock.calls[0]![1].headers as Headers).get("X-Issue-Pilot-Repository")).toBe("orders");
    expect((fetch.mock.calls[0]![1].headers as Headers).get("X-Issue-Pilot-Path")).toBe("src%2F%E8%AE%A2%E5%8D%95.ts");
    expect(fetch.mock.calls[1]![0]).toBe("/api/issues/ISSUE-20260810-001/source/search");
    expect((fetch.mock.calls[1]![1].headers as Headers).get("X-Issue-Pilot-Query")).toBe("%E5%AE%A2%E6%88%B7%E7%BC%96%E5%8F%B7");
    expect((fetch.mock.calls[1]![1].headers as Headers).get("X-Issue-Pilot-Case-Sensitive")).toBe("true");
    expect((fetch.mock.calls[1]![1].headers as Headers).get("X-Issue-Pilot-Word-Match")).toBe("false");
    expect(fetch.mock.calls[2]![0]).toBe("/api/issues/ISSUE-20260810-001/source/commit");
    expect((fetch.mock.calls[2]![1].headers as Headers).get("X-Issue-Pilot-Revision")).toBe("a".repeat(40));
    expect((fetch.mock.calls[2]![1].headers as Headers).get("X-Issue-Pilot-Path")).toBe("src%2F%E8%AE%A2%E5%8D%95.ts");
    expect(fetch.mock.calls[3]![0]).toBe("/api/issues/ISSUE-20260810-001/source/commit-file");
    expect((fetch.mock.calls[3]![1].headers as Headers).get("X-Issue-Pilot-Revision")).toBe("a".repeat(40));
    expect((fetch.mock.calls[3]![1].headers as Headers).get("X-Issue-Pilot-Path")).toBe("src%2F%E8%AE%A2%E5%8D%95.ts");
    expect(fetch.mock.calls[4]![0]).toBe("/api/issues/ISSUE-20260810-001/source/blame");
    expect((fetch.mock.calls[4]![1].headers as Headers).get("X-Issue-Pilot-Line")).toBe("7");
    expect(fetch.mock.calls[5]![0]).toBe("/api/issues/ISSUE-20260810-001/source/diff");
    expect((fetch.mock.calls[5]![1].headers as Headers).get("X-Issue-Pilot-Path")).toBe("src%2F%E8%AE%A2%E5%8D%95.ts");
    expect(fetch.mock.calls[6]![0]).toBe("/api/issues/ISSUE-20260810-001/source/diff-file");
    expect((fetch.mock.calls[6]![1].headers as Headers).get("X-Issue-Pilot-Path")).toBe("src%2F%E8%AE%A2%E5%8D%95.ts");
  });

  it("saves source text with an optimistic content hash", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ path: "src/index.ts", content: "updated\n", size: 8, sha256: "b".repeat(64) }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await saveSourceFile("ISSUE-20260810-001", "orders", "src/index.ts", "updated\n", "a".repeat(64));

    const [url, init] = fetch.mock.calls[0]!;
    const headers = init.headers as Headers;
    expect(url).toBe("/api/issues/ISSUE-20260810-001/source/file");
    expect(init.method).toBe("PUT");
    expect(init.body).toBe("updated\n");
    expect(headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(headers.get("X-Issue-Pilot-Sha256")).toBe("a".repeat(64));
  });

  it("rejects stale source commit response contracts", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ content: "raw patch", truncated: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await expect(loadSourceCommit("ISSUE-20260810-001", "orders", "a".repeat(40))).rejects.toThrow("source_commit_response_invalid");
    await expect(loadSourceCommitFile("ISSUE-20260810-001", "orders", "a".repeat(40), "src/index.ts")).rejects.toThrow("source_commit_file_response_invalid");
    await expect(loadSourceDiff("ISSUE-20260810-001", "orders")).rejects.toThrow("source_diff_response_invalid");
    await expect(loadSourceDiffFile("ISSUE-20260810-001", "orders", "src/index.ts")).rejects.toThrow("source_diff_file_response_invalid");
  });

  it("uses the dedicated development conversion endpoint", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ issueKey: "ISSUE-20260810-001" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await expect(convertIssueToDevelopment("ISSUE-20260810-001")).resolves.toEqual({ issueKey: "ISSUE-20260810-001" });
    expect(fetch).toHaveBeenCalledWith("/api/issues/ISSUE-20260810-001/development", expect.objectContaining({ method: "POST" }));
  });

  it("accepts a user message for Pi session delivery", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetch);

    await expect(sendAgentMessage("ISSUE-20260810-001", "Continue")).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith("/api/issues/ISSUE-20260810-001/agent-messages", expect.objectContaining({ method: "POST", body: JSON.stringify({ message: "Continue" }) }));
  });
});
