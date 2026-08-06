import { afterEach, describe, expect, it, vi } from "vitest";

import { sendAgentMessage } from "./client";

describe("API client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts a user message for Pi session delivery", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetch);

    await expect(sendAgentMessage("ISSUE-1", "Continue")).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith("/api/issues/ISSUE-1/agent-messages", expect.objectContaining({ method: "POST", body: JSON.stringify({ message: "Continue" }) }));
  });
});
