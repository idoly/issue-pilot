interface SseTarget {
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  write(payload: string): boolean;
  once(event: "drain" | "close" | "error", listener: (error?: unknown) => void): unknown;
  off(event: "drain" | "close" | "error", listener: (error?: unknown) => void): unknown;
}

export interface OrderedSseWriter {
  write(payload: string): void;
  idle(): Promise<void>;
}

export function createOrderedSseWriter(
  target: SseTarget,
  maximumPendingBytes = Number.POSITIVE_INFINITY,
  onWriteFailure: (error: unknown) => void = () => undefined,
): OrderedSseWriter {
  const queue: Array<{ payload: string; bytes: number }> = [];
  const idleWaiters = new Set<() => void>();
  let pendingBytes = 0;
  let pumping = false;
  let closed = false;
  let removeDrainListener: (() => void) | undefined;
  let transportListenersAttached = true;

  const notifyIdle = () => {
    if (pumping || removeDrainListener || queue.length) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };
  const removeTransportListeners = () => {
    if (!transportListenersAttached) return;
    transportListenersAttached = false;
    target.off("close", onTransportClose);
    target.off("error", onTransportError);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    removeDrainListener?.();
    removeDrainListener = undefined;
    removeTransportListeners();
    queue.length = 0;
    pendingBytes = 0;
    notifyIdle();
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
    try {
      while (!closed && !removeDrainListener && queue.length) {
        if (target.destroyed || target.writableEnded) { close(); break; }
        const next = queue.shift()!;
        let accepted: boolean;
        try { accepted = target.write(next.payload); }
        catch (error) { fail(error); break; }
        if (accepted) {
          pendingBytes -= next.bytes;
          continue;
        }
        if (pendingBytes > maximumPendingBytes) {
          fail(new Error("sse_backpressure_limit_exceeded"));
          break;
        }
        const removeListener = () => target.off("drain", onDrain);
        const onDrain = () => {
          removeDrainListener = undefined;
          removeListener();
          pendingBytes -= next.bytes;
          pump();
        };
        removeDrainListener = removeListener;
        target.once("drain", onDrain);
      }
    } finally {
      pumping = false;
      notifyIdle();
    }
  };
  const write = (payload: string) => {
    if (closed) return;
    const bytes = Buffer.byteLength(payload);
    if (pendingBytes > 0 && pendingBytes + bytes > maximumPendingBytes) {
      fail(new Error("sse_backpressure_limit_exceeded"));
      return;
    }
    pendingBytes += bytes;
    queue.push({ payload, bytes });
    pump();
  };
  const idle = () => pumping || removeDrainListener || queue.length
    ? new Promise<void>((resolve) => idleWaiters.add(resolve))
    : Promise.resolve();
  return { write, idle };
}
