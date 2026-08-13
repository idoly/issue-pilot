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
  let removeBlockedListeners: (() => void) | undefined;

  const notifyIdle = () => {
    if (pumping || removeBlockedListeners || queue.length) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    removeBlockedListeners?.();
    removeBlockedListeners = undefined;
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
  const pump = () => {
    if (pumping || closed || removeBlockedListeners) return;
    pumping = true;
    try {
      while (!closed && !removeBlockedListeners && queue.length) {
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
        const removeListeners = () => {
          target.off("drain", onDrain);
          target.off("close", onClose);
          target.off("error", onError);
        };
        const onDrain = () => {
          removeBlockedListeners = undefined;
          removeListeners();
          pendingBytes -= next.bytes;
          pump();
        };
        const onClose = () => close();
        const onError = (error?: unknown) => fail(error ?? new Error("sse_transport_error"));
        removeBlockedListeners = removeListeners;
        target.once("drain", onDrain);
        target.once("close", onClose);
        target.once("error", onError);
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
  const idle = () => pumping || removeBlockedListeners || queue.length
    ? new Promise<void>((resolve) => idleWaiters.add(resolve))
    : Promise.resolve();
  return { write, idle };
}
