import { describe, expect, it, vi } from "vitest";

import { AgentStreamController } from "./agent-stream";

class ClosingErrorEventSource extends EventTarget {
  closeCalls = 0;
  constructor(readonly url: string) { super(); }
  close(): void {
    this.closeCalls += 1;
    this.dispatchEvent(new Event("error"));
  }
}

describe("AgentStreamController", () => {
  it("invalidates the previous stream before closing it", async () => {
    vi.useFakeTimers();
    try {
      const sources: ClosingErrorEventSource[] = [];
      const errors: string[] = [];
      const controller = new AgentStreamController(
        (issueId) => `/api/issues/${issueId}/agent-stream`,
        1_000,
        {
          onConnection() {},
          onError(error) { errors.push(error); },
          onSnapshot() {},
          onEvent() {},
        },
        (url) => {
          const source = new ClosingErrorEventSource(url);
          sources.push(source);
          return source as unknown as EventSource;
        },
      );

      controller.connect("ISSUE-20260810-001");
      controller.connect("ISSUE-20260810-002");
      expect(sources).toHaveLength(2);
      expect(sources[0]!.closeCalls).toBe(1);
      expect(errors).toEqual([]);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(sources).toHaveLength(2);
      controller.dispose();
      expect(sources[1]!.closeCalls).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
