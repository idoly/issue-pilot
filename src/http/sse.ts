interface SseTarget {
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  write(payload: string): boolean;
  once(event: "drain" | "close" | "error", listener: () => void): unknown;
  off(event: "drain" | "close" | "error", listener: () => void): unknown;
}

export interface OrderedSseWriter {
  write(payload: string): void;
  idle(): Promise<void>;
}

export function createOrderedSseWriter(target: SseTarget): OrderedSseWriter {
  let tail = Promise.resolve();
  const write = (payload: string) => {
    tail = tail.then(() => new Promise<void>((resolve) => {
      if (target.destroyed || target.writableEnded) { resolve(); return; }
      if (target.write(payload)) { resolve(); return; }
      const finish = () => {
        target.off("drain", finish);
        target.off("close", finish);
        target.off("error", finish);
        resolve();
      };
      target.once("drain", finish);
      target.once("close", finish);
      target.once("error", finish);
    }));
  };
  return { write, idle: () => tail };
}
