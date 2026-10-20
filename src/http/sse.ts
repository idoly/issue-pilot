interface SseTarget {
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  write(payload: string): boolean;
  once(event: "drain" | "close" | "error", listener: (error?: unknown) => void): unknown;
  off(event: "drain" | "close" | "error", listener: (error?: unknown) => void): unknown;
}

export interface OrderedSseWriter {
  write(payload: string): void;
}

export function createOrderedSseWriter(
  target: SseTarget,
  onWriteFailure: (error: unknown) => void = () => undefined,
): OrderedSseWriter {
  const queue: string[] = [];
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
    }
  };
  const write = (payload: string) => {
    if (closed) return;
    queue.push(payload);
    pump();
  };
  return { write };
}
