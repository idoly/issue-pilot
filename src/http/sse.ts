import { issuePilotConfig } from "../../issue-pilot.config.ts";

interface SseTarget {
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  write(payload: string): boolean;
  once(event: "drain" | "close" | "error", listener: (error?: unknown) => void): unknown;
  off(event: "drain" | "close" | "error", listener: (error?: unknown) => void): unknown;
}

export interface OrderedSseWriter {
  write(payload: string): void;
  /** Pace durable replay; resolves when drained or closed so disconnects cannot strand a route. */
  drain(): Promise<void>;
}

export function createOrderedSseWriter(
  target: SseTarget,
  onWriteFailure: (error: unknown) => void = () => undefined,
  maxQueuedBytes = issuePilotConfig.http.sseQueuedBytes,
): OrderedSseWriter {
  const queue: string[] = [];
  let queuedBytes = 0;
  const drainWaiters = new Set<() => void>();
  const resolveDrain = () => { for (const resolve of drainWaiters) resolve(); drainWaiters.clear(); };
  let pumping = false;
  let closed = false;
  let removeDrainListener: (() => void) | undefined;

  const close = () => {
    if (closed) return;
    closed = true;
    removeDrainListener?.();
    removeDrainListener = undefined;
    target.off("close", onTransportClose);
    target.off("error", onTransportError);
    queue.length = 0;
    queuedBytes = 0;
    resolveDrain();
  };
  const fail = (error: unknown) => {
    if (closed) return;
    close();
    try { onWriteFailure(error); } catch {
      // A transport cleanup failure cannot reject the ordered writer queue.
    }
  };
  const onTransportClose = () => close();
  const onTransportError = (error?: unknown) => fail(error ?? new Error("sse_transport_error"));
  target.once("close", onTransportClose);
  target.once("error", onTransportError);
  const pump = () => {
    if (pumping || closed || removeDrainListener) return;
    pumping = true;
    let consumed = 0;
    try {
      while (!closed && !removeDrainListener && consumed < queue.length) {
        if (target.destroyed || target.writableEnded) { close(); break; }
        const next = queue[consumed++]!;
        queuedBytes -= Buffer.byteLength(next);
        let accepted: boolean;
        try { accepted = target.write(next); }
        catch (error) { fail(error); break; }
        if (accepted) continue;
        const removeListener = () => target.off("drain", onDrain);
        const onDrain = () => {
          removeDrainListener = undefined;
          removeListener();
          pump();
        };
        removeDrainListener = removeListener;
        target.once("drain", onDrain);
      }
    } finally {
      queue.splice(0, consumed);
      pumping = false;
      if (!queue.length && !removeDrainListener) resolveDrain();
    }
  };
  const write = (payload: string) => {
    if (closed) return;
    queue.push(payload);
    queuedBytes += Buffer.byteLength(payload);
    pump();
    // The transport owns a directly written frame. Bound only frames waiting behind backpressure.
    if (queuedBytes > maxQueuedBytes) fail(new Error("sse_queue_budget_exceeded"));
  };
  const drain = () => closed || !queue.length && !removeDrainListener
    ? Promise.resolve()
    : new Promise<void>(resolve => { drainWaiters.add(resolve); });
  return { write, drain };
}
