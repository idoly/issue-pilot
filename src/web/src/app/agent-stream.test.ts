import { describe, expect, it, vi } from "vitest";

import { AgentStreamController, reconnectDelay } from "./agent-stream";

class ClosingErrorEventSource extends EventTarget {
  closeCalls = 0;
  constructor(readonly url: string) {
    super();
  }
  close(): void {
    this.closeCalls += 1;
    this.dispatchEvent(new Event("error"));
  }
}

const footer = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costSource: null, latestCacheHitRate: null, contextPercent: null, contextWindow: 0, autoCompact: true };
const snapshot = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({ agent: { provider: "test", model: "model", thinkingLevel: "medium" }, footer, runState: "idle", issueStatus: "open", issueRevision: "revision-1", ...fields });

describe("AgentStreamController", () => {
  it.each<[string, Record<string, unknown>]>([
    ["missing runState", { runState: undefined }],
    ["null runState", { runState: null }],
    ["unknown runState", { runState: "unknown" }],
    ["numeric runState", { runState: 1 }],
    ["missing agent", { agent: undefined }],
    ["incomplete agent", { agent: { provider: "test", model: "model" } }],
    ["missing footer", { footer: undefined }],
    ["invalid footer", { footer: { ...footer, input: "0" } }],
    ["unknown cost source", { footer: { ...footer, costSource: "guessed" } }],
    ["missing issueStatus", { issueStatus: undefined }],
    ["unknown issueStatus", { issueStatus: "closed" }],
    ["missing issueRevision", { issueRevision: undefined }],
  ])("rejects a snapshot with %s and validates the fresh stream", async (_label, invalid) => {
    vi.useFakeTimers();
    try {
      const sources: ClosingErrorEventSource[] = [],
        onSnapshot = vi.fn<ConstructorParameters<typeof AgentStreamController>[3]["onSnapshot"]>(),
        onEvent = vi.fn<ConstructorParameters<typeof AgentStreamController>[3]["onEvent"]>(),
        onError = vi.fn<ConstructorParameters<typeof AgentStreamController>[3]["onError"]>();
      const controller = new AgentStreamController(
        (id) => `/api/issues/${id}/agent-stream`,
        1000,
        45000,
        { onConnection() {}, onError, onSnapshot, onEvent },
        (url) => {
          const source = new ClosingErrorEventSource(url);
          sources.push(source);
          return source as unknown as EventSource;
        },
      );
      try {
        controller.connect("ISSUE-20261030-001");
        const first = sources[0]!;
        first.dispatchEvent(new MessageEvent("snapshot_ready", { data: snapshot(invalid) }));
        expect(onSnapshot).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenLastCalledWith("agent_event_protocol_error");
        expect(first.closeCalls).toBe(1);
        await vi.advanceTimersByTimeAsync(1000);
        expect(sources).toHaveLength(2);
        const second = sources[1]!;
        second.dispatchEvent(new MessageEvent("snapshot_ready", { data: snapshot({ runState: "queued" }) }));
        expect(onSnapshot).toHaveBeenCalledTimes(1);
        second.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: "bad", event: { type: "issue_run_state", state: "unknown" } }) }));
        expect(onEvent).not.toHaveBeenCalled();
        expect(onError.mock.calls.filter(([reason]) => reason)).toHaveLength(2);
        expect(onError).toHaveBeenLastCalledWith("agent_event_protocol_error");
        expect(second.closeCalls).toBe(1);
        second.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: "good", event: { type: "issue_run_state", state: "running" } }) }));
        expect(onEvent).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1000);
        const third = sources[2]!;
        third.dispatchEvent(new MessageEvent("snapshot_ready", { data: snapshot({ runState: "running" }) }));
        third.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: "good", event: { type: "issue_run_state", state: "running" } }) }));
        expect(onEvent).toHaveBeenCalledTimes(1);
      } finally {
        controller.dispose();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  for (const phase of ["replay", "live"]) {
    it(`recovers a complete conversation after a malformed ${phase} message instead of keeping a partial stream`, async () => {
      vi.useFakeTimers();
      const sources: ClosingErrorEventSource[] = [];
      const onSnapshot = vi.fn<ConstructorParameters<typeof AgentStreamController>[3]["onSnapshot"]>(),
        onEvent = vi.fn<ConstructorParameters<typeof AgentStreamController>[3]["onEvent"]>(),
        onError = vi.fn<ConstructorParameters<typeof AgentStreamController>[3]["onError"]>();
      const controller = new AgentStreamController(
        (id) => `/stream/${id}`,
        1000,
        45000,
        { onConnection() {}, onError, onSnapshot, onEvent },
        (url) => {
          const source = new ClosingErrorEventSource(url);
          sources.push(source);
          return source as unknown as EventSource;
        },
      );
      const userMessage = JSON.stringify({ id: "user-1", createdAt: "2026-11-05T00:00:00Z", event: { type: "issue_user", message: "persisted message" } });
      try {
        controller.connect("ISSUE-20261105-001");
        const first = sources[0]!;
        first.dispatchEvent(new MessageEvent("message", { data: userMessage }));
        if (phase === "live") first.dispatchEvent(new MessageEvent("snapshot_ready", { data: snapshot() }));
        const accepted = onSnapshot.mock.calls.length;
        first.dispatchEvent(new MessageEvent("message", { data: "{incomplete" }));
        expect(first.closeCalls).toBe(1);
        first.dispatchEvent(new MessageEvent("snapshot_ready", { data: snapshot() }));
        first.dispatchEvent(new MessageEvent("message", { data: userMessage }));
        expect(onSnapshot).toHaveBeenCalledTimes(accepted);
        expect(onEvent).not.toHaveBeenCalled();
        expect(onError).toHaveBeenLastCalledWith("agent_event_protocol_error");
        await vi.advanceTimersByTimeAsync(1000);
        expect(sources).toHaveLength(2);
        sources[1]!.dispatchEvent(new MessageEvent("message", { data: userMessage }));
        sources[1]!.dispatchEvent(new MessageEvent("snapshot_ready", { data: snapshot() }));
        const replay = onSnapshot.mock.lastCall![1];
        expect(replay.entries).toHaveLength(1);
        expect(JSON.stringify(replay.entries)).toContain("persisted message");
      } finally {
        controller.dispose();
        vi.useRealTimers();
      }
    });
  }

  it("reconnects on a session reset and discards events from the previous stream", async () => {
    const sources: ClosingErrorEventSource[] = [],
      onEvent = vi.fn<ConstructorParameters<typeof AgentStreamController>[3]["onEvent"]>();
    const controller = new AgentStreamController(
      (id) => `/api/issues/${id}/agent-stream`,
      1000,
      45000,
      { onConnection() {}, onError() {}, onSnapshot() {}, onEvent },
      (url) => {
        const source = new ClosingErrorEventSource(url);
        sources.push(source);
        return source as unknown as EventSource;
      },
    );
    try {
      controller.connect("ISSUE-20261030-001");
      sources[0]!.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: "reset", event: { type: "session_reset" } }) }));
      await vi.waitFor(() => expect(sources).toHaveLength(2));
      expect(sources[0]!.closeCalls).toBe(1);
      sources[0]!.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: "old", event: { type: "issue_user", message: "old context" } }) }));
      expect(onEvent).not.toHaveBeenCalled();
    } finally {
      controller.dispose();
    }
  });

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
          onError(error) {
            errors.push(error);
          },
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
          onConnection(connected) {
            connections.push(connected);
          },
          onError(error) {
            errors.push(error);
          },
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

  it("parks hidden streams through backoff and Issue switches, then reconnects only the current Issue", async () => {
    vi.useFakeTimers();
    const sources: ClosingErrorEventSource[] = [];
    const onConnection = vi.fn<ConstructorParameters<typeof AgentStreamController>[3]["onConnection"]>(),
      onSnapshot = vi.fn<ConstructorParameters<typeof AgentStreamController>[3]["onSnapshot"]>();
    const controller = new AgentStreamController(
      (id) => `/stream/${id}`,
      1000,
      45000,
      { onConnection, onSnapshot, onError() {}, onEvent() {} },
      (url) => {
        const source = new ClosingErrorEventSource(url);
        sources.push(source);
        return source as unknown as EventSource;
      },
    );
    try {
      controller.setVisible(false);
      controller.connect("first");
      expect(sources).toHaveLength(0);
      controller.setVisible(true);
      sources[0]!.dispatchEvent(new Event("error"));
      controller.setVisible(false);
      controller.connect("second");
      await vi.advanceTimersByTimeAsync(50_000);
      expect(sources).toHaveLength(1);
      controller.setVisible(true);
      expect(sources.map((source) => source.url)).toEqual(["/stream/first", "/stream/second"]);
      sources[0]!.dispatchEvent(new MessageEvent("snapshot_ready", { data: snapshot() }));
      sources[1]!.dispatchEvent(new Event("open"));
      expect(onSnapshot).not.toHaveBeenCalled();
      expect(onConnection).toHaveBeenLastCalledWith(false);
      sources[1]!.dispatchEvent(new MessageEvent("snapshot_ready", { data: snapshot() }));
      expect(onConnection).toHaveBeenLastCalledWith(true);
      controller.setVisible(false);
      controller.dispose();
      controller.setVisible(true);
      expect(sources).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });

  it("bounds the jittered reconnect delay between half and the full exponential ceiling", () => {
    expect(reconnectDelay(1000, 0, () => 0)).toBe(500);
    expect(reconnectDelay(1000, 0, () => 1)).toBe(1000);
    expect(reconnectDelay(1000, 3, () => 1)).toBe(8000);
    expect(reconnectDelay(1000, 10, () => 1)).toBe(30_000);
    expect(reconnectDelay(1000, 10_000, () => 0)).toBe(15_000);
  });

  it("backs off on consecutive failures and resets to the base after snapshot_ready", async () => {
    vi.useFakeTimers();
    const sources: ClosingErrorEventSource[] = [];
    const controller = new AgentStreamController(
      (id) => `/stream/${id}`,
      1000,
      45000,
      { onConnection() {}, onError() {}, onSnapshot() {}, onEvent() {} },
      (url) => {
        const source = new ClosingErrorEventSource(url);
        sources.push(source);
        return source as unknown as EventSource;
      },
      () => 1,
    );
    const failAndExpectRetryAfter = async (delay: number) => {
      const count = sources.length;
      sources.at(-1)!.dispatchEvent(new Event("error"));
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(sources).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(sources).toHaveLength(count + 1);
    };
    try {
      controller.connect("ISSUE-20261117-001");
      await failAndExpectRetryAfter(1000);
      await failAndExpectRetryAfter(2000);
      await failAndExpectRetryAfter(4000);
      sources.at(-1)!.dispatchEvent(new MessageEvent("snapshot_ready", { data: snapshot() }));
      await failAndExpectRetryAfter(1000);
      await failAndExpectRetryAfter(2000);
      controller.connect("ISSUE-20261117-002");
      await failAndExpectRetryAfter(1000);
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });
});
