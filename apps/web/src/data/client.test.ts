import { afterEach, describe, expect, it, vi } from "vitest";

import { sendAgentMessage } from "./client";

describe("API client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the accepted user terminal frame", async () => {
    const accepted = { id: "user-1", issueId: "issue-1", kind: "user", message: "Continue", createdAt: "2026-08-06T00:00:00.000Z", terminal: { ansi: "native frame", text: "User: Continue", lines: 3, replaceLines: 0 } };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(accepted), { status: 202 }));
    vi.stubGlobal("fetch", fetch);

    await expect(sendAgentMessage("ISSUE-1", "Continue", 88)).resolves.toEqual(accepted);
    expect(fetch).toHaveBeenCalledWith("/api/issues/ISSUE-1/agent-messages", expect.objectContaining({ method: "POST", body: JSON.stringify({ message: "Continue", cols: 88 }) }));
  });
});
