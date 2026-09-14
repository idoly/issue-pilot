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
        45_000,
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

  it("reconnects when a proxied stream becomes silent without an error event", async () => {
    vi.useFakeTimers();
    try {
      const sources: ClosingErrorEventSource[] = [];
      const connections: boolean[] = [];
      const errors: string[] = [];
      const controller = new AgentStreamController(
        (issueId) => `/api/issues/${issueId}/agent-stream`,
        1_000,
        45_000,
        {
          onConnection(connected) { connections.push(connected); },
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

      controller.connect("ISSUE-20260824-003");
      sources[0]!.dispatchEvent(new Event("open"));
      await vi.advanceTimersByTimeAsync(30_000);
      sources[0]!.dispatchEvent(new MessageEvent("heartbeat", { data: "{}" }));
      await vi.advanceTimersByTimeAsync(44_999);
      expect(sources).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(sources[0]!.closeCalls).toBe(1);
      expect(connections.at(-1)).toBe(false);
      expect(errors.at(-1)).toBe("agent_event_connection_failed");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sources).toHaveLength(2);

      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
