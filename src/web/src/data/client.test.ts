import { afterEach, describe, expect, it, vi } from "vitest";

import { createIssue, loadCurrentUser, sendAgentMessage, setCurrentUserSubject } from "./client";

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

  it("sends the selected user identity with API requests", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ subject: "lyz5613@xianhengguoji.com", name: "刘宜展", email: "lyz5613@xianhengguoji.com" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    setCurrentUserSubject("lyz5613@xianhengguoji.com");

    await loadCurrentUser();

    const [, init] = fetch.mock.calls[0]!;
    expect((init.headers as Headers).get("X-Issue-Pilot-Subject")).toBe("lyz5613@xianhengguoji.com");
  });

  it("accepts a user message for Pi session delivery", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetch);

    await expect(sendAgentMessage("ISSUE-20260810-001", "Continue")).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith("/api/issues/ISSUE-20260810-001/agent-messages", expect.objectContaining({ method: "POST", body: JSON.stringify({ message: "Continue" }) }));
  });
});
