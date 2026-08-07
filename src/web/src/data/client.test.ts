import { afterEach, describe, expect, it, vi } from "vitest";

import { createIssue, sendAgentMessage } from "./client";

describe("API client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates an issue and its initial attachments in one request", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "ISSUE-1" }), { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    const file = new File(["evidence"], "evidence.txt", { type: "text/plain" });

    await createIssue({
      title: "Investigate",
      description: "Details",
      priority: "p1",
      type: "smart_analysis",
      serviceKey: "service-a",
      environmentKey: "test",
      reporter: "User",
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

  it("accepts a user message for Pi session delivery", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetch);

    await expect(sendAgentMessage("ISSUE-1", "Continue")).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith("/api/issues/ISSUE-1/agent-messages", expect.objectContaining({ method: "POST", body: JSON.stringify({ message: "Continue" }) }));
  });
});
