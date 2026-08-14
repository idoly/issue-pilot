import { afterEach, describe, expect, it, vi } from "vitest";

import { convertIssueToDevelopment, createIssue, deleteService, listIssues, loadCatalog, loadCurrentUser, sendAgentMessage, setCurrentUserSubject, updateIssue, updateService } from "./client";

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
    }, [file]);

    const [, init] = fetch.mock.calls[0]!;
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("issue")).toContain('"title":"Investigate"');
    const submittedFile = (init.body as FormData).get("files") as File;
    expect(submittedFile.name).toBe("evidence.txt");
    expect(submittedFile.type).toBe("text/plain");
    expect(await submittedFile.text()).toBe("evidence");
  });

  it("updates issue metadata and attachment changes in one request", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "ISSUE-20260810-001" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const file = new File(["new evidence"], "new.txt", { type: "text/plain" });
    const input = { title: "Updated", description: "Details", priority: "p2" as const, type: "smart_analysis" as const, serviceKey: "service-a", assigneeSubject: null, ccSubjects: [] };

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

  it("loads the non-secret configuration catalog independently", async () => {
    const catalog = { environments: [{ key: "prod", name: "正式" }], services: [{ key: "orders", name: "Orders", deployments: [{ environmentKey: "prod" }] }] };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(catalog), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await expect(loadCatalog()).resolves.toEqual(catalog);
    expect(fetch).toHaveBeenCalledWith("/api/catalog", expect.any(Object));
  });

  it("sends the selected Service revision with configuration writes", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const revision = "a".repeat(64);

    await updateService("orders", revision, { name: "Orders", description: "", repositories: [], deployments: [] });
    await deleteService("orders", revision);

    expect((fetch.mock.calls[0]![1].headers as Headers).get("If-Match")).toBe(revision);
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: "PATCH" });
    expect((fetch.mock.calls[1]![1].headers as Headers).get("If-Match")).toBe(revision);
    expect(fetch.mock.calls[1]![1]).toMatchObject({ method: "DELETE" });
  });

  it("passes cancellation to read-only list requests", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();

    await listIssues(controller.signal);

    expect(fetch).toHaveBeenCalledWith("/api/issues", expect.objectContaining({ signal: controller.signal }));
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
